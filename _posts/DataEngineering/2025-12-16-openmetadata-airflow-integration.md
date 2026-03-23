---
title: "기존 Airflow Docker에 OpenMetadata 통합하기 — 버전 호환성 함정 총정리"
categories: [DataEngineering]
tags: [OpenMetadata, Airflow, Docker, DataCatalog, DataQuality, Lineage, Elasticsearch]
date: 2026-03-11
---

### 이 글에서 다루는 것

기존에 운영 중인 **Airflow Docker 환경에 OpenMetadata를 직접 통합**하는 과정을 정리한다. 별도 ingestion 컨테이너를 띄우는 방식이 아니라, Airflow 이미지 자체에 OpenMetadata 패키지를 추가하는 Option A 방식을 선택했다.

이 글을 읽고 나면 다음을 할 수 있다:

- 기존 Airflow Dockerfile에 OpenMetadata 패키지를 추가하는 방법
- 버전 호환성 지뢰(Python, 클라이언트-서버, Elasticsearch)를 사전에 피하는 방법
- Airflow + OM Server + Elasticsearch를 단일 docker-compose로 묶는 구성
- SDK로 연결 테스트부터 REST API로 서비스/리니지/DQ 등록까지 E2E 검증

> **테스트 환경**: OpenMetadata **v1.12.1**, Airflow **2.9.3**, Python **3.10**, Elasticsearch **7.17.24**, Docker Desktop for Mac

---

### 사전 준비

이 글을 따라하려면 다음이 필요하다:

- **Docker Desktop** (Docker Compose v2 포함)
- 기존 Airflow Docker 환경 (Dockerfile + docker-compose.yml)
- OpenMetadata의 기본 개념 이해 (메타데이터 카탈로그, ingestion 파이프라인)
- REST API 호출 경험 (curl 또는 Python requests)

---

### 배경: 왜 별도 컨테이너 대신 통합인가

OpenMetadata의 공식 Docker 배포판에는 **ingestion 컨테이너**가 포함되어 있다. 이 컨테이너는 자체 Airflow 기반으로 동작하며 데이터 수집 파이프라인 스케줄링을 담당한다.

문제는 이미 별도로 운영 중인 Airflow 환경이 있을 때다. 두 Airflow가 공존하면:

1. DAG 관리 포인트가 분산된다.
2. 리소스 낭비가 발생한다.
3. 기존 DAG과 OM ingestion DAG의 연계가 불편해진다.

그래서 **기존 Airflow에 OpenMetadata 패키지를 탑재(Option A)**하는 방식을 선택했다. OM 서버는 별도 컨테이너로 띄우되, ingestion은 기존 Airflow가 담당한다.

```
Option A (선택): 기존 Airflow + openmetadata-ingestion 패키지
  → Airflow 컨테이너 하나로 DAG 관리 일원화

Option B: 별도 OM ingestion 컨테이너 추가
  → Airflow가 두 개 → DAG 관리 분산
```

---

### 접근 방식

기존 파일을 수정하지 않고 새 파일 3개를 추가하는 방식을 선택했다. 기존 환경에 영향을 주지 않으면서 병렬로 테스트할 수 있도록 하기 위해서다.

```
project/
├── Dockerfile                          # 기존 (수정 안 함)
├── docker-compose.yml                  # 기존 (수정 안 함)
├── config/
│   ├── requirements.txt                # 기존 (수정 안 함)
│   └── requirements-openmetadata.txt   # 신규: 기존 + OM 패키지
├── Dockerfile.openmetadata             # 신규: OM 통합 이미지
└── docker-compose-openmetadata.yml     # 신규: 전체 스택 컴포즈
```

| 파일 | 역할 |
|---|---|
| `Dockerfile.openmetadata` | OpenMetadata 통합 Airflow 이미지 |
| `config/requirements-openmetadata.txt` | 기존 requirements + OM 패키지 |
| `docker-compose-openmetadata.yml` | 전체 스택 통합 컴포즈 |

---

### Dockerfile 구성

#### Python 3.8에서 3.10으로 업그레이드

