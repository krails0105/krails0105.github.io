---
title: "Soda Core vs DataHub vs OpenMetadata — 데이터 품질 모니터링 도구 직접 비교"
categories:
  - DataEngineering
tags:
  - DataQuality
  - SodaCore
  - DataHub
  - OpenMetadata
  - Databricks
date: 2026-03-10
---

### 개요

Databricks Lakehouse에서 여러 외부 시스템(PostgreSQL, BigQuery)으로 데이터를 복제하는 파이프라인을 운영하다 보면 세 가지 니즈가 생깁니다.

1. **DQ(Data Quality) 모니터링**: row count 불일치, 필드 범위 이탈, 동기화 지연 감지
2. **메타데이터 카탈로그**: 테이블 스키마, 소유자, 설명을 한 곳에서 관리
3. **리니지 시각화**: "이 테이블이 어떤 테이블에서 만들어졌는가"를 그래프로 추적

이 세 가지를 커버하는 도구를 직접 로컬 Docker에서 테스트했습니다. 테스트한 도구는 **Soda Core**, **DataHub**, **OpenMetadata**, 그리고 자동 리니지 수집을 위한 **OpenLineage**입니다.

이 글에서는 각 도구를 실제로 연동하면서 겪은 경험을 바탕으로, 설치 난이도, 인프라 요구사항, 기능 범위, 운영 비용을 비교합니다. 글을 끝까지 읽으면 팀 규모와 인프라 환경에 맞는 도구 조합을 선택할 수 있습니다.

#### 이 글에서 다루는 것과 다루지 않는 것

| 다루는 것 | 다루지 않는 것 |
|-----------|---------------|
| 로컬 Docker 기반 설치 및 연동 테스트 | 대규모 프로덕션 벤치마크 |
| Python SDK / REST API 코드 예시 | 각 도구의 전체 기능 레퍼런스 |
| AWS 기준 월간 인프라 비용 추산 | SaaS(managed) 버전 비교 |
| 실제로 만난 문제점과 workaround | 보안/RBAC 상세 비교 |

---

### 배경: 왜 모니터링 도구가 필요했는가

파이프라인 구조는 다음과 같습니다.

```
Databricks Delta Lake (Source of Truth)
  ├── PostgreSQL 복제 → API 서버 (실시간 서빙)
  └── BigQuery 복제 → 분석 쿼리
```

운영하면서 이런 문제들이 반복됐습니다.

- Databricks job은 성공인데 PostgreSQL에 row가 안 들어온 경우 (CDF 기반 복제 이슈)
- Delta와 PostgreSQL 간 row count가 조용히 벌어지는 경우
- 어떤 테이블이 어떤 테이블에 의존하는지 문서화가 안 된 상태

"사후에 알게 되는" 패턴이 반복되자, 체계적인 모니터링 도구 도입을 본격적으로 검토했습니다.

---

### 전제 조건

이 글의 테스트 환경은 다음과 같습니다. 동일한 테스트를 재현하려면 아래 환경이 필요합니다.

- Docker Desktop (4GB 이상 메모리 할당, DataHub 테스트 시 8GB 이상 권장)
- Python 3.10+
- Databricks workspace (Unity Catalog 활성화)
- PostgreSQL 인스턴스 (cross-source 비교 테스트용)

---

### 도구별 테스트 결과

#### Soda Core — DQ 모니터링 전문 도구

**역할**: 데이터 품질 체크 전문. 카탈로그/리니지 기능은 없음.

SodaCL(Soda Checks Language)이라는 YAML 형식으로 체크를 정의하고, Python의 `Scan` 클래스로 실행합니다. SodaCL은 SQL을 몰라도 읽을 수 있을 정도로 직관적인 DSL입니다.

```yaml
# checks/daily_checks.yaml
checks for orders:
  - row_count > 0
  - max(amount) < 1000000
  - freshness(updated_at) < 2h
  - missing_count(user_id) = 0
```

