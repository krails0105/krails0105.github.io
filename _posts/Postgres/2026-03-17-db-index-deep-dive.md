---
title: "[Postgres] DB 인덱스 심화 — B-Tree, GIN, BRIN, Covering Index 완전 정리"
categories:
  - Postgres
tags: [PostgreSQL, Index, B-Tree, GIN, BRIN, Covering Index, 시계열DB]
---

## Introduction

---

DB 인덱스를 처음 배울 때는 "자주 조회하는 컬럼에 인덱스를 걸면 빨라진다" 정도로 이해하고 넘어가기 쉽다. 실제로도 그 방법만으로 많은 경우를 해결할 수 있다. 하지만 데이터 구조가 복잡해지거나(JSONB, 배열), 데이터 양이 수십억 건 규모로 커지거나, 쿼리 패턴이 다양해지면 "B-Tree 인덱스 하나면 된다"는 가정이 무너지기 시작한다.

이 글에서는 PostgreSQL을 중심으로 인덱스의 내부 구조와 동작 원리를 설명하고, 상황에 맞는 인덱스 타입을 선택하는 판단 기준을 정리한다.

이 글을 읽고 나면 다음을 할 수 있다:
- B-Tree와 B+Tree의 차이를 설명하고, 왜 DB가 B+Tree를 쓰는지 이해할 수 있다.
- GIN, BRIN 인덱스가 각각 어떤 문제를 해결하는지 알 수 있다.
- Covering Index(INCLUDE)를 언제, 어떻게 써야 하는지 판단할 수 있다.
- 시계열 데이터 저장에서 BRIN이 어떻게 활용되는지 이해할 수 있다.

### 사전 지식

이 글은 다음 개념에 대한 기본적인 이해를 전제로 한다:
- SQL SELECT/WHERE 기본 문법
- 인덱스가 조회 성능을 높인다는 개념 (자세한 구조는 몰라도 된다)
- PostgreSQL 사용 경험 (기초 수준)

## 1. B-Tree vs B+Tree — "B-Tree 인덱스"의 실체

---

PostgreSQL과 MySQL(InnoDB) 문서에는 "B-Tree 인덱스"라고 표기되어 있다. 그런데 실제 내부는 **B+Tree**로 구현되어 있다. 이 두 자료구조의 차이를 이해하면 인덱스가 왜 범위 검색에 강한지 자연스럽게 납득이 된다.

### B-Tree

B-Tree는 모든 노드(내부 노드 + 리프 노드)에 **키(key)와 데이터(data)를 함께 저장**한다.

```
         [30]
        /    \
    [10,20]  [40,50]
    각 노드에 키 + 실제 데이터(row 포인터) 저장
```

루트에서 원하는 키를 찾으면 바로 그 노드에서 데이터를 꺼낼 수 있다. 단일 키 조회는 빠르다. 그러나 **범위 검색**(예: `WHERE age BETWEEN 20 AND 40`)에서는 트리의 여러 레벨을 반복 탐색해야 하므로 비효율적이다.

### B+Tree

B+Tree는 내부 노드에 **키만** 저장하고, **실제 데이터는 리프 노드에만** 저장한다. 그리고 리프 노드들이 **이중 연결 리스트(doubly linked list)** 형태로 이어져 있다.

```
         [30]             <-- 내부 노드: 키만 존재 (라우팅용)
        /    \
    [10,20]<=>[30,40,50]  <-- 리프 노드: 키 + 데이터, 양방향 연결
```

범위 검색에서 B+Tree가 압도적으로 유리한 이유가 여기에 있다. `WHERE age BETWEEN 20 AND 40`을 처리할 때:
1. 트리를 타고 내려가 `20`에 해당하는 리프 노드를 찾는다.
2. 리프 노드를 **오른쪽으로 순차 스캔**해서 `40`까지 읽는다.

디스크 I/O 관점에서 리프 노드가 순차적으로 연결되어 있으면 랜덤 I/O가 아닌 순차 I/O로 읽을 수 있어 성능 차이가 크다. 또한 내부 노드에 데이터를 저장하지 않기 때문에 하나의 내부 노드 페이지에 더 많은 키를 담을 수 있고, 이는 트리의 깊이를 낮춰 디스크 접근 횟수를 줄인다.

