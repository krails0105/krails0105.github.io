---
title: "StarRocks로 dbt 없이 분석가 API 서빙하기: Delta Lake External Catalog와 Materialized View"
categories:
  - DataEngineering
tags:
  - StarRocks
  - ClickHouse
  - OLAP
  - DeltaLake
  - MaterializedView
  - DataArchitecture
date: 2026-03-03
---

### 개요

BQ + dbt 스택을 운영하는 팀에서 분석가가 쿼리를 바꿀 때마다 dbt 사이클(SQL 재작성 -> PR 리뷰 -> 배포)을 거쳐야 하는 병목이 생기는 경우가 있습니다. 이 글에서는 이 문제를 해결하기 위해 여러 옵션을 검토하고, StarRocks와 ClickHouse를 비교한 뒤, StarRocks의 핵심 기능인 **External Catalog**과 **Async Materialized View**를 실습한 내용을 정리합니다.

이 글을 읽고 나면 다음을 이해할 수 있습니다.

- dbt 사이클이 병목이 되는 구체적인 상황과 각 해결 옵션의 트레이드오프
- ClickHouse와 StarRocks의 강점이 갈리는 기준
- StarRocks의 테이블 모델(Primary Key / Duplicate Key)과 Sync MV / Async MV의 차이
- Delta Lake External Catalog로 ETL 없이 S3 데이터를 직접 쿼리하는 방법

---

### 1. 문제 상황: dbt 사이클이 왜 병목인가

현재 스택을 단순화하면 다음과 같습니다.

```
S3 Delta Lake (Databricks) --> BigQuery (DW) --> API 서빙
                                              --> PostgreSQL (Mart) --> API 서빙
BQ + dbt --> 분석가 Ad-hoc 쿼리 API
```

분석가가 새로운 지표를 API로 노출하고 싶을 때 발생하는 흐름을 보면 문제가 명확해집니다.

```
분석가: "이 지표도 API로 줄 수 있어요?"
     |
     v
SQL 재작성 --> dbt 모델 추가 --> PR 리뷰 --> 배포 (수 시간 ~ 수 일)
     |
     v
"다음 스프린트에 반영할게요"
```

쿼리 하나를 바꾸는 데 개발 프로세스 전체가 개입하는 구조입니다. 분석가가 원하는 것은 "SQL 하나로 지표를 바로 확인"하는 것인데, 실제로는 dbt 모델 정의, 코드 리뷰, CI/CD 배포라는 엔지니어링 프로세스를 거쳐야 합니다. 이것이 핵심 페인포인트입니다.

---

### 2. 검토한 옵션들

이 병목을 해소하기 위해 네 가지 옵션을 검토했습니다. 각 옵션의 장단점을 비교한 뒤 최종 선택 기준을 정리합니다.

#### 옵션 1: BQ 직접 쿼리

분석가가 BQ에 직접 쿼리하고 결과를 API로 내보내는 방식입니다.

**장점**: 추가 인프라 없이 즉시 적용할 수 있습니다.

**문제**: BQ는 스캔한 데이터 양에 비례해 비용이 발생합니다. TB 단위 풀스캔이 일어나면 쿼리 한 번에 수만 원이 나올 수 있으며, Ad-hoc 쿼리의 특성상 스캔량을 예측할 수 없어 비용 관리가 어렵습니다.

#### 옵션 2: BQ Materialized View

BQ에서 집계 결과를 사전에 계산해 저장해두는 방식입니다.

**적합한 상황**: API 호출 빈도가 낮고, BQ 내부에서 집계를 완결할 수 있는 경우. 별도 인프라 없이 해결할 수 있어 운영 부담이 가장 낮습니다.

**한계**: API 레이턴시가 여전히 BQ 쿼리 응답 시간에 묶입니다. BQ는 분석 쿼리에 최적화되어 있어 응답 시간이 초 단위인 경우가 많습니다. 고빈도 API 호출(밀리초 단위 응답이 필요한 경우)에는 적합하지 않습니다.

