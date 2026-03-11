---
layout: post
title: "[DataEngineering] Databricks 파이프라인 모니터링 솔루션 비교 — Lakehouse Monitoring 롤백부터 Soda+SQL Dashboard 선택까지"
categories:
  - DataEngineering
tags:
  - Databricks
  - DataQuality
  - Soda
  - DataHub
  - OpenMetadata
  - Grafana
  - LakehouseMonitoring
  - DeltaLake
  - Bitcoin
  - Monitoring
date: 2026-03-10
toc: true
toc_sticky: true
---

## 개요

Bitcoin on-chain 데이터 ETL 파이프라인을 운영하다 보면 block gap, PSQL ingestion SSL 끊김, CDF version 0 문제 같은 장애를 사후에야 알게 되는 상황이 반복됩니다. "왜 모니터링이 없지?"라는 자각 이후 Databricks Lakehouse Monitoring을 직접 시도했다가 전체 롤백하고, 결국 Soda Core + Databricks SQL Dashboard 조합을 선택하기까지의 과정을 정리합니다.

이 글에서 다루는 내용:

- Databricks Lakehouse Monitoring을 시도하고 롤백한 이유
- 데이터 품질 모니터링 전문 도구 5종 (Soda / Monte Carlo / Metaplane / Elementary / Great Expectations) 비교
- 대시보드 도구 4종 (Metabase / Superset / Streamlit / Grafana) 비교
- 카탈로그 + Lineage + 모니터링 통합 도구 2종 (DataHub / OpenMetadata) 비교
- Databricks SQL Federation으로 Delta + PSQL + BQ 통합 쿼리하는 방법
- 최종 Phase 1/2 설계

---

## 배경 — 무엇을 모니터링해야 하는가

파이프라인 구조는 다음과 같습니다.

```
S3 (raw blocks)
  → Bronze (DLT streaming / batch)
  → Silver (address_transfer, balance_diff, entity_flow)
  → Bitcoin (14+ block tables: utxo_*, network_*, indicator_*, exchange_inflow_*)
  → PSQL + BigQuery (API 서빙)
```

실제로 겪었던 문제들:

- **Block gap**: `spot_ohlcv_index_min` 가격 소스 누락 → downstream cascade. 블록 13개가 동시에 빠진 경우도 있었음
- **Snapshot skip**: 10K 블록 간격 snapshot을 놓치면 Process A/B 전체 재계산 필요
- **PSQL ingestion SSL 끊김**: JDBC 동시 연결 수 초과 → DB writer CPU 47%, 21 active sessions → SSL timeout
- **CDF version 0 문제**: `mode("overwrite").saveAsTable()` 후 ALTER TABLE로 CDF 활성화 → version 0에 CDF 데이터 없음 → `init=true` 실패
- **rollup start_ts 불일치**: window 경계로 truncate 안 하면 누적 집계가 어긋남

이 문제들의 공통점은 **장애가 발생하고 나서야 알게 된다**는 것입니다. 이상적으로는 다음을 자동으로 감지해야 합니다.

- 특정 block_height 범위가 비어 있는지 (gap)
- 마지막 갱신이 몇 시간 전인지 (freshness)
- PSQL/BQ sync가 얼마나 뒤처져 있는지 (lag)
- NULL, 음수, 이상 값이 생겼는지 (data quality)

---

## 시도 1: Databricks Lakehouse Monitoring — 그리고 전체 롤백

가장 먼저 시도한 것은 Databricks 네이티브 모니터링입니다.

### 시도 과정

처음에는 `databricks.lakehouse_monitoring` Python 모듈을 임포트하려 했지만 클러스터에 없었습니다. Databricks SDK의 `w.quality_monitors.create()`로 접근 방식을 바꿨습니다.

```python
# Databricks SDK 방식
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()
w.quality_monitors.create(
    table_name="tech_lakehouse_prod.bitcoin.indicator_block",
    assets_dir="/Shared/monitoring",
    output_schema_name="tech_lakehouse_prod.monitoring",
    # ...
)
```

