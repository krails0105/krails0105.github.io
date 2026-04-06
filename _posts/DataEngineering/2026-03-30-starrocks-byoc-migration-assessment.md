---
title: "StarRocks BYOC 마이그레이션 종합 평가: 10가지 이슈와 대안 솔루션 비교"
date: 2026-03-30
categories:
  - DataEngineering
tags:
  - StarRocks
  - BigQuery
  - OLAP
  - Trino
  - ClickHouse
  - Druid
  - Databricks
  - CostOptimization
  - Migration
---

## 들어가며

지난 3편의 포스트에서 StarRocks BYOC + Databricks Delta Lake 조합을 순차적으로 검증했다.

1. [StarRocks BYOC + Databricks Delta Lake로 BigQuery 파이프라인 대체하기](/dataengineering/starrocks-byoc-databricks-migration/) -- 전체 아키텍처, MV/VIEW 전략, FastAPI 서버 구축
2. [StarRocks Delta Lake MV의 한계와 상용 대안 패턴](/dataengineering/starrocks-delta-lake-mv-limitations/) -- Delta Lake External Table MV는 incremental refresh 불가, 4-Tier 대안 패턴
3. [StarRocks + Databricks UniForm: Iceberg Catalog으로 Incremental MV가 가능할까?](/dataengineering/starrocks-iceberg-uniform-incremental-test/) -- UniForm Iceberg Catalog 연결 성공, 파티션 MV 생성 성공, 그러나 incremental refresh는 사실상 실패

이번 글은 시리즈의 마무리다. 세 편의 검증 결과를 종합하고, 추가 분석(비용, 대안 솔루션 비교, OOM, STRING 제한 등)을 더해 최종 판단을 내린다.

**결론을 먼저 말하면:**

- metric 레이어(집계 테이블) 전환은 기술적으로 가능하고 비용 효과도 충분하다.
- raw 레이어(상세 트랜잭션 테이블)와 BigQuery 완전 제거는 현실적으로 어렵다. 3개의 블로커가 동시에 걸린다.

---

## 아키텍처 개요

### AS-IS: 현재 파이프라인

```
PostgreSQL (Metrics DB) → 데이터 수집 파이프라인 → BigQuery (metric.*)
    → dbt 변환 → BQ mart 테이블
    → Airflow reverse ETL → PostgreSQL West
    → Analytics API (BQ 쿼리 프록시)
    → 웹사이트 백엔드 (PostgreSQL West 직접 읽기)
```

중간 단계가 많다. BQ 조회 비용, reverse ETL 운영, dbt 모델 관리, 중간 PostgreSQL 유지 비용이 모두 발생한다.

### TO-BE: 목표 아키텍처

```
Databricks Delta Lake (S3)
    │ Unity Catalog
    ▼
StarRocks BYOC (External Catalog + Materialized View)
    │
    ▼
Analytics API
```

BQ, dbt, reverse ETL, 중간 PostgreSQL을 한 번에 제거하는 것이 목표다. Databricks는 데이터 생산만 담당하고, StarRocks가 쿼리 서빙 + 집계 변환을 동시에 맡는다.

검증 대상은 특정 체인(이하 "BTC") 데이터 한정이다. 다른 체인 데이터는 기존 파이프라인을 유지한다.

---

## 발견된 10가지 문제

### 1. Delta Lake MV 풀스캔 (해결 불가)

StarRocks의 Async MV는 파티션 단위 incremental refresh를 지원하지만, **Delta Lake와 Hudi는 이 기능에서 제외**된다. 공식 문서에 명시된 파티션 레벨 변경 감지 지원 목록은 다음과 같다.

| Catalog | 파티션 Incremental Refresh | 비고 |
|---|---|---|
| Hive | 지원 | |
| Iceberg | 지원 (v3.1.4+) | Partition Transform 지원은 v3.2.3+ |
| Paimon | 지원 (v3.2.1+) | |
| JDBC (MySQL) | 지원 (v3.1.4+) | range-partitioned 테이블만 |
| Delta Lake | **미지원** | 전체 refresh만 가능 |
| Hudi | **미지원** | 전체 refresh만 가능 |

파티션 절을 포함해 MV를 생성하면 에러가 발생한다.

```sql
-- delta_catalog: Delta Lake External Catalog
CREATE MATERIALIZED VIEW mv_metrics_day
PARTITION BY date_trunc('day', datetime)
REFRESH ASYNC
AS SELECT ...
FROM delta_catalog.analytics.metrics_day;

-- ERROR: Materialized view with partition does not support base table type : DELTALAKE
```