```python
# run_checks.py
from soda.scan import Scan

scan = Scan()
scan.set_scan_definition_name("daily_dq_check")
scan.set_data_source_name("databricks")
scan.add_configuration_yaml_file("configuration.yaml")
scan.add_sodacl_yaml_file("checks/daily_checks.yaml")
scan.execute()

# 결과 확인
print(scan.get_logs_text())

# 실패 체크가 있으면 alert 발송
if scan.has_check_fails():
    send_alert(scan.get_logs_text())
```

> **패키지 설치 참고**: Databricks 환경에서는 `pip install -i https://pypi.cloud.soda.io soda-spark[databricks]`로 설치합니다. 기존 `soda-core-spark` 패키지명은 deprecated되었으므로 새 프로젝트에서는 `soda-spark` 패키지를 사용하세요.

##### Spark DataFrame 직접 체크 (Databricks Notebook)

Soda Core는 Spark DataFrame을 직접 체크할 수도 있습니다. DataFrame을 temp view로 등록한 뒤 SodaCL 체크를 실행하는 방식입니다.

```python
from soda.scan import Scan

# DataFrame을 temp view로 등록
df = spark.read.table("prod.gold.daily_summary")
df.createOrReplaceTempView("daily_summary")

scan = Scan()
scan.set_scan_definition_name("spark_df_check")
scan.set_data_source_name("spark_ds")
scan.add_spark_session(spark, data_source_name="spark_ds")
scan.add_sodacl_yaml_str("""
checks for daily_summary:
  - row_count > 0
  - missing_count(daily_total) = 0
""")
scan.execute()
print(scan.get_logs_text())
```

##### cross-source 비교 패턴

카탈로그 기능이 없으니 Delta와 PostgreSQL 간 row count 비교는 직접 구현해야 합니다. 두 소스를 각각 scan하고 Python에서 비교하는 방식입니다.

```python
# Delta scan
delta_scan = run_scan("databricks", "checks/delta_checks.yaml")
delta_row_count = extract_check_value(delta_scan, "row_count")

# PostgreSQL scan
psql_scan = run_scan("postgresql", "checks/psql_checks.yaml")
psql_row_count = extract_check_value(psql_scan, "row_count")

# Python에서 직접 비교
lag = delta_row_count - psql_row_count
if lag > THRESHOLD:
    alert(f"Sync lag detected: {lag} rows")
```

##### 평가 요약

| 항목 | 결과 |
|------|------|
| 설치 | `pip install -i https://pypi.cloud.soda.io soda-spark[databricks]` |
| 인프라 비용 | $0 (별도 서버 불필요) |
| 카탈로그 / 리니지 | 없음 |
| 운영 부담 | 매우 낮음 (cron 또는 Databricks job 후처리로 충분) |
| 한계 | cross-source 비교를 직접 코딩해야 함 |

DQ 체크만 필요하다면 가장 가볍고 실용적입니다.

---

#### DataHub — 카탈로그 + 리니지 + DQ 올인원

**역할**: 메타데이터 카탈로그, 리니지 시각화, DQ를 하나의 플랫폼에서 제공.

로컬 테스트에서 필요한 컨테이너 구성입니다. 총 6개 컨테이너가 필요합니다.

```
MySQL        — 메타데이터 저장소 (PostgreSQL 불가, MySQL만 지원)
OpenSearch   — 검색 인덱스
Kafka        — 이벤트 스트리밍 (Kinesis 등으로 대체 불가)
GMS          — Graph Metadata Service (핵심 백엔드)
Frontend     — React 기반 UI
Actions      — 이벤트 기반 액션 핸들러
```

Python SDK(`acryl-datahub`)로 메타데이터와 리니지를 등록합니다. 현재 권장되는 방식은 `MetadataChangeProposalWrapper`(MCP)를 사용하는 것입니다.

