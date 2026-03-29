---
title: "StarRocks Delta Lake External Table에서 Materialized View의 한계와 상용 대안 패턴"
categories:
  - DataEngineering
tags:
  - StarRocks
  - DeltaLake
  - MaterializedView
  - ExternalCatalog
  - DataCache
  - InternalTable
  - Iceberg
date: 2026-03-29
---

## 개요

StarRocks의 Delta Lake External Catalog에서 Materialized View(MV)를 사용할 때 예상치 못한 제약이 있습니다. 공식 문서를 파고들면서 파악한 핵심은 하나입니다. **Delta Lake 기반 MV는 항상 풀스캔입니다.** 이 글에서는 그 이유와 함께 상용 환경에서 실제로 사용되는 대안 패턴 4가지를 정리합니다.

이 글을 읽고 나면 다음을 판단할 수 있습니다.

- Delta Lake External Table 기반 MV가 자신의 데이터 규모에서 실용적인지
- 상용 환경에서 어떤 대안 패턴이 적합한지
- Iceberg 전환이나 Internal Table 적재가 필요한 시점은 언제인지

### 사전 지식

- StarRocks External Catalog 개념 (Hive, Iceberg, Delta Lake 등 외부 데이터 소스를 카탈로그로 등록하여 쿼리)
- StarRocks Async Materialized View 기본 개념 (비동기 갱신 MV)
- Delta Lake 테이블 구조 기초

---

## 1. 문제: Delta Lake MV는 왜 항상 풀스캔인가

StarRocks의 Async MV는 Refresh 전략이 두 가지입니다.

- **파티션 단위 incremental refresh**: 변경된 파티션만 새로고침
- **전체 refresh**: MV 전체를 다시 계산

파티션 단위 incremental refresh가 지원되는 External Catalog은 다음과 같습니다.

| Catalog | 파티션 Refresh | 비고 |
|---|---|---|
| Hive | 지원 | HMS/Glue 메타데이터 캐시로 변경 감지 |
| Iceberg | 지원 (v3.1.4+) | Partition Transforms 포함 (v3.2.3+) |
| Paimon | 지원 (v3.2.1+) | |
| JDBC (MySQL) | 지원 (v3.1.4+) | range-partitioned 테이블 한정 |
| **Delta Lake** | **미지원** | **항상 풀스캔** |
| Hudi | 미지원 | |

공식 문서의 해당 설명을 인용합니다.

> Hive, Iceberg (starting from v3.1.4), JDBC catalog (starting from v3.1.4, only for MySQL range-partitioned tables), and Paimon Catalog (starting from v3.2.1) support detecting data changes at the partition level. As a result, StarRocks can refresh only the partitions with data changes to avoid full-size refresh.

Delta Lake와 Hudi는 이 목록에 포함되지 않습니다. StarRocks가 이 두 포맷의 파티션 수준 변경을 감지하는 메커니즘을 아직 구현하지 않았기 때문입니다. 따라서 Delta Lake External Table을 기반으로 MV를 만들면 REFRESH를 실행할 때마다 전체 데이터를 원본 스토리지(S3 등)에서 다시 읽습니다.

---

## 2. 파티션 MV 생성 시도 시 발생하는 에러

파티션을 지정해서 MV를 만들면 생성 자체가 실패합니다.

```sql
-- delta_catalog: Delta Lake External Catalog
CREATE MATERIALIZED VIEW mv_monthly_metrics
PARTITION BY date_trunc('month', datetime)
REFRESH ASYNC
AS
SELECT
    date_trunc('month', datetime) AS month,
    metric_type,
    sum(value) AS total_value
FROM delta_catalog.analytics.metrics
GROUP BY 1, 2;
```

에러 메시지는 명확합니다.

```
ERROR: Materialized view with partition does not support base table type : DELTALAKE
```

파티션 없이 MV를 만드는 것은 가능하지만, 그 경우 REFRESH마다 전체 테이블을 풀스캔합니다. 데이터가 커질수록 이 비용은 선형으로 증가합니다.

---

## 3. 상용 환경 4-Tier 패턴

Delta Lake 기반 StarRocks 환경에서 상용으로 사용되는 패턴은 4가지 계층으로 정리됩니다. 데이터 규모와 freshness 요구사항에 따라 적합한 Tier가 달라집니다.

### Tier 1: Direct Query + Data Cache

가장 단순한 방법입니다. External Table에 직접 쿼리하고, StarRocks의 Data Cache가 자동으로 원본 스토리지의 파일을 로컬에 캐시합니다.

Data Cache는 BE(Backend) 노드 설정으로 활성화합니다. StarRocks 3.x 이상에서는 기본값이 `true`이므로 별도 설정 없이도 동작합니다.

