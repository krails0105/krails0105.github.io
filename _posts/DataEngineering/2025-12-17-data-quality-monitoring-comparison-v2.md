---
title: "[DataEngineering] Databricks 파이프라인 모니터링 솔루션 비교 — Lakehouse Monitoring 롤백부터 Soda + SQL Dashboard 선택까지"
categories:
  - DataEngineering
tags:
  - Databricks
  - DataQuality
  - Soda
  - LakehouseMonitoring
  - DeltaLake
  - SodaCL
date: 2026-03-10
---

### 개요

대규모 이벤트 데이터 ETL 파이프라인을 운영하면서 block gap, PSQL ingestion SSL 끊김, CDF version 0 문제 같은 장애를 **사후에야** 알게 되는 상황이 반복됐습니다. "왜 모니터링이 없지?"라는 자각 이후 Databricks Lakehouse Monitoring을 직접 시도했다가 전체 롤백하고, 결국 **Soda Core + Databricks SQL Dashboard** 조합을 선택하기까지의 과정을 정리합니다.

**이 글에서 다루는 내용:**

- Databricks Lakehouse Monitoring을 시도하고 롤백한 이유
- 데이터 품질 모니터링 전문 도구 5종 비교 (Soda / Monte Carlo / Metaplane / Elementary / Great Expectations)
- 대시보드 도구 5종 비교 (Databricks SQL Dashboard / Metabase / Superset / Streamlit / Grafana)
- 카탈로그 + Lineage + 모니터링 통합 도구 2종 비교 (DataHub / OpenMetadata)
- Databricks Lakehouse Federation으로 Delta + PSQL + BQ를 단일 SQL로 통합 쿼리하는 방법
- 최종 Phase 1/2 설계와 선택 근거

**대상 독자:** Databricks 기반 ETL 파이프라인을 운영하면서 데이터 품질 모니터링 도구 도입을 검토 중인 엔지니어

---

### 배경 --- 무엇을 모니터링해야 하는가

파이프라인 구조는 다음과 같습니다.

```
S3 (raw blocks)
  -> Bronze (DLT streaming / batch)
    -> Silver (address_transfer, balance_diff, entity_flow)
      -> Derived (14+ block tables: metric_*, network_*, derived_*, event_*)
        -> PSQL + BigQuery (API 서빙)
```

각 레이어에서 실제로 겪었던 문제들입니다.

| 문제 | 발생 레이어 | 영향 |
|------|-----------|------|
| **Block gap** | Bronze -> Derived | `spot_ohlcv_index_min` 가격 소스 누락으로 downstream 13개 블록 cascade |
| **Snapshot skip** | Derived | 10K 블록 간격 snapshot 누락 시 Process A/B 전체 재계산 필요 |
| **PSQL SSL 끊김** | Derived -> PSQL | JDBC 동시 연결 수 초과 -> DB writer CPU 47%, 21 active sessions -> timeout |
| **CDF version 0 부재** | Derived -> PSQL | `saveAsTable()` 후 ALTER TABLE CDF 활성화 -> version 0에 CDF 데이터 없음 -> `init=true` 실패 |
| **rollup start_ts 불일치** | Derived | window 경계 truncate 누락 -> 누적 집계 어긋남 |

이 문제들의 공통점은 **장애가 발생하고 나서야 알게 된다**는 것입니다. 이상적으로는 다음 네 가지를 자동으로 감지해야 합니다.

1. **Gap 감지**: 특정 event_id 범위가 비어 있는지
2. **Freshness 감지**: 마지막 갱신이 몇 시간 전인지
3. **Sync lag 감지**: PSQL/BQ sync가 Delta 대비 얼마나 뒤처져 있는지
4. **Data quality 감지**: NULL, 음수, 이상 값이 생겼는지

---

### 시도 1: Databricks Lakehouse Monitoring --- 그리고 전체 롤백

가장 먼저 시도한 것은 Databricks 네이티브 모니터링입니다.

#### 시도 과정

처음에는 `databricks.lakehouse_monitoring` Python 모듈을 임포트하려 했지만 클러스터에 설치되어 있지 않았습니다. Databricks SDK의 `w.quality_monitors.create()` API로 접근 방식을 바꿨습니다.