PostgreSQL의 B-Tree 인덱스는 `<`, `<=`, `=`, `>=`, `>` 연산자를 지원한다. 대부분의 등가 조건과 범위 조건 쿼리에서 기본 선택지가 되는 이유다.

### 정리

| 구분 | B-Tree | B+Tree |
|------|--------|--------|
| 데이터 저장 위치 | 모든 노드 | 리프 노드만 |
| 리프 노드 연결 | 없음 | 이중 연결 리스트 |
| 내부 노드 fan-out | 낮음 (데이터가 공간 차지) | 높음 (키만 저장) |
| 단일 키 조회 | 빠름 (상위 노드에서 바로 찾을 수 있음) | 빠름 (항상 리프까지 내려감) |
| 범위 검색 | 비효율적 (트리 재탐색 필요) | 효율적 (리프 노드 순차 스캔) |
| DB 사용 여부 | 실제로 사용 안 함 | PostgreSQL, MySQL(InnoDB) 등 |

PostgreSQL과 MySQL이 "B-Tree 인덱스"라고 부르는 것은 일종의 관용적 표현이다. 내부 구현은 B+Tree다.

## 2. GIN (Generalized Inverted Index) — 하나의 row에 여러 값이 있을 때

---

B+Tree는 한 row에 하나의 인덱스 값이 대응된다는 전제로 설계되어 있다. 그런데 JSONB 컬럼이나 배열 컬럼에는 하나의 row가 여러 값을 가진다. B-Tree로 이를 색인하면 "이 배열에 특정 값이 포함되어 있는가?" 같은 쿼리를 효율적으로 처리할 수 없다.

GIN(Generalized Inverted Index)은 이 문제를 **역인덱스(inverted index)** 방식으로 해결한다.

### 구조

역인덱스는 "단어 -> 그 단어가 나오는 문서 목록"처럼 **값 -> row 목록** 형태의 매핑을 저장한다.

```
-- tags 컬럼 (배열 타입)
row 1: {python, backend}
row 2: {python, frontend}
row 3: {backend, devops}

-- GIN 인덱스 내부 구조
"backend"  -> [row1, row3]
"devops"   -> [row3]
"frontend" -> [row2]
"python"   -> [row1, row2]
```

`WHERE 'python' = ANY(tags)` 쿼리가 들어오면 GIN 인덱스에서 `"python"` 키를 찾아 `[row1, row2]`를 즉시 반환한다. 전체 테이블을 스캔할 필요가 없다.

### 사용 케이스와 지원 연산자

GIN은 데이터 타입별로 다른 **연산자 클래스(operator class)**를 사용한다.

```sql
-- JSONB 컬럼에 GIN 인덱스 생성 (기본 연산자 클래스)
-- 지원 연산자: @> (포함), ? (키 존재), ?| (키 중 하나 존재), ?& (키 모두 존재), @?, @@
CREATE INDEX idx_product_meta ON products USING GIN (metadata);

-- JSONB에 jsonb_path_ops 연산자 클래스 사용 (더 작은 인덱스, @>/@?/@@ 전용)
CREATE INDEX idx_product_meta_path ON products USING GIN (metadata jsonb_path_ops);

-- 배열 컬럼에 GIN 인덱스 생성
CREATE INDEX idx_article_tags ON articles USING GIN (tags);

-- Full-text search에 GIN 인덱스 생성
CREATE INDEX idx_post_search ON posts USING GIN (to_tsvector('english', content));
```

```sql
-- GIN 인덱스가 활용되는 쿼리 예시

-- JSONB 포함 검색 (@> 연산자)
SELECT * FROM products WHERE metadata @> '{"color": "red"}';

-- JSONB 키 존재 검색 (? 연산자)
SELECT * FROM products WHERE metadata ? 'color';

-- 배열 포함 검색 (@> 연산자)
SELECT * FROM articles WHERE tags @> ARRAY['python'];

-- 전문 검색 (@@ 연산자)
SELECT * FROM posts WHERE to_tsvector('english', content) @@ to_tsquery('database');
```