```python
# datahub_emitter.py
import datahub.emitter.mce_builder as builder
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.metadata.schema_classes import (
    DatasetPropertiesClass,
    UpstreamLineageClass,
    UpstreamClass,
    DatasetLineageTypeClass,
)

# REST emitter 생성 (GMS 서버 주소)
emitter = DatahubRestEmitter(gms_server="http://localhost:8080")
emitter.test_connection()

# 데이터셋 URN 생성
dataset_urn = builder.make_dataset_urn("spark", "prod.gold.orders", "PROD")
upstream_urn = builder.make_dataset_urn("spark", "prod.bronze.raw_events", "PROD")

# 리니지 등록 (MCP 방식)
lineage = UpstreamLineageClass(upstreams=[
    UpstreamClass(
        dataset=upstream_urn,
        type="TRANSFORMED"
    )
])

metadata_event = MetadataChangeProposalWrapper(
    entityUrn=dataset_urn,
    aspect=lineage,
)

# emit() 메서드로 전송 (emit_mcp가 아님)
emitter.emit(metadata_event)
```

> **API 참고**: 이전 버전에서 사용하던 `DatasetSnapshotClass` 기반의 MCE(MetadataChangeEvent) 방식은 deprecated되었습니다. 새 코드에서는 반드시 `MetadataChangeProposalWrapper`를 사용하세요.

##### 실제로 만난 문제들

1. **GMS OOM crash (3회)**: 8GB MacBook Air에서 GMS 컨테이너가 메모리 부족으로 반복 재시작되었습니다. **최소 16GB 메모리 환경을 권장합니다.**

2. **MySQL 강제 의존**: DataHub의 메타데이터 저장소는 MySQL만 지원합니다. PostgreSQL을 이미 운영 중이라도 MySQL을 별도로 추가해야 합니다.

3. **Kafka 필수**: 이벤트 파이프라인이 Kafka 기반으로 고정되어 있습니다. AWS 환경이라면 Kinesis로 대체할 수 없어 MSK 또는 self-hosted Kafka가 필요합니다.

4. **OSS Assertion 제한**: DQ Assertion 기능은 `acryl-datahub-cloud`(유료 SaaS) 플랜에서 완전히 동작합니다. OSS 버전에서는 제한적이며, REST Emitter를 통한 workaround가 필요합니다.

##### 비용 추산 (AWS 기준)

| 구성 요소 | 월 비용 |
|-----------|---------|
| MySQL (RDS t3.small) | ~$30 |
| MSK (kafka.t3.small x 2) | ~$120 |
| ECS / EC2 (GMS + Frontend + Actions) | ~$130 |
| **합계** | **~$280/월** |

##### 평가 요약

SDK가 강력하고 ingestion connector가 성숙해 있습니다. 이미 Kafka 인프라를 운영 중인 팀이라면 추가 비용 없이 강력한 카탈로그+리니지를 얻을 수 있습니다. 다만 MySQL + Kafka 강제 조합과 GMS의 높은 메모리 요구가 소규모 팀에는 부담입니다.

---

#### OpenMetadata — 가벼운 올인원 플랫폼

**역할**: 카탈로그 + 리니지 + DQ. DataHub보다 가벼운 인프라 구성.

로컬 테스트 컨테이너 구성입니다. 최소 3개 컨테이너로 동작합니다.

```
OpenMetadata Server  — 핵심 서버 + REST API + Ingestion Framework
PostgreSQL           — 메타데이터 저장소 (기존 인스턴스 재활용 가능)
Elasticsearch        — 검색 인덱스
Airflow (선택)       — DQ 워크플로우 실행 (DQ 기능 사용 시 필요)
```

OpenMetadata의 가장 큰 차별점은 **순수 REST API만으로 전체 기능을 사용할 수 있다**는 것입니다. 별도의 Python SDK 설치 없이 `curl`이나 `requests`로 모든 CRUD가 가능합니다.

```python
# openmetadata_client.py
import requests

OM_HOST = "http://localhost:8585/api/v1"
TOKEN = "your-jwt-token"
headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# 테이블 메타데이터 등록
table_payload = {
    "name": "orders",
    "databaseSchema": {"fullyQualifiedName": "prod.default"},
    "columns": [
        {"name": "order_id", "dataType": "BIGINT"},
        {"name": "amount",   "dataType": "DECIMAL"},
        {"name": "created_at", "dataType": "TIMESTAMP"},
    ]
}
requests.post(f"{OM_HOST}/tables", json=table_payload, headers=headers)

# 리니지 등록
lineage_payload = {
    "edge": {
        "fromEntity": {"type": "table", "fullyQualifiedName": "prod.default.raw_events"},
        "toEntity":   {"type": "table", "fullyQualifiedName": "prod.default.orders"},
    }
}
requests.put(f"{OM_HOST}/lineage", json=lineage_payload, headers=headers)
```