#### 옵션 3: ClickHouse

BQ가 Transform을 완료한 데이터를 ClickHouse에 인제스트하고, ClickHouse가 API 서빙을 담당하는 구조입니다.

**강점**: HTTP 인터페이스가 내장되어 있어, ClickHouse에 SQL을 날리면 REST API처럼 동작합니다. 별도 API 서버 없이 쿼리 결과를 JSON으로 받을 수 있습니다. 단일 바이너리로 배포 가능하여 운영이 상대적으로 단순합니다.

**한계**: BQ에서 ClickHouse로 데이터를 옮기는 인제스트 파이프라인이 추가로 필요합니다. 대형 테이블 간의 복잡한 JOIN은 비효율적입니다.

#### 옵션 4: StarRocks

S3의 Delta Lake를 ETL 없이 직접 쿼리하고, 자주 쓰는 쿼리는 Materialized View로 사전 집계하는 구조입니다.

**강점**: BQ 파이프라인을 우회해 Delta Lake에서 직접 데이터를 읽을 수 있습니다(External Catalog). 복잡한 multi-table JOIN도 CBO(Cost-Based Optimizer)가 잘 처리합니다. MySQL 프로토콜 호환이라 분석가가 익숙한 도구로 접속할 수 있습니다.

**한계**: FE + BE 분리 아키텍처라 ClickHouse 대비 운영 복잡도가 높습니다.

---

### 3. ClickHouse vs StarRocks: 언제 무엇을 선택하는가

두 도구는 OLAP DB라는 점에서 비슷해 보이지만, 강점이 다른 영역에 있습니다. 선택 기준을 정리하면 다음과 같습니다.

| 상황 | 선택 | 이유 |
|------|------|------|
| BQ가 이미 Transform 담당 + 단순 집계 서빙 | ClickHouse | BQ가 JOIN/Transform을 처리하므로, 서빙 레이어만 필요 |
| S3 Delta Lake가 있고 BQ 파이프라인을 줄이고 싶음 | StarRocks | External Catalog로 Delta Lake 직접 쿼리 가능 |
| 복잡한 multi-table JOIN이 많음 | StarRocks | CBO 기반 JOIN 최적화가 강점 |
| MySQL 문법에 친숙한 분석가 팀 | StarRocks | MySQL 프로토콜 호환 |
| HTTP API로 직접 쿼리 서빙 | ClickHouse | HTTP 인터페이스 내장, 별도 API 서버 불필요 |

**BQ 스택이 있을 때 ClickHouse가 더 자연스러운 이유**: StarRocks의 핵심 장점인 Delta Lake 직접 쿼리, 복잡한 JOIN 처리는 BQ가 이미 담당합니다. StarRocks의 FE + BE 분리 아키텍처는 운영 복잡도가 ClickHouse보다 높습니다. BQ 스택이 탄탄하면 ClickHouse를 서빙 레이어로 추가하는 것이 더 단순합니다.

**3개 API를 2개로 통합하는 시나리오**:

```
기존 (3개 API):
  BQ API          (분석 집계)
  PostgreSQL API  (트랜잭션 데이터)
  BQ Ad-hoc API   (분석가 쿼리)

개선 (2개 API):
  ClickHouse API  (분석용 통합 - BQ 집계 + Ad-hoc 통합)
  PostgreSQL API  (트랜잭션용 - 그대로 유지)
```

반면 BQ 의존도를 낮추고 싶거나, Delta Lake를 데이터 소스로 직접 활용하고 싶다면 StarRocks가 더 적합합니다. 이 글의 나머지 부분에서는 StarRocks를 선택한 경우의 핵심 기능들을 다룹니다.

---

### 4. StarRocks 시작: Docker 환경 구성

StarRocks는 `allin1` 이미지로 로컬에서 빠르게 시작할 수 있습니다.