JSONB에서 **기본 GIN 연산자 클래스**는 `?`, `?|`, `?&`, `@>`, `@?`, `@@` 연산자를 모두 지원한다. 키 존재 검색(`?`)이 필요 없고 포함 검색(`@>`)만 사용한다면 `jsonb_path_ops` 클래스를 선택하면 인덱스 크기가 더 작고 검색 성능도 좋다.

### GIN의 쓰기 성능과 fastupdate

GIN은 읽기에 최적화된 구조라 쓰기 비용이 높다. 이를 완화하기 위해 PostgreSQL은 **fastupdate** 메커니즘을 제공한다.

fastupdate가 활성화되면(기본값) 새로 추가되는 항목을 즉시 GIN 트리에 삽입하지 않고 **pending list**에 임시 저장한다. pending list가 일정 크기(`gin_pending_list_limit`, 기본 4MB)에 도달하면 한꺼번에 GIN 트리에 병합한다.

```sql
-- fastupdate 비활성화 (쓰기 느림, 읽기 일관성 높음)
CREATE INDEX idx_tags ON articles USING GIN (tags) WITH (fastupdate = off);

-- pending list 수동 정리
SELECT gin_clean_pending_list('idx_tags');
```

pending list에 데이터가 쌓여 있으면 검색 시 pending list도 함께 스캔해야 하므로 읽기 성능이 다소 저하된다. 쓰기가 많은 시간대 이후 VACUUM이 자동으로 pending list를 정리하지만, 읽기 지연이 민감한 경우 `gin_clean_pending_list()` 함수로 수동 정리할 수 있다.

### B-Tree와 비교

| 구분 | B-Tree | GIN |
|------|--------|-----|
| 적합한 데이터 | 단일 스칼라 값 | 복합 값 (배열, JSONB, tsvector) |
| 쓰기 성능 | 빠름 | 느림 (역인덱스 업데이트 비용, fastupdate로 완화 가능) |
| 읽기 성능 (포함 검색) | 지원 안 됨 | 빠름 |
| 인덱스 크기 | 작음 | 큼 (jsonb_path_ops로 축소 가능) |

GIN은 쓰기가 많은 테이블에 올리면 INSERT/UPDATE 성능을 저하시킬 수 있다. 읽기 비율이 높고, 배열/JSONB 포함 검색이 자주 발생하는 컬럼에 적용하는 것이 적합하다.

## 3. BRIN (Block Range Index) — 물리적으로 정렬된 데이터의 경량 인덱스

---

BRIN(Block Range Index)은 발상이 독특한 인덱스다. 개별 row를 색인하는 대신, **디스크 블록의 범위 단위로 min/max 값만 저장**한다.

### 구조

PostgreSQL은 데이터를 8KB 단위의 블록(page)에 저장한다. BRIN은 여러 블록을 묶어 하나의 "블록 범위"로 취급하고, 그 범위 내의 최솟값과 최댓값만 기록한다.

```
-- logs 테이블, created_at 컬럼에 BRIN 인덱스 (pages_per_range = 128, 기본값)

블록 범위 0-127:   min=2024-01-01 00:00:00, max=2024-01-05 12:30:00
블록 범위 128-255: min=2024-01-05 12:30:01, max=2024-01-10 08:15:00
블록 범위 256-383: min=2024-01-10 08:15:01, max=2024-01-15 23:59:59
...
```

`WHERE created_at BETWEEN '2024-01-08' AND '2024-01-12'`를 처리할 때:
1. BRIN 인덱스를 스캔해 조건 범위와 겹치는 블록 범위를 찾는다 (128-255, 256-383).
2. 해당 블록 범위만 읽는다. 나머지 블록은 완전히 건너뛴다.

### pages_per_range 튜닝

`pages_per_range`는 하나의 BRIN 엔트리가 커버하는 블록 수를 결정한다. 기본값은 **128**이다.

```sql
-- 기본값 (128블록 = 약 1MB 범위 단위)
CREATE INDEX idx_logs_brin ON logs USING BRIN (created_at);

-- 더 세밀한 범위 (필터링 정밀도 높아짐, 인덱스 크기 증가)
CREATE INDEX idx_logs_brin ON logs USING BRIN (created_at) WITH (pages_per_range = 32);

-- 더 넓은 범위 (인덱스 크기 극소, 필터링 정밀도 낮아짐)
CREATE INDEX idx_logs_brin ON logs USING BRIN (created_at) WITH (pages_per_range = 256);
```