기존 Dockerfile의 base image는 `apache/airflow:2.2.3-python3.8`이었다. `openmetadata-ingestion`은 **Python 3.9+를 요구**하므로 업그레이드가 필요했다.

Airflow 버전도 requirements.txt에서 2.9.3을 설치하고 있었으므로 base image를 일치시켰다.

```dockerfile
# Dockerfile.openmetadata
# 기존: apache/airflow:2.2.3-python3.8
FROM apache/airflow:2.9.3-python3.10

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential gcc && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

USER airflow
COPY config/requirements-openmetadata.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt

COPY local_test/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

`build-essential`과 `gcc`는 `openmetadata-ingestion`의 일부 의존성(예: `grpcio`, `cryptography`)이 wheel이 없을 때 소스 빌드에 필요하다. Airflow 공식 Docker 이미지에서도 [커스텀 패키지 설치 시 동일한 패턴을 권장](https://airflow.apache.org/docs/docker-stack/build.html)한다.

#### requirements 구성

```text
# config/requirements-openmetadata.txt
# 기존 패키지들 (유지)
apache-airflow-providers-postgres
apache-airflow-providers-amazon
# ... (기존 패키지 생략)

# OpenMetadata 통합 패키지
openmetadata-ingestion==1.12.1.0
openmetadata-managed-apis==1.12.1.0
```

> **주의**: 처음에는 `openmetadata-ingestion~=1.6.0`으로 시도했다가 버전 불일치 문제를 겪었다. 버전 번호를 최종적으로 변경한 이유는 아래 "함정 2"에서 설명한다.

<!-- TODO: verify - PyPI에서 패키지명이 openmetadata-managed-apis인지 openmetadata-airflow-managed-apis인지 확인 필요. Context7 docs에서는 openmetadata-airflow-managed-apis로 표기되어 있으나, v1.12.1에서 패키지명이 다를 수 있음 -->

---

### docker-compose 구조

6개 서비스를 단일 compose 파일로 관리한다.

```yaml
# docker-compose-openmetadata.yml (구조 요약)
services:
  airflow-postgres:   # Airflow 메타데이터 DB (PostgreSQL 15)
  airflow:            # Airflow 2.9.3 + openmetadata-ingestion + managed-apis
  om-postgresql:      # OpenMetadata 메타데이터 DB (공식 이미지)
  elasticsearch:      # 검색 엔진 (7.17.24)
  om-migrate:         # DB 스키마 마이그레이션 (one-shot, restart: "no")
  om-server:          # OpenMetadata Server + UI (포트 8585)
```

#### Airflow 환경변수 설정

OM 서버가 Airflow REST API를 호출하여 DAG을 배포하고 실행한다. 이를 위해 Airflow에 인증과 OM 관련 환경변수를 설정해야 한다.

```yaml
# airflow 서비스 환경변수
environment:
  # REST API 인증: basic_auth + session 모두 활성화
  - AIRFLOW__API__AUTH_BACKENDS=airflow.api.auth.backend.basic_auth,airflow.api.auth.backend.session
  # OM managed-apis가 생성하는 DAG 파일 저장 경로
  - AIRFLOW__OPENMETADATA_AIRFLOW_APIS__DAG_GENERATED_CONFIGS=/opt/airflow/dag_generated_configs
  # OM 서버가 Airflow를 찾는 주소 (같은 Docker network)
  - PIPELINE_SERVICE_CLIENT_ENDPOINT=http://airflow:8080
