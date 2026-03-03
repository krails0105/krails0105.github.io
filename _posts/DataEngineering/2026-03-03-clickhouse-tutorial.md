---
layout: post
title: "[ClickHouse] ClickHouse 입문: MergeTree부터 HTTP API까지 직접 해보기"
categories:
  - DataEngineering
tags:
  - ClickHouse
  - OLAP
  - MergeTree
  - ReplacingMergeTree
  - Docker
  - Tutorial
date: 2026-03-03
toc: true
toc_sticky: true
---

## 개요

ClickHouse를 처음 접하는 백엔드/데이터 엔지니어를 위한 실습 중심 입문 가이드입니다. Docker로 환경을 구성하고, MergeTree 테이블에 1,000만 건 데이터를 삽입하여 성능과 압축률을 직접 확인합니다. ReplacingMergeTree로 OLAP DB에서 upsert를 구현하는 패턴, HTTP API로 SQL을 REST 엔드포인트처럼 활용하는 방법도 함께 다룹니다.

이 글을 따라하고 나면 다음을 직접 확인할 수 있습니다.

- MergeTree의 파트(Part) 기반 쓰기가 왜 배치 INSERT에 빠른지
- 1,000만 건 삽입 시 실제 성능과 압축률이 어느 정도인지
- ReplacingMergeTree + FINAL 키워드로 OLAP에서 upsert를 구현하는 방법
- HTTP API 하나로 SQL 쿼리를 REST처럼 호출하는 방법

---

## 사전 지식

- **SQL 기본 문법**: CREATE TABLE, INSERT, SELECT, GROUP BY 수준
- **Docker / Docker Compose**: 컨테이너 실행 경험 (`docker compose up -d`)
- **OLTP DB 기본 개념**: MySQL이나 PostgreSQL에서 테이블을 생성하고 쿼리를 실행해 본 경험
- (선택) **curl 사용 경험**: HTTP API 실습에 필요하지만, 예시를 그대로 복사해서 실행할 수 있으므로 필수는 아닙니다

---

## 1. ClickHouse란?

ClickHouse는 **OLAP(Online Analytical Processing) 전용으로 설계된 컬럼 지향(Column-oriented) SQL DBMS**입니다. MySQL, PostgreSQL 같은 OLTP DB와 겉으로는 SQL 문법이 비슷하지만, 내부 설계 철학이 완전히 다릅니다.

| 구분 | OLTP (MySQL, PostgreSQL) | OLAP (ClickHouse) |
|---|---|---|
| 주요 워크로드 | 단건 트랜잭션 (INSERT/UPDATE/DELETE) | 대규모 집계, 분석 쿼리 |
| 스토리지 구조 | 행(Row) 기반 | 컬럼(Column) 기반 |
| 읽기 단위 | 행 전체 | 필요한 컬럼만 |
| UPDATE/DELETE | 효율적 | 느림 (Mutation으로 파트 재작성) |
| 주요 강점 | 빠른 단건 쓰기, ACID 트랜잭션 | 빠른 집계 쿼리, 높은 압축률 |

### ClickHouse가 집계 쿼리에 빠른 이유

**컬럼 지향 저장**: `SELECT sum(amount) FROM orders`를 실행하면, 행 기반 DB는 모든 컬럼을 디스크에서 읽어야 합니다. ClickHouse는 `amount` 컬럼 파일만 읽으면 됩니다. 읽는 I/O 자체가 줄어듭니다.

```
행 기반:   [id=1, name=A, amount=100] [id=2, name=B, amount=200] ...
                                       ↑ amount만 필요한데 전체를 읽음

컬럼 기반: [id: 1,2,3,...] [name: A,B,C,...] [amount: 100,200,300,...]
                                              ↑ amount 컬럼만 읽으면 됨
```

**Vectorized 실행 엔진**: CPU의 SIMD(Single Instruction Multiple Data) 명령어를 활용하여 데이터를 묶음(벡터) 단위로 처리합니다. 한 번의 CPU 명령으로 여러 값을 동시에 연산합니다.

**높은 압축률**: 같은 타입의 데이터가 연속으로 배치되어 있으면 압축 알고리즘이 더 잘 동작합니다. 뒤에서 실측 결과를 확인합니다.

---

## 2. MergeTree 동작 원리