```yaml
# docker-compose.yml
services:
  starrocks:
    image: starrocks/allin1-ubuntu:latest
    ports:
      - "9030:9030"   # MySQL 프로토콜 (mysql 클라이언트로 접속)
      - "8030:8030"   # FE(Frontend) HTTP
      - "8040:8040"   # BE(Backend) HTTP
```

```bash
docker compose up -d

# StarRocks가 준비되기까지 약 30초 이상 소요됨
# docker compose logs starrocks 로 로그를 확인할 수 있음

# mysql 클라이언트로 접속 (MySQL 프로토콜 호환)
mysql -h 127.0.0.1 -P 9030 -u root --prompt="StarRocks> "
```

StarRocks는 FE(Frontend)와 BE(Backend)가 분리된 아키텍처입니다. FE는 쿼리 파싱, 플래닝, 메타데이터 관리를 담당하고, BE는 실제 데이터 저장과 연산을 담당합니다. `allin1` 이미지는 개발/학습용으로 이 둘을 하나의 컨테이너에 묶어놓은 것이며, 프로덕션 환경에서는 FE와 BE를 각각 별도 노드로 분리하여 배포합니다.

> **참고**: docker-compose.yml의 `version` 필드는 Docker Compose V2에서는 더 이상 필요하지 않습니다. `docker compose` 명령어(하이픈 없음)를 사용하는 경우 생략해도 됩니다.

---

### 5. StarRocks 테이블 모델

StarRocks는 테이블을 생성할 때 **어떻게 쓸 것인지(테이블 타입)**를 선언합니다. ClickHouse가 테이블 엔진(MergeTree 패밀리)으로 이를 결정하는 것과 유사한 개념입니다. StarRocks는 Duplicate Key, Aggregate, Unique Key, Primary Key의 네 가지 테이블 타입을 제공하며, 여기서는 가장 자주 쓰이는 두 가지를 다룹니다.

#### Primary Key Table: 실시간 upsert

동일한 PK로 들어오는 데이터를 자동으로 upsert 처리합니다. 사용자 정보처럼 최신 상태 하나만 유지해야 하는 데이터에 적합합니다.

```sql
-- 동일 user_id가 다시 들어오면 자동으로 최신 값으로 갱신
CREATE TABLE users (
    user_id     INT          NOT NULL,  -- PK 컬럼은 반드시 NOT NULL
    name        VARCHAR(50),
    email       VARCHAR(100),
    created_at  DATETIME
) PRIMARY KEY (user_id)
DISTRIBUTED BY HASH(user_id);
```

**주의사항**:
- Primary Key 컬럼은 반드시 `NOT NULL`이어야 하며, 테이블 정의에서 가장 먼저 선언해야 합니다.
- Primary Key에는 파티셔닝/버켓팅에 사용하는 컬럼이 포함되어야 합니다.
- 인코딩된 PK의 최대 길이는 128바이트입니다.

ClickHouse의 ReplacingMergeTree와 비슷한 역할이지만, StarRocks의 Primary Key Table은 INSERT 시점에 즉시 upsert가 발생합니다. ClickHouse의 ReplacingMergeTree는 비동기 머지 시점에 중복이 제거되므로, `FINAL` 키워드 없이는 중복이 남아 있을 수 있습니다.

#### Duplicate Key Table: 원본 그대로 저장

중복을 허용하며 들어오는 데이터를 모두 보존합니다. 로그, 이벤트처럼 모든 기록이 필요한 데이터에 적합합니다.

```sql
-- 동일 order_id가 여러 번 들어와도 모두 저장됨
CREATE TABLE orders (
    order_id    INT          NOT NULL,
    user_id     INT          NOT NULL,
    product_id  INT,
    amount      DECIMAL(10, 2),
    status      VARCHAR(20),
    order_date  DATE
) DUPLICATE KEY (order_id, user_id)
PARTITION BY RANGE(order_date) (
    PARTITION p2024_01 VALUES LESS THAN ("2024-02-01"),
    PARTITION p2024_02 VALUES LESS THAN ("2024-03-01"),
    PARTITION p2024_03 VALUES LESS THAN ("2024-04-01")
)
DISTRIBUTED BY HASH(order_id);
```

