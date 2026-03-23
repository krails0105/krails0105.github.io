---
title: "OpenMetadata 로컬 테스트 — Docker에서 서비스 등록부터 리니지, DQ까지"
categories: [DataEngineering]
tags: [OpenMetadata, Data Catalog, Lineage, Data Quality, Docker, REST API, PostgreSQL]
date: 2026-03-10
---

### 이 글에서 다루는 것

데이터 카탈로그/거버넌스 도구인 **OpenMetadata**를 로컬 Docker 환경에서 직접 설치하고, Python stdlib(`urllib` + `json`)만으로 메타데이터 등록 → 리니지 구성 → Data Quality Test Case 설정까지 핸즈온 테스트한 경험을 정리한다.

이전에 DataHub를 테스트했는데, PostgreSQL 지원 여부 및 Kafka 의존성 제거가 관심사였다. OpenMetadata가 그 대안이 될 수 있는지 직접 확인해봤다.

이 글을 읽고 나면 다음을 할 수 있다:

- OpenMetadata를 Docker로 로컬에서 실행하기
- Python stdlib만으로 Service → Database → Schema → Table 계층을 REST API로 등록하기
- 멀티 소스(PostgreSQL, Databricks, BigQuery, StarRocks) 연동 시 각 Connection Config 함정 피하기
- 파이프라인 내부 리니지(Bronze → Silver → Gold)를 REST API로 수동 등록하기
- Data Quality Test Case 정의와 현재 OSS 버전 한계 파악하기

> **테스트 환경**: OpenMetadata **v1.12.1**, Docker Desktop for Mac, Python 3.12

---

### 사전 준비

| 항목 | 요구 사항 |
|---|---|
| Docker Desktop | 4.x 이상, 메모리 **4 GB 이상** 할당 권장 |
| Python | 3.10+ (stdlib만 사용하므로 추가 패키지 불필요) |
| 디스크 | Docker 이미지 약 3 GB |
| (선택) SSH 터널 | AWS RDS 등 외부 DB 연동 시 필요 |
| (선택) Databricks CLI | Unity Catalog 스키마 export 시 필요 (`databricks unity-catalog`) |

---

### 배경: 왜 OpenMetadata를 테스트했나

데이터 파이프라인이 여러 소스에 걸쳐 복잡해지면 다음 문제가 생긴다:

1. **데이터 출처 불투명**: "이 메트릭 테이블은 어디서 왔어?" — 문서가 없으면 아는 사람이 없다.
2. **다운스트림 영향 파악 불가**: 업스트림을 수정하면 어떤 테이블이 깨지는지 모른다.
3. **스키마 변경 추적 부재**: 컬럼이 언제 추가됐는지, deprecated 컬럼이 아직 쓰이는지 알 수 없다.

OpenMetadata는 이런 문제를 해결하는 오픈소스 **데이터 카탈로그 + 리니지 + 데이터 품질** 플랫폼이다. DataHub와 동일한 포지션이지만 구조가 다르다 — Kafka가 없고, PostgreSQL을 공식 지원한다.

---

### Docker 실행 (PostgreSQL 버전)

OpenMetadata는 두 가지 Docker Compose 파일을 제공한다. MySQL 버전과 PostgreSQL 버전이 있는데, 여기서는 PostgreSQL 버전을 사용했다.

#### 컨테이너 구성

```bash
# docker-compose-postgres.yml 기준
docker compose -f docker-compose-postgres.yml up -d
```

총 4개 컨테이너가 뜬다:

| 컨테이너 | 역할 | 메모리 |
|---|---|---|
| `openmetadata-server` | REST API 서버 + 웹 UI | ~1.2 GB |
| `postgresql` | 메타데이터 영구 저장 | ~200 MB |
| `elasticsearch` | 전문 검색 (메타데이터 인덱싱) | ~700 MB |
| `ingestion` | Airflow 기반 수집 스케줄러 | ~500 MB |

DataHub(6개 컨테이너: Kafka + ZooKeeper + MySQL + OpenSearch + GMS + Frontend)에 비해 구성이 단순하다.

접속: `http://localhost:8585` — 기본 계정 `admin@open-metadata.org` / `admin`

#### 메모리 부족 시 대응

