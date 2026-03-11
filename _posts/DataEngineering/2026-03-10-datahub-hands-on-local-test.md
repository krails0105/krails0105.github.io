---
layout: post
title: "DataHub 로컬 핸즈온 테스트 — Docker Quickstart부터 Lineage, Assertion까지"
categories: [DataEngineering]
tags: [DataHub, DataQuality, Lineage, Metadata, Docker, DataCatalog]
date: 2026-03-10
toc: true
---

## 이 글에서 다루는 것

데이터 카탈로그/거버넌스 도구인 **DataHub**를 로컬 Docker 환경에서 직접 설치하고, Python SDK로 메타데이터 등록 → Lineage 구성 → Assertion(데이터 품질 검증)까지 핸즈온 테스트한 경험을 정리한다.

"쓸 수 있는 도구인가?"를 판단하기 위해 직접 부딪혀 본 결과를 공유한다. 장점만 있지는 않았다 — GMS가 테스트 중 3번 크래시했고, SDK assertion API는 유료 전용이었으며, 프로덕션 운영 비용도 만만치 않았다.

이 글을 읽고 나면 다음을 할 수 있다:

- DataHub를 로컬에서 Docker로 띄우고 웹 UI에 접속하기
- Python REST Emitter로 Dataset, Lineage, Assertion을 프로그래밍 방식으로 등록하기
- OSS vs 유료(Acryl Cloud) 기능 차이를 이해하고, OSS 한계 우회 방법 적용하기
- DataHub 프로덕션 도입 시 인프라 비용과 대안(OpenMetadata)을 비교 판단하기

---

## 사전 준비

- **Docker Desktop** (6개 컨테이너, 최소 7~8 GB 여유 RAM 필요)
- **Python 3.10~3.11** 권장 (3.12는 아래 호환 이슈 참조)
- `pip install acryl-datahub` (DataHub CLI + Python SDK)

---

## 배경: 왜 DataHub를 테스트했나

데이터 파이프라인이 복잡해지면 두 가지 문제가 생긴다.

1. **데이터 출처 파악 불가**: "이 테이블 어디서 왔어?" — 아는 사람이 없다.
2. **품질 검증 부재**: 파이프라인이 돌았는지는 알지만, 데이터가 맞는지는 모른다.

DataHub는 LinkedIn이 오픈소스로 공개한 **데이터 카탈로그 + 리니지 + 데이터 품질** 플랫폼이다. CNCF Incubating 프로젝트로, 대형 조직에서 널리 쓰인다. 우리 환경에서 쓸 수 있는지 직접 확인하고 싶었다.

---

## Docker Quickstart로 설치하기

### 설치 명령

```bash
pip install acryl-datahub
datahub docker quickstart
```

단 두 줄이다. 내부적으로 Docker Compose를 사용해 6개 컨테이너를 자동으로 띄운다.

### 컨테이너 구성과 리소스

| 컨테이너 | 역할 | 메모리 |
|---|---|---|
| OpenSearch | 메타데이터 검색 엔진 | ~1.26 GB |
| Kafka + ZooKeeper | 이벤트 스트리밍 | ~610 MB |
| DataHub Frontend | React 웹 UI | ~502 MB |
| MySQL | 메타데이터 영구 저장 | ~439 MB |
| DataHub GMS | 메타데이터 API 서버 (REST) | ~300 MB |
| DataHub Actions | 이벤트 처리 워커 | ~200 MB |

**총 메모리: 약 3 GB.** Mac 기준 7~8 GB RAM 환경에서 다른 작업과 병행하면 빠듯하다. 16 GB 이상의 환경을 권장한다.

설치 후 `http://localhost:9002`에 접속하면 UI가 열린다. 기본 계정: `datahub / datahub`.

### Python 3.12 호환 이슈

```
ModuleNotFoundError: No module named 'pkg_resources'
```

`acryl-datahub`가 내부적으로 `great_expectations`를 의존하는데, `great_expectations`가 Python 3.12에서 제거된 `pkg_resources`를 사용한다.

```bash
pip install "setuptools<81"
```

setuptools를 다운그레이드하면 해결되지만, Python 3.10~3.11을 사용하는 것이 가장 깔끔하다.

---