`PARTITION BY RANGE`는 날짜 범위로 데이터를 물리적으로 분리합니다. `WHERE order_date >= '2024-02-01'` 쿼리를 날리면 p2024_01 파티션은 읽지 않습니다(파티션 프루닝). `DUPLICATE KEY`에 지정한 컬럼은 데이터의 정렬(sort) 기준으로 사용되며, 자주 필터링하는 컬럼을 지정하면 쿼리 성능이 향상됩니다.

> **참고**: StarRocks v3.3부터 `DUPLICATE KEY` 대신 `ORDER BY`로 정렬 키를 지정할 수 있습니다. `ORDER BY`와 `DUPLICATE KEY`를 동시에 지정하면 `DUPLICATE KEY`는 무시됩니다. v3.1부터는 `DISTRIBUTED BY HASH`를 생략하면 랜덤 버켓팅이 기본 적용됩니다.

---

### 6. Sync MV vs Async MV: 왜 JOIN은 Async만 되는가

StarRocks의 Materialized View(MV)는 두 종류가 있으며, 동작 방식이 근본적으로 다릅니다. 이 차이를 이해해야 적절한 MV를 선택할 수 있습니다.

#### Sync MV (동기 Materialized View)

Sync MV는 **기반 테이블의 데이터가 변경될 때 자동으로 갱신**됩니다. 별도의 물리적 테이블이 아니라 기반 테이블 위에 생성되는 특수한 인덱스에 가깝습니다.

```sql
-- 단일 테이블에 대한 집계만 가능
-- GROUP BY 사용 시 집계 함수가 반드시 포함되어야 함
CREATE MATERIALIZED VIEW mv_daily_order_count
AS
SELECT
    order_date,
    COUNT(*) AS order_count
FROM orders
GROUP BY order_date;
```

**지원하는 집계 함수**: `SUM`, `MIN`, `MAX`, `COUNT`, `BITMAP_UNION`(count distinct 대체), `HLL_UNION`(approx count distinct 대체). 이 외의 집계 함수는 사용할 수 없습니다.

**JOIN을 지원하지 않는 이유**: Sync MV는 데이터 변경과 동시에 갱신이 일어납니다. `orders` 테이블에 행이 하나 추가될 때, `products` 테이블 전체를 다시 JOIN해야 한다면 매 INSERT마다 막대한 재계산 비용이 발생합니다. 쓰기 성능을 보장할 수 없으므로 단일 테이블만 지원하도록 설계되어 있습니다.

#### Async MV (비동기 Materialized View)

Async MV는 **명시적으로 갱신 명령을 내리거나 스케줄을 설정해서 갱신**합니다. INSERT 타이밍과 분리되어 있으므로 여러 테이블을 JOIN할 수 있고, StarRocks가 제공하는 모든 쿼리 문법을 사용할 수 있습니다. 또한 External Catalog의 외부 테이블에서도 생성할 수 있어, Delta Lake 데이터에 대한 Async MV도 가능합니다.

```sql
-- JOIN을 포함한 복잡한 집계를 사전 계산
-- Async MV는 반드시 DISTRIBUTED BY 또는 REFRESH 중 하나 이상을 지정해야 함
CREATE MATERIALIZED VIEW mv_daily_category_sales
DISTRIBUTED BY HASH(order_date)
REFRESH ASYNC EVERY (INTERVAL 1 HOUR)  -- 1시간마다 자동 갱신
AS
SELECT
    o.order_date,
    p.category,
    COUNT(*)           AS order_count,
    SUM(o.amount)      AS daily_revenue
FROM orders o
JOIN products p ON o.product_id = p.product_id
WHERE o.status != 'cancelled'
GROUP BY o.order_date, p.category;

-- 수동 갱신 (스케줄과 별도로 즉시 갱신하고 싶을 때)
REFRESH MATERIALIZED VIEW mv_daily_category_sales;
```

**REFRESH 옵션 정리**:

