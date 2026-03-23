---
title: "[DataEngineering] Databricks Data Quality Monitoring 솔루션 7종 비교 — 2025년 10월 리뉴얼 이후 달라진 것들"
categories:
  - DataEngineering
tags:
  - Databricks
  - DataQuality
  - Soda
  - GreatExpectations
  - DataHub
  - OpenMetadata
  - DeltaLake
date: 2026-03-10
---

### 개요

Databricks + Unity Catalog 기반 ETL 파이프라인(Delta Lake 다수 테이블, PSQL/BQ sync)에 데이터 품질 모니터링을 붙이는 과정에서 7개 솔루션을 비교했습니다. 특히 Databricks의 모니터링 제품이 2025년 10월에 이름과 설계 모두 크게 바뀌었기 때문에, 예전 정보로 검토했다면 틀린 판단을 내릴 수 있습니다.

이 글은 직접 설치하고 부딪힌 오류(Soda opentelemetry 충돌, Lakehouse Federation NCC 설정 등)를 포함한 실전 비교입니다.

**대상 독자:** Databricks 기반 파이프라인에 데이터 품질 모니터링 도입을 검토 중인 엔지니어. DE 2-3명 소규모 팀, 시간 단위 모니터링 필요.

**이 글을 읽고 나면:**
- Databricks DQ Monitoring이 리뉴얼 전후로 어떻게 달라졌는지 파악할 수 있습니다.
- 7개 솔루션 각각의 강점과 한계를 비교해 자신의 환경에 맞는 조합을 선택할 수 있습니다.
- Soda opentelemetry 충돌, Lakehouse Federation NCC 설정 등 실제 도입 시 만나는 문제의 원인과 대처법을 알 수 있습니다.

---

### 배경 -- 무엇을 모니터링해야 하는가

일반적인 파이프라인 구조는 다음과 같습니다.

```
S3 (raw data)
  -> Bronze (DLT streaming / batch)
    -> Silver (가공/조인)
      -> Gold (다수 분석 테이블)
        -> PSQL + BigQuery (API 서빙)
```

실제로 겪은 문제들을 정리하면 네 가지 유형으로 나뉩니다.

| 유형 | 구체적 사례 | 영향 |
|------|-----------|------|
| **Gap 감지** | 소스 데이터 누락으로 downstream cascade drop | 연쇄적 데이터 손실 |
| **Freshness 감지** | job 실패 시 수 시간째 갱신 안 된 테이블 | 사후에만 인지, 대응 지연 |
| **Sync lag 감지** | PSQL/BQ sync가 Delta 대비 뒤처짐 | API가 stale 데이터 서빙 |
| **Data quality 감지** | NULL, 음수, 이상 값 | 잘못된 지표가 API까지 전파 |

이 네 가지를 1시간 주기로 자동 감지하는 것이 목표입니다.

---

### 비교한 솔루션 7종

#### 1. Databricks Data Quality Monitoring (구 Lakehouse Monitoring)

2025년 10월 완전 리뉴얼되면서 이름이 바뀌고 설계도 달라졌습니다. 예전 자료와 혼동하지 않도록 주의가 필요합니다.

**바뀐 것:**

| 항목 | 이전 (Lakehouse Monitoring) | 이후 (Data Quality Monitoring) |
|------|--------------------------|-------------------------------|
| 설정 단위 | 테이블별 개별 설정 | 스키마 단위 1-click 활성화 |
| 비용 | 스토리지/컴퓨트 과금 | DBU 과금 (별도 인프라 비용은 없음) |
| 스캔 주기 | 수동 설정 | 테이블 업데이트 빈도에 맞게 자동 조정 |
| 제공 체크 | 통계적 drift (profile/drift 메트릭) | freshness + completeness (anomaly detection) |

> **비용에 대한 보충:** 리뉴얼 이후 "추가 비용 없음"이라고 소개되는 경우가 있지만, `system.billing.usage` 테이블에서 `billing_origin_product = 'DATA_QUALITY_MONITORING'`으로 DBU 소비가 기록됩니다. 별도 인프라 비용은 없지만 DBU 과금은 발생하므로, 대규모 스키마에서는 비용을 모니터링할 필요가 있습니다.

**활성화 방법:**