14개 테이블 중 13개 모니터 생성에 성공했습니다. 그런데 실제로 살펴보니 문제가 있었습니다.

### 롤백 이유

Databricks Lakehouse Monitoring은 **DWH 테이블의 통계적 drift 감지**에 최적화된 도구입니다. 생성되는 산출물이 `profile_metrics`, `drift_metrics` 두 개의 메타 테이블인데, 저희가 원하는 것과 결이 다릅니다.

- **원하는 것**: "block 938,577이 빠져 있다", "PSQL이 3시간째 sync 안 됐다"
- **LM이 주는 것**: "이 컬럼의 평균이 지난 달 대비 12% 바뀌었다"

통계적 drift 감지는 ML feature 모니터링이나 DW 테이블 품질 추적에 유용하지만, 블록체인 ETL처럼 **연속적인 block_height 커버리지와 freshness**가 핵심인 파이프라인에는 핏이 맞지 않았습니다. 결국 13개 모니터를 모두 삭제하고 `profile_metrics`/`drift_metrics` 테이블도 DROP했습니다.

**교훈**: 도구가 "강력"해도 내 문제에 맞지 않으면 오히려 운영 부담만 늡니다.

---

## 솔루션 비교

롤백 이후 시장에 있는 도구들을 체계적으로 비교했습니다. 크게 세 가지 범주로 나눠서 평가했습니다.

### 1. 데이터 품질 모니터링 전문 도구

| 솔루션 | 접근 방식 | 비용 | 우리 환경 적합도 | 탈락/선정 |
|--------|----------|------|----------------|----------|
| **Soda** | SQL/YAML 선언적 체크 | Core 무료 / Cloud $300+/mo | Delta + PSQL + BQ 모두 지원 | **선정** |
| **Monte Carlo** | 자동 anomaly detection, ML 기반 | $$$$ (enterprise) | 기능 과잉 | 탈락 |
| **Metaplane** | Monte Carlo 경량판 | $$ (테이블당 과금) | Snowflake 중심 | 탈락 |
| **Elementary** | dbt 네이티브 | 무료(OSS) | dbt 미사용 | 탈락 |
| **Great Expectations** | Python expectation 정의 | 무료(OSS) | 대시보드 약함 | 보류 |

**Soda를 선택한 이유:**

Soda Core는 YAML로 체크를 선언합니다. 간단한 예시:

```yaml
# checks/indicator_block.yml
checks for tech_lakehouse_prod.bitcoin.indicator_block:
  - freshness(block_timestamp) < 2h:
      name: indicator_block_freshness
  - missing_count(mvrv) = 0:
      name: mvrv_no_nulls
  - min(realized_cap) >= 0:
      name: realized_cap_non_negative
```

테이블이 추가될 때 YAML 파일 하나 추가하면 됩니다. Delta Lake, PostgreSQL, BigQuery 커넥터를 모두 공식 지원하므로 우리 파이프라인의 세 소스를 하나의 도구로 커버할 수 있습니다.

**탈락 사유 상세:**

- **Monte Carlo**: 자동 anomaly detection이 강점이지만 enterprise 가격대. 팀 2-3명 규모에 오버스펙
- **Metaplane**: 2024년 Datadog에 인수됨. Snowflake 중심 설계이고 Delta Lake 지원이 제한적. 향후 로드맵 불투명
- **Elementary**: dbt의 `test` 블록을 래핑하는 도구. dbt를 안 쓰면 의미가 없음
- **Great Expectations**: Python 코드로 expectation을 정의하는 방식은 유연하지만, 기본 대시보드가 없어서 별도 시각화 레이어가 필요함. 결과적으로 Soda + Databricks SQL Dashboard보다 구축 비용이 높음

### 2. 대시보드 도구

| 솔루션 | 특징 | 비용 | 탈락/선정 |
|--------|------|------|----------|
| **Databricks SQL Dashboard** | 이미 있음, Federation으로 3소스 | DBU만 | **선정** |
| **Metabase** | 가장 심플, PSQL 네이티브 | 무료(OSS) / Cloud $85/mo | 보류 |
| **Apache Superset** | 강력, SQL Lab 지원 | 무료(OSS) | 보류 |
| **Streamlit on Databricks** | Python, Databricks Apps 호스팅 | DBU만 | 보류 |
| **Grafana** | 시각화 최강, 시계열 특화 | 무료(OSS) + EC2 | 보류 |