| 옵션 | 동작 |
|------|------|
| `REFRESH MANUAL` | 수동으로만 갱신 (`REFRESH MATERIALIZED VIEW` 명령 필요). REFRESH 생략 시 기본값 |
| `REFRESH ASYNC` | 기반 테이블 변경 시 자동 갱신 |
| `REFRESH ASYNC EVERY (INTERVAL n HOUR)` | 지정한 주기마다 자동 갱신 |
| `REFRESH IMMEDIATE` / `REFRESH DEFERRED` | 생성 직후 즉시 갱신할지, 다음 스케줄까지 대기할지 결정 |

#### Sync MV와 Async MV 비교

| 구분 | Sync MV | Async MV |
|------|---------|----------|
| 본질 | 기반 테이블의 특수 인덱스 | 독립적인 물리 테이블 |
| 갱신 시점 | 데이터 변경과 동시 (자동) | 명시적 갱신 명령 또는 스케줄 |
| JOIN 지원 | 불가 (단일 테이블만) | 가능 (다중 테이블, External Catalog 포함) |
| 집계 함수 | SUM, MIN, MAX, COUNT 등 제한적 | 모든 집계 함수 사용 가능 |
| 데이터 최신성 | 항상 최신 | 마지막 갱신 시점까지 |
| 쓰기 성능 영향 | 있음 (INSERT 시 함께 갱신) | 없음 (갱신이 분리됨) |

#### 쿼리 자동 재작성 (Query Rewrite)

Async MV의 중요한 기능 중 하나입니다. 원본 테이블에 JOIN 쿼리를 날려도, StarRocks가 자동으로 해당 MV를 활용하도록 쿼리를 재작성합니다. v2.5부터 기본으로 활성화되어 있습니다(`enable_materialized_view_rewrite = true`).

```sql
-- 이 쿼리를 날리면...
SELECT order_date, category, SUM(amount)
FROM orders o
JOIN products p ON o.product_id = p.product_id
WHERE o.status != 'cancelled'
GROUP BY order_date, category;

-- EXPLAIN 결과에서 확인:
-- TABLE: mv_daily_category_sales
-- MaterializedView: true
-- <-- 원본 테이블 대신 MV에서 읽음
```

분석가가 원본 테이블 기준으로 쿼리를 작성해도 MV의 성능 이점을 자동으로 얻을 수 있습니다. 분석가 입장에서는 MV의 존재를 의식하지 않아도 되므로, SQL 작성의 자유도가 유지됩니다.

> **주의**: Query Rewrite는 SPJG(Scan, Project, Join, Group-by) 패턴의 쿼리에서 동작합니다. 서브쿼리, UNION, 윈도우 함수 등이 포함된 복잡한 쿼리는 자동 재작성이 되지 않을 수 있으므로, `EXPLAIN`으로 실제 MV가 사용되는지 확인하는 것이 좋습니다.

---

### 7. Delta Lake External Catalog: ETL 없는 쿼리

StarRocks의 가장 강력한 기능 중 하나는 S3의 Delta Lake를 별도 ETL 없이 직접 쿼리할 수 있다는 점입니다. 이를 **External Catalog**이라고 합니다. 카탈로그(Catalog)란 데이터베이스들의 묶음을 관리하는 메타데이터 계층으로, 한 번 등록하면 해당 데이터 소스의 모든 데이터베이스와 테이블을 일반 테이블처럼 탐색하고 쿼리할 수 있습니다.

#### ClickHouse의 Delta Lake 접근 방식과 비교

ClickHouse에서는 Delta Lake 데이터에 접근하려면 테이블 단위로 S3 경로를 직접 지정해야 합니다.

```sql
-- ClickHouse: 테이블 단위로 S3 경로를 직접 지정
-- 읽기 전용, 경로가 바뀌면 매번 재정의 필요
CREATE TABLE my_delta
ENGINE = DeltaLake('s3://bucket/path/', 'access_key', 'secret_key');
```