Unity Catalog에서 스키마로 이동한 뒤 **Details** 탭에서 **Enable**을 클릭하면 됩니다. 각 테이블의 업데이트 빈도에 맞춰 자동으로 스캔 주기가 조정됩니다.

```sql
-- 모니터링 결과 확인: system table에서 직접 쿼리 가능
SELECT
  DATE_TRUNC('HOUR', event_time) AS evaluated_at,
  CONCAT(catalog_name, '.', schema_name, '.', table_name) AS full_table_name,
  status,
  MAX(freshness.commit_freshness.predicted_value) AS commit_expected,
  MAX(freshness.commit_freshness.last_value) AS commit_actual,
  MAX(completeness.daily_row_count.min_predicted_value) AS completeness_expected,
  MAX(completeness.daily_row_count.last_value) AS completeness_actual
FROM system.data_quality_monitoring.table_results
WHERE evaluated_at >= current_timestamp() - INTERVAL 6 HOURS
  AND status = 'Unhealthy'
GROUP BY ALL;
```

**장점:**
- Unity Catalog 네이티브, 스키마 단위 1-click 활성화
- ML 기반 anomaly detection으로 과거 패턴 학습 후 이상 탐지
- 별도 인프라, 의존성 없음

**한계:**
- 커스텀 체크 불가: gap count, cross-source sync lag, 특정 컬럼 음수 여부 등을 체크하려면 다른 도구 필요
- 뷰(View), 외부 테이블 미지원
- snapshot 테이블 상태 감지 불가

핵심 요구사항인 "데이터 gap 감지"와 "cross-source sync lag"는 Databricks DQ가 커버하지 못합니다. 그래서 단독으로는 부족하고 반드시 SQL 보완이 필요합니다.

#### 2. Soda

Core(오픈소스 무료)와 Cloud(유료 SaaS)로 구분됩니다.

**Soda Core:**
- Spark DataFrame 커넥터: `pip install soda-sparkdf` (구 패키지명 `soda-core-spark-df`에서 변경됨)
- SodaCL(Soda Checks Language)이라는 YAML DSL로 체크 선언
- Delta Lake, PostgreSQL, BigQuery 커넥터 공식 지원

> **패키지명 변경 주의:** Soda가 버전 업데이트를 거치면서 패키지 구조가 바뀌었습니다. 최신 버전은 `soda-sparkdf`이며, `soda_core.contracts`와 `SparkDataFrameDataSource` 클래스를 사용합니다. 구 버전(`soda-core-spark-df`)의 `soda.scan.Scan` 기반 API도 아직 동작하지만, 신규 도입 시에는 최신 API 사용을 권장합니다.

```python
# 최신 API (soda-sparkdf, Contract 기반)
from soda_core.contracts import verify_contract_locally
from soda_sparkdf import SparkDataFrameDataSource

spark_data_source = SparkDataFrameDataSource.from_existing_session(
    session=spark,
    name="my_sparkdf"
)

result = verify_contract_locally(
    data_sources=[spark_data_source],
    contract_file_path="./my_table.yaml",
)

if result.is_ok:
    print("Contract verification passed.")
else:
    print("Contract verification failed:")
    print(result.get_errors_str())
```

```python
# Legacy API (soda-core-spark-df, Scan 기반) -- 기존 코드에서 여전히 동작
from soda.scan import Scan

df.createOrReplaceTempView("my_table")

scan = Scan()
scan.set_scan_definition_name("my_check")
scan.set_data_source_name("my_source")
scan.add_spark_session(spark, data_source_name="my_source")

checks = """
checks for my_table:
  - row_count > 0
  - missing_count(important_col) = 0
  - min(metric_col) >= 0
"""
scan.add_sodacl_yaml_str(checks)
scan.execute()
print(scan.get_logs_text())
```