파티션 없이 MV를 만들 수는 있다. 하지만 그 경우 REFRESH마다 전체 테이블을 풀스캔한다. 수천~수만 rows 규모에서는 감당 가능하지만 수억 rows 이상에서는 현실적으로 불가능하다.

### 2. UniForm Iceberg incremental refresh 실패 (해결 불가)

Databricks UniForm은 Delta Table에 Iceberg 메타데이터를 병행 관리하는 기능이다. 이를 통해 StarRocks Iceberg Catalog으로 연결하면 파티션 MV를 생성할 수 있다.

```sql
-- Iceberg Catalog 기반 MV: 파티션 생성 성공
CREATE MATERIALIZED VIEW mv_metrics_hour_ice
PARTITION BY _partition_date
REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
AS SELECT ...
FROM iceberg_uc.analytics.metrics_hour;

-- partition_type: RANGE  (Delta Lake에서는 UNPARTITIONED였음)
```

파티션 MV 생성 자체는 성공했다. 그러나 두 번째 refresh 시 로그에서 전체 6,290개 파티션이 "변경됨"으로 인식되는 것을 확인했다.

```
# 두 번째 refresh 로그
Partitions to refresh: 6290 / 6290
```

원인은 UniForm의 메타데이터 재생성 방식이다. Delta write 후 생성되는 Iceberg snapshot이 전체 테이블 상태를 포함하는 manifest를 만들기 때문에, StarRocks가 이전 snapshot과의 차이를 파티션 단위로 추적하지 못한다. **진정한 incremental refresh는 Iceberg 네이티브 테이블(Iceberg로 직접 write)이어야 가능하다.**

### 3. STRING 길이 제한 (부분 해결)

StarRocks의 `VARCHAR` 타입은 길이를 명시하지 않으면 기본값이 **1바이트**다. 명시적으로 길이를 지정하는 경우, StarRocks 2.1 이전에는 최대 65,533바이트, **2.1 이후부터는 최대 1,048,576바이트(약 1MB)**까지 허용된다.

raw 트랜잭션 데이터 중 일부 컬럼은 70KB를 초과하는 값이 존재한다. 기본 길이의 `VARCHAR`로 테이블을 생성하면 INSERT 시 실패한다.

```sql
-- 해결: 명시적으로 최대 길이 지정
VARCHAR(1048576)  -- 최대 1MB (StarRocks 2.1+)
```

하지만 이 문제는 모든 raw 테이블에 대해 컬럼별 최대 길이를 전수 조사해야 확정할 수 있다. 규모가 수십 개 테이블, 수백 컬럼에 걸쳐 있어 공수가 상당하다.

### 4. BE 메모리 OOM (미해결 -- 스케일업 필요)

Free Tier 구성(FE 8c/32GB 1대, BE 4c/16GB 1대)에서 raw 테이블 대범위 집계 쿼리 시 BE OOM이 발생했다. raw 레이어 적재(Internal Table로 CTAS) 시도 시에도 동일하게 OOM이 발생했다.

| 구성 | raw 레이어 적재 | External Table 집계 |
|---|---|---|
| BE 4c/16GB | OOM | OOM |
| BE 32c/128GB (예상) | 가능 | 가능 |

metric 집계 레이어(수십만 rows)는 현재 스펙으로도 안정적으로 동작한다. raw 레이어(수억 rows)는 32c/128GB 이상의 스케일업이 사실상 필수다.

### 5. External Table cold 쿼리 느림 (구조적 한계)

raw 테이블에 대한 cold 쿼리(Data Cache 미적중 상태)는 S3 전체 스캔이 발생한다. 측정 결과 52초가 소요됐다. BQ는 파티션 프루닝으로 동일 쿼리가 사실상 0초에 가깝다.

StarRocks의 Data Cache는 자주 조회되는 데이터를 BE 로컬 디스크/메모리에 캐싱하여 반복 쿼리 성능을 개선하는 기능이다. 하지만 메모리를 늘려도 cold 상태의 S3 전체 스캔 자체는 개선되지 않는다. Data Cache에 올라온 warm 상태에서야 실용적인 응답 시간이 된다.

| 레이어 | cold 쿼리 | warm 쿼리 (Data Cache 적중) |
|---|---|---|
| metric (수십만 rows) | 수초 | 28~65ms |
| raw (수억 rows) | 52초+ | 미측정 (OOM으로 적재 불가) |