```

`AIRFLOW__API__AUTH_BACKENDS`는 Airflow 2.x에서 REST API 인증을 설정하는 환경변수다. `basic_auth`를 포함해야 OM 서버가 username/password로 Airflow API를 호출할 수 있다.

`PIPELINE_SERVICE_CLIENT_ENDPOINT`는 OM 서버가 Airflow를 찾는 주소다. 같은 Docker network에 있으므로 서비스명(`airflow`)으로 참조한다.

---

### 발견한 함정 3가지

#### 함정 1: Python 버전 -- 3.8은 호환 불가

`openmetadata-ingestion`은 Python 3.9+를 요구한다. 기존 base image인 `apache/airflow:2.2.3-python3.8`에서 설치를 시도하면 빌드 단계에서 실패한다.

```
ERROR: Could not find a version that satisfies the requirement openmetadata-ingestion==1.12.1.0
```

**해결**: base image를 `apache/airflow:2.9.3-python3.10`으로 변경.

추가 효과로, requirements.txt에서 `apache-airflow==2.9.3`을 별도 설치하던 방식에서 base image 버전과 일치하게 되어 설치 충돌이 줄었다.

#### 함정 2: 클라이언트-서버 버전 불일치 (가장 빈번한 실수)

처음에 `openmetadata-ingestion~=1.6.0`을 사용했더니 실제로는 `1.6.13.2`가 설치됐다. OM 서버는 1.12.1인데 클라이언트가 1.6.x이면 연결 시 다음 에러가 발생한다.

```
VersionMismatchException: Server version is 1.12.1 vs. Client version 1.6.13.2
```

OpenMetadata는 **클라이언트와 서버의 major.minor 버전이 반드시 일치**해야 한다. tilde(`~=`) 같은 범위 지정자를 사용하면 의도하지 않은 버전이 설치될 수 있으므로 **정확한 버전을 고정(`==`)**해야 한다.

**해결**: 정확한 버전으로 고정.

```text
# config/requirements-openmetadata.txt (최종)
openmetadata-ingestion==1.12.1.0
openmetadata-managed-apis==1.12.1.0
```

#### 함정 3: Elasticsearch 버전 -- 7.17.x만 정상 동작

이 함정이 가장 많은 시간을 소비했다. 시도한 버전별 결과는 다음과 같다.

| ES 버전 | 결과 | 원인 |
|---|---|---|
| 8.10.2 | Lineage 500 에러 | OM Java 클라이언트가 ES 7.x용, ES 8.x의 content-type 검증과 충돌 |
| 8.15.0 | 동일 | 동일 |
| 7.16.3 | 컨테이너 기동 실패 | Docker Desktop cgroup 호환성 (`NullPointerException`) |
| **7.17.24** | **정상** | OM 1.12.1 공식 지원 버전 |

ES 8.x에서는 Service, Table, TestCase API는 정상 동작하지만 **Lineage PUT에서 500이 반환**됐다. 실제 데이터는 저장되지만 OM UI에서 탐색 시 에러 팝업이 노출되어 사용성이 떨어진다.

> **핵심**: OpenMetadata의 `openmetadata.yaml` 설정에서 `searchType: elasticsearch`로 지정하며, OM 서버의 Java 클라이언트는 ES 7.x API를 전제로 구현되어 있다. ES 8.x는 하위 호환성을 제공하지만 일부 API(특히 Lineage 인덱싱)에서 호환되지 않는 부분이 있다.

```yaml
# docker-compose-openmetadata.yml (elasticsearch 서비스)
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:7.17.24
  environment:
    - discovery.type=single-node
    - ES_JAVA_OPTS=-Xms512m -Xmx512m
    - xpack.security.enabled=false
  ports:
    - "9200:9200"
    - "9300:9300"
```

`discovery.type=single-node`은 단일 노드 개발 환경에서 클러스터 검색을 비활성화한다. `ES_JAVA_OPTS`로 JVM 힙을 제한하지 않으면 Docker Desktop에서 OOM이 발생할 수 있다.

---

### E2E 검증 결과

빌드부터 Lineage 등록까지 전체 흐름을 검증한 결과다.

| 단계 | 결과 | 비고 |
|---|---|---|
| Docker 이미지 빌드 (~60s) | 정상 | |
| Airflow 기동 및 health check | 정상 | |
| `openmetadata-ingestion 1.12.1.0` 설치 확인 | 정상 | `pip show openmetadata-ingestion` |
| `openmetadata_managed_apis` 플러그인 로드 | 정상 | Airflow 로그에서 확인 |
| `OpenLineageProviderPlugin` 자동 로드 | 정상 | openmetadata-ingestion 의존성으로 자동 설치 |
| Airflow 컨테이너에서 OM Server SDK 연결 | 정상 | `metadata.health_check()` |
| REST API: Service/Table (2 services, 6 tables) | 정상 | PUT `/api/v1/services/databaseServices` |
| REST API: Lineage (3 edges) | 정상 | ES 7.17.24에서만 |
| REST API: Test Cases (3 cases) | 정상 | |
| Lineage 검증: `indicator_block` upstream 1개 확인 | 정상 | GET `/api/v1/lineage/...` |

---

### SDK 연결 예시

Airflow 컨테이너 내부에서 SDK로 OM 서버에 연결하는 코드다. OpenMetadata 공식 문서에서 제공하는 JWT 인증 패턴을 그대로 따른다.

```python
# Airflow DAG 또는 컨테이너 내 Python 스크립트
from metadata.ingestion.ometa.ometa_api import OpenMetadata
from metadata.generated.schema.entity.services.connections.metadata.openMetadataConnection import (
    OpenMetadataConnection,
    AuthProvider,
)
from metadata.generated.schema.security.client.openMetadataJWTClientConfig import (
    OpenMetadataJWTClientConfig,
)