## Python REST Emitter로 메타데이터 등록하기

DataHub는 **GMS(Generalized Metadata Service)**라는 REST API 서버를 통해 메타데이터를 받는다. Python SDK의 `DatahubRestEmitter`가 이 API를 추상화해준다. GMS 기본 포트는 `8080`이다.

### Dataset 등록 기본 패턴

```python
# datahub_register.py
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import DatasetPropertiesClass

# GMS 서버에 연결 (기본 포트 8080)
emitter = DatahubRestEmitter(gms_server="http://localhost:8080")
emitter.test_connection()  # 연결 상태 확인 (선택이지만 권장)

# URN: DataHub에서 모든 엔티티를 식별하는 고유 이름
urn = "urn:li:dataset:(urn:li:dataPlatform:postgres,mydb.myschema.orders,PROD)"

props = DatasetPropertiesClass(
    name="orders",
    description="Order transactions",
    customProperties={"owner": "data-team", "sla": "1h"},
)

# MetadataChangeProposalWrapper: URN + aspect(메타데이터 조각)를 감싸는 표준 래퍼
emitter.emit(MetadataChangeProposalWrapper(entityUrn=urn, aspect=props))
```

핵심 개념은 **URN(Uniform Resource Name)**이다. DataHub에서 모든 엔티티는 URN으로 식별된다.

```
urn:li:dataset:(urn:li:dataPlatform:{platform},{경로},{env})
```

- `platform`: `postgres`, `databricks`, `bigquery` 등
- `경로`: 플랫폼별 테이블 식별 경로 (예: `catalog.schema.table_name`)
- `env`: `PROD`, `DEV`, `STAGING` 중 하나

등록 후 UI의 Search에서 `orders`를 검색하면 바로 나온다.

> **참고**: `DatahubRestEmitter.emit()`은 동기(blocking) 호출이다. 호출 즉시 GMS에 전송된다. 비동기 처리가 필요하면 `emit_mode=EmitMode.ASYNC_WAIT`을 사용할 수 있다.

---

## Lineage 등록하기

DataHub의 핵심 기능이다. 어떤 테이블이 어떤 테이블에서 파생됐는지를 **그래프**로 시각화한다.

### Lineage 등록 코드

```python
# lineage_register.py
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    UpstreamClass,
    UpstreamLineageClass,
    DatasetLineageTypeClass,
)

emitter = DatahubRestEmitter(gms_server="http://localhost:8080")

# downstream 테이블의 URN에 upstream 정보를 붙이는 구조
# "이 PostgreSQL orders 테이블은 Databricks orders에서 파생됐다"
lineage = UpstreamLineageClass(
    upstreams=[
        UpstreamClass(
            dataset="urn:li:dataset:(urn:li:dataPlatform:databricks,catalog.schema.orders,PROD)",
            type=DatasetLineageTypeClass.TRANSFORMED,  # COPY, VIEW 등도 가능
        )
    ]
)

# Lineage는 downstream 엔티티의 aspect로 등록
mcp = MetadataChangeProposalWrapper(
    entityUrn="urn:li:dataset:(urn:li:dataPlatform:postgres,mydb.schema.orders,PROD)",
    aspect=lineage,
)
emitter.emit(mcp)
```

내부 파이프라인 레이어(Bronze → Silver → Gold) 리니지도 같은 방식으로 등록할 수 있다. 각 단계의 URN을 연결하면 된다.

등록 후 UI의 Lineage 탭에서 상하류 그래프를 클릭하며 탐색할 수 있다. 이 부분은 직접 써보면 강력하다는 느낌이 온다 — 복잡한 ETL 파이프라인의 테이블 간 의존성을 한눈에 볼 수 있다.

> **참고**: `DatasetLineageTypeClass`의 주요 타입은 `TRANSFORMED`(데이터 변환), `COPY`(단순 복사), `VIEW`(뷰 기반) 등이 있다. 대부분의 ETL 파이프라인은 `TRANSFORMED`가 적절하다.

---

## Assertion 등록하기 (데이터 품질 검증)

### SDK assertion API는 유료(Acryl Cloud) 전용

DataHub 공식 문서에 `DataHubGraph.upsert_custom_assertion()` 같은 고수준 API가 나온다. 그러나 실제 OSS 버전에서 사용하면 이런 에러가 발생한다:

```
AttributeError: 'DataHubGraph' object has no attribute 'assertions'
```

확인해보니 `acryl-datahub-cloud` 패키지(유료 SaaS)에만 포함된 기능이다. **OSS 버전에서는 고수준 assertion SDK가 동작하지 않는다.**

### REST Emitter로 우회하는 방법

OSS에서도 REST Emitter로 Assertion을 직접 등록할 수 있다. 단계가 두 개다: **정의(AssertionInfo)**와 **실행 결과(AssertionRunEvent)**.

```python
# assertion_register.py
import time
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    AssertionInfoClass,
    AssertionTypeClass,
    CustomAssertionInfoClass,
    AssertionRunEventClass,
    AssertionResultClass,
    AssertionResultTypeClass,
    AssertionRunStatusClass,
)

emitter = DatahubRestEmitter(gms_server="http://localhost:8080")

dataset_urn = "urn:li:dataset:(urn:li:dataPlatform:postgres,mydb.schema.orders,PROD)"
assertion_urn = "urn:li:assertion:orders_row_count_check"

# ── Step 1: Assertion 정의 ──
# "이 assertion은 orders 테이블의 row count가 0보다 큰지 검사한다"
info = AssertionInfoClass(
    type=AssertionTypeClass.CUSTOM,
    customAssertion=CustomAssertionInfoClass(
        type="ROW_COUNT_CHECK",
        entity=dataset_urn,
        logic="row_count > 0",
    ),
)
emitter.emit(MetadataChangeProposalWrapper(entityUrn=assertion_urn, aspect=info))

# ── Step 2: 실행 결과 등록 (SUCCESS / FAILURE) ──
# 외부 스케줄러(Airflow, Databricks Jobs 등)에서 체크 후 결과만 push
run = AssertionRunEventClass(
    timestampMillis=int(time.time() * 1000),
    assertionUrn=assertion_urn,
    asserteeUrn=dataset_urn,
    runId="daily_check_2026_03_10",
    status=AssertionRunStatusClass.COMPLETE,
    result=AssertionResultClass(type=AssertionResultTypeClass.SUCCESS),
)
emitter.emit(MetadataChangeProposalWrapper(entityUrn=assertion_urn, aspect=run))
```

등록 후 UI의 **Quality 탭**에서 assertion 목록과 최근 실행 결과(PASS/FAIL 히스토리)를 확인할 수 있다.

**핵심은 assertion을 "정의"하고 "결과를 밀어 넣는" 두 단계를 분리하는 것이다.** 외부 스케줄러(Airflow, Databricks Jobs 등)에서 체크 로직을 실행하고, 결과만 DataHub에 push하는 아키텍처가 자연스럽다.

---

## Ingestion Recipe으로 메타데이터 자동 수집하기

앞서 살펴본 REST Emitter는 프로그래밍 방식이고, **Ingestion Recipe**는 YAML 설정 파일 기반으로 메타데이터를 자동 수집하는 방식이다. 스키마, 테이블 목록, 프로파일링 정보 등을 소스에서 직접 가져올 때 유용하다.

```yaml
# recipe_postgres.yml
source:
  type: postgres
  config:
    host_port: "localhost:5432"
    database: mydb
    username: user
    password: pass
    include_tables: true
    include_views: true

sink:
  type: datahub-rest
  config:
    server: "http://localhost:8080"
```

```bash
datahub ingest -c recipe_postgres.yml
```

`source.type`만 변경하면 다양한 데이터 소스를 지원한다:

| 소스 | `type` 값 | 비고 |
|---|---|---|
| PostgreSQL | `postgres` | 스키마 + 테이블 + 뷰 |
| Databricks Unity Catalog | `unity-catalog` | 카탈로그 전체 메타데이터 |
| BigQuery | `bigquery` | 프로젝트 단위 수집 |
| MySQL | `mysql` | DataHub 내부 저장소와 동일 |
| dbt | `dbt` | dbt 모델 + 리니지 자동 추출 |

Recipe 방식은 REST Emitter 방식과 병행할 수 있다. 예를 들어 스키마 메타데이터는 Recipe로 자동 수집하고, 커스텀 프로퍼티나 Assertion은 REST Emitter로 등록하는 식이다.