테이블이 10개라면 10번 정의해야 하고, 경로가 바뀔 때마다 재정의가 필요합니다.

#### StarRocks External Catalog

StarRocks는 카탈로그 단위로 등록하므로, 한 번 설정하면 해당 메타스토어가 관리하는 모든 테이블에 접근할 수 있습니다.

```sql
-- 카탈로그를 한 번 등록하면 DB처럼 탐색 가능
CREATE EXTERNAL CATALOG my_delta_catalog
PROPERTIES (
    "type" = "deltalake",
    "hive.metastore.type" = "glue",          -- 또는 "hive"
    -- Hive Metastore를 사용하는 경우:
    -- "hive.metastore.uris" = "thrift://xx.xx.xx.xx:9083",
    "aws.s3.access_key" = "...",
    "aws.s3.secret_key" = "...",
    "aws.s3.region" = "ap-northeast-2"
);

-- 등록 후 일반 DB처럼 탐색
SHOW DATABASES FROM my_delta_catalog;

USE my_delta_catalog.my_database;
SHOW TABLES;

-- 일반 테이블처럼 쿼리 (catalog.database.table 형식)
SELECT * FROM my_delta_catalog.my_database.orders
WHERE order_date >= '2024-02-01';
```

StarRocks External Catalog는 Delta Lake의 트랜잭션 로그를 인식합니다. Delta Lake의 ACID 트랜잭션이 완료된 데이터만 읽으므로, 진행 중인 트랜잭션의 부분 데이터가 섞이지 않습니다.

#### 3가지 접근 방식 비교

| 방식 | 장점 | 문제점 |
|------|------|--------|
| Delta Lake 직접 쿼리 (Spark) | 풍부한 생태계 | 콜드스타트 지연, 클러스터 비용, API 서빙 부적합 |
| BQ/PostgreSQL -> StarRocks 인제스트 | 데이터가 로컬에 있어 빠름 | ETL 파이프라인 추가, 데이터 중복, 동기화 지연 |
| StarRocks External Catalog | ETL 없음, 데이터 중복 없음, Delta 트랜잭션 인식 | 네트워크 I/O 발생, Spark 대비 생태계 제한 |

#### 실무 권장 패턴

```
ad-hoc 쿼리     --> External Catalog로 Delta Lake 직접 쿼리
                    (ETL 없음, 최신 데이터 즉시 반영)

고빈도 API 서빙 --> Async MV로 사전 집계
                    (빠른 응답, 갱신 주기 설정 가능)
```

분석가가 새로운 지표를 탐색할 때는 External Catalog로 Delta Lake를 직접 쿼리하고, 확정된 지표는 Async MV로 사전 집계해 API로 서빙하는 방식입니다. dbt 사이클 없이 분석가가 SQL만으로 탐색부터 서빙까지 처리할 수 있습니다.

---

### 8. 파티션 프루닝 확인

앞서 Duplicate Key Table에서 `PARTITION BY RANGE`를 설정했습니다. WHERE 절이 파티션 조건과 맞을 때 불필요한 파티션을 스캔하지 않는지 `EXPLAIN`으로 확인할 수 있습니다.

```sql
EXPLAIN SELECT *
FROM orders
WHERE order_date >= '2024-02-01';

-- 결과에서 확인:
-- Partitions: [p2024_02, p2024_03]
-- <-- p2024_01은 스캔하지 않음 (파티션 프루닝 작동)
```

파티션 설계가 쿼리 패턴과 맞지 않으면 프루닝이 동작하지 않아 전체 파티션을 스캔합니다. `WHERE`에서 자주 쓰는 컬럼을 파티션 키로 설정하는 것이 중요합니다.

**흔한 실수**: 파티션 키로 설정하지 않은 컬럼으로 WHERE 조건을 거는 경우. 예를 들어 `PARTITION BY RANGE(order_date)`로 설정했는데 `WHERE user_id = 123`만 쓰면 파티션 프루닝이 동작하지 않습니다.

---

### 9. 실무에서 주의할 점