ClickHouse의 핵심 스토리지 엔진은 **MergeTree 패밀리**입니다. MySQL의 B-Tree 인덱스와 비교하면 설계 철학의 차이가 명확합니다.

| 항목 | MySQL B-Tree | ClickHouse MergeTree |
|---|---|---|
| INSERT 방식 | 정렬된 위치를 찾아 삽입 (O(log n)) | 임시 파트(Part)로 즉시 기록 (append) |
| 전체 정렬 시점 | INSERT마다 유지 | 백그라운드 병합(Merge) 시 수행 |
| 쓰기 성능 | 데이터가 많을수록 느려짐 | 데이터 양에 관계없이 빠름 |
| 읽기 최적화 방식 | Dense Index (행마다 인덱스 엔트리) | Sparse Index (기본 8,192행마다 인덱스 엔트리 1개) |

MySQL B-Tree는 INSERT할 때마다 정렬된 트리 안에서 올바른 위치를 찾아 삽입합니다. 데이터가 많아질수록 트리 탐색 비용이 늘어납니다.

반면 MergeTree는 **LSM Tree(Log-Structured Merge Tree) 계열**입니다. INSERT가 발생하면 데이터를 바로 정렬하지 않고 **"Part"** 라는 불변 파일 덩어리로 디스크에 append합니다. 각 파트 내부는 `ORDER BY`에 지정된 컬럼 기준으로 정렬되어 있지만, 파트 간에는 정렬이 보장되지 않습니다. 이후 ClickHouse가 백그라운드에서 작은 Part들을 큰 Part로 병합하며 전체 정렬을 완성합니다.

```
INSERT → Part_1 (파트 내부 정렬됨, 소규모)
INSERT → Part_2 (파트 내부 정렬됨, 소규모)
INSERT → Part_3 (파트 내부 정렬됨, 소규모)
       ↓ 백그라운드 병합 (ClickHouse가 자동 수행)
     Part_1_2_3 (전체 정렬 완성)
```

### Sparse Index와 그래뉼(Granule)

Part 내부의 데이터는 **그래뉼(Granule)** 단위로 나뉩니다. 기본 설정에서 1개 그래뉼은 8,192행입니다. ClickHouse는 모든 행에 인덱스를 만드는 대신, 각 그래뉼의 첫 번째 행에 대해서만 인덱스 엔트리를 생성합니다. 이것이 **Sparse Index(희소 인덱스)** 입니다.

```
행 0~8,191     → 인덱스 엔트리 1 (그래뉼 1의 첫 행 값)
행 8,192~16,383 → 인덱스 엔트리 2 (그래뉼 2의 첫 행 값)
행 16,384~...   → 인덱스 엔트리 3 (그래뉼 3의 첫 행 값)
```

수십억 행 테이블도 인덱스 크기가 수 MB에 불과하여 메모리에 상주시킬 수 있습니다. 쿼리 실행 시 이진 탐색으로 관련 그래뉼만 찾아 읽기 때문에 빠릅니다.

MySQL의 Dense Index는 행마다 인덱스 엔트리가 있어 단건 조회에 유리합니다. ClickHouse의 Sparse Index는 대량 데이터의 범위 스캔/집계에 유리합니다. 설계 목적이 다르기 때문에 어느 쪽이 "더 좋다"가 아니라 워크로드에 따라 선택하는 것입니다.

---

## 3. Docker로 시작하기

### docker-compose.yml 작성

```yaml
# docker-compose.yml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:latest
    container_name: clickhouse-tutorial
    ports:
      - "8123:8123"   # HTTP API 포트 (curl, 브라우저로 쿼리 실행)
      - "9000:9000"   # Native TCP 포트 (clickhouse-client 접속용)
    environment:
      CLICKHOUSE_DB: tutorial
      CLICKHOUSE_USER: admin
      CLICKHOUSE_PASSWORD: password123
    volumes:
      - clickhouse_data:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144

volumes:
  clickhouse_data:
```

> **참고**: Docker Compose V2(docker compose CLI 플러그인)에서는 최상위 `version` 키를 지정하지 않아도 됩니다. V1(docker-compose 바이너리)을 사용하는 경우에만 `version: '3.8'`을 추가합니다.

### 컨테이너 실행 및 접속

```bash
# 컨테이너 시작
docker compose up -d

# ClickHouse 클라이언트로 접속
docker exec -it clickhouse-tutorial clickhouse-client \
  --user admin --password password123
```