---

## 삽질 기록: GMS가 3번 크래시했다

테스트 중 가장 고생한 부분이다. 이 경험이 DataHub 로컬 테스트의 현실을 보여준다고 생각한다.

### 증상

100개 dataset을 한번에 등록하는 스크립트를 돌렸더니 GMS 컨테이너가 `Exited 255`로 종료됐다. UI는 연결 불가 상태가 되고, 모든 API 호출이 실패했다.

### 원인 추정

```
OpenSearch: PIT API compatibility issue
Query latency: 30s+ on metadata index
```

OpenSearch가 대량 MCP(MetadataChangeProposal) 처리에서 PIT(Point-In-Time) API 이슈로 응답이 느려지고, GMS가 타임아웃으로 크래시하는 패턴이었다.

7.6 GB RAM 환경에서 6개 컨테이너를 동시 운영하는 것 자체가 한계에 가깝다. OpenSearch만 1.26 GB를 차지하고, GMS가 300 MB로 동작해야 하는 상황에서 대량 인덱싱이 걸리면 메모리 압박이 온다.

### 해결 시도

```bash
# 인덱스 복구 시도 (실패 — DNS 이슈)
datahub docker quickstart --restore-indices

# 전체 재시작으로 해결
datahub docker quickstart
```

`--restore-indices` 옵션은 OpenSearch 인덱스를 MySQL에 저장된 데이터 기준으로 재구성해주는 기능인데, 내부 DNS 해석 실패로 동작하지 않았다. 결국 전체 재시작으로 해결했다. 등록한 데이터는 MySQL에 영구 저장되어 있어서 재시작 후에도 유지됐다.

### 교훈

대량 메타데이터 등록 시 배치 크기를 줄이고, 요청 간 딜레이를 넣어야 한다. 아래처럼 방어적으로 작성하는 것을 권장한다:

```python
import time

for urn, props in dataset_list:
    emitter.emit(MetadataChangeProposalWrapper(entityUrn=urn, aspect=props))
    time.sleep(0.1)  # OpenSearch 인덱싱 부하 분산
```

프로덕션에서는 이 문제가 적절한 인프라 스펙(OpenSearch 4 GB+, GMS 2 GB+)으로 완화되겠지만, 로컬 테스트 환경에서는 반드시 유의해야 한다.

---

## 프로덕션 인프라 비용 분석

로컬 테스트가 끝난 후 "실제로 운영하면 얼마나 드는가?"를 계산해봤다.

### AWS 기준 최소 비용

| 컴포넌트 | 최소 스펙 | AWS 서비스 | 월 비용 (예상) |
|---|---|---|---|
| MySQL | 2 vCPU, 4 GB | RDS t3.medium | ~$60 |
| OpenSearch | 2 vCPU, 4 GB | OpenSearch t3.medium | ~$50 |
| Kafka | 2 vCPU, 4 GB | MSK t3.small x 3 | ~$100 |
| GMS + Frontend | 2 vCPU, 4 GB | ECS Fargate 2 task | ~$70 |
| **합계** | | | **~$280/월** |

### 구조적 제약 사항

여기서 드러나는 DataHub의 구조적 특성이 있다:

- **MySQL 전용**: PostgreSQL 대체 불가. JPA + MySQL dialect이 하드코딩되어 있다.
- **Kafka 필수**: Kinesis나 다른 메시지 큐로 대체 불가. Kafka Streams API를 직접 사용한다.
- **OpenSearch 필수**: 전문 검색 엔진이 없으면 동작하지 않는다.

기존에 PostgreSQL RDS, Amazon Kinesis를 사용하는 AWS 환경이라면 DataHub를 위해 MySQL, MSK를 **새로 띄워야 한다.** 인프라 호환성 측면에서 부담이 크다.

---

## DataHub vs OpenMetadata 비교

같은 포지션의 대안인 OpenMetadata와 비교하면 결이 다르다.