```bash
# 리니지 조회도 REST API 한 줄로 가능
curl -X GET "http://localhost:8585/api/v1/lineage/table/name/prod.default.orders?upstreamDepth=3&downstreamDepth=3" \
  -H "Authorization: Bearer ${TOKEN}"
```

##### 실제로 만난 문제들

1. **Connection config 문서 부족**: `serviceType`별로 요구 필드가 다른데, 공식 문서에 예시가 부족해 UI에서 직접 설정하며 역공학해야 하는 경우가 있었습니다.

2. **DQ 결과 REST API push 불가 (v1.12.1 기준)**: DQ 체크 정의는 REST API로 가능하지만, 실행 결과를 기록하려면 Airflow 컨테이너를 추가해야 합니다. DQ만 필요하다면 Soda Core를 별도로 쓰는 편이 낫습니다.

3. **Databricks connector token 필드 버그 (v1.12.1 기준)**: Databricks connection config에서 token 필드가 UI를 통해 정상 저장되지 않는 버그가 있었습니다. REST API로 직접 POST하는 workaround로 해결했습니다.

##### 비용 추산 (AWS 기준, Airflow 포함)

| 구성 요소 | 월 비용 |
|-----------|---------|
| Aurora PostgreSQL (t3.small) | ~$30 (기존 인스턴스 재활용 시 $0) |
| Elasticsearch (t3.small) | ~$40 |
| ECS (Server + Airflow) | ~$60 |
| **합계** | **~$100-130/월** |

기존 Aurora PostgreSQL을 재활용하면 추가 비용이 더 줄어듭니다.

##### 평가 요약

기존 PostgreSQL 재활용, Kafka 불필요, REST API 기반의 단순한 통합 구조. 소규모~중간 규모 팀에서 카탈로그+리니지를 빠르게 도입하기에 적합합니다.

---

#### OpenLineage — Spark 자동 리니지의 현실

OpenLineage는 별도의 독립 도구가 아니라, Spark에 리스너(listener)를 붙여 read/write 이벤트를 자동으로 캡처하는 **리니지 수집 표준 프로토콜**입니다. 캡처된 이벤트는 DataHub 또는 OpenMetadata 같은 consumer로 전송됩니다.

##### Databricks 설정 방식

클러스터 init script로 JAR를 설치하고, Spark config에서 리스너를 등록합니다.

```bash
# init script (클러스터 시작 시 실행)
# 버전 번호는 실제 최신 릴리즈로 교체하세요
wget -O /databricks/jars/openlineage-spark.jar \
  "https://repo1.maven.org/maven2/io/openlineage/openlineage-spark/1.28.0/openlineage-spark-1.28.0.jar"
```

```properties
# Spark config (클러스터 Advanced Options > Spark Config)
spark.extraListeners          io.openlineage.spark.agent.OpenLineageSparkListener
spark.openlineage.transport.type   http
spark.openlineage.transport.url    http://your-openmetadata-host:4433
spark.openlineage.namespace        prod
```

설정 후에는 **별도 코드 수정 없이** Spark의 read/write 이벤트가 자동 캡처됩니다.

```python
# 아래 코드는 수정 없이 리니지가 자동 캡처됨
df = spark.read.table("prod.bronze.raw_events")
result = df.groupBy("date").agg(F.sum("value").alias("daily_total"))
result.write.saveAsTable("prod.gold.daily_summary")
# → raw_events → daily_summary 리니지가 자동으로 consumer에 전송
```

##### 캡처 불가능한 케이스 (중요)

OpenLineage는 Spark SQL 엔진을 통하지 않는 외부 시스템 쓰기를 감지하지 못합니다.