```ini
# be.conf (BE 노드 설정)
# Data Cache 활성화 (기본값: true)
datacache_enable = true

# Block Cache 메모리 크기 (예: 5GB)
block_cache_mem_size = 5368709120
# Block Cache 디스크 크기 (예: 180GB)
block_cache_disk_size = 193273528320
```

Data Cache는 데이터 블록 단위로 캐싱되기 때문에 쿼리 패턴과 무관하게 동작합니다. 동일한 데이터 블록에 접근하는 후속 쿼리는 원본 스토리지를 읽지 않고 로컬 캐시에서 응답합니다. 벤치마크 기준으로 Cold(원본 스토리지 직접 읽기) 대비 Warm(캐시 hit) 상태에서 약 5~10배 빠릅니다.

- Cold: ~248-300ms
- Warm: ~28-65ms

Ad-hoc 쿼리나 탐색 단계에 적합합니다. 다만 캐시가 LRU 방식으로 관리되기 때문에 데이터가 크거나 접근 패턴이 다양하면 캐시 효율이 낮아집니다.

### Tier 2: MV on External Table (비파티션)

작은 데이터셋에만 실용적입니다. 앞서 설명한 것처럼 Delta Lake에서는 파티션 incremental refresh가 불가하므로, 풀스캔 비용이 감당 가능한 수준일 때만 사용할 수 있습니다.

풀스캔 비용을 줄이는 완화 방법은 몇 가지 있습니다.

```sql
-- 최근 N일만 포함하는 시간 제한 MV
-- WHERE 절로 스캔 범위를 제한하면 풀스캔이어도 읽는 양이 줄어듦
CREATE MATERIALIZED VIEW mv_recent_metrics
REFRESH ASYNC EVERY (INTERVAL 1 HOUR)
AS
SELECT *
FROM delta_catalog.analytics.metrics
WHERE datetime >= date_sub(current_date(), 7);
```

```sql
-- Staleness 허용: MV 데이터가 최대 1시간 지연되어도 쿼리 리라이트 허용
-- 이 설정이 없으면 원본에 변경이 생길 때마다 MV 리라이트를 건너뜀
SET mv_rewrite_staleness_second = 3600;
```

데이터 행 수 기준으로 수천~수만 rows 규모라면 MV REFRESH 비용이 낮아서 유지할 수 있습니다.

### Tier 3: Internal Table + Incremental Load

Delta Lake에서 가장 일반적인 상용 패턴입니다. External Table은 원본 참조용으로만 쓰고, StarRocks 내부 테이블에 데이터를 주기적으로 적재합니다.

```sql
-- Step 1: 내부 테이블 생성 및 초기 적재 (CTAS)
CREATE TABLE internal_metrics
PRIMARY KEY (id, datetime)
DISTRIBUTED BY HASH(id)
PARTITION BY date_trunc('day', datetime)
AS
SELECT * FROM delta_catalog.analytics.metrics;
```

```sql
-- Step 2: 증분 적재 (INSERT INTO SELECT)
-- Airflow, StarRocks SUBMIT TASK 등으로 스케줄링
INSERT INTO internal_metrics
SELECT *
FROM delta_catalog.analytics.metrics
WHERE datetime >= date_sub(current_date(), 1)
  AND datetime < current_date();
```

`SUBMIT TASK`를 사용하면 StarRocks 내부에서 비동기로 INSERT를 실행할 수도 있습니다. v2.5에서 도입되었고, v3.0부터 CTAS와 INSERT 문을 모두 지원합니다.

```sql
-- StarRocks 내장 비동기 태스크로 증분 적재
SUBMIT TASK daily_load AS
INSERT INTO internal_metrics
SELECT *
FROM delta_catalog.analytics.metrics
WHERE datetime >= date_sub(current_date(), 1)
  AND datetime < current_date();
```

Internal Table에 적재된 후에는 MV를 파티션 단위로 관리할 수 있습니다. 이것이 이 패턴의 핵심 장점입니다.

```sql
-- Internal Table 기반이므로 파티션 incremental refresh 가능
CREATE MATERIALIZED VIEW mv_monthly_metrics
PARTITION BY date_trunc('month', datetime)
REFRESH ASYNC EVERY (INTERVAL 1 HOUR)
AS
SELECT
    date_trunc('month', datetime) AS month,
    metric_type,
    sum(value) AS total_value
FROM internal_metrics
GROUP BY 1, 2;
```

이 패턴의 주요 트레이드오프는 다음과 같습니다.

| 장점 | 단점 |
|---|---|
| MV 파티션 incremental refresh 가능 | 적재 파이프라인 운영 부담 |
| 쿼리 성능 예측 가능 (로컬 스토리지) | 데이터 freshness 지연 (적재 주기만큼) |
| StarRocks 최적화(인덱스, 정렬 등) 활용 | 스토리지 이중 사용 (원본 + 내부 복제) |