접속 후 `SELECT version()` 을 입력해 정상 연결을 확인합니다. 버전 번호가 출력되면 환경 구성이 완료된 것입니다.

---

## 4. 테이블 설계

환경이 준비되었으니 실습용 테이블을 만들어 봅니다. MergeTree(기본 분석용)와 ReplacingMergeTree(upsert용) 두 가지를 각각 생성합니다.

### MergeTree: 기본 분석용 테이블

```sql
-- tutorial 데이터베이스 생성
CREATE DATABASE IF NOT EXISTS tutorial;

-- 주문 데이터 테이블 (MergeTree)
CREATE TABLE tutorial.orders
(
    order_id   UInt64,
    user_id    UInt32,
    product_id UInt32,
    quantity   UInt16,
    amount     Decimal(10, 2),
    -- Enum8: 허용값을 명시하여 저장 공간 절약 (1바이트)
    status     Enum8('pending'=1, 'paid'=2, 'shipped'=3, 'cancelled'=4),
    order_date Date,
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(order_date)  -- 월별 파티션: 특정 월 데이터만 빠르게 삭제 가능
ORDER BY (order_date, user_id);    -- 쿼리 필터 컬럼을 앞에 배치
```

**PARTITION BY toYYYYMM(order_date)** 는 데이터를 월별로 물리적으로 분리합니다. `ALTER TABLE ... DROP PARTITION '202401'`처럼 특정 월 데이터를 파일 삭제 수준으로 빠르게 제거할 수 있어, 데이터 보존 정책 관리에 유용합니다.

**ORDER BY (order_date, user_id)** 는 파트 내부의 데이터 정렬 순서를 결정합니다. 동시에 Sparse Index가 이 컬럼들을 기준으로 생성되므로, `WHERE order_date = '2024-03-15'` 같은 필터가 인덱스를 활용할 수 있습니다. 자주 필터에 사용하는 컬럼을 앞에 배치하는 것이 핵심입니다.

### ReplacingMergeTree: upsert용 테이블

```sql
-- 사용자 프로필 테이블 (ReplacingMergeTree)
CREATE TABLE tutorial.users
(
    user_id    UInt32,
    username   String,
    email      String,
    country    String,
    created_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree()  -- 같은 ORDER BY 키의 중복을 병합 시 제거
ORDER BY user_id;
```

ClickHouse에는 OLTP DB의 `UPDATE`와 동일한 개념이 없습니다. 대신 **새 버전의 행을 INSERT하면, 백그라운드 병합 시 같은 `ORDER BY` 키를 가진 중복 행 중 가장 최신 행만 남깁니다.** 이것이 ClickHouse에서 upsert를 구현하는 기본 패턴입니다.

`ReplacingMergeTree(ver)` 형태로 버전 컬럼을 지정하면, 해당 컬럼 값이 가장 큰 행이 "최신"으로 유지됩니다. `ver` 파라미터를 생략하면 나중에 삽입된 행(파트 내에서 더 뒤에 있는 행)이 유지됩니다.

---

## 5. 1,000만 건 성능 + 압축률 실증

테이블이 준비되었으니, MergeTree의 배치 INSERT 성능과 컬럼 기반 압축률을 직접 확인합니다.

### 데이터 생성

ClickHouse에는 `numbers(N)` 함수가 내장되어 있습니다. `FROM numbers(10000000)`은 0부터 9,999,999까지의 숫자 행을 생성하며, 이를 `INSERT INTO ... SELECT`로 변환하여 한 번에 삽입합니다. 외부 데이터 파일 없이 SQL만으로 대량 테스트 데이터를 만들 수 있습니다.

```sql
INSERT INTO tutorial.orders
SELECT
    number + 10000                                              AS order_id,
    (number % 10) + 1                                          AS user_id,
    (number % 10) + 1                                          AS product_id,
    (number % 5) + 1                                           AS quantity,
    ((number % 100) + 1) * 10000                               AS amount,
    ['pending','paid','shipped','cancelled'][number % 4 + 1]   AS status,
    toDate('2024-01-01') + (number % 365)                      AS order_date,
    now()                                                      AS created_at
FROM numbers(10000000);
```

> **참고**: `['pending','paid','shipped','cancelled'][number % 4 + 1]`은 ClickHouse의 배열 인덱싱 문법입니다. ClickHouse 배열 인덱스는 1부터 시작하므로 `+ 1`을 붙여 1~4 범위를 만듭니다.