| pages_per_range | 인덱스 크기 | 필터링 정밀도 | 적합한 상황 |
|-----------------|-------------|---------------|-------------|
| 작은 값 (32) | 상대적으로 큼 | 높음 | 데이터 밀도가 높고 정밀한 필터링 필요 |
| 기본값 (128) | 작음 | 보통 | 대부분의 시계열 데이터 |
| 큰 값 (256+) | 매우 작음 | 낮음 | 데이터가 매우 크고 대략적 필터링으로 충분 |

### 효과적인 케이스 vs 비효과적인 케이스

BRIN의 핵심 전제는 **데이터가 물리적으로 정렬된 순서와 논리적 정렬 순서가 일치**해야 한다는 것이다.

**좋은 케이스: `logs.created_at`**

로그 테이블은 시간 순서대로 INSERT된다. 먼저 들어온 row가 디스크의 앞쪽 블록에, 나중에 들어온 row가 뒤쪽 블록에 저장된다. 물리적 순서와 시간 순서가 일치하므로 블록 범위별 min/max가 겹치지 않는다.

```sql
CREATE INDEX idx_logs_created_at ON logs USING BRIN (created_at);
```

**나쁜 케이스: `users.name`**

사용자는 이름 순서와 무관하게 가입한다. "Alice"가 블록 1에, "Zara"가 블록 2에, 다시 "Bob"이 블록 3에 들어갈 수 있다. 각 블록 범위의 min/max가 전체 알파벳 범위를 커버하게 되어 BRIN이 아무 블록도 스킵하지 못한다.

**주의: 지연 INSERT와 UPDATE**

시계열 데이터라도 다음 상황에서는 BRIN의 효율이 떨어진다:
- **과거 시간의 row가 나중에 INSERT되는 경우**: 해당 블록 범위의 min 값이 낮아져 범위가 넓어진다.
- **UPDATE가 발생하는 경우**: PostgreSQL의 MVCC 특성상 UPDATE는 새 row를 다른 블록에 기록할 수 있어 물리적 정렬이 흐트러진다.

```
-- 2024-01-03 데이터가 블록 범위 128-255에 늦게 들어온 경우:
블록 범위 128-255: min=2024-01-03, max=2024-01-10  -- 범위가 넓어짐 -> 필터링 효율 저하
```

BRIN의 효과를 극대화하려면 **append-only**(INSERT만, UPDATE/DELETE 없음) 패턴이 이상적이다.

### B-Tree와 비교

| 구분 | B-Tree | BRIN |
|------|--------|------|
| 인덱스 크기 | 데이터 크기의 약 10-30% | 수 KB ~ 수십 KB (수백 배 작음) |
| 단일 행 조회 | 빠름 | 블록 범위만 좁힘 (B-Tree보다 느림) |
| 범위 조회 (정렬 보장 데이터) | 빠름 | 빠름 |
| 범위 조회 (비정렬 데이터) | 빠름 | 거의 효과 없음 |
| 적합한 데이터 | 일반 | append-only 시계열 |

BRIN은 수십억 건의 시계열 로그 테이블처럼 인덱스 크기가 문제가 되는 상황에서 B-Tree의 현실적인 대안이 된다.

## 4. Covering Index — 테이블을 읽지 않는 인덱스

---

인덱스로 row를 찾은 뒤, 실제 데이터는 테이블(힙)에 있으므로 한 번 더 디스크를 읽어야 한다. 이 추가 접근을 **Heap Fetch**라고 부른다. Covering Index는 쿼리에 필요한 모든 컬럼을 인덱스에 포함시켜서 Heap Fetch를 완전히 제거하는 기법이다.

### INCLUDE 문법 (PostgreSQL 11+)

```sql
-- users 테이블: (id, email, name, status, created_at)
-- 아래 쿼리를 자주 실행한다고 가정
-- SELECT email, name FROM users WHERE status = 'active';

-- 일반 인덱스: status로 row를 찾고, email/name은 힙에서 추가로 읽음
CREATE INDEX idx_users_status ON users (status);

-- Covering Index: email, name을 인덱스에 포함 -> 힙 접근 불필요
CREATE INDEX idx_users_status_covering ON users (status) INCLUDE (email, name);
```