```python
# (1) psycopg2 직접 INSERT → OpenLineage 감지 불가
conn = psycopg2.connect(...)
cursor.execute("INSERT INTO orders VALUES (%s, %s)", (id, value))

# (2) BigQuery client write → 감지 불가
bq_client.load_table_from_dataframe(df, "project.dataset.table")

# (3) Databricks serverless compute → init script 실행 불가 → JAR 설치 불가
```

##### 외부 시스템 리니지: Python client로 수동 emit

외부 시스템으로의 복제 리니지는 OpenLineage Python client를 사용해 직접 emit해야 합니다.

```python
from openlineage.client import OpenLineageClient
from openlineage.client.run import RunEvent, Dataset

client = OpenLineageClient.from_environment()

# Delta → PostgreSQL 복제 완료 후 수동 emit
client.emit(RunEvent(
    eventType="COMPLETE",
    inputs=[Dataset(namespace="databricks", name="prod.gold.orders")],
    outputs=[Dataset(namespace="postgresql", name="public.orders")],
    # ... run, job, producer 등 필수 필드 생략
))
```

##### 요약

Databricks Spark job 내부의 Delta 테이블 간 리니지는 자동화가 가능합니다. 하지만 외부 시스템(PostgreSQL, BigQuery)으로의 복제 리니지와 serverless compute 환경에서는 수동 emit이 필요합니다. 리니지 완전 자동화를 기대하고 도입하면 예상과 다른 결과를 얻을 수 있습니다.

---

### 최종 비교 표

| 항목 | Soda Core | DataHub | OpenMetadata |
|------|-----------|---------|-------------|
| **카탈로그** | ✗ | ✓ | ✓ |
| **리니지** | ✗ | ✓ | ✓ |
| **DQ 모니터링** | ✓ | ✓ (유료 SaaS에서 완전) | ✓ (Airflow 필요) |
| **DB 요구사항** | 없음 | MySQL only | PostgreSQL OK |
| **메시지 큐** | 없음 | Kafka 필수 | 없음 |
| **인프라 비용** | $0 | ~$280/월 | ~$100-130/월 |
| **컨테이너 수** | 0 | 6 | 3-4 |
| **통합 방식** | Python SDK (`soda.scan`) | Python SDK (`acryl-datahub`) | REST API (SDK 불필요) |
| **OpenLineage consumer** | ✗ | ✓ | ✓ |
| **메모리 요구** | 최소 | 높음 (GMS 16GB+) | 보통 (~3GB) |

---

### 아키텍처 결정

#### 추천 조합: OpenMetadata + Soda Core

| 역할 | 도구 | 이유 |
|------|------|------|
| 카탈로그 + 리니지 | OpenMetadata | PostgreSQL 재활용, Kafka 불필요, REST API |
| DQ 모니터링 | Soda Core | 인프라 $0, SodaCL 직관적, 빠른 도입 |

**선택 근거**:

- 기존 Aurora PostgreSQL을 OpenMetadata 저장소로 재활용 가능 (추가 MySQL 불필요)
- Kafka 의존성 없음 (MSK 비용 제거)
- Soda Core는 별도 인프라 없이 `pip install`로 DQ 체크 즉시 시작 가능
- OpenMetadata REST API로 Soda Core 결과를 카탈로그에 기록하는 통합이 가능
- 두 도구 모두 OSS이므로 vendor lock-in 없음

DataHub는 팀 규모가 커지고 올인원 플랫폼이 필요할 때, 또는 이미 Kafka 인프라가 있는 환경에서 고려할 수 있습니다.

#### 대안: OpenMetadata 단독 (DQ 포함)

Airflow 컨테이너(+$30/월)를 추가하면 DQ도 OpenMetadata UI 안에서 관리할 수 있습니다. 한 화면에서 카탈로그 + 리니지 + DQ 결과를 모두 확인하고 싶다면 이 구성이 더 편합니다. 다만, Soda Core의 SodaCL만큼 유연한 체크 정의는 어렵습니다.

---

### 주의할 점 (Gotchas)

실제 테스트에서 만난 함정들을 정리합니다. 도입 전에 확인하면 시행착오를 줄일 수 있습니다.