# JWT 토큰은 OM UI > Settings > Bots > ingestion-bot에서 복사
server_config = OpenMetadataConnection(
    hostPort="http://om-server:8585/api",   # 같은 Docker network 내 서비스명
    authProvider=AuthProvider.openmetadata,
    securityConfig=OpenMetadataJWTClientConfig(
        jwtToken="eyJhbGciOiJSUzI1NiIs..."  # 실제 토큰으로 교체
    ),
)
metadata = OpenMetadata(server_config)

# 연결 확인
assert metadata.health_check()  # True면 연결 성공
```

`hostPort`는 컨테이너 간 통신이므로 서비스명(`om-server`)을 사용한다. 호스트 머신에서 접근하려면 `http://localhost:8585/api`로 변경하면 된다.

> **참고**: OpenMetadata는 최근 버전에서 새로운 SDK 패턴(`from metadata.sdk import OpenMetadata, OpenMetadataConfig`)도 제공하고 있다. 위 코드는 v1.12.1에서 검증된 안정적인 패턴이다.

---

### REST API로 서비스 등록 시 주의점

소스별로 Connection Config 형식이 다르다. 잘못 보내면 `400 Unrecognized field` 에러가 발생한다. 아래는 실제로 겪은 두 가지 사례다.

#### Databricks -- token 필드 사용 불가 (v1.12.1)

```python
# PUT /api/v1/services/databaseServices
{
    "name": "databricks_prod",
    "serviceType": "Databricks",
    "connection": {"config": {
        "type": "Databricks",
        "hostPort": "dbc-xxxx.cloud.databricks.com:443",
        "httpPath": "/sql/1.0/warehouses/dummy",
        # "token": "..." → v1.12.1에서 Unrecognized field 에러
        # "personalAccessToken": "..." → 마찬가지로 에러
    }}
}
```

v1.12.1 기준으로 `token`과 `personalAccessToken` 필드 모두 `Unrecognized field` 에러가 발생한다. 인증 정보 없이 Service만 등록하고, 스키마는 `databricks unity-catalog` CLI로 별도 export해서 REST API로 직접 등록하는 방식으로 우회했다.

> **Tip**: Service 등록에 필요한 정확한 JSON 스키마는 OM 서버의 `/api/v1/services/databaseServices` 엔드포인트에 잘못된 필드를 보내면 에러 메시지에 허용 필드 목록이 포함된다. 이를 참고하면 버전별 스키마 차이를 빠르게 파악할 수 있다.

#### PostgreSQL -- authType 래퍼 필수

```python
# PUT /api/v1/services/databaseServices
{
    "name": "psql_prod",
    "serviceType": "Postgres",
    "connection": {"config": {
        "type": "Postgres",
        "hostPort": "host.docker.internal:5432",
        "username": "user",
        "authType": {"password": "pass"},   # 최상위에 "password" 직접 전달 불가
        "database": "db",
    }}
}
```

`password`를 최상위에 바로 넣으면 `Unrecognized field "password"` 에러가 발생한다. 반드시 `authType` 객체 안에 감싸야 한다.

---

### 트러블슈팅 가이드

통합 과정에서 만날 수 있는 일반적인 문제와 해결 방법을 정리한다.