**Soda Cloud:**
<!-- TODO: verify -- Soda Cloud 가격 정보는 공식 문서에서 확인 불가. 아래는 2025년 기준 공개 정보이며 변경되었을 수 있음 -->
- Free 플랜: 제한된 dataset까지 무료
- 유료 플랜: dataset 수 기준 과금 (정확한 가격은 [공식 사이트](https://www.soda.io/pricing)에서 확인 필요)
- anomaly detection, 이력 추적, Slack/PagerDuty 알림 내장

**실제 설치 시 부딪힌 문제 -- opentelemetry 충돌:**

Databricks 클러스터에서 Soda를 설치하면 opentelemetry 버전 충돌이 발생할 수 있습니다.

```
ImportError: cannot import name '_ExtendedAttributes' from 'opentelemetry.util.types'
```

이 에러는 Databricks 클러스터(DBR 15.x)에 사전 설치된 opentelemetry 버전과 Soda가 의존하는 버전이 충돌하기 때문입니다. Databricks 런타임이 내부적으로 opentelemetry를 사용하고 있어, Soda가 요구하는 버전으로 강제 업그레이드하면 런타임 자체가 불안정해질 수 있습니다.

**해결 방법:**

```bash
# 클러스터 init script 또는 노트북 상단에서 버전 고정
%pip install soda-sparkdf opentelemetry-api==1.x.x opentelemetry-sdk==1.x.x
# (x.x는 Soda 요구 버전과 DBR 호환 버전의 교집합으로 설정)
```

해결 자체는 가능하지만, 클러스터 업그레이드(DBR 버전 변경) 때마다 호환 버전을 재확인해야 하는 관리 부담이 생깁니다.

#### 3. Great Expectations (GX)

Python 코드로 "expectation"을 정의하는 방식입니다. 최근 버전(GX Core 1.x)에서 API가 크게 바뀌었으므로, 예전 자료를 참고할 때 주의가 필요합니다.

```python
# GX Core 1.x -- 현재 API (클래스 기반)
import great_expectations as gx
import great_expectations.expectations as gxe

context = gx.get_context()

# Expectation 정의
expectation = gxe.ExpectColumnValuesToNotBeNull(column="important_col")
expectation_range = gxe.ExpectColumnValuesToBeBetween(
    column="metric_col", min_value=0
)

# Batch에 대해 검증 실행
validation_result = batch.validate(expectation)
```

```python
# 구 API (0.x) -- 더 이상 권장하지 않음
# expect_column_values_to_not_be_null("important_col")
# expect_column_values_to_be_between("metric_col", min_value=0)
```

**장점:** Python 기반이라 유연성 최고, Spark DataFrame 직접 지원

**단점:**
- Soda보다 설정이 무겁고 보일러플레이트 코드가 많음 (Data Context, Data Source, Data Asset, Batch Definition 순서로 설정)
- 기본 대시보드가 없어 이력 추적을 직접 구축해야 함 (GX Cloud 유료 서비스는 제공)
- Databricks 환경에서 opentelemetry 충돌 가능성 동일하게 존재

#### 4. Elementary

dbt의 `test` 블록을 확장하는 데이터 관측성 도구입니다.

**탈락 사유:** dbt를 사용하지 않는 환경에서는 도입 의미가 없습니다. 이 파이프라인은 PySpark 노트북 기반이므로 해당 없음.

#### 5. DataHub

LinkedIn에서 시작한 오픈소스 메타데이터 플랫폼으로, 데이터 카탈로그 + lineage + 데이터 품질 관측성을 통합 제공합니다.

**데이터 품질 기능:**
- Assertion 기반 체크: Freshness, Volume(row count), Custom SQL, Column, Schema 등 다양한 assertion 타입
- YAML 선언적 정의 또는 GraphQL API/Python SDK로 프로그래밍 방식 정의 가능
- cron 스케줄링 또는 테이블 변경 시 자동 실행

```yaml
# DataHub Open Assertions Spec (YAML 선언적)
version: 1
assertions:
  - entity: urn:li:dataset:(urn:li:dataPlatform:spark,my_catalog.my_schema.orders,PROD)
    type: volume
    metric: "row_count"
    condition:
      type: between
      min: 1000
      max: 10000000
    schedule:
      type: on_table_change
  - entity: urn:li:dataset:(urn:li:dataPlatform:spark,my_catalog.my_schema.orders,PROD)
    type: sql
    statement: |
      SELECT COUNT(*) FROM my_schema.orders
      - (SELECT COUNT(*) FROM my_schema.order_details) AS diff
    condition:
      type: equal_to
      value: 0
    schedule:
      type: interval
      interval: "6 hours"
```

```python
# DataHub Python SDK로 Custom SQL Assertion 생성
from datahub.sdk import DataHubClient

client = DataHubClient(server="<server>", token="<token>")

sql_assertion = client.assertions.sync_sql_assertion(
    dataset_urn="urn:li:dataset:(...)",
    display_name="Row Count Gap Check",
    statement="SELECT COUNT(*) FROM gap_detection_query",
    criteria_condition="IS_EQUAL_TO",
    criteria_parameters=0,
    schedule="0 */1 * * *",  # 매 1시간
    enabled=True
)
```

**장점:**
- 카탈로그 + lineage + 데이터 품질을 하나의 플랫폼에서 통합 관리
- Custom SQL assertion으로 gap 감지, cross-source 비교 등 커스텀 체크 가능
- Slack/PagerDuty/email 알림 내장
- Spark, PostgreSQL, BigQuery 등 다양한 데이터 소스 커넥터 제공
- 가장 성숙한 오픈소스 메타데이터 플랫폼 (CNCF 인큐베이팅)

**한계:**
- Docker 기반 자체 호스팅 필수 (Kafka, Elasticsearch, MySQL/PostgreSQL 등 컴포넌트 다수)
- 인프라 운영 부담이 큼: DE 2-3명 소규모 팀에서 DataHub 자체를 관리하는 것이 오버헤드
- 데이터 품질 *만* 필요하다면 오버스펙 — 카탈로그/lineage까지 필요할 때 가치가 생김
- Managed DataHub(Acryl Data)는 유료 SaaS

#### 6. OpenMetadata

Apache 2.0 라이선스의 메타데이터 플랫폼으로, DataHub과 유사하게 카탈로그 + lineage + 데이터 품질을 제공합니다.

**데이터 품질 기능:**
- **No-code 테스트 정의**: UI에서 클릭으로 테스트 케이스 생성 가능
- 내장 테스트 타입: `column_values_to_be_not_null`, `column_values_to_be_between`, `table_row_count_to_be_between` 등
- Test Suite로 그룹화하여 관리, 결과를 인터랙티브 대시보드에서 확인
- Profiler: 테이블/컬럼 레벨 자동 프로파일링 (통계, 분포, 샘플 데이터)

```yaml
# OpenMetadata Profiler YAML 설정
source:
  type: databricks
  serviceName: my_lakehouse
  sourceConfig:
    config:
      type: Profiler
      generateSampleData: true
      schemaFilterPattern:
        includes:
          - my_schema
      tableFilterPattern:
        includes:
          - orders
          - customers

processor:
  type: "orm-profiler"
  config:
    tableConfig:
      - fullyQualifiedName: my_lakehouse.my_schema.orders
        profileSample: 100
```

**장점:**
- UI가 모던하고 직관적, API-first 설계
- No-code 테스트 생성으로 비개발자도 품질 체크 정의 가능
- Apache 2.0 라이선스 (완전 무료)
- Databricks, PostgreSQL, BigQuery 커넥터 공식 지원

**한계:**
- DataHub과 동일하게 Docker 자체 호스팅 필요 (Elasticsearch, Airflow 등 의존성)
- DataHub 대비 커뮤니티 규모가 작고, 생태계 성숙도가 낮음
- 데이터 품질만을 위해 도입하기에는 역시 오버스펙

#### 7. 순수 SQL/PySpark

별도 도구 없이 노트북에서 직접 체크 쿼리를 작성하는 방식입니다.

```sql
-- gap 감지 예시: 연속 ID에 빈 구간이 있는지 확인
SELECT
  id + 1 AS gap_start,
  next_id - 1 AS gap_end,
  next_id - id - 1 AS gap_size
FROM (
  SELECT
    id,
    LEAD(id) OVER (ORDER BY id) AS next_id
  FROM my_catalog.my_schema.my_table
  WHERE id >= 900000
)
WHERE next_id - id > 1;
```

```sql
-- cross-source sync lag 감지 예시: Delta vs PSQL 최신 ID 비교 (JDBC)
SELECT
  delta_max - psql_max AS sync_lag,
  CASE WHEN delta_max - psql_max > 100 THEN 'ALERT' ELSE 'OK' END AS status
FROM (
  SELECT MAX(id) AS delta_max
  FROM my_catalog.my_schema.my_table
) delta
CROSS JOIN (
  SELECT MAX(id) AS psql_max
  FROM psql_foreign.my_schema.my_table  -- Lakehouse Federation 또는 JDBC
) psql;
```

**장점:** 의존성 0, 추가 비용 0, 완전한 커스텀 체크 가능, Databricks SQL Alert와 바로 연동

**단점:** anomaly detection 없음, 이력 추적을 직접 구현해야 함, 알림 연동도 직접 작성

---

### 종합 비교표

| | Databricks DQ | Soda Core | Soda Cloud | GX | Elementary | DataHub | OpenMetadata | 순수 SQL |
|---|---|---|---|---|---|---|---|---|
| **본질** | DQ 모니터링 | 체크 엔진 | 체크+관측성 SaaS | 체크 엔진 | dbt 관측성 | 카탈로그+관측성 | 카탈로그+관측성 | 직접 작성 |
| **설정 방식** | UI 1-click | pip+YAML | pip+YAML+SaaS | pip+Python | dbt 필수 | Docker+YAML/API | Docker+UI/YAML | 노트북 |
| **anomaly detection** | O (ML) | X | O | X | O | X | X | X |
| **카탈로그/lineage** | Unity Catalog | X | X | X | X | O (풀스택) | O (풀스택) | X |
| **자동 프로파일링** | O | X | O | X | O | X | O | X |
| **이력 추적** | O (system table) | X | O | 직접 구축 | O | O | O | 직접 구축 |
| **Slack 알림** | SQL Alert | 직접 구현 | 내장 | X | Slack | 내장 | 내장 | 직접 구현 |
| **커스텀 체크** | X | O (YAML) | O (YAML) | O (Python) | O (dbt) | O (SQL/YAML) | O (no-code/API) | O (자유) |
| **cross-source 비교** | X | O | O | O | X | O | O | O |
| **인프라 추가** | 없음 | pip install | 없음(SaaS) | pip install | dbt 필수 | Docker (Kafka+ES+DB) | Docker (ES+Airflow) | 없음 |
| **Delta Lake** | O (네이티브) | O (Spark DF) | O (Spark DF) | O (Spark DF) | O (dbt) | O (Spark 커넥터) | O (Databricks 커넥터) | O (네이티브) |
| **PostgreSQL** | X | O (커넥터) | O (커넥터) | O (커넥터) | O (dbt) | O (커넥터) | O (커넥터) | O (Federation/JDBC) |
| **BigQuery** | X | O (커넥터) | O (커넥터) | O (커넥터) | O (dbt) | O (커넥터) | O (커넥터) | O (Federation) |
| **StarRocks** | X | O (MySQL 호환) | O (MySQL 호환) | O (MySQL 커넥터) | X | O (MySQL 호환) | O (MySQL 호환) | O (JDBC) |
| **비용** | DBU 과금 | 무료 | 유료 | 무료 | OSS 무료 | OSS 무료/Managed$$$ | 무료(Apache2.0) | 무료 |

---

### 추가로 검토한 것들

#### Lakehouse Federation으로 PSQL 연결하기

Databricks SQL Dashboard에서 PSQL에 접근하려면 Lakehouse Federation을 사용할 수 있습니다.

```sql
-- 1. Connection 생성 (secret scope 사용 권장)
CREATE CONNECTION psql_prod
TYPE POSTGRESQL
OPTIONS (
  host secret('scope', 'pg_host'),
  port '5432',
  user secret('scope', 'pg_user'),
  password secret('scope', 'pg_password')
);

-- 2. Foreign Catalog 생성
CREATE FOREIGN CATALOG psql_foreign
USING CONNECTION psql_prod
OPTIONS (database 'metric');
```

설정 후에는 `psql_foreign.my_schema.my_table` 형태로 Delta 테이블과 동일한 SQL 문법으로 접근 가능합니다.

**현실적인 문제 -- NCC(Network Connectivity Configuration):**

SQL Warehouse(Serverless)에서 외부 PSQL에 접근하려면 네트워크 경로를 열어야 합니다. 이를 위해 필요한 인프라 설정은 다음과 같습니다.

```
[필요한 인프라 설정 -- 7단계]
1. AWS NLB (Network Load Balancer) 생성 -- RDS 앞단
2. VPC Endpoint Service 생성 -- NLB를 서비스로 노출
3. Databricks NCC (Network Connectivity Configuration) 생성
4. NCC에 VPC Endpoint Service ARN 등록
5. VPC Endpoint Service에서 Databricks 연결 승인
6. NCC를 Databricks Workspace에 연결
7. Connection/Foreign Catalog 생성 (위 SQL)
```

PSQL sync lag 체크 하나를 위해 NLB + VPC Endpoint Service + NCC를 모두 설정하는 것은 소규모 팀에게 과도한 인프라 투자입니다. 기존 범용 클러스터(existing_cluster_id)에서 JDBC로 직접 접근하는 방식이 현실적입니다.

> **클러스터 vs SQL Warehouse:** 이미 범용 클러스터가 있고 VPC 내에서 RDS에 접근 가능하다면, 그 클러스터에서 JDBC로 PSQL에 접근하는 것이 NCC 설정 없이 가장 간단합니다.

---

### 최종 결론

#### 1순위: Databricks DQ + 순수 SQL 보완

Databricks DQ가 자동으로 커버하는 것과 못하는 것을 분리하고, 각각에 적합한 도구를 배치합니다.

```
[Databricks DQ -- 자동]
  freshness 이상 감지 (commit 주기 기반 ML anomaly detection)
  completeness 이상 감지 (daily row count 패턴 학습)
  결과 조회: system.data_quality_monitoring.table_results

[순수 SQL 노트북 -- 1시간 주기 보완]
  데이터 gap 감지 (LEAD window function)
  PSQL/BQ sync lag (JDBC 직접 연결로 MAX(id) 비교)
  snapshot 상태 확인
  음수 값, 이상 범위 커스텀 체크
  결과 저장: Delta 테이블 → Databricks SQL Dashboard
```

**이 조합이 적합한 이유:** 소규모 팀(2-3명)에서 추가 인프라와 의존성 없이 시작할 수 있습니다. Databricks DQ가 통계적 이상을 자동으로 잡아주고, 못하는 부분만 SQL로 보완하면 충분합니다.

#### 2순위: Soda Cloud (커스텀 체크가 체계적으로 많아질 때)

커스텀 체크가 수십 개로 늘어나고 팀 간 공유가 필요해지면 Soda Cloud를 검토합니다. 하지만 Databricks DQ가 이미 anomaly detection을 제공하므로 추가 가치가 제한적입니다. opentelemetry 의존성 충돌 이슈도 관리 부담으로 남습니다.

#### 3순위: DataHub / OpenMetadata (카탈로그+lineage가 필요해질 때)

데이터 소스가 늘어나고(StarRocks 도입 등) 크로스 플랫폼 lineage, 메타데이터 카탈로그가 필요해지면 검토합니다. 두 플랫폼 모두 데이터 품질 체크 기능을 내장하고 있어, 카탈로그와 품질 모니터링을 하나의 플랫폼에서 통합 관리할 수 있습니다.

- **DataHub**: 가장 성숙한 OSS 메타데이터 플랫폼 (CNCF 인큐베이팅). Custom SQL assertion이 강력하고 YAML 선언적 정의 지원. 단, Kafka+Elasticsearch+DB 등 컴포넌트가 많아 운영 부담이 큼
- **OpenMetadata**: Apache 2.0, 모던 UI, no-code 테스트 생성. DataHub 대비 커뮤니티가 작지만 API-first 설계가 깔끔함

현재는 카탈로그/lineage 없이 품질 모니터링만 필요하므로 Phase 2로 미룸.

#### 탈락

- **Elementary**: dbt 없으므로 불가
- **Great Expectations**: Soda보다 설정이 무겁고(Data Context/Source/Asset/Batch 4단계), 동일한 의존성 문제가 있으며, 기본 대시보드 부재
- **Monte Carlo/Metaplane**: 가격 과잉 (소규모 팀 기준). Metaplane은 Datadog 인수 후 로드맵 불투명
- **DataHub/OpenMetadata (현 시점)**: 데이터 품질만 필요한데 카탈로그 플랫폼 전체를 Docker로 운영하는 것은 DE 2-3명 팀에 과도한 인프라 부담. 카탈로그+lineage 필요 시점에 재검토

---

### 도입 시 주의할 점

#### 1. Databricks DQ와 구 Lakehouse Monitoring을 혼동하지 말 것

2025년 10월 이전 자료를 보면 "무겁다", "핏 안 맞다"는 평가가 많습니다. 리뉴얼 이후에는 스키마 단위 1-click 활성화, ML 기반 자동 anomaly detection으로 완전히 달라졌습니다. 예전 블로그 포스트나 문서를 그대로 참고하면 틀린 판단을 내릴 수 있습니다.

#### 2. Databricks DQ의 DBU 비용 확인

"추가 비용 없음"이라는 표현은 별도 라이선스나 인프라를 말하는 것이며, 스캔에 소비되는 DBU는 과금됩니다. `system.billing.usage`에서 `billing_origin_product = 'DATA_QUALITY_MONITORING'`으로 필터링하면 실제 소비량을 확인할 수 있습니다.

#### 3. Soda 설치 시 opentelemetry 버전 고정 필요

Databricks 클러스터(DBR 15.x 기준)에서 Soda를 사용하려면 클러스터 init script 또는 `%pip install` 시점에서 opentelemetry 버전을 명시적으로 고정해야 합니다. 클러스터 DBR 버전 업그레이드 시 반드시 재확인이 필요합니다.

#### 4. Soda 패키지명 변경에 주의

구 패키지(`soda-core-spark-df`)에서 신규 패키지(`soda-sparkdf`)로 이름이 바뀌었습니다. 구 패키지로 설치하면 deprecation 경고가 나오거나 최신 기능을 사용할 수 없습니다.

#### 5. Great Expectations API 변경에 주의

GX 0.x의 메서드 체이닝 API(`expect_column_values_to_not_be_null("col")`)는 GX Core 1.x에서 클래스 기반 API(`gxe.ExpectColumnValuesToNotBeNull(column="col")`)로 바뀌었습니다. 구 API 예제를 그대로 복사하면 동작하지 않을 수 있습니다.

#### 6. Lakehouse Federation NCC 없이는 SQL Warehouse에서 PSQL 연결 불가

SQL Warehouse(Serverless)에서 외부 PSQL에 접근하려면 NCC + AWS NLB + VPC Endpoint Service 설정이 필요합니다. 기존 범용 클러스터에서 JDBC로 직접 접근하는 방식이 소규모 팀에 더 현실적입니다.

---

### 요구사항별 도구 배치 정리

| 요구사항 | 담당 도구 | 비고 |
|---------|---------|------|
| freshness / completeness 이상 감지 | Databricks DQ (자동) | 스키마 단위 1-click |
| 데이터 gap 감지 | 순수 SQL 노트북 | LEAD window function |
| PSQL/BQ sync lag | 순수 SQL + JDBC 직접 연결 | 범용 클러스터 활용 |
| 음수/NULL 커스텀 체크 | 순수 SQL 또는 Soda Core | 규모에 따라 선택 |
| 대시보드 | Databricks SQL Dashboard | system table + 커스텀 결과 테이블 |

도구 선택에서 중요한 것은 "얼마나 강력한가"보다 "내 문제에 맞는가"입니다. Databricks DQ의 freshness/completeness 자동 감지로 기본을 커버하고, 나머지는 SQL로 직접 작성하는 조합이 소규모 팀에서 가장 현실적인 출발점입니다.

---

### Reference

- [Databricks Data Quality Monitoring 공식 문서](https://docs.databricks.com/aws/en/data-quality/)
- [Databricks Anomaly Detection](https://docs.databricks.com/aws/en/data-quality-monitoring/anomaly-detection)
- [Databricks DQ Monitoring 비용 확인](https://docs.databricks.com/aws/en/data-quality-monitoring/data-profiling/expense)
- [Soda Spark DataFrame 커넥터](https://docs.soda.io/reference/data-source-reference-for-soda-core/spark-dataframe)
- [Soda + Databricks 연동 가이드](https://docs.soda.io/soda/connect-spark)
- [SodaCL 체크 언어 레퍼런스](https://docs.soda.io/soda-cl/soda-cl-overview)
- [Great Expectations 공식 문서](https://docs.greatexpectations.io/)
- [Elementary OSS 공식 문서](https://docs.elementary-data.com/)
- [Databricks Lakehouse Federation 공식 문서](https://docs.databricks.com/aws/en/query-federation/)
- [DataHub 공식 문서](https://datahubproject.io/docs/)
- [DataHub Assertions Spec](https://datahubproject.io/docs/managed-datahub/observe/custom-sql-assertions)
- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- [OpenMetadata Data Quality](https://docs.open-metadata.org/v1.6.x/how-to-guides/data-quality-observability)