문제는 raw 레이어다. cold 상태에서 52초는 API 서빙 용도로 허용 불가능한 수준이다.

### 6. 스키마 불일치 (해결됨, 주의사항)

마이그레이션 과정에서 여러 스키마 불일치 이슈가 발생했다.

- 테이블마다 컬럼 구성이 다름 (예: block 테이블에는 특정 집계 컬럼 없음)
- Delta Lake External Table에 `_partition_date` 같은 내부 파티션 컬럼이 추가되어 INSERT 시 컬럼 수 불일치 발생
- 파티션 범위 밖 날짜 데이터 INSERT 실패 -- 동적 파티셔닝(`dynamic_partition.enable = true`)으로 해결

교훈은 단순하다. **INSERT 전에 반드시 `DESC` 또는 `INFORMATION_SCHEMA`로 실제 스키마를 확인해야 한다.** 소스 테이블과 타겟 테이블의 컬럼 수, 타입, 순서가 모두 일치해야 한다.

### 7. dbt mart 소스 체인 복잡 (미해결)

BQ 비용의 상당 부분은 dbt mart 모델에서 발생한다. 그런데 BTC 체인의 dbt 모델 소스가 ETH raw 데이터까지 얽혀 있다. BTC만 분리해서 StarRocks로 옮기려면 dbt 모델 분리/수정이 선행되어야 하는데, 그 범위가 예상보다 넓다.

### 8. 부하 테스트 미검증

현재 시스템 기준으로 Analytics API를 통해 약 36만 쿼리/월이 발생한다. 현재 StarRocks 구성(4c/16GB)에서 이 트래픽을 감당할 수 있는지 검증이 없다. 스케일업 없이 프로덕션 전환 시 쿼리 지연 또는 장애가 발생할 수 있다.

### 9. 비용 불확실성

CelerData BYOC의 CCU(CelerData Unit) 소비율은 노드 스펙에 따라 다르다. 공식 가격 테이블에 정확한 수치가 공개되어 있지 않으며, 스케일업 시 비용은 추정치만 있고 실측 데이터가 없다. Trial 기간이 20일 남은 상황에서 이후 비용 구조를 확정하지 못한 채 진행하면 리스크가 크다.

### 10. 멀티체인 dbt 모델 수정 필요

일부 dbt 모델이 BTC와 ETH 데이터를 혼합해서 처리한다. BTC만 StarRocks로 분리하려면 이 모델들을 체인별로 분리하는 사전 작업이 필요하다.

---

## 대안 OLAP 솔루션 비교

StarRocks가 현재 구조에서 여러 제약을 드러내면서, 대안 솔루션을 함께 검토했다.

| 솔루션 | 장점 | 단점 | 판정 |
|---|---|---|---|
| **StarRocks BYOC** | MV, External Catalog, MySQL 프로토콜, Data Cache | Delta Lake incremental 미지원, OOM, STRING 제한 | 검증 중 (metric은 실용) |
| **Trino** | Delta Lake 네이티브, 파티션 프루닝 완벽 | MV는 Iceberg Connector에서만 지원, Delta Lake MV 불가 | Delta Lake MV 부재 |
| **ClickHouse** | 단일 테이블 집계 최고 속도 | 복잡한 JOIN에서 성능 저하, External Catalog 미성숙 | 부적합 |
| **Apache Druid** | 실시간 ingestion 강점 | JOIN 조건 제한적, SQL 지원 불완전 | 부적합 |
| **Databricks SQL Warehouse** | Delta Lake 네이티브, 파티션 프루닝 완벽 | CCU 과금, 36만 쿼리/월이면 BQ보다 비쌀 수 있음 | 비용 목적에 역행 |

각 솔루션이 탈락하는 이유를 구체적으로 정리하면 다음과 같다.

### ClickHouse: 복잡한 JOIN에 구조적으로 불리

현재 쿼리 패턴이 multi-table JOIN 중심이다. 예를 들어 UTXO 분포 테이블은 6개 테이블 JOIN에 166컬럼을 처리한다. ClickHouse 공식 문서에서도 **JOIN 수를 최대 3~4개로 줄이는 것을 권장**하며, 비정규화(denormalization)나 Dictionary, MV를 통해 JOIN을 회피하는 모델링을 안내하고 있다. 6개 테이블 JOIN은 ClickHouse의 권장 패턴을 크게 벗어난다.