**Databricks SQL Dashboard를 선택한 이유:**

결정적인 이유는 **Lakehouse Federation**입니다. Databricks SQL Warehouse에서 PSQL과 BigQuery를 외부 카탈로그로 연결하면 Delta 테이블과 동일한 SQL로 크로스 쿼리가 가능합니다.

```sql
-- Lakehouse Federation 설정
CREATE CONNECTION psql_prod
TYPE POSTGRESQL
OPTIONS (
  host 'your-rds-endpoint',
  port '5432',
  user secret('scope', 'key'),
  password secret('scope', 'key')
);

CREATE FOREIGN CATALOG psql_foreign
USING CONNECTION psql_prod
OPTIONS (database 'metric');
```

설정 이후에는 하나의 SQL로 Delta ↔ PSQL ↔ BQ sync lag를 비교할 수 있습니다.

```sql
-- Delta와 PSQL 간 sync lag 확인
SELECT
  d.block_height AS delta_max,
  p.block_height AS psql_max,
  d.block_height - p.block_height AS lag
FROM (
  SELECT MAX(block_height) AS block_height
  FROM tech_lakehouse_prod.bitcoin.indicator_block
) d
CROSS JOIN (
  SELECT MAX(block_height) AS block_height
  FROM psql_foreign.bitcoin.indicator_block
) p;
```

인프라를 추가로 띄울 필요 없이, 이미 있는 Databricks SQL을 그대로 씁니다.

Grafana가 시각화 측면에서는 더 강력하지만, EC2 인스턴스를 별도로 운영해야 하고 Delta Lake 연결에 추가 설정이 필요합니다. 현재 규모에서 운영 비용 대비 이득이 크지 않습니다.

### 3. 카탈로그 + Lineage + 모니터링 통합 도구

| 솔루션 | 카탈로그 | Lineage | 모니터링 | 비용 | 탈락/선정 |
|--------|---------|---------|---------|------|----------|
| **DataHub** | 강함 | 크로스플랫폼 | Smart Assertions (ML 기반) | OSS 무료 / Cloud $$$ | Phase 2 후보 |
| **OpenMetadata** | 강함 | 크로스플랫폼 | 내장 테스트 + 알림 | 완전 무료 (Apache 2.0) | Phase 2 후보 |

이 두 도구는 단순 모니터링을 넘어 **데이터 자산 전체를 관리**하는 플랫폼입니다. Delta, PSQL, BigQuery, StarRocks를 하나의 카탈로그에서 보고 lineage(데이터 흐름)를 추적할 수 있습니다.

지금 당장 선택하지 않은 이유는 세 가지입니다.

1. **현재 소스가 3개**: Delta + PSQL + BQ. 이 수준에서 카탈로그 플랫폼을 도입하면 오히려 관리 오버헤드가 커집니다
2. **StarRocks 도입 미결정**: CelerData BYOC를 검토 중인데, 소스가 4개(+StarRocks)로 늘어나는 시점에 평가하는 게 더 합리적입니다
3. **Soda YAML 재사용 가능**: Phase 1에서 작성한 Soda 체크는 나중에 DataHub/OpenMetadata로 이관해도 문법이 유사합니다

---

## 최종 결정: 단계적 접근

### Phase 1 (즉시 적용)

**Soda Core + Databricks SQL Dashboard**

```
[Databricks Job - 매 1시간]
  ├── Soda Delta 체크 (14개 block 테이블: gap, freshness, null, 음수)
  ├── Soda PSQL 체크 (sync lag, row count 일치)
  └── Soda BQ 체크 (freshness, row count)
          ↓
      결과 → Slack 알림

[Databricks SQL Dashboard - 실시간]
  ├── 현재 max block_height per table
  ├── Delta ↔ PSQL ↔ BQ sync lag
  └── 최근 24시간 freshness 히트맵
```