```python
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()
w.quality_monitors.create(
    table_name="{analytics_catalog}.analytics.indicator_block",
    assets_dir="/Shared/monitoring",
    output_schema_name="{analytics_catalog}.monitoring",
    # ...
)
```

14개 테이블 중 13개 모니터 생성에 성공했습니다. 그런데 실제로 결과를 살펴보니 근본적인 문제가 있었습니다.

#### 롤백 이유

Databricks Lakehouse Monitoring은 **DWH 테이블의 통계적 drift 감지**에 최적화된 도구입니다. 생성되는 산출물이 `profile_metrics`, `drift_metrics` 두 개의 메타 테이블인데, 이것이 우리가 원하는 것과 결이 다릅니다.

| 우리가 원하는 것 | Lakehouse Monitoring이 제공하는 것 |
|----------------|--------------------------------|
| "block 938,577이 빠져 있다" | "이 컬럼의 평균이 지난 달 대비 12% 바뀌었다" |
| "PSQL이 3시간째 sync 안 됐다" | "NULL 비율이 지난 주 대비 0.3% 증가했다" |

통계적 drift 감지는 ML feature 모니터링이나 DW 테이블 품질 추적에 유용합니다. 하지만 블록체인 ETL처럼 **연속적인 event_id 커버리지와 freshness**가 핵심인 파이프라인에는 핏이 맞지 않았습니다.

결국 13개 모니터를 모두 삭제하고 `profile_metrics`/`drift_metrics` 테이블도 DROP했습니다.

> **교훈**: 도구가 "강력"해도 내 문제에 맞지 않으면 오히려 운영 부담만 늘어납니다. 도구의 설계 철학이 내 요구사항과 일치하는지 먼저 확인하는 것이 중요합니다.

---

### 솔루션 비교

롤백 이후 시장에 있는 도구들을 체계적으로 비교했습니다. 크게 세 가지 범주로 나눠서 평가했습니다.

#### 1. 데이터 품질 모니터링 전문 도구

| 솔루션 | 접근 방식 | 비용 | 환경 적합도 | 탈락/선정 |
|--------|----------|------|-----------|----------|
| **Soda** | SQL/YAML 선언적 체크 (SodaCL) | Core 무료 / Cloud $300+/mo | Delta + PSQL + BQ 모두 지원 | **선정** |
| **Monte Carlo** | 자동 anomaly detection, ML 기반 | Enterprise (수천 달러/mo) | 기능 과잉 | 탈락 |
| **Metaplane** | Monte Carlo 경량판 | 테이블당 과금 | Snowflake 중심 | 탈락 |
| **Elementary** | dbt 네이티브 | 무료 (OSS) | dbt 미사용 환경에 부적합 | 탈락 |
| **Great Expectations** | Python expectation 정의 | 무료 (OSS) | 대시보드 부재 | 보류 |

**Soda를 선택한 이유:**

Soda Core는 **SodaCL**(Soda Checks Language)이라는 YAML 기반 DSL로 체크를 선언합니다. 간단한 예시를 보겠습니다.

```yaml
# checks/indicator_block.yml
checks for {analytics_catalog}.analytics.indicator_block:
  - freshness(block_timestamp) < 2h:
      name: indicator_block_freshness
  - missing_count(value_ratio) = 0:
      name: value_ratio_no_nulls
  - min(realized_value) >= 0:
      name: realized_value_non_negative
```

테이블이 추가될 때 YAML 파일 하나 추가하면 됩니다. `freshness`, `missing_count`, `min/max` 같은 빌트인 메트릭을 조합해서 대부분의 체크를 커버할 수 있고, 커스텀 SQL 체크도 지원합니다.

Delta Lake, PostgreSQL, BigQuery 커넥터를 모두 공식 지원하므로 파이프라인의 세 소스를 하나의 도구로 커버할 수 있다는 점이 결정적이었습니다.

**탈락 사유 상세:**