### 성능 결과

```
Ok.
10000000 rows in set. Elapsed: 0.015 sec.
Processed 10.00 million rows, 80.00 MB (656.29 million rows/s., 5.25 GB/s.)
Peak memory usage: 10.42 MiB.
```

1,000만 건을 **0.015초**, 초당 약 6.6억 행 처리. 메모리 사용량은 약 10MB에 불과합니다. ClickHouse의 배치 INSERT는 내부적으로 스트리밍 방식으로 처리하기 때문에 전체 데이터를 메모리에 올리지 않습니다. 이것이 2장에서 설명한 "Part로 즉시 기록(append)" 방식의 실질적 효과입니다.

### 압축률 확인

ClickHouse는 `system.parts` 테이블에서 파트별 압축 전/후 크기를 제공합니다. 다음 쿼리로 테이블 단위 압축률을 확인합니다.

```sql
SELECT
    table,
    formatReadableSize(sum(data_compressed_bytes))   AS compressed,
    formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
    round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 1) AS ratio
FROM system.parts
WHERE database = 'tutorial' AND active = 1
GROUP BY table;
```

```
┌─table──┬─compressed─┬─uncompressed─┬─ratio─┐
│ orders │ 51.14 MiB  │ 315.19 MiB   │   6.2 │
└────────┴────────────┴──────────────┴───────┘
```

원본 315MB가 51MB로 줄어 **6.2배 압축**됩니다. 컬럼 기반 저장에서 같은 타입, 비슷한 범위의 값이 연속으로 배치되면 LZ4(ClickHouse의 기본 압축 알고리즘) 같은 압축 알고리즘이 훨씬 효과적으로 동작합니다. 행 기반 DB에서는 서로 다른 타입의 데이터가 섞여 있어 이 정도 압축률을 기대하기 어렵습니다.

### Part 상태 확인

```sql
-- 현재 활성 파트 목록 조회
SELECT table, partition, name, rows
FROM system.parts
WHERE database = 'tutorial' AND active = 1
ORDER BY table, partition;
```

`system.parts`는 ClickHouse의 내부 메타데이터 테이블입니다. 각 파티션에 파트가 몇 개 있는지, 백그라운드 병합이 얼마나 진행됐는지 확인할 수 있습니다. 만약 파트 수가 비정상적으로 많다면 소규모 INSERT가 반복되고 있다는 신호일 수 있습니다 (8장에서 자세히 설명합니다).

---

## 6. HTTP API 활용

ClickHouse는 포트 8123에서 HTTP API를 제공합니다. 별도 API 서버 없이 SQL을 직접 REST 요청으로 실행할 수 있습니다. 드라이버 설치가 필요 없으므로, 간단한 데이터 조회나 파이프라인 연동에 유용합니다.

```bash
# 월별 주문 집계 -- SQL이 바로 REST API가 됨
curl "http://localhost:8123/?user=admin&password=password123" \
  --data "SELECT
            toYYYYMM(order_date) AS month,
            count()              AS orders,
            sum(amount)          AS total_amount
          FROM tutorial.orders
          GROUP BY month
          ORDER BY month
          FORMAT JSON"
```

응답 포맷으로 `JSON`, `CSV`, `TSV`, `JSONEachRow` 등을 지정할 수 있습니다. `FORMAT`을 지정하지 않으면 기본 포맷인 `TabSeparated`로 응답합니다.

```bash
# CSV 포맷으로 결과를 파일에 저장하는 예시
curl "http://localhost:8123/?user=admin&password=password123" \
  --data "SELECT toYYYYMM(order_date) AS month, count() AS orders
          FROM tutorial.orders
          GROUP BY month ORDER BY month
          FORMAT CSV" > orders_by_month.csv
```

데이터 파이프라인이나 외부 시스템과 연동할 때 별도 드라이버 없이 HTTP만으로 ClickHouse에 쿼리를 실행하는 패턴이 자주 사용됩니다. 특히 `JSONEachRow` 포맷은 스트리밍 INSERT에도 활용되어, Kafka Connect HTTP Sink 같은 커넥터에서 ClickHouse로 데이터를 밀어넣는 표준 패턴으로 사용됩니다.

---

## 7. ReplacingMergeTree upsert 패턴