| 항목 | DataHub | OpenMetadata |
|---|---|---|
| 메타데이터 DB | MySQL 전용 | PostgreSQL 지원 |
| 메시지 큐 | Kafka 필수 (MSK 3대) | 불필요 |
| 검색 엔진 | OpenSearch 필수 | Elasticsearch |
| 거버넌스 성숙도 | 높음 (LinkedIn 사용 중) | 중간 |
| 커뮤니티 규모 | CNCF Incubating, 12K+ stars | Apache 2.0, 6K+ stars |
| Managed SaaS | Acryl Cloud (유료) | 없음 |
| SDK assertion (품질 검증) | 유료 전용 (OSS는 REST 우회) | OSS에서 기본 지원 |
| 최소 운영 비용 | ~$280/월 | ~$100~150/월 |

OpenMetadata는 PostgreSQL을 지원하고 Kafka 의존성이 없어서 기존 AWS 인프라와 친화적이다. 비용도 절반 수준이다.

---

## 주의할 점 (트러블슈팅)

### 1. GMS 안정성 — 로컬에서 과부하 주의

한번에 대량 MCP를 보내면 GMS가 크래시한다. 특히 로컬 Docker 환경(8 GB 이하 RAM)에서는 배치 처리 시 반드시 `time.sleep()`을 넣자.

### 2. SDK assertion API는 OSS에서 동작하지 않는다

문서에 `DataHubGraph.upsert_custom_assertion()` API가 나와도 OSS에서는 `AttributeError`가 난다. 이 글에서 소개한 REST Emitter 우회 방식(`AssertionInfoClass` + `AssertionRunEventClass`)을 써야 한다.

### 3. URN 형식을 정확히 맞춰야 한다

```
# 올바른 형식
urn:li:dataset:(urn:li:dataPlatform:postgres,mydb.myschema.orders,PROD)

# 흔한 실수: platform 이름 오타
urn:li:dataset:(urn:li:dataPlatform:postgresql,...)  # postgres가 맞음
```

URN 형식이 틀려도 에러 없이 등록은 되지만, UI에서 엉뚱한 플랫폼으로 분류된다. 특히 `postgres` (not `postgresql`), `databricks` (not `delta-lake`) 같은 platform 문자열에 주의하자.

### 4. `--restore-indices`가 항상 동작하지 않는다

Docker 네트워크의 DNS 해석 환경에 따라 실패할 수 있다. GMS 크래시 복구는 전체 재시작(`datahub docker quickstart`)이 가장 확실하다. MySQL에 데이터가 영구 저장되므로 재시작해도 등록한 메타데이터는 유지된다.

---

## 정리: 핵심 결론

DataHub 로컬 테스트에서 얻은 결론을 정리한다.

| 평가 항목 | 판단 |
|---|---|
| **Lineage 시각화** | 압도적으로 강하다. 복잡한 파이프라인 의존성을 그래프로 탐색하는 경험은 실제로 유용했다. |
| **데이터 품질 (Assertion)** | OSS에서는 REST Emitter 우회가 필수. 품질만 필요하다면 Soda Core가 훨씬 간단하다. |
| **인프라 비용** | 최소 ~$280/월. MySQL + Kafka + OpenSearch를 새로 운영해야 한다. |
| **카탈로그 + 리니지** | 기존 인프라(PostgreSQL, Kinesis)와의 호환성 측면에서 OpenMetadata가 현실적 대안이다. |
| **적합한 조직** | Netflix, LinkedIn처럼 수백 명의 데이터 엔지니어가 공유하는 대규모 환경에서 빛난다. |

소규모 팀에서는 인프라 오버헤드 대비 효용이 낮을 수 있다. 도입 전에 반드시 로컬 테스트로 실제 워크플로우를 검증해보길 권한다.

---

## Reference

- [DataHub 공식 문서](https://datahubproject.io/docs/)
- [DataHub Python SDK — REST Emitter](https://docs.datahub.com/docs/python-sdk/clients/rest-emitter)
- [DataHub Python SDK — As a Library](https://datahubproject.io/docs/metadata-ingestion/as-a-library/)
- [DataHub Docker Quickstart](https://datahubproject.io/docs/quickstart/)
- [DataHub Custom Assertions 가이드](https://docs.datahub.com/docs/api/tutorials/custom-assertions)
- [DataHub Assertion Entity 모델](https://docs.datahub.com/docs/generated/metamodel/entities/assertion)
- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