- **Monte Carlo**: 자동 anomaly detection이 강점이지만 enterprise 가격대입니다. 2-3명 규모 팀에 수천 달러/월은 오버스펙입니다.
- **Metaplane**: 2024년 Datadog에 인수되었습니다. Snowflake 중심 설계이고 Delta Lake 지원이 제한적이며, 인수 후 로드맵이 불투명합니다.
- **Elementary**: dbt의 `test` 블록을 래핑하는 도구입니다. dbt를 사용하지 않는 환경에서는 도입 의미가 없습니다.
- **Great Expectations**: Python 코드로 expectation을 정의하는 방식은 유연하지만, 기본 대시보드가 없어서 별도 시각화 레이어가 필요합니다. 최종적으로 Soda + Databricks SQL Dashboard보다 구축 비용이 높습니다.

#### 2. 대시보드 도구

| 솔루션 | 특징 | 비용 | 탈락/선정 |
|--------|------|------|----------|
| **Databricks SQL Dashboard** | 이미 사용 중, Federation으로 3소스 통합 | DBU 과금만 | **선정** |
| **Metabase** | 가장 심플한 BI, PSQL 네이티브 | 무료(OSS) / Cloud $85/mo | 보류 |
| **Apache Superset** | 풍부한 차트, SQL Lab 지원 | 무료(OSS) | 보류 |
| **Streamlit on Databricks** | Python 기반, Databricks Apps 호스팅 | DBU 과금만 | 보류 |
| **Grafana** | 시계열 시각화 최강, 알림 내장 | 무료(OSS) + EC2 운영 | 보류 |

**Databricks SQL Dashboard를 선택한 이유:**

결정적인 이유는 **Lakehouse Federation**입니다. Databricks SQL Warehouse에서 PostgreSQL과 BigQuery를 외부 카탈로그로 연결하면, Delta 테이블과 동일한 SQL 문법으로 크로스 소스 쿼리가 가능합니다.

```sql
-- 1) PostgreSQL 연결 생성
CREATE CONNECTION psql_prod
TYPE POSTGRESQL
OPTIONS (
  host 'your-rds-endpoint',
  port '5432',
  user secret('scope', 'pg_user'),
  password secret('scope', 'pg_password')
);

-- 2) 외부 카탈로그 등록
CREATE FOREIGN CATALOG psql_foreign
USING CONNECTION psql_prod
OPTIONS (database 'metric');
```

`CREATE CONNECTION`으로 외부 데이터 소스 연결을 정의하고, `CREATE FOREIGN CATALOG`로 해당 연결을 Unity Catalog에 카탈로그로 등록합니다. 이후에는 `psql_foreign.schema.table` 형태로 일반 테이블처럼 접근할 수 있습니다.

설정 이후에는 하나의 SQL로 Delta와 PSQL 간 sync lag를 비교할 수 있습니다.

```sql
-- Delta와 PSQL 간 sync lag 확인
SELECT
  d.event_id AS delta_max,
  p.event_id AS psql_max,
  d.event_id - p.event_id AS lag
FROM (
  SELECT MAX(event_id) AS event_id
  FROM {analytics_catalog}.analytics.indicator_block
) d
CROSS JOIN (
  SELECT MAX(event_id) AS event_id
  FROM psql_foreign.analytics.indicator_block
) p;
```

인프라를 추가로 띄울 필요 없이, 이미 사용 중인 Databricks SQL Warehouse를 그대로 활용합니다.

Grafana가 시계열 시각화와 알림 기능 측면에서는 더 강력하지만, EC2 인스턴스를 별도로 운영해야 하고 Delta Lake 연결에 추가 설정(Databricks JDBC 드라이버 등)이 필요합니다. 현재 규모에서 운영 비용 대비 이득이 크지 않다고 판단했습니다.

#### 3. 카탈로그 + Lineage + 모니터링 통합 도구

| 솔루션 | 카탈로그 | Lineage | 모니터링 | 비용 | 선정 |
|--------|---------|---------|---------|------|------|
| **DataHub** | 강함 | 크로스플랫폼 | Smart Assertions (ML 기반) | OSS 무료 / Cloud 유료 | Phase 2 후보 |
| **OpenMetadata** | 강함 | 크로스플랫폼 | 내장 테스트 + 알림 | 완전 무료 (Apache 2.0) | Phase 2 후보 |