로컬에서 RAM이 빠듯하다면 ingestion 컨테이너를 정지하면 약 500 MB를 확보할 수 있다. REST API로 메타데이터를 직접 등록하는 방식을 쓸 경우 ingestion 컨테이너는 필수가 아니다. 단, Data Quality 테스트를 Airflow로 실행하려면 ingestion 컨테이너가 필요하다.

```bash
docker stop openmetadata_ingestion
```

#### Elasticsearch OOM 이슈

Elasticsearch가 메모리 부족으로 `exit 137`(OOM Kill)로 종료되는 경우가 있다. `docker-compose-postgres.yml`의 Elasticsearch 서비스에 힙 크기를 명시적으로 제한하면 안정적으로 동작한다:

```yaml
# docker-compose-postgres.yml (elasticsearch 서비스 하위)
environment:
  - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
```

이 설정으로 Elasticsearch의 JVM 힙을 512 MB로 고정하면 Docker Desktop 메모리 4 GB 환경에서도 안정적으로 실행된다.

---

### REST API 인증

OpenMetadata는 모든 API 호출에 **JWT Bearer 토큰**이 필요하다. 토큰 발급은 로그인 API를 통해 이루어진다.

```python
# openmetadata_api.py
import json
import base64
import urllib.parse
import urllib.request
import urllib.error

BASE_URL = "http://localhost:8585/api/v1"

def get_token():
    """로그인 API로 JWT 토큰을 발급받는다."""
    # 패스워드는 base64 인코딩 필수 (plain text 불가)
    pw = base64.b64encode(b"admin").decode()
    body = json.dumps({
        "email": "admin@open-metadata.org",
        "password": pw,
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/users/login",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["accessToken"]

TOKEN = get_token()
```

DataHub는 `acryl-datahub` SDK가 인증을 추상화하지만, OpenMetadata는 표준 HTTP Bearer 인증이라서 외부 라이브러리가 전혀 필요하지 않다.

> **참고**: OpenMetadata는 공식 Python SDK(`openmetadata-ingestion`)도 제공한다. 하지만 이 글에서는 REST API 구조 자체를 이해하기 위해 의도적으로 stdlib만 사용했다.

---

### API 헬퍼 함수

REST API를 반복 호출하기 위한 범용 헬퍼 함수를 만든다. 두 가지 함정을 미리 처리해둔다.

```python
# openmetadata_api.py (계속)
def api(method, path, data=None):
    """OpenMetadata REST API를 호출하고 JSON 응답을 반환한다."""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}  # lineage PUT은 빈 body 반환
    except urllib.error.HTTPError as e:
        if e.code == 409:  # Conflict = already exists → 멱등성 보장
            return {}
        raise
```

처리하는 두 가지 함정:

- **lineage PUT 빈 body**: 리니지 등록 성공 시 응답 body가 비어있다. `json.loads("")`는 `JSONDecodeError`가 발생하므로 `if raw` 분기가 필수다.
- **409 Conflict**: 이미 존재하는 엔티티에 PUT을 보내면 409가 온다. PUT이 upsert 의미론이 아니라 create-only인 경우가 있어서, 멱등성을 위해 409를 무시하도록 처리한다.

---

### 메타데이터 등록: Service → Database → Schema → Table

OpenMetadata의 계층 구조는 **Service → Database → Schema → Table**이다. 하위 엔티티는 상위 엔티티를 **FQN(Fully Qualified Name)**으로 참조한다.

```
Service (my-databricks)
  └── Database (my_catalog)
       └── Schema (gold)
            ├── Table (metric_table)
            └── Table (daily_summary)
```

#### 1단계: Service 등록

Service는 데이터 소스의 연결 정보를 나타낸다. `PUT /services/databaseServices`로 등록한다.

```python
api("PUT", "/services/databaseServices", {
    "name": "my-databricks",
    "serviceType": "Databricks",
    "connection": {
        "config": {
            "type": "Databricks",
            "hostPort": "adb-xxxx.azuredatabricks.net:443",
            "httpPath": "/sql/1.0/warehouses/xxxx",
        }
    },
})
```

#### 2단계: Database 등록

```python
api("PUT", "/databases", {
    "name": "my_catalog",
    "service": "my-databricks",  # Service의 name = FQN
})
```

#### 3단계: Schema 등록

```python
api("PUT", "/databaseSchemas", {
    "name": "gold",
    "database": "my-databricks.my_catalog",  # service.database 형식의 FQN
})
```