INCLUDE 절에 포함된 컬럼은 B+Tree의 **리프 노드에만 저장**된다. 내부 노드의 탐색 키로는 사용되지 않으므로, 인덱스 크기 증가를 최소화하면서 Index Only Scan을 가능하게 한다.

### INCLUDE vs 복합 인덱스 차이

두 가지 방법 모두 컬럼을 인덱스에 포함시키지만 역할이 다르다.

```sql
-- 복합 인덱스: (status, email) 모두 B+Tree 구조에 참여
-- -> WHERE status = 'active' AND email = 'a@b.com' 같은 조건에서도 활용 가능
-- -> 인덱스가 커지고 쓰기 비용 증가
CREATE INDEX idx_users_status_email ON users (status, email);

-- INCLUDE: email은 B+Tree 구조에 참여하지 않고 리프 노드에만 저장
-- -> WHERE email = '...' 조건만으로는 이 인덱스를 사용할 수 없음
-- -> 단순히 "힙 접근 제거"가 목적
CREATE INDEX idx_users_status_covering ON users (status) INCLUDE (email);
```

| 구분 | 복합 인덱스 `(a, b)` | `(a) INCLUDE (b)` |
|------|---------------------|-------------------|
| b 컬럼 탐색 조건 활용 | 가능 | 불가능 |
| b 컬럼 정렬 지원 | 가능 | 불가능 |
| 힙 접근 제거 | 가능 | 가능 |
| 인덱스 크기/쓰기 비용 | 큼 | 복합보다 작음 |

INCLUDE는 UNIQUE 인덱스와 함께 사용할 수도 있다. 이 경우 유니크 제약은 키 컬럼에만 적용되고, INCLUDE 컬럼은 제약에 포함되지 않는다.

```sql
-- x에 대해서만 유니크 제약, y는 단순 포함
CREATE UNIQUE INDEX tab_x_y ON tab(x) INCLUDE (y);
```