**알림 규칙:**

| 수준 | 조건 | 행동 |
|------|------|------|
| CRITICAL | gap 발생, sync lag > 100 블록 | 즉시 Slack @channel |
| WARNING | null 비율 > 0.1%, lag 10~100 블록 | 1시간 요약 메시지 |
| OK | 모든 체크 통과 | 무음 |

**선택 이유 요약:**

- 인프라 추가 없음 (Databricks Job + Databricks SQL은 이미 있음)
- Delta + PSQL + BQ 모두 Soda 커넥터로 단일 도구 커버
- Lakehouse Federation으로 SQL Dashboard에서 3소스 크로스 쿼리
- YAML 선언적이라 테이블 추가 시 파일 하나 추가로 확장 가능

### Phase 2 (StarRocks 도입 시)

소스가 Delta + PSQL + BQ + StarRocks 4개로 늘어나는 시점에 DataHub 또는 OpenMetadata를 평가합니다.

- StarRocks는 MySQL 프로토콜이므로 두 도구 모두 즉시 호환
- Phase 1의 Soda YAML은 재사용 또는 이관 가능
- lineage: S3 → Bronze → Silver → Bitcoin → StarRocks → API 흐름 시각화

---

## Soda Core 설정 예시

실제 파이프라인에 적용할 체크 구성입니다.

```yaml
# checks/bitcoin_block_tables.yml

checks for tech_lakehouse_prod.bitcoin.utxo_events_block:
  - freshness(block_timestamp) < 3h:
      name: utxo_events_freshness
  - row_count > 0
  - missing_count(delta_value) = 0

checks for tech_lakehouse_prod.bitcoin.indicator_block:
  - freshness(block_timestamp) < 3h:
      name: indicator_freshness
  - min(realized_cap) >= 0:
      name: realized_cap_non_negative
  - min(mvrv) >= 0

checks for tech_lakehouse_prod.bitcoin.network_block:
  - freshness(block_timestamp) < 3h
  - missing_count(hashrate) = 0
```

```python
# Databricks Job cell
from soda.scan import Scan

scan = Scan()
scan.set_data_source_name("delta_lakehouse")
scan.add_configuration_yaml_file("config/datasources.yml")
scan.add_sodacl_yaml_file("checks/bitcoin_block_tables.yml")
scan.execute()

if scan.has_check_fails():
    # Slack webhook 호출
    notify_slack(scan.get_checks_fail())
```

---

## 정리

| 단계 | 도구 | 역할 |
|------|------|------|
| Phase 1 | Soda Core | gap / freshness / null / 음수 자동 체크 + Slack 알림 |
| Phase 1 | Databricks SQL Dashboard | 실시간 현황 + 3소스 sync lag 시각화 |
| Phase 2 | DataHub 또는 OpenMetadata | 카탈로그 + lineage (StarRocks 도입 시 평가) |

Databricks Lakehouse Monitoring은 강력하지만 DW drift 감지에 특화되어 있어, 블록체인 ETL의 gap/freshness 모니터링 요구와 맞지 않았습니다. 도구 선택에서 중요한 것은 "얼마나 강력한가"보다 "내 문제에 맞는가"입니다.

Soda Core의 YAML 선언적 방식은 테이블 수가 늘어도 선형적으로 확장되고, Phase 2에서 플랫폼을 교체하더라도 체크 로직을 재사용할 수 있다는 점이 장기적으로 유리합니다.

---

## Reference

- [Databricks Lakehouse Monitoring 공식 문서](https://docs.databricks.com/aws/en/lakehouse-monitoring/)
- [Soda Core 공식 문서](https://docs.soda.io/soda-core/overview-main.html)
- [Databricks Lakehouse Federation 공식 문서](https://docs.databricks.com/aws/en/query-federation/)
- [DataHub 공식 문서](https://datahubproject.io/docs/)
- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- 관련 포스트: [21개 OLAP 솔루션 비교](../2026-03-04-olap-architecture-review-21-solutions-v2)