| 증상 | 원인 | 해결 |
|---|---|---|
| `VersionMismatchException` | 클라이언트-서버 버전 불일치 | `openmetadata-ingestion=={서버버전}.0`으로 고정 |
| Lineage PUT 500 | ES 8.x 사용 | ES 7.17.x로 다운그레이드 |
| ES 컨테이너 `NullPointerException` | ES 7.16.x + Docker Desktop cgroup 이슈 | ES 7.17.24 사용 |
| OM 서버 기동 후 503 | ES 미기동 또는 연결 실패 | ES health check 후 OM 서버 시작 (depends_on 설정) |
| Airflow 플러그인 미로드 | `openmetadata-managed-apis` 미설치 | requirements에 추가 후 이미지 재빌드 |
| `dag_generated_configs` 디렉토리 없음 | 볼륨 마운트 누락 | Airflow 서비스에 해당 경로 볼륨 추가 |

---

### 최종 아키텍처

```
┌─────────────────────────────────────────────────┐
│  docker-compose-openmetadata.yml                │
│                                                 │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │ airflow-pg   │    │ om-postgresql          │ │
│  │ (Airflow DB) │    │ (OM 메타데이터 DB)      │ │
│  └──────┬───────┘    └──────────┬─────────────┘ │
│         │                       │               │
│  ┌──────┴───────┐    ┌──────────┴─────────────┐ │
│  │ airflow:8080 │←──→│ om-server:8585         │ │
│  │ + managed-apis│   │ (REST API + UI)        │ │
│  │ + ingestion   │   └──────────┬─────────────┘ │
│  │ + openlineage │              │               │
│  └──────────────┘    ┌──────────┴─────────────┐ │
│                       │ elasticsearch 7.17.24  │ │
│                       └────────────────────────┘ │
└─────────────────────────────────────────────────┘

접속:
  Airflow UI:       http://localhost:8080  (admin / test)
  OpenMetadata UI:  http://localhost:8585  (admin@open-metadata.org / admin)
```

화살표(`←→`)는 양방향 통신을 나타낸다. OM 서버는 Airflow REST API를 호출하여 DAG을 배포하고, Airflow의 ingestion DAG은 OM 서버 API를 호출하여 메타데이터를 전송한다.

---

### 정리

기존 Airflow Docker에 OpenMetadata를 통합하는 것은 가능하다. 단, 세 가지 버전 호환성 조건을 반드시 맞춰야 한다.

| 항목 | 요구사항 | 잘못 설정 시 |
|---|---|---|
| Python | 3.9+ (권장 3.10) | 빌드 단계에서 패키지 설치 실패 |
| openmetadata-ingestion | 서버 버전과 major.minor 일치 (`==`로 고정) | `VersionMismatchException` |
| Elasticsearch | 7.17.x | Lineage API 500, UI 에러 팝업 |

이 조건을 맞추면 기존 DAG은 그대로 동작하고, OM UI에서 ingestion pipeline을 생성하면 Airflow에 DAG이 자동으로 배포된다. 별도 ingestion 컨테이너 없이 단일 Airflow로 데이터 파이프라인 오케스트레이션과 메타데이터 수집을 모두 처리할 수 있다.

다음 단계로는 실제 데이터소스(Databricks, PostgreSQL 등)에 대한 ingestion pipeline을 OM UI에서 생성하고, Lineage 자동 수집을 설정하는 것이 자연스럽다.

---

### Reference

- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- [OpenMetadata Docker Deployment Guide](https://docs.open-metadata.org/deployment/docker)
- [openmetadata-ingestion PyPI](https://pypi.org/project/openmetadata-ingestion/)
- [openmetadata-managed-apis PyPI](https://pypi.org/project/openmetadata-managed-apis/)
- [Airflow Docker Image 커스터마이징](https://airflow.apache.org/docs/docker-stack/build.html)
- [Airflow REST API 인증 설정](https://airflow.apache.org/docs/apache-airflow/2.9.3/security/api.html)
- 관련 포스트: [OpenMetadata 로컬 핸즈온 테스트]({% post_url DataEngineering/2026-03-10-openmetadata-hands-on-local-test %})