### EXPLAIN으로 효과 확인

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT email, name FROM users WHERE status = 'active';
```

Covering Index가 제대로 동작하면 실행 계획에 다음이 나타난다:
- `Index Only Scan` (일반 `Index Scan`이 아님)
- `Heap Fetches: 0`

만약 `Heap Fetches`가 높게 나온다면 **VACUUM**이 필요한 상태다. PostgreSQL은 가시성(visibility) 정보를 힙에 저장하므로, **visibility map**이 최신 상태가 아니면 Index Only Scan이어도 힙을 확인해야 한다. 이는 PostgreSQL의 MVCC 구조상 해당 row가 현재 트랜잭션에서 보이는지를 반드시 검증해야 하기 때문이다.

```sql
-- Heap Fetches가 높을 때
VACUUM ANALYZE users;
-- VACUUM 후 다시 EXPLAIN하면 Heap Fetches가 0 또는 매우 낮아진다.
```

### INCLUDE 사용 시 주의사항

- INCLUDE에 여러 컬럼을 추가할수록 인덱스 크기가 커진다. 인덱스가 크면 캐시 효율(shared_buffers)이 떨어지고 쓰기 성능도 저하된다.
- INCLUDE 컬럼은 탐색에 사용되지 않으므로, WHERE 절 조건으로만 사용하는 컬럼은 INCLUDE가 아닌 인덱스 키에 포함해야 한다.
- 실제 실행 계획에서 Heap Fetch가 병목임을 확인한 뒤 적용하는 것이 좋다. "혹시 모르니까" 여러 컬럼을 INCLUDE하는 것은 비용 대비 효과가 떨어질 수 있다.

## 5. 시계열 데이터와 BRIN — 현실적인 선택

---

BRIN을 설명하면서 append-only 시계열 데이터가 최적이라고 했다. 이 맥락에서 시계열 데이터 처리 전략을 간략히 정리한다.

### 전용 시계열 DB

대표적인 시계열 전용 DB로 InfluxDB, TimescaleDB(PostgreSQL 확장), Prometheus가 있다. 이들이 일반 RDBMS보다 빠른 이유는 다음 세 가지가 결합되어 있기 때문이다:
1. **컬럼 기반 저장**: 시간 범위 조회 시 관련 컬럼만 읽는다.
2. **시간 기준 물리 정렬**: 데이터가 시간 순으로 연속 저장된다.
3. **압축**: 시계열 특성상 인접 값의 차이가 작아 높은 압축률을 달성한다.

다만 전용 시계열 DB는 별도 운영 비용이 발생하고, 기존 RDBMS 생태계(ORM, 마이그레이션 도구 등)와 통합이 복잡하다.

### Aurora + BRIN + 파티셔닝

별도 시계열 DB 없이 PostgreSQL(또는 Aurora) 위에서 현실적으로 대응하는 방법은 다음 조합이다:

```sql
-- 1. 월별 파티셔닝으로 오래된 데이터 분리
CREATE TABLE logs (
    id          BIGSERIAL,
    created_at  TIMESTAMPTZ NOT NULL,
    event_type  TEXT,
    payload     JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE logs_2024_01 PARTITION OF logs
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE logs_2024_02 PARTITION OF logs
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- 2. 각 파티션에 BRIN 적용 (append-only 보장 -> BRIN 효과 극대화)
CREATE INDEX idx_logs_2024_01_brin ON logs_2024_01 USING BRIN (created_at);
CREATE INDEX idx_logs_2024_02_brin ON logs_2024_02 USING BRIN (created_at);

-- 3. JSONB payload에는 GIN 인덱스 (이벤트 내용 기반 검색)
CREATE INDEX idx_logs_2024_01_gin ON logs_2024_01 USING GIN (payload);
```

이 조합의 장점:
- **파티셔닝**: 쿼리 시 PostgreSQL이 자동으로 관련 파티션만 스캔(partition pruning). 오래된 파티션은 `DROP TABLE`로 즉시 삭제 가능 (DELETE 비용 없음).
- **BRIN**: 각 파티션 내에서 시간 기반 범위 검색을 경량 인덱스로 처리.
- **GIN**: JSONB payload 안의 특정 키/값 검색을 효율적으로 처리.

이 방법은 시계열 전용 DB 없이도 수십억 건 규모를 처리할 수 있으며, PostgreSQL의 기존 생태계(pg_dump, ORM, 모니터링 도구 등)를 그대로 활용할 수 있다.

## 정리

---

| 인덱스 타입 | 핵심 특징 | 적합한 케이스 | 주의사항 |
|-------------|-----------|---------------|----------|
| B-Tree (B+Tree) | 리프 연결, 범위 검색 강함 | 단일 스칼라 값, 등가/범위 조건 | 기본 선택지 |
| GIN | 역인덱스, 복합 값 색인 | JSONB, 배열, 전문 검색 | 쓰기 성능 저하, fastupdate 활용 |
| BRIN | 블록 범위 min/max | append-only 시계열, 대용량 | 물리적 정렬 전제, UPDATE 시 효율 저하 |
| Covering (INCLUDE) | 힙 접근 제거 | 읽기 빈도 높은 특정 쿼리 | 인덱스 크기 증가, VACUUM 필요 |

인덱스 선택의 흐름은 대략 이렇다:
1. 기본은 **B-Tree**. 대부분의 등가/범위 조건은 여기서 해결된다.
2. JSONB, 배열, 전문 검색이 필요하면 **GIN**. 연산자 클래스(`jsonb_path_ops` 등)를 용도에 맞게 선택한다.
3. 수십억 건의 시계열 로그처럼 인덱스 크기가 문제가 되면 **BRIN** (물리적 정렬 보장 필요). `pages_per_range`를 데이터 특성에 맞게 조정한다.
4. 특정 쿼리의 Heap Fetch가 병목이면 **Covering Index(INCLUDE)**. EXPLAIN으로 효과를 반드시 검증한다.

## Reference

---

- [PostgreSQL 공식 문서 -- Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL -- Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL -- GIN Indexes](https://www.postgresql.org/docs/current/gin.html)
- [PostgreSQL -- BRIN Indexes](https://www.postgresql.org/docs/current/brin.html)
- [PostgreSQL -- Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html)
- [PostgreSQL -- JSONB Indexing](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)
- [PostgreSQL -- CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