### Apache Druid: JOIN 조건이 제한적

Druid의 JOIN은 **등호 조건(equality)만 지원**하며, 상수 값을 포함하는 조건이나 multi-value dimension에 대한 조건은 지원하지 않는다. 또한 JOIN reordering 최적화가 없어 복잡한 JOIN에서 성능 예측이 어렵다. 현재 쿼리 패턴과 맞지 않는다.

### Trino: Delta Lake에서는 MV 미지원

Trino는 `CREATE MATERIALIZED VIEW` 구문을 지원하지만, 이는 **Iceberg Connector에서만 사용 가능**하다. 현재 데이터 소스가 Delta Lake인 상황에서 Trino의 MV 기능은 쓸 수 없다. MV 없이 쿼리 가속을 하려면 dbt 변환 레이어를 그대로 유지해야 하는데, 그렇게 되면 파이프라인 단순화라는 핵심 목표가 달성되지 않는다.

### Databricks SQL Warehouse: 비용 구조가 BQ와 유사

Delta Lake와 완전히 네이티브하게 연동되며 파티션 프루닝도 완벽하다. 그러나 CCU 기반 쿼리 과금이 발생한다. 36만 쿼리/월 수준에서 계산해보면 BQ 비용과 비슷하거나 더 높아질 수 있다. BQ 비용을 줄이기 위한 마이그레이션인데 비용 구조가 BQ와 유사한 솔루션을 쓰는 것은 목적과 상충한다.

### 소결

현재 요구사항(복잡한 JOIN, MV 기반 집계, 고정 비용)에 가장 맞는 솔루션은 여전히 StarRocks다. 다만 Delta Lake incremental 제약을 회피할 수 없다는 점을 인정하고 그 위에서 전략을 짜야 한다.

---

## 비용 분석

### 현재 BigQuery 비용 (월)

| 항목 | 월 비용 |
|---|---|
| 데이터 처리 프로젝트 (dbt 실행) | ~$8,420 |
| 서빙 프로젝트 (API 쿼리) | ~$5,108 |
| 합계 | ~$13,520 |

BTC 관련 비중은 전체의 약 54%로, BTC 관련 비용은 약 $7,088/월로 추산된다.

### StarRocks BYOC 비용 시나리오

| 구성 | 주요 용도 | 월 비용 (추산) | BQ 대비 절감 |
|---|---|---|---|
| 4c/16GB FE x1 + BE x1 (현재 Free Tier) | metric 레이어만 | ~$900--1,000 | ~93% |
| 32c/128GB FE x1 + BE x1 | metric + raw 레이어 | ~$3,100--4,500 | ~67--77% |
| 32c/128GB FE x1 + BE x2 (HA 구성) | 프로덕션 | ~$6,300--9,100 | ~33--53% |

단, 이 수치는 CCU 소비율 공식 데이터가 없어 추정치다. 실측 전까지는 참고치로만 봐야 한다.

### BTC 전환 시 순 절감 효과

metric 레이어만 StarRocks로 전환하더라도 의미 있는 절감이 발생한다.

| 항목 | 금액 |
|---|---|
| 현재 BTC 관련 BQ 비용 | ~$7,088/월 |
| StarRocks metric-only 비용 | ~$900--1,000/월 |
| 순 절감 | ~$6,000/월 |
| 연간 절감 | ~$72,000/년 |

raw 레이어까지 포함하면 절감폭은 줄어들고 관리 복잡도는 늘어난다. metric-only 전환이 ROI가 가장 명확하다.

---

## 최종 판단

### 현실적으로 가능한 것

**metric 레이어 (일별/시간별 집계 테이블)**

- 수만~수십만 rows 규모
- MV 풀스캔 refresh 시간: 약 20초 (1시간마다 실행해도 감당 가능)
- Data Cache warm 시 쿼리 응답: 28~65ms

**block-level metric (VIEW + Data Cache)**

- MV 대신 VIEW로 처리 (데이터가 크고 최신성이 중요한 경우)
- warm 상태 쿼리: 28~65ms

이 두 레이어만으로도 BTC 관련 BQ 비용의 상당 부분을 절감할 수 있다.

### 현실적으로 어려운 것

**raw 레이어 (상세 트랜잭션 테이블)** -- 3개의 블로커가 동시에 작용한다.

