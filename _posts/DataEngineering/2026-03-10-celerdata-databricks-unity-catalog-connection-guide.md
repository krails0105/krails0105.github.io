---
title: "CelerData Cloud + Databricks Unity Catalog 연결 가이드 -- 설정부터 Materialized View까지"
categories: [DataEngineering]
tags: [CelerData, StarRocks, Databricks, Unity Catalog, Delta Lake, S3, Materialized View, External Catalog, HTTP SQL API]
date: 2026-03-23
---

## 이 글에서 다루는 것

**CelerData Cloud**(StarRocks 관리형 서비스)를 **Databricks Unity Catalog**와 연결해 Delta Lake 테이블을 직접 쿼리하고 Materialized View를 만드는 전체 과정을 정리한다.

공식 문서에는 설정값 목록만 나열되어 있고, 실제로 연결하다 보면 PAT 토큰 오류, S3 권한 부족, MV 생성 실패 같은 문제가 순서대로 튀어나온다. 이 글은 그 트러블슈팅 과정을 **에러 -> 원인 -> 해결** 순서로 정리한 실전 기록이다.

**이 글을 읽고 나면:**
- CelerData Cloud 클러스터 초기 설정과 계정 구조를 이해할 수 있다
- Unity Catalog External Catalog 연결 시 발생하는 S3 권한 문제를 해결할 수 있다
- External Catalog 테이블 기반으로 Async Materialized View를 만들 수 있다
- pymysql, HTTP SQL API로 CelerData에 쿼리하는 방법을 알 수 있다

### 사전 요구사항

| 항목 | 값 |
|---|---|
| CelerData | Cloud (BYOC, VPC Peering 완료) |
| Databricks | Unity Catalog 활성화 |
| 데이터 소스 | Delta Lake on S3 |
| 네트워크 | CelerData와 Databricks가 같은 VPC 또는 Peering 연결 |
| Databricks PAT | Settings > Developer > Access tokens에서 발급 |

---

## 1. CelerData Cloud 클러스터 초기 설정

### 계정 구조 이해하기

CelerData에는 두 레벨의 접근 권한이 있다.

| 구분 | 역할 | 관리 방법 |
|---|---|---|
| **Organization/Account** | Cloud Manager 웹 UI 접근. 클러스터 생성, 모니터링, 설정 | Cloud Manager에서 초대 |
| **DB User** | SQL 클라이언트로 데이터베이스에 실제 접속 | `CREATE USER` SQL로 생성 |

Account는 dev/prod 환경을 분리하는 단위이고, User는 같은 Account 내에서 DB 접속 권한을 분리하는 단위다.

처음에 이 둘을 혼동하기 쉽다. Cloud Manager에 초대한다고 DB 접속 권한이 생기는 게 아니고, `CREATE USER`로 DB 계정을 만든다고 Cloud Manager에 로그인할 수 있는 게 아니다.

### 기본 계정으로 첫 로그인

클러스터 생성 직후 접속 정보:

| 항목 | 값 |
|---|---|
| 호스트 | Cloud Manager > Connection 탭에서 확인 |
| 포트 | `9030` (MySQL 프로토콜 호환) |
| 기본 계정 | `admin` |
| 비밀번호 | 클러스터 생성 시 설정한 값 (분실 시 Cloud Manager > Connection > Reset password) |

PoC 단계에서는 `admin` 하나로 충분하다. 프로덕션 전환 시점에 역할별로 계정을 분리하는 것을 권장한다.

```sql
-- 프로덕션 계정 분리 예시
CREATE USER etl_user IDENTIFIED BY '...';
CREATE USER api_readonly IDENTIFIED BY '...';

GRANT SELECT ON my_mv_db.* TO api_readonly;
GRANT ALL ON my_mv_db.* TO etl_user;
```

---

## 2. Databricks Unity Catalog 연결 (External Catalog)

### External Catalog이란