이 두 도구는 단순 모니터링을 넘어 **데이터 자산 전체를 관리**하는 플랫폼입니다. Delta, PSQL, BigQuery, StarRocks를 하나의 카탈로그에서 보고 lineage(데이터 흐름)를 추적할 수 있습니다.

지금 당장 선택하지 않은 이유는 세 가지입니다.

1. **현재 소스가 3개뿐**: Delta + PSQL + BQ 수준에서 카탈로그 플랫폼을 도입하면 오히려 관리 오버헤드가 커집니다.
2. **StarRocks 도입 미결정**: CelerData BYOC를 검토 중인데, 소스가 4개(+StarRocks)로 늘어나는 시점에 평가하는 것이 더 합리적입니다.
3. **Soda YAML 재사용 가능**: Phase 1에서 작성한 SodaCL 체크는 나중에 DataHub/OpenMetadata로 이관하더라도 문법이 유사하므로 재작성 비용이 낮습니다.

---

### 최종 결정: 단계적 접근

#### Phase 1 (즉시 적용) --- Soda Core + Databricks SQL Dashboard

```
[Databricks Job - 매 1시간]
  +-- Soda Delta 체크 (14개 block 테이블: gap, freshness, null, 음수)
  +-- Soda PSQL 체크 (sync lag, row count 일치)
  +-- Soda BQ 체크 (freshness, row count)
          |
          v
      결과 -> Slack 알림

[Databricks SQL Dashboard - 실시간]
  +-- 현재 max event_id per table
  +-- Delta <-> PSQL <-> BQ sync lag
  +-- 최근 24시간 freshness 히트맵
```

**알림 규칙:**

| 수준 | 조건 | 행동 |
|------|------|------|
| CRITICAL | gap 발생, sync lag > 100 블록 | 즉시 Slack @channel |
| WARNING | null 비율 > 0.1%, lag 10~100 블록 | 1시간 요약 메시지 |
| OK | 모든 체크 통과 | 무음 (silent) |

**이 조합을 선택한 근거:**

- **인프라 추가 없음**: Databricks Job + SQL Warehouse는 이미 있음
- **단일 도구로 3소스 커버**: Delta + PSQL + BQ 모두 Soda 커넥터 공식 지원
- **크로스 소스 쿼리**: Lakehouse Federation으로 SQL Dashboard에서 3소스 JOIN 가능
- **선형 확장**: 테이블 추가 시 YAML 파일 하나 추가로 끝

#### Phase 2 (StarRocks 도입 시) --- 카탈로그 플랫폼 전환

소스가 Delta + PSQL + BQ + StarRocks 4개로 늘어나는 시점에 DataHub 또는 OpenMetadata를 평가합니다.

- StarRocks는 MySQL 프로토콜이므로 두 도구 모두 즉시 호환
- Phase 1의 SodaCL YAML은 재사용 또는 이관 가능
- Lineage 시각화: S3 -> Bronze -> Silver -> Derived -> StarRocks -> API 흐름 추적

---

### Soda Core 설정 예시

실제 파이프라인에 적용할 체크 구성입니다.

#### SodaCL 체크 파일

```yaml
# checks/bitcoin_block_tables.yml

checks for {analytics_catalog}.analytics.events_block:
  - freshness(block_timestamp) < 3h:
      name: events_freshness
  - row_count > 0
  - missing_count(delta_value) = 0

checks for {analytics_catalog}.analytics.indicator_block:
  - freshness(block_timestamp) < 3h:
      name: indicator_freshness
  - min(realized_value) >= 0:
      name: realized_value_non_negative
  - min(value_ratio) >= 0

checks for {analytics_catalog}.analytics.network_block:
  - freshness(block_timestamp) < 3h
  - missing_count(hashrate) = 0
```

SodaCL의 `freshness` 체크는 지정한 타임스탬프 컬럼의 최신 값과 현재 시각의 차이를 계산합니다. `< 3h`는 "3시간 미만이어야 통과"를 의미합니다.

#### Python 프로그래매틱 스캔