4장에서 ReplacingMergeTree 테이블을 생성했습니다. 이제 실제로 중복 데이터를 삽입하고, 어떻게 upsert가 동작하는지 확인합니다.

### 중복 삽입과 FINAL 키워드

```sql
-- 초기 사용자 데이터 삽입
INSERT INTO tutorial.users VALUES
    (1, 'alice', 'alice@example.com', 'USA', now()),
    (2, 'bob',   'bob@example.com',   'KOR', now());

-- alice의 이메일 변경 -- UPDATE 대신 새 행 INSERT
INSERT INTO tutorial.users VALUES
    (1, 'alice', 'alice_new@example.com', 'USA', now());
```

이 시점에서 `user_id = 1`인 행이 두 개 존재합니다. 두 번의 INSERT가 각각 별도의 파트를 생성했고, 백그라운드 병합이 아직 실행되지 않은 상태이기 때문입니다.

```sql
-- FINAL 없이 조회 -- 중복 행이 보일 수 있음
SELECT * FROM tutorial.users WHERE user_id = 1;
```

```
┌─user_id─┬─username─┬─email─────────────────┬─country─┬──────────created_at─┐
│       1 │ alice    │ alice@example.com     │ USA     │ 2026-03-03 10:00:00 │
│       1 │ alice    │ alice_new@example.com │ USA     │ 2026-03-03 10:01:00 │
└─────────┴──────────┴───────────────────────┴─────────┴─────────────────────┘
```

`user_id = 1`인 행이 2개 반환됩니다. 아직 병합이 이루어지지 않았기 때문입니다.

```sql
-- FINAL: 쿼리 시점에 즉시 dedup 적용 -- 최신 행 1개만 반환
SELECT * FROM tutorial.users FINAL WHERE user_id = 1;
```

```
┌─user_id─┬─username─┬─email─────────────────┬─country─┬──────────created_at─┐
│       1 │ alice    │ alice_new@example.com │ USA     │ 2026-03-03 10:01:00 │
└─────────┴──────────┴───────────────────────┴─────────┴─────────────────────┘
```

`FINAL`은 쿼리 시점에 논리적 병합을 강제 실행하여, 같은 ORDER BY 키를 가진 행 중 최신 행만 반환합니다. 정확한 결과를 보장하지만, 대용량 테이블에서는 병합 연산이 추가되므로 성능 비용이 있습니다.

### 즉시 병합 강제 실행

```sql
-- 백그라운드 병합을 즉시 강제 실행
OPTIMIZE TABLE tutorial.users FINAL;

-- 이후 FINAL 없이도 중복 제거된 결과 확인
SELECT * FROM tutorial.users WHERE user_id = 1;
```

`OPTIMIZE TABLE ... FINAL`은 모든 파트를 하나로 병합합니다. 병합 후에는 FINAL 없이도 중복이 제거된 결과가 조회됩니다.

**주의**: 프로덕션 환경에서 `OPTIMIZE TABLE ... FINAL`은 전체 파트를 재작성하므로 높은 I/O 부하를 유발합니다. 테스트나 마이그레이션 후 즉시 일관성이 필요한 상황에서만 사용합니다. 일반적으로는 `SELECT ... FINAL`로 쿼리 시점에 dedup을 처리하는 것이 더 안전합니다.

---

## 8. 주의할 점

### VALUES 블록에 SQL 주석 사용 불가

ClickHouse는 `INSERT INTO ... VALUES (...)` 블록 안에 `--` 주석을 허용하지 않습니다. VALUES 구문에서는 ClickHouse가 SQL 파서 대신 별도의 값 전용 파서(Values format parser)를 사용하기 때문입니다.

```sql
-- [오류] VALUES 안에 -- 주석 사용
INSERT INTO tutorial.users VALUES
    (1, 'alice', 'alice@example.com', 'USA', now()),  -- admin user
    (2, 'bob',   'bob@example.com',   'KOR', now());
```

이 쿼리는 다음과 유사한 파싱 에러를 발생시킵니다.

```
Code: 27. DB::ParsingException: Cannot parse input: expected ')' before: '-- admin user\n...'
```

VALUES 블록 안에서 `--` 이후의 텍스트가 주석이 아닌 데이터 값의 일부로 해석되면서 파싱에 실패합니다.