### Tier 4: Full Lakehouse (Iceberg 기반)

대규모 환경에서는 Delta Lake 대신 Iceberg를 채택하는 경우가 많습니다. StarRocks 생태계 자체가 Iceberg에 최적화되어 있고, v3.1.4부터는 Iceberg의 파티션 수준 변경 감지를 통해 MV 파티션 incremental refresh가 지원됩니다. v3.2.3부터는 Iceberg Partition Transforms(`identity`, `year`, `month`, `day`, `hour`)를 사용한 파티션 MV도 지원합니다.

현재 Delta Lake를 사용 중이라면 Databricks UniForm을 통해 Delta Lake 테이블에 Iceberg 호환 메타데이터를 추가하는 방법이 있습니다. UniForm이 활성화된 테이블은 Delta Lake와 Iceberg 양쪽 메타데이터를 동시에 갖기 때문에, 기존 Databricks 파이프라인은 그대로 유지하면서 StarRocks에서는 **Iceberg Catalog으로 접근**하여 파티션 incremental refresh의 이점을 얻을 수 있습니다. 이 조합이 확인되면 앞서 설명한 Tier 2의 풀스캔 제약이 사라지므로, MV/VIEW 이원 전략 대신 MV 단일 전략으로 단순화할 수 있습니다.

---

## 4. 데이터 규모별 권장 패턴 정리

| 데이터 규모 | 권장 패턴 | 이유 |
|---|---|---|
| 수천~수만 rows | Tier 2: MV on External Table | 풀스캔 비용이 낮아 REFRESH 부담 적음 |
| 수십만 rows | Tier 1: Direct Query + Data Cache | MV REFRESH 비용 대비 캐시가 효율적 |
| 수억 rows 이상 | Tier 3: Internal Table 적재 | External Table 직접 사용 시 쿼리 성능 불안정 |
| 수십억 rows 이상 + MV 필수 | Tier 4: Iceberg 전환 검토 | 파티션 incremental refresh 필수 |

---

## 5. 흔한 실수와 트러블슈팅

### Delta Lake MV에 PARTITION BY를 넣었다가 에러

앞서 다룬 것처럼 `PARTITION BY` 절을 포함하면 생성 자체가 실패합니다. Delta Lake External Table 기반 MV는 파티션 없이 생성해야 합니다.

### MV REFRESH가 예상보다 느린 경우

비파티션 MV의 REFRESH는 전체 데이터를 읽으므로 시간이 지남에 따라 느려집니다. 다음을 확인합니다.

1. MV의 SELECT에 WHERE 조건으로 시간 범위를 제한하고 있는지
2. 원본 Delta Lake 테이블의 파일 수가 지나치게 많지 않은지 (small file 문제)
3. Data Cache가 정상 동작하고 있는지 (`block_cache_enable = true` 확인)

### MV 쿼리 리라이트가 동작하지 않는 경우

Delta Lake External Table의 데이터가 변경되면 StarRocks는 MV의 데이터가 stale하다고 판단하여 쿼리 리라이트를 건너뜁니다. `mv_rewrite_staleness_second` 속성을 설정하여 일정 시간 내의 지연을 허용할 수 있습니다.

---

## 6. 교훈

StarRocks 공식 문서는 External Catalog MV 관련해서 제약을 명시해두고 있지만, "파티션 refresh 지원 여부"가 카탈로그 종류에 따라 다르다는 점은 초기에 놓치기 쉽습니다. Delta Lake External Table로 MV를 구성하기 전에 다음 두 가지를 먼저 확인해야 합니다.

1. 대상 테이블의 데이터 규모가 풀스캔 REFRESH를 감당할 수 있는 수준인가
2. Iceberg 전환 또는 Internal Table 적재 파이프라인 구성이 장기적으로 더 적합하지 않은가

External Catalog의 편의성에 이끌려 MV를 먼저 만들고 나중에 성능 문제를 발견하는 것보다, 데이터 규모와 갱신 주기를 기준으로 Tier를 먼저 결정하는 것이 운영 비용을 줄이는 방법입니다.

---

## Reference

- [StarRocks - Data Lake Query Acceleration with Materialized Views](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_lake_query_acceleration_with_materialized_views/)
- [StarRocks - Data Cache](https://docs.starrocks.io/docs/data_source/data_cache/)
- [StarRocks - SUBMIT TASK](https://docs.starrocks.io/docs/sql-reference/sql-statements/loading_unloading/ETL/SUBMIT_TASK/)
- [StarRocks - Loading Data (INSERT INTO)](https://docs.starrocks.io/docs/loading/Loading_intro/)