```python
# Databricks Job cell
from soda.scan import Scan

scan = Scan()
scan.set_data_source_name("delta_lakehouse")
scan.add_configuration_yaml_file(file_path="config/datasources.yml")
scan.add_sodacl_yaml_file("checks/bitcoin_block_tables.yml")
scan.set_scan_definition_name("bitcoin_pipeline_hourly")
scan.execute()

# 결과 검사
if scan.has_check_fails():
    # 실패한 체크 목록 조회
    failed_checks = scan.get_checks_fail()
    notify_slack(failed_checks)

# 에러 로그 확인 (연결 실패 등 스캔 자체 오류)
if scan.has_error_logs():
    notify_slack_error(scan.get_error_logs_text())
```

`scan.has_check_fails()`는 데이터 품질 체크 실패 여부를, `scan.has_error_logs()`는 스캔 실행 자체의 오류(연결 실패 등)를 구분해서 확인합니다. 이 두 가지를 분리하면 "데이터에 문제가 있는 것"과 "모니터링 시스템에 문제가 있는 것"을 구분할 수 있습니다.

---

### 흔히 빠지는 함정과 팁

솔루션 비교 과정에서 얻은 교훈을 정리합니다.

1. **"가장 강력한 도구"의 함정**: Lakehouse Monitoring은 통계적 drift 감지에 강력하지만, gap/freshness 모니터링에는 핏이 맞지 않았습니다. 도구의 "기능 목록"이 아닌 "설계 철학"이 내 문제에 맞는지 먼저 확인하세요.

2. **Federation 연결 시 secret 사용**: `CREATE CONNECTION`에서 비밀번호를 직접 하드코딩하면 SQL 히스토리에 남습니다. 반드시 `secret('scope', 'key')` 형태로 Databricks Secret을 사용하세요.

3. **Soda Core vs Soda Cloud**: Soda Core(무료, OSS)만으로 체크 실행과 결과 확인이 가능합니다. Soda Cloud($300+/mo)는 웹 UI 대시보드와 이력 관리를 추가하는 것으로, 초기에는 Core만으로 충분합니다.

4. **SodaCL freshness의 전제**: `freshness` 체크가 정상 동작하려면 해당 컬럼에 현재 시각 기준의 "최신" 데이터가 있어야 합니다. 역사 데이터를 배치로 적재하는 초기화 단계에서는 의도치 않게 실패할 수 있으므로, 초기화와 증분 업데이트 단계를 구분해서 체크를 적용하는 것이 좋습니다.

---

### 정리

| 단계 | 도구 | 역할 |
|------|------|------|
| Phase 1 | Soda Core | gap / freshness / null / 음수 자동 체크 + Slack 알림 |
| Phase 1 | Databricks SQL Dashboard | 실시간 현황 + Lakehouse Federation 3소스 sync lag 시각화 |
| Phase 2 | DataHub 또는 OpenMetadata | 카탈로그 + lineage (StarRocks 도입 시 평가) |

Databricks Lakehouse Monitoring은 DW drift 감지에 특화되어 있어, 블록체인 ETL의 gap/freshness 모니터링 요구와 맞지 않았습니다. **도구 선택에서 중요한 것은 "얼마나 강력한가"보다 "내 문제에 맞는가"**입니다.

Soda Core의 SodaCL 선언적 방식은 테이블 수가 늘어도 YAML 파일 추가만으로 선형 확장되고, Phase 2에서 플랫폼을 교체하더라도 체크 로직을 재사용할 수 있다는 점이 장기적으로 유리합니다.

---

### Reference

- [Databricks Lakehouse Monitoring 공식 문서](https://docs.databricks.com/aws/en/lakehouse-monitoring/)
- [Soda Core 공식 문서 - Run a Scan](https://docs.soda.io/soda-library/run-a-scan)
- [SodaCL Checks Language](https://docs.soda.io/soda-cl/soda-cl-overview)
- [Databricks Lakehouse Federation 공식 문서](https://docs.databricks.com/aws/en/query-federation/)
- [Databricks Federated Queries SQL Reference](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-federated-queries)
- [DataHub 공식 문서](https://datahubproject.io/docs/)
- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- 관련 포스트: [21개 OLAP 솔루션 비교](../2026-03-04-olap-architecture-review-21-solutions-v2)