**1. DataHub GMS는 메모리를 많이 씁니다.**
로컬 개발 머신(8GB 이하)에서는 GMS가 반복적으로 OOM crash할 수 있습니다. 프로덕션 배포 전 최소 16GB 환경에서 테스트하세요.

**2. OpenMetadata DQ는 Airflow 없이는 반쪽짜리입니다 (v1.12.1 기준).**
REST API로 체크 정의는 가능하지만 실행 결과를 기록하려면 Airflow 연동이 필요합니다. DQ를 Soda Core로 분리하면 이 제약을 우회할 수 있습니다.

**3. OpenLineage는 외부 시스템 리니지를 자동으로 잡지 못합니다.**
Databricks Spark job에서 Delta 테이블 간 리니지는 자동입니다. 하지만 psycopg2, BQ client, serverless compute 기반의 작업은 수동 emit이 필요합니다.

**4. OpenMetadata Databricks connector에 버그가 있을 수 있습니다.**
버전에 따라 connection config 저장이 정상 동작하지 않는 경우가 있습니다. REST API로 직접 POST하는 방법을 fallback으로 알아두면 좋습니다.

**5. cross-source DQ 비교는 항상 직접 구현이 필요합니다.**
세 도구 모두 "Delta와 PostgreSQL의 row count를 비교해서 lag를 계산"하는 기능을 내장하지 않습니다. Soda Core로 각 소스를 scan한 뒤 Python에서 직접 비교하는 방식이 현실적입니다.

**6. Soda Core 패키지명이 변경되었습니다.**
기존 `soda-core-spark` 패키지는 deprecated되었습니다. 새 프로젝트에서는 `pip install -i https://pypi.cloud.soda.io soda-spark[databricks]`를 사용하세요. 별도의 private PyPI 인덱스(`pypi.cloud.soda.io`)를 지정해야 하는 점에 주의하세요.

---

### 다음 단계 (Next Steps)

이 비교를 바탕으로 실제 운영 환경에 적용할 계획입니다.

1. **OpenMetadata 운영 배포**: Aurora PostgreSQL 연결, Databricks + PostgreSQL + BigQuery connector 등록
2. **Soda Core 스케줄러 연동**: Databricks job 성공 후 hook으로 scan 트리거 (결과를 OpenMetadata에 기록)
3. **OpenLineage 선택적 적용**: serverless가 아닌 classic compute job에 한해 init script 적용
4. **cross-source 비교 대시보드**: Soda scan 결과를 Databricks SQL Dashboard에서 시각화

---

### 핵심 요약 (Key Takeaways)

- **DQ 체크만 필요하다면**: Soda Core 단독으로 충분합니다. 인프라 비용 $0, SodaCL로 체크 정의가 직관적.
- **카탈로그 + 리니지가 필요하다면**: OpenMetadata가 가장 가벼운 선택. PostgreSQL 재활용 가능, Kafka 불필요.
- **올인원 플랫폼이 필요하고 Kafka가 이미 있다면**: DataHub의 성숙한 SDK와 connector 생태계가 장점.
- **OpenLineage는 만능이 아닙니다**: Spark 내부 리니지는 자동이지만, 외부 시스템과 serverless는 수동 emit 필수.
- **cross-source 비교는 어떤 도구든 직접 구현이 필요합니다**: 이 부분은 도구 선택과 무관하게 커스텀 코드가 필요한 영역.

---

### References

- [Soda Core 공식 문서](https://docs.soda.io/)
- [Soda Spark Databricks 연결 가이드](https://docs.soda.io/soda/connect-spark)
- [DataHub 공식 문서](https://datahubproject.io/docs/)
- [DataHub Python SDK (as-a-library)](https://datahubproject.io/docs/metadata-ingestion/as-a-library/)
- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- [OpenMetadata Databricks Connector](https://docs.open-metadata.org/connectors/database/databricks)
- [OpenLineage 공식 문서](https://openlineage.io/docs/)
- [OpenLineage Spark 통합 가이드](https://openlineage.io/docs/integrations/spark/)