#### 4단계: Table 등록

```python
api("PUT", "/tables", {
    "name": "metric_table",
    "databaseSchema": "my-databricks.my_catalog.gold",  # service.database.schema FQN
    "columns": [
        {"name": "id",           "dataType": "INT",       "description": "PK"},
        {"name": "created_at",   "dataType": "TIMESTAMP", "description": "생성 시각"},
        {"name": "metric_value", "dataType": "DOUBLE",    "description": "지표 값"},
    ],
})
```

FQN은 `.`으로 구분하는 `service.database.schema.table` 형식이다. 계층을 올바르게 이어주지 않으면 테이블이 UI에서 고아 엔티티(orphan)로 나타나므로 주의해야 한다.

> **PUT vs POST**: OpenMetadata REST API에서 Service/Database/Schema/Table 생성은 `PUT`을 사용한다. 공식 문서의 curl 예제에서는 `POST`를 사용하는 경우도 있는데, `PUT`은 name 기반 idempotent create로 동작한다. 이미 같은 name이 존재하면 409를 반환한다.

---

### 멀티 소스 연동 — Connection Config 함정

실제 데이터 소스를 연동할 때 각 소스별로 Connection Config 형식이 다르다. 잘못 보내면 `400 Unrecognized field` 에러가 난다. 소스별로 동작하는 설정 형식을 정리한다.

#### PostgreSQL — authType 래퍼 필수

```python
{
    "type": "Postgres",
    "hostPort": "localhost:5432",
    "username": "myuser",
    "authType": {"password": "mypassword"},  # 직접 "password" 필드 사용 불가
    "database": "mydb",
}
```

`password` 필드를 최상위에 직접 넣으면 `Unrecognized field "password"` 에러가 난다. 반드시 `authType` 객체 안에 넣어야 한다.

> **Docker 네트워크 주의**: 컨테이너 내부에서 `localhost`는 컨테이너 자신을 가리킨다. 호스트 머신의 DB에 접근하려면 `host.docker.internal`을 사용해야 한다.

```python
"hostPort": "host.docker.internal:15432",  # 호스트 머신의 SSH 터널 포트
```

#### Databricks — token 필드 미지원 (v1.12.1)

```python
{
    "type": "Databricks",
    "hostPort": "adb-xxxx.azuredatabricks.net:443",
    "httpPath": "/sql/1.0/warehouses/xxxx",
    # "token" 또는 "personalAccessToken" → v1.12.1 기준 Unrecognized
}
```

`token`, `personalAccessToken` 필드 모두 v1.12.1에서 `Unrecognized field` 에러가 발생했다. Connection Config에 인증 정보를 넣지 않고 `hostPort` + `httpPath`만 전달하면 Service는 등록된다. 실제 Ingestion은 불가능하지만, 스키마를 CLI(`databricks unity-catalog`)로 별도 export한 뒤 REST API로 직접 등록하는 방식으로 우회할 수 있다.

<!-- TODO: verify - 최신 버전(v1.5.x)에서 Databricks token 필드 지원 여부 확인 필요 -->

#### BigQuery — gcpConfig 중첩 구조

```python
{
    "type": "BigQuery",
    "credentials": {
        "gcpConfig": {
            "type": "service_account",
            "project_id": "my-project",
            "private_key_id": "...",
            "private_key": "-----BEGIN PRIVATE KEY-----\n...",
            "client_email": "sa@my-project.iam.gserviceaccount.com",
        }
    },
}
```

GCP Service Account JSON 키 파일의 내용을 `credentials.gcpConfig` 안에 그대로 넣는 구조다.

#### StarRocks — MySQL 프로토콜로 연결

StarRocks는 MySQL 호환 프로토콜을 사용한다. OpenMetadata에 별도 StarRocks 커넥터가 없으므로, Service 타입을 `Mysql`로 등록하면 된다.

```python
api("PUT", "/services/databaseServices", {
    "name": "my-starrocks",
    "serviceType": "Mysql",
    "connection": {
        "config": {
            "type": "Mysql",
            "hostPort": "host.docker.internal:9030",  # StarRocks FE query port
            "username": "root",
            "authType": {"password": ""},
        }
    },
})
```

#### dataType 매핑 — TIMESTAMPTZ 미지원