StarRocks/CelerData의 External Catalog은 외부 데이터 소스를 로컬 테이블처럼 쿼리할 수 있게 해주는 기능이다. 데이터를 복사해오는 것이 아니라, 메타데이터(스키마, 파티션 정보)는 외부 메타스토어(Unity Catalog)에서 읽고, 실제 데이터는 S3에서 직접 읽는 구조다.

StarRocks 공식 문서 기준으로 Delta Lake External Catalog을 SQL로 생성할 때의 문법은 다음과 같다.

```sql
CREATE EXTERNAL CATALOG <catalog_name>
[COMMENT <comment>]
PROPERTIES
(
    "type" = "deltalake",
    -- MetastoreParams (Hive Metastore, AWS Glue 등)
    -- StorageCredentialParams (S3 인증)
    -- MetadataUpdateParams (캐시 TTL 등)
);
```

CelerData Cloud Manager에서는 UI를 통해 이 과정을 대신 처리해준다.

### Cloud Manager UI에서 생성하기

CelerData Cloud Manager UI에서 **External Catalog**를 생성한다.

| 설정 항목 | 값 | 설명 |
|---|---|---|
| Catalog type | Databricks Unity Catalog | 내부적으로 `type = "deltalake"` |
| Catalog name | `my_catalog` | CelerData에서 사용할 카탈로그 이름 |
| Databricks host | `https://dbc-xxxxx.cloud.databricks.com` | Workspace URL |
| Access token | `dapi...` 형식 | Databricks PAT |
| Unity Catalog name | `my_catalog` | Databricks 쪽 실제 카탈로그 이름 |

내부적으로는 `type = "deltalake"`, `hive.metastore.type = "unity"`로 설정된다. StarRocks/CelerData의 Delta Lake 커넥터가 Unity Catalog REST API를 통해 메타데이터를 읽는 구조다.

### 트러블슈팅 1: PAT 토큰 인증 오류

**증상**: External Catalog 생성 시 인증 오류 발생

**원인**: Databricks PAT가 만료되었거나, 잘못된 토큰을 입력한 경우

**해결**:
1. Databricks workspace > Settings > Developer > Access tokens에서 기존 토큰 상태 확인
2. 만료된 경우 기존 토큰 폐기 후 재발급
3. 토큰이 `dapi...` 형식인지 확인 (Databricks PAT는 항상 `dapi` 접두사)
4. CelerData Cloud Manager에서 External Catalog 설정의 토큰 업데이트

> PAT에는 만료 기한이 있다. 프로덕션 환경이라면 만료 알림을 설정하거나, Service Principal 기반 인증으로 전환하는 것을 권장한다.

---

## 3. S3 접근 권한 문제 해결

External Catalog 연결이 성공해도 실제 쿼리 시 에러가 발생하는 경우가 있다. 이 부분이 가장 흔하게 막히는 지점이다.

### 데이터 접근 경로: 메타데이터 vs 실제 데이터

External Catalog을 통한 쿼리에는 두 단계의 데이터 접근이 있다.

```
SELECT 쿼리 실행
  |
  +-- 1단계: 메타데이터 (Unity Catalog REST API)
  |     - 테이블 스키마, 파티션 목록, 파일 경로
  |     - PAT 토큰으로 인증 --> External Catalog 설정에 포함
  |
  +-- 2단계: 실제 데이터 (S3 직접 읽기)
        - Delta/Parquet 파일
        - CelerData 클러스터의 IAM role로 인증 --> 별도 권한 필요
```

이 구조 때문에 `SHOW TABLES`는 되지만 `SELECT`는 실패하는 상황이 발생한다.

### 트러블슈팅 2: SHOW TABLES는 되지만 SELECT는 안 됨

**증상**:
```sql
-- 이건 됨 (메타데이터만 조회)
SHOW TABLES IN my_catalog.my_schema;

-- 이건 에러 (S3에서 파일을 읽어야 함)
SELECT * FROM my_catalog.my_schema.my_table LIMIT 10;
-- Error: Access Denied on S3 bucket
```