```sql
-- [해결] VALUES 바깥에 주석 작성
-- admin user
INSERT INTO tutorial.users VALUES (1, 'alice', 'alice@example.com', 'USA', now());
-- regular user
INSERT INTO tutorial.users VALUES (2, 'bob',   'bob@example.com',   'KOR', now());
```

대용량 INSERT를 SQL 파일로 작성할 때 특히 자주 마주치는 에러입니다. `INSERT INTO ... SELECT` 구문에서는 일반 SQL 파서가 동작하므로 `--` 주석을 정상적으로 사용할 수 있습니다.

### 비동기 병합과 데이터 일관성

ReplacingMergeTree, SummingMergeTree 등에서 중복 제거/집계는 **병합이 완료된 시점에만 보장**됩니다. 방금 INSERT한 데이터는 아직 별도 파트에 있으므로 쿼리 결과가 의도와 다를 수 있습니다. 이것이 ClickHouse의 **eventual consistency** 특성입니다.

- 정확한 결과가 필요할 때: `SELECT ... FINAL` 사용
- 테스트/개발 중 즉시 병합: `OPTIMIZE TABLE ... FINAL` 사용 (프로덕션 지양)
- 쿼리 패턴으로 해결: `GROUP BY` + `argMax()` 등의 함수를 사용하여 최신 행을 선택하는 방법도 있습니다

### 소규모 INSERT 반복 금지

ClickHouse는 INSERT마다 새 파트(Part)가 생성됩니다. 1건씩 INSERT를 반복하면 파트 수가 폭증하여 백그라운드 병합에 과도한 부하가 걸리고, 심하면 `Too many parts` 에러로 INSERT 자체가 거부됩니다.

```
Code: 252. DB::Exception: Too many parts (600). Merges are processing
significantly slower than inserts.
```

공식 문서에서는 초당 1회 이하의 INSERT 빈도를 권장합니다. 최소 1,000행 이상, 가능하면 수만~수십만 행을 묶어서 배치 INSERT하는 것이 기본 원칙입니다. 애플리케이션에서 개별 이벤트를 실시간으로 저장해야 한다면, 중간에 Kafka 같은 버퍼를 두고 ClickHouse에는 배치로 삽입하는 아키텍처를 고려합니다.

---

## 9. 정리

| 항목 | 내용 |
|---|---|
| MergeTree | 기본 분석용 엔진. INSERT 시 Part로 빠르게 기록, 백그라운드 병합 시 정렬 완성 |
| ReplacingMergeTree | 같은 ORDER BY 키의 중복을 병합 시 제거. OLAP에서의 upsert 패턴 |
| Sparse Index | 기본 8,192행(그래뉼) 단위의 희소 인덱스. 대용량 집계에 최적화 |
| FINAL 키워드 | 쿼리 시점에 논리적 병합 강제. 중복 제거 보장, 성능 비용 존재 |
| HTTP API (포트 8123) | SQL을 HTTP POST로 직접 실행. FORMAT JSON/CSV 등 지정 가능 |
| numbers(N) 함수 | 대용량 테스트 데이터 생성에 활용하는 내장 함수 |
| VALUES 안 주석 | `--` 주석 불가. 값 전용 파서가 동작하기 때문. VALUES 블록 바깥에 작성해야 함 |
| 소규모 INSERT | 파트 폭증 위험. 최소 1,000행 이상 배치 INSERT 권장 |

이번 실습에서 확인한 핵심은 **ClickHouse는 쓰기 설계가 OLTP와 근본적으로 다르다**는 점입니다. UPDATE 대신 새 행 INSERT + ReplacingMergeTree, ACID 트랜잭션 없음, 비동기 병합으로 인한 eventual consistency -- 이 세 가지를 먼저 이해하면 ClickHouse를 사용할 때 예상치 못한 동작으로 당황하는 일을 크게 줄일 수 있습니다.

---

## Reference

- [ClickHouse 공식 문서 - Getting Started](https://clickhouse.com/docs/en/getting-started/quick-start)
- [ClickHouse 공식 문서 - MergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/mergetree)
- [ClickHouse 공식 문서 - ReplacingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)
- [ClickHouse 공식 문서 - HTTP Interface](https://clickhouse.com/docs/en/interfaces/http)
- [ClickHouse 공식 문서 - system.parts](https://clickhouse.com/docs/en/operations/system-tables/parts)
- [ClickHouse 공식 문서 - Sparse Primary Indexes](https://clickhouse.com/docs/en/optimize/sparse-primary-indexes)