OpenMetadata는 `TIMESTAMPTZ` 타입을 지원하지 않는다. PostgreSQL의 `TIMESTAMPTZ` 컬럼을 등록할 때는 `TIMESTAMP`로 매핑해야 한다.

```python
# PostgreSQL → OpenMetadata dataType 매핑
TYPE_MAP = {
    "bigint": "BIGINT",
    "integer": "INT",
    "double precision": "DOUBLE",
    "timestamp with time zone": "TIMESTAMP",  # TIMESTAMPTZ → TIMESTAMP
    "text": "TEXT",
    "boolean": "BOOLEAN",
    "numeric": "NUMERIC",
}
```

지원하는 전체 dataType 목록은 [OpenMetadata OpenAPI spec](https://sandbox.open-metadata.org/swagger.html)의 `Column` 스키마에서 확인할 수 있다.

---

### 실제 데이터소스 일괄 등록

앞서 정의한 `api()` 헬퍼와 Connection Config를 조합하면 여러 소스의 스키마를 일괄 등록할 수 있다.

#### PostgreSQL RDS (SSH 터널 경유)

AWS RDS는 VPC 내부에 있어 직접 연결이 불가능하므로 SSH 터널을 사용했다:

```bash
# bastion 호스트를 경유하여 로컬 15432 포트로 RDS에 접근
ssh -L 15432:rds-host.rds.amazonaws.com:5432 bastion-host -N &
```

터널이 열리면 `localhost:15432`로 접속 가능하다. Docker 컨테이너 내부에서는 `host.docker.internal:15432`로 접근한다.

psycopg2로 `information_schema`에서 스키마를 추출한 뒤 REST API로 등록했다. 테이블당 30~40개 컬럼이 자동으로 등록된다.

#### Databricks Unity Catalog (CLI export → 일괄 등록)

Databricks Connection Config의 token 필드 이슈로 Ingestion 자동화가 막혔다. 대신 CLI로 스키마를 export했다:

```bash
# Unity Catalog에서 테이블 목록과 스키마를 JSON으로 export
databricks unity-catalog tables list \
  --catalog my_catalog --schema gold \
  | jq '.[]' > tables.json
```

126개 MANAGED 테이블 중 `ARRAY` 타입을 가진 4개 테이블만 실패했다. OpenMetadata가 `ARRAY<STRUCT<...>>` 같은 중첩 타입을 파싱하지 못하기 때문이다. 나머지 122개는 정상 등록됐다.

#### BigQuery (bq CLI export)

```bash
bq show --format=prettyjson --schema my-project:my_dataset.my_table
```

26개 테이블을 export해서 일괄 등록했다. BigQuery는 Connection Config에 인증 정보가 포함되므로 Ingestion 자동화도 가능하지만, 이번 테스트에서는 CLI export 방식으로 통일했다.

---

### 리니지 등록

파이프라인 내부 데이터 흐름을 리니지로 등록하면 UI에서 상하류 탐색이 가능해진다. OpenMetadata의 리니지 API는 `PUT /lineage`로 엣지를 하나씩 추가하는 방식이다.

```python
def register_lineage(from_fqn, to_fqn):
    """두 테이블 간 리니지 엣지를 등록한다."""
    # 1. FQN으로 테이블 ID 조회 (FQN에 .이 포함되므로 URL 인코딩 필수)
    src = api("GET", f"/tables/name/{urllib.parse.quote(from_fqn, safe='')}?fields=id")
    dst = api("GET", f"/tables/name/{urllib.parse.quote(to_fqn,  safe='')}?fields=id")

    # 2. 리니지 엣지 등록 (성공 시 응답 body가 비어 있음)
    api("PUT", "/lineage", {
        "edge": {
            "fromEntity": {"id": src["id"], "type": "table"},
            "toEntity":   {"id": dst["id"], "type": "table"},
        }
    })

# 예시: Bronze → Gold 파이프라인 리니지
edges = [
    ("my-service.catalog.bronze.raw_data",      "my-service.catalog.gold.base_table"),
    ("my-service.catalog.gold.base_table",       "my-service.catalog.gold.events_table"),
    ("my-service.catalog.gold.events_table",     "my-service.catalog.gold.snapshot_table"),
    ("my-service.catalog.gold.snapshot_table",    "my-service.catalog.gold.distribution_table"),
    ("my-service.catalog.gold.events_table",     "my-service.catalog.gold.metric_table"),
]

for from_fqn, to_fqn in edges:
    register_lineage(from_fqn, to_fqn)
    print(f"  {from_fqn} -> {to_fqn}")
```

35개 내부 리니지 엣지를 등록한 결과, 중간 테이블의 **upstream 10개, downstream 26개**가 UI에서 그래프로 표시됐다. 특정 테이블을 수정하면 어떤 하류 테이블이 영향받는지 한눈에 파악할 수 있다.

등록된 리니지를 조회할 때는 `GET /lineage/table/name/{fqn}`을 사용한다. `upstreamDepth`와 `downstreamDepth` 파라미터로 탐색 깊이를 조절할 수 있다(기본값 3).

```python
# 특정 테이블의 리니지 그래프 조회 (upstream 2단계, downstream 2단계)
fqn = urllib.parse.quote("my-service.catalog.gold.events_table", safe="")
lineage = api("GET", f"/lineage/table/name/{fqn}?upstreamDepth=2&downstreamDepth=2")
print(f"upstream edges:   {len(lineage.get('upstreamEdges', []))}")
print(f"downstream edges: {len(lineage.get('downstreamEdges', []))}")
```

---

### Data Quality Test Case 정의

OpenMetadata의 Data Quality는 **Test Definition(템플릿) → Test Case(인스턴스) → Test Result(실행 결과)** 3계층으로 구성된다.

#### 사용 가능한 Test Definition 조회

먼저 어떤 테스트를 정의할 수 있는지 확인한다. `tableRowCountToBeGreaterThan` 같은 직관적인 이름의 definition은 v1.12.1에 존재하지 않았다.

```python
# 지원하는 Test Definition 목록 조회
definitions = api("GET", "/dataQuality/testDefinitions?limit=100")
for d in definitions["data"]:
    print(f"  {d['name']:45s} {d['entityType']}")

# 출력 예시 (v1.12.1):
#   tableRowCountToBeBetween                       TABLE
#   columnValuesToBeNotNull                         COLUMN
#   columnValuesToBeBetween                         COLUMN
#   ...
```

#### Test Case 등록

```python
def create_test_case(table_fqn, test_name, definition, params):
    """테이블에 Data Quality Test Case를 등록한다."""
    api("POST", "/dataQuality/testCases", {
        "name": test_name,
        "entityLink": f"<#E::table::{table_fqn}>",
        "testDefinition": definition,
        "parameterValues": params,
    })

# 예시 1: row count 최솟값 체크
create_test_case(
    table_fqn="my-service.catalog.gold.metric_table",
    test_name="metric_table_row_count_check",
    definition="tableRowCountToBeBetween",
    params=[{"name": "minValue", "value": "1000"}],  # maxValue 생략 = 상한 없음
)

# 예시 2: 컬럼 null 체크
create_test_case(
    table_fqn="my-service.catalog.gold.metric_table",
    test_name="metric_value_not_null",
    definition="columnValuesToBeNotNull",
    params=[],
)
```

> **주의**: `entityLink`의 형식 `<#E::table::FQN>`은 OpenMetadata 고유 문법이다. 오타가 있으면 `400 Bad Request`가 발생하며, 에러 메시지가 직관적이지 않으므로 형식을 정확히 지켜야 한다.

#### DQ 결과 push는 현재 제한적

REST API로 Test Case 정의는 가능하지만, **결과를 직접 push하는 API가 v1.12.1에서 동작하지 않았다.** OpenMetadata의 DQ 실행은 ingestion 컨테이너(Airflow)를 통해 수행하도록 설계되어 있다.

외부에서 결과를 push하는 `/dataQuality/testCases/{id}/testCaseResult` API는 응답은 오지만 UI에 반영되지 않았다. 공식 문서상으로는 지원하나, 현재 버전에서는 Airflow 경유가 사실상 필수다.

**현실적인 DQ 아키텍처:**

```
외부 스케줄러 (Airflow / Databricks Jobs)
  → 데이터 품질 체크 실행 (row count, freshness, cross-table sync 등)
  → OpenMetadata ingestion 컨테이너가 결과를 수집하여 UI에 반영
```

Test Case 정의만 REST API로 등록해 두고, 실행과 결과 반영은 ingestion 컨테이너에 위임하는 것이 현재 동작하는 방식이다. 외부에서 DQ 결과를 직접 push하고 싶다면 Soda Core 같은 별도 프레임워크와 조합하는 것이 현실적이다.

---

### 트러블슈팅 정리

로컬 테스트 중 만난 함정을 정리한다.

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | `JSONDecodeError` on lineage PUT | 리니지 등록 성공 시 응답 body가 비어 있음 | `if raw` 분기로 빈 body 처리 |
| 2 | 테이블 GET 시 404 | FQN의 `.`이 URL 경로 구분자로 해석됨 | `urllib.parse.quote(fqn, safe='')` |
| 3 | Databricks `Unrecognized field "token"` | v1.12.1에서 token 필드 미지원 | `hostPort` + `httpPath`만 전달, CLI export로 우회 |
| 4 | Table PUT 시 `ARRAY` 타입 400 에러 | `ARRAY<STRUCT<...>>` 중첩 타입 파싱 실패 | 해당 컬럼을 `ARRAY`로 단순화하거나 건너뜀 |
| 5 | PostgreSQL `Unrecognized field "password"` | password를 최상위에 직접 설정 | `authType: {"password": "..."}` 래퍼 사용 |
| 6 | Elasticsearch `exit 137` | OOM Kill (기본 힙이 너무 큼) | `ES_JAVA_OPTS=-Xms512m -Xmx512m` 설정 |

---

### DataHub와의 비교

같은 포지션의 도구인 DataHub와 구조적 차이를 정리한다.

| 항목 | DataHub | OpenMetadata |
|---|---|---|
| 메타데이터 DB | MySQL 전용 | **PostgreSQL 지원** |
| 메시지 큐 | Kafka 필수 | 불필요 |
| 검색 엔진 | OpenSearch | Elasticsearch |
| Python SDK 의존성 | `acryl-datahub` SDK 필수 | stdlib(`urllib` + `json`)으로 충분 |
| DQ 결과 push (OSS) | REST Emitter로 가능 | ingestion 컨테이너 경유 필요 |
| 컨테이너 수 | 6개 | 4개 |
| 최소 운영 비용 (AWS) | ~$280/월 | ~$100~150/월 |

DataHub는 DQ 결과 push의 유연성과 커뮤니티 규모에서 앞선다. OpenMetadata는 인프라 단순성과 PostgreSQL 네이티브 지원에서 장점이 있다.

---

### 정리

OpenMetadata 로컬 테스트의 핵심 결론:

| 항목 | 판단 |
|---|---|
| **설치 단순성** | 4개 컨테이너, Kafka 없음 — DataHub보다 가볍다 |
| **REST API 친화성** | stdlib만으로 전체 워크플로 수행 가능 — SDK 의존성 없음 |
| **리니지 시각화** | 상하류 그래프 탐색 기능은 DataHub와 동급 |
| **멀티 소스 Connection Config** | 소스마다 다른 형식 함정 — OpenAPI spec 확인 필수 |
| **Data Quality** | Test Case 정의는 API로 가능, 실행/반영은 ingestion 컨테이너 필요 |
| **적합한 환경** | PostgreSQL + Elasticsearch 기반 인프라, Kafka를 피하고 싶은 팀 |

DataHub가 거버넌스 성숙도와 커뮤니티 규모에서 앞서지만, OpenMetadata는 **인프라 단순성과 PostgreSQL 친화성**에서 뚜렷한 장점이 있다. 기존에 PostgreSQL RDS를 운영 중이라면 OpenMetadata가 훨씬 현실적인 선택이다.

---

### Reference

- [OpenMetadata 공식 문서](https://docs.open-metadata.org/)
- [OpenMetadata Docker 설치 가이드](https://docs.open-metadata.org/v1.4.x/quick-start/local-docker-deployment)
- [OpenMetadata REST API 레퍼런스 (Swagger)](https://sandbox.open-metadata.org/swagger.html)
- [OpenMetadata Data Quality 가이드](https://docs.open-metadata.org/v1.4.x/how-to-guides/data-quality-observability)
- [OpenMetadata GitHub](https://github.com/open-metadata/OpenMetadata)
- 관련 포스트: [DataHub 로컬 핸즈온 테스트]({% post_url DataEngineering/2026-03-10-datahub-hands-on-local-test %})