**원인**: `SHOW TABLES`는 Unity Catalog API만 호출하므로 PAT 토큰으로 충분하지만, `SELECT`는 S3에서 Delta 파일을 실제로 읽어야 하므로 CelerData 클러스터의 IAM role에 해당 S3 버킷 접근 권한이 없으면 실패한다.

**해결**:

**1단계 -- S3 데이터 경로 확인:**

```sql
-- Databricks notebook에서 실행
DESCRIBE DETAIL my_catalog.my_schema.my_table;
-- location 컬럼 확인: s3://my-databricks-bucket/unity-catalog/...
```

**2단계 -- CelerData IAM role 확인:**

Cloud Manager > Cluster > IAM Role 섹션에서 ARN 확인

**3단계 -- IAM 정책에 S3 권한 추가:**

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject",
    "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::my-databricks-bucket",
    "arn:aws:s3:::my-databricks-bucket/*"
  ]
}
```

`s3:ListBucket`은 버킷 리소스에, `s3:GetObject`는 객체 리소스(`/*`)에 각각 지정해야 한다. 이 부분을 혼동하면 정책이 적용되지 않는다.

권한 추가 후 `SELECT` 재시도하면 정상 동작한다.

---

## 4. Async Materialized View 생성

External Catalog 테이블을 기반으로 Materialized View(MV)를 만들면, S3 데이터를 매번 읽지 않고 CelerData 내부 스토리지에 캐싱된 결과를 쿼리할 수 있다. 이것이 CelerData를 도입하는 핵심 이유다.

### 로컬 카탈로그/DB 준비

MV는 항상 CelerData의 **로컬 카탈로그**(= `default_catalog`)에 생성해야 한다. External Catalog에 직접 MV를 만들 수 없다.

```sql
SET CATALOG default_catalog;
CREATE DATABASE IF NOT EXISTS my_mv_db;
```

### StarRocks Async MV 문법

StarRocks/CelerData의 Async Materialized View 전체 문법은 다음과 같다.

```sql
CREATE MATERIALIZED VIEW [IF NOT EXISTS] [database.]<mv_name>
[COMMENT ""]
[DISTRIBUTED BY HASH(<bucket_key>) [BUCKETS <bucket_number>]]
[REFRESH
    [IMMEDIATE | DEFERRED]
    [ASYNC | ASYNC [START (<start_time>)] EVERY (INTERVAL <refresh_interval>) | MANUAL]
]
[PARTITION BY {<date_column> | date_trunc(fmt, <date_column>)}]
[ORDER BY (<sort_key>)]
[PROPERTIES ("key"="value", ...)]
AS
<query_statement>
```

주요 갱신 방식:
- `REFRESH ASYNC`: 기반 테이블 변경 시 자동 갱신
- `REFRESH ASYNC EVERY (INTERVAL 1 HOUR)`: 주기적 갱신
- `REFRESH MANUAL`: 수동 트리거만

### 트러블슈팅 3: JOIN 포함 MV 생성 실패

**증상**:
```sql
CREATE MATERIALIZED VIEW my_mv_db.mv_sample_metric_day
AS SELECT ... FROM t1 JOIN t2 ON ...;
-- Error: Materialized view with joins must use REFRESH ASYNC
```

**원인**: JOIN이 포함된 MV는 기반 테이블의 변경을 추적하기 어렵기 때문에, StarRocks에서는 비동기 갱신 전략을 명시하도록 요구한다. 갱신 방식 없이 MV를 생성하면 기본값이 동기식으로 시도되어 실패한다.

**해결**: `REFRESH ASYNC EVERY (INTERVAL N HOUR)` 절을 추가하여 주기적 비동기 갱신을 명시한다.

### 구현 예시: estimated_leverage_ratio MV

두 테이블을 JOIN하여 파생 지표를 계산하는 Async MV 예시다.

- **테이블 A**: `my_catalog.schema_a.metrics_day` (일별 지표)
- **테이블 B**: `my_catalog.schema_b.summary_day` (일별 요약)
- **공식**: `sample_ratio = value_a / value_b`

```sql
SET CATALOG default_catalog;

CREATE MATERIALIZED VIEW my_mv_db.mv_sample_metric_day
REFRESH ASYNC EVERY (INTERVAL 1 HOUR)
AS
SELECT
    r.datetime,
    r.id,
    o.name,
    ROUND(o.value_a / r.value_b, 8) AS sample_ratio
FROM my_catalog.schema_b.summary_day r
JOIN my_catalog.schema_a.metrics_day o
    ON r.datetime = o.datetime
    AND r.id = o.id;
```

JOIN key로 `datetime`과 `id`를 함께 쓴다.

> `value_b = 0`인 경우 Division by Zero가 발생한다. 프로덕션에서는 `NULLIF(r.value_b, 0)` 또는 `CASE WHEN` 방어가 필요하다.

### MV 상태 확인 및 수동 갱신

```sql
-- MV 갱신 상태 확인
SHOW MATERIALIZED VIEWS FROM my_mv_db;

-- 수동 갱신 트리거
REFRESH MATERIALIZED VIEW my_mv_db.mv_sample_metric_day;

-- 갱신 주기 변경
ALTER MATERIALIZED VIEW my_mv_db.mv_sample_metric_day
REFRESH ASYNC EVERY (INTERVAL 30 MINUTE);
```

---

## 5. 외부에서 CelerData 쿼리하기

CelerData는 MySQL 프로토콜(포트 9030)과 HTTP SQL API(포트 8030)를 지원한다. Private subnet에 배포된 경우 같은 VPC 내 서비스에서만 접근 가능하다.

### 접속 방법 비교

| 방법 | 포트 | 프로토콜 | 용도 |
|---|---|---|---|
| pymysql | 9030 | MySQL | 단순 쿼리, 스크립트, 테스트 |
| SQLAlchemy | 9030 | MySQL | 프로덕션 API 서버 (커넥션 풀) |
| HTTP SQL API | 8030 | HTTP (NDJSON) | REST 기반 통합, 서버리스 환경 |

### 방법 1: pymysql로 직접 쿼리

Private subnet이라 외부에서 직접 접근이 어려울 때 Databricks 노트북을 임시 테스트 환경으로 활용할 수 있다. 같은 VPC 내에 있기 때문이다.

```python
import pymysql

conn = pymysql.connect(
    host="<celerdata-host>",
    port=9030,
    user="admin",
    password="<password>",
    database="my_mv_db",
    charset="utf8mb4",
    connect_timeout=10,
    read_timeout=30,
)

try:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM mv_sample_metric_day LIMIT 5")
        for row in cur.fetchall():
            print(row)
except pymysql.Error as e:
    print(f"Query failed: {e}")
finally:
    conn.close()
```

결과를 딕셔너리 형태로 받고 싶다면 `cursorclass=pymysql.cursors.DictCursor`를 `connect()`에 추가한다.

### 방법 2: HTTP SQL API

StarRocks HTTP SQL API는 두 가지 엔드포인트를 제공한다.

| 엔드포인트 | 설명 |
|---|---|
| `POST /api/v1/catalogs/<catalog_name>/sql` | 카탈로그 범위. 쿼리에서 `database.table` 형식으로 지정 |
| `POST /api/v1/catalogs/<catalog_name>/databases/<database_name>/sql` | 카탈로그+데이터베이스 범위. 테이블명만 지정 |

인증은 HTTP Basic Auth를 사용한다. 응답 형식은 **Newline Delimited JSON (NDJSON)**이므로, 여러 행이 개행으로 구분되어 반환된다는 점에 주의해야 한다.

```python
import requests
import base64

# CelerData HTTP SQL API
url = "http://<celerdata-host>:8030/api/v1/catalogs/default_catalog/databases/my_mv_db/sql"
credentials = base64.b64encode(b"admin:<password>").decode()

resp = requests.post(
    url,
    headers={
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/json",
    },
    json={
        "query": "SELECT * FROM mv_sample_metric_day LIMIT 5",
        # "sessionVariables": {}  -- 필요 시 세션 변수 설정 가능
    },
)

# 응답이 NDJSON 형식이므로 행 단위로 파싱
# Content-Type: application/x-ndjson charset=UTF-8
if resp.ok:
    import json
    for line in resp.text.strip().split("\n"):
        if line:
            print(json.loads(line))
else:
    print(f"Error {resp.status_code}: {resp.text}")
```

> 응답 헤더의 `X-StarRocks-Query-Id`로 쿼리 ID를 추적할 수 있다. 느린 쿼리 디버깅 시 유용하다.

### 방법 3: SQLAlchemy (프로덕션 권장)

프로덕션 API 서버에서는 커넥션 풀 관리를 위해 SQLAlchemy를 사용하는 것을 권장한다. StarRocks/CelerData는 MySQL 프로토콜을 지원하므로 pymysql 드라이버를 그대로 사용할 수 있다.

```python
from sqlalchemy import create_engine, text

# pymysql 드라이버 사용, CelerData는 MySQL 프로토콜 호환
engine = create_engine(
    "mysql+pymysql://admin:<password>@<celerdata-host>:9030/my_mv_db",
    pool_size=5,
    max_overflow=10,
    pool_recycle=3600,
)

with engine.connect() as conn:
    result = conn.execute(text("SELECT * FROM mv_sample_metric_day LIMIT 5"))
    for row in result:
        print(row)
```

---

## 6. 주의할 점 정리

### S3 권한은 별도로 부여해야 한다

External Catalog 연결이 성공해도 데이터 쿼리는 CelerData IAM role의 S3 권한이 필요하다. `SHOW TABLES`만으로는 권한 문제를 확인할 수 없으므로, 반드시 `SELECT`까지 테스트해야 한다.

### JOIN 있는 MV는 REFRESH ASYNC 필수

단순 집계만 있는 MV는 동기 갱신이 가능하지만, JOIN이 포함되면 반드시 비동기 갱신 주기(`REFRESH ASYNC EVERY`)를 명시해야 한다.

### MV는 로컬 카탈로그에 생성한다

External Catalog(`my_catalog`)에 직접 MV를 만들 수 없다. 항상 `SET CATALOG default_catalog`를 먼저 실행한다.

### 계정 구조 혼동 주의

Cloud Manager 초대(Organization)와 DB 접속 계정(SQL `CREATE USER`)은 별개다. 각각 독립적으로 관리해야 한다.

### HTTP SQL API 응답은 NDJSON이다

`resp.json()`으로 파싱하면 실패할 수 있다. 행 단위로 `json.loads()`를 사용해야 한다.

---

## 다음 단계

- MV 갱신 주기를 데이터 파이프라인 완료 시점과 맞춰 자동화
- `value_b = 0` 케이스 처리 (`NULLIF` 또는 `CASE WHEN`으로 ZeroDivisionError 방어)
- API 서버에서 SQLAlchemy + 커넥션 풀로 교체
- 프로덕션 계정 분리 (`etl_user` / `api_readonly`)
- PAT 만료 알림 또는 Service Principal 인증으로 전환

---

## Reference

- [StarRocks Delta Lake Catalog 공식 문서](https://docs.starrocks.io/docs/data_source/catalog/deltalake_catalog/)
- [StarRocks Async Materialized View 공식 문서](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_modeling_with_materialized_views/)
- [StarRocks HTTP SQL API 공식 문서](https://docs.starrocks.io/docs/sql-reference/http_sql_api/)
- [StarRocks CREATE MATERIALIZED VIEW 문법](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW/)
- [PyMySQL GitHub](https://github.com/PyMySQL/PyMySQL)
- [Databricks Personal Access Token 발급](https://docs.databricks.com/en/dev-tools/auth/pat.html)