#### External Catalog 쿼리 성능

External Catalog로 Delta Lake를 직접 쿼리하면 S3에 대한 네트워크 I/O가 발생합니다. 대용량 데이터를 풀스캔하면 성능이 떨어질 수 있으므로, 파티션 프루닝이 적용되도록 쿼리를 작성하는 것이 중요합니다. 자주 사용하는 쿼리는 Async MV로 사전 집계하여 StarRocks 내부에 캐싱하는 패턴을 권장합니다.

#### Async MV 갱신 주기 설정

`REFRESH ASYNC EVERY (INTERVAL 1 HOUR)`처럼 갱신 주기를 설정할 때, 너무 짧은 주기는 StarRocks에 부하를 줍니다. 데이터의 변경 빈도와 허용 가능한 지연(staleness)을 고려하여 적절한 주기를 설정해야 합니다. `mv_rewrite_staleness_second` 속성을 설정하면, MV 데이터가 일정 시간 이내에 갱신된 경우에만 Query Rewrite를 적용하도록 제어할 수 있습니다.

#### Sync MV를 과도하게 만들지 않기

Sync MV는 INSERT 시마다 함께 갱신되므로, 하나의 테이블에 Sync MV를 많이 만들면 INSERT 성능이 그만큼 떨어집니다. 공식 문서에서도 과도한 MV 생성이 데이터 적재 효율을 비례적으로 저하시킨다고 명시하고 있습니다.

---

### 10. 정리

| 항목 | 내용 |
|------|------|
| 핵심 문제 | dbt 사이클로 인한 분석가 쿼리 배포 병목 |
| BQ 스택이 있을 때 | ClickHouse를 서빙 레이어로 추가 (단순, HTTP API 내장) |
| Delta Lake가 있을 때 | StarRocks External Catalog로 ETL 없이 직접 쿼리 |
| 자주 쓰는 쿼리 최적화 | Async MV로 사전 집계 (JOIN 포함 가능, REFRESH 스케줄 설정) |
| Query Rewrite | 원본 테이블 쿼리를 자동으로 MV 활용으로 재작성 (v2.5 기본 활성화) |
| Sync MV vs Async MV | Sync는 즉시 갱신(단일 테이블, 제한된 집계), Async는 스케줄 갱신(JOIN/외부 테이블 가능) |

StarRocks는 Delta Lake를 데이터 소스로 활용하는 환경에서, BQ 파이프라인 없이 분석가가 직접 쿼리하고 MV로 API를 서빙하는 구조를 만들 수 있습니다. 반면 BQ 스택이 이미 탄탄하다면 ClickHouse의 단순함과 HTTP API가 더 실용적인 선택입니다.

어떤 도구를 선택하든 핵심은 "분석가가 dbt 사이클 없이 SQL만으로 지표를 탐색하고 서빙할 수 있는가"입니다. 이 기준으로 팀의 기존 스택과 데이터 소스 구조에 맞는 도구를 선택하면 됩니다.

---

### Reference

- [StarRocks 공식 문서](https://docs.starrocks.io)
- [StarRocks External Catalog - Delta Lake](https://docs.starrocks.io/docs/data_source/catalog/deltalake_catalog/)
- [StarRocks Sync Materialized View](https://docs.starrocks.io/docs/using_starrocks/Materialized_view-single_table/)
- [StarRocks Async Materialized View](https://docs.starrocks.io/docs/using_starrocks/async_mv/Materialized_view/)
- [StarRocks CREATE MATERIALIZED VIEW SQL Reference](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW/)
- [StarRocks Query Rewrite with Materialized Views](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/query_rewrite_with_materialized_views/)
- [StarRocks Table Types](https://docs.starrocks.io/docs/table_design/table_types/)
- [StarRocks Docker allin1 이미지](https://hub.docker.com/r/starrocks/allin1-ubuntu)
- [ClickHouse DeltaLake Table Engine](https://clickhouse.com/docs/en/engines/table-engines/integrations/deltalake)