1. **OOM**: BE 16GB로는 raw 테이블 집계 자체가 실패한다. 32c/128GB 스케일업이 필수다.
2. **STRING 제한**: 전수 조사 공수가 크고, 누락 시 INSERT 실패가 발생한다.
3. **cold 쿼리 성능**: 52초 S3 스캔은 BQ 파티션 프루닝과 비교해 구조적으로 불리하다.

**BQ 완전 제거** -- dbt mart 모델의 소스 체인이 ETH raw 데이터까지 얽혀 있어, BTC만 분리하는 것 자체가 큰 리팩토링이 된다.

**UniForm incremental refresh** -- 구조적으로 불가능하다. 진정한 incremental이 필요하다면 Databricks 파이프라인을 Iceberg 네이티브 테이블로 전환해야 한다. 이는 Databricks 팀의 작업 범위까지 영향을 미치는 큰 변경이다.

### 결론 요약

```
metric-only 전환  →  기술적 가능, ~$6,000/월 절감, 권장
raw 레이어 전환   →  3개 블로커, 스케일업 비용 증가, 추가 검증 필요
BQ 완전 제거      →  dbt 소스 체인 문제로 장기 과제
```

---

## 다음 단계

프로덕션 전환 전에 반드시 확인해야 할 것들이다.

### 1. 부하 테스트

36만 쿼리/월(약 500 QPD, 피크 시 수십 QPS)을 StarRocks 4c/16GB에서 시뮬레이션한다. 스케일업 없이 metric-only 트래픽을 감당할 수 있는지 확인이 필요하다.

### 2. Trial 만료 전 비용 실측

현재 20일 남은 Trial 기간 내에 metric-only 구성으로 실제 CCU 소비량을 측정해야 한다. Free Tier 만료 후 Elastic Cluster 전환 시 비용 구조가 달라지므로, 전환 결정 전 실측 데이터를 확보해야 한다.

### 3. metric-only 전환 진행 여부 확정

부하 테스트와 비용 실측 결과를 기반으로 metric 레이어 전환을 진행할지 최종 결정한다. 긍정적이면 Phase 2(API 전환) → Phase 3(BQ 정리) 순서로 진행한다.

### 4. raw 레이어 전략 별도 수립

raw 레이어는 metric-only 전환이 안정화된 후 별도 프로젝트로 검토한다. 선택지는 세 가지다.

- StarRocks 스케일업 + STRING 전수 조사 후 전환
- BQ + dbt 유지 (현상 유지)
- 네이티브 Iceberg 전환 검토 (Databricks 파이프라인 변경 포함)

---

## Reference

**이 시리즈 이전 포스트**

- [StarRocks BYOC + Databricks Delta Lake로 BigQuery 파이프라인 대체하기](/dataengineering/starrocks-byoc-databricks-migration/)
- [StarRocks Delta Lake External Table에서 MV의 한계와 상용 대안 패턴](/dataengineering/starrocks-delta-lake-mv-limitations/)
- [StarRocks + Databricks UniForm: Iceberg Catalog으로 Incremental MV가 가능할까?](/dataengineering/starrocks-iceberg-uniform-incremental-test/)

**StarRocks 공식 문서**

- [StarRocks: Delta Lake Catalog](https://docs.starrocks.io/docs/data_source/catalog/deltalake_catalog/)
- [StarRocks: Iceberg Catalog](https://docs.starrocks.io/docs/data_source/catalog/iceberg/iceberg_catalog/)
- [StarRocks: Data Lake Query Acceleration with MVs](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_lake_query_acceleration_with_materialized_views/)
- [StarRocks: Feature Support for Data Lake Analytics](https://docs.starrocks.io/docs/data_source/feature-support-data-lake-analytics/)
- [StarRocks: CREATE MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW)
- [StarRocks: VARCHAR Data Type](https://docs.starrocks.io/docs/sql-reference/data-types/string-type/VARCHAR)

**Databricks 공식 문서**

- [Databricks UniForm](https://docs.databricks.com/en/delta/uniform.html)
- [Databricks Unity Catalog Iceberg REST API](https://docs.databricks.com/aws/en/external-access/iceberg)

**대안 솔루션 참고**

- [ClickHouse: Using JOINs](https://clickhouse.com/docs/guides/joining-tables)
- [Apache Druid: SQL JOIN Translation](https://druid.apache.org/docs/latest/querying/sql-translation)
- [Trino: CREATE MATERIALIZED VIEW](https://trino.io/docs/current/sql/create-materialized-view)

**CelerData**

- [CelerData BYOC 가격 정보](https://celerdata.com/pricing)
