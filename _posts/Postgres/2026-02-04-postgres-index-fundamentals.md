---
title: "[PostgreSQL] 인덱스 기초 - B-tree, GIN, 언제 어떤 인덱스를 쓸까"
categories:
  - Postgres
tags:
  - [PostgreSQL, Index, Performance, Database]
---

# Introduction

---

인덱스는 **책의 목차**와 같습니다. 전체를 읽지 않고 원하는 내용을 빠르게 찾습니다.

```
인덱스 없이: 100만 행 전체 스캔 → 느림
인덱스 있으면: 바로 해당 행 찾기 → 빠름
```

# 1. 인덱스 타입

---

## B-tree (기본)

가장 일반적인 인덱스입니다. **정렬된 데이터**에 적합합니다.

```sql
CREATE INDEX idx_users_email ON users(email);

-- 적합한 쿼리
SELECT * FROM users WHERE email = 'user@example.com';
SELECT * FROM users WHERE email LIKE 'user%';  -- 접두사 검색
SELECT * FROM users ORDER BY email;
SELECT * FROM users WHERE email BETWEEN 'a' AND 'b';
```

**적합한 연산:** `=`, `<`, `>`, `<=`, `>=`, `BETWEEN`, `LIKE 'prefix%'`

## Hash

정확한 일치 검색에 최적화됩니다.

```sql
CREATE INDEX idx_users_id_hash ON users USING hash(id);

-- 적합한 쿼리
SELECT * FROM users WHERE id = 123;
```

**주의:** 범위 검색(`<`, `>`)에는 사용 불가

## GIN (Generalized Inverted Index)

**배열, JSON, 전문 검색**에 적합합니다.

```sql
-- 배열 인덱스
CREATE INDEX idx_posts_tags ON posts USING gin(tags);
SELECT * FROM posts WHERE tags @> ARRAY['python'];

-- JSON 인덱스
CREATE INDEX idx_data_json ON events USING gin(data jsonb_path_ops);
SELECT * FROM events WHERE data @> '{"type": "click"}';

-- 전문 검색
CREATE INDEX idx_posts_content ON posts USING gin(to_tsvector('english', content));
SELECT * FROM posts WHERE to_tsvector('english', content) @@ to_tsquery('python');
```

## GiST (Generalized Search Tree)

**공간 데이터, 범위 타입**에 적합합니다.

```sql
-- 지리 데이터 (PostGIS)
CREATE INDEX idx_locations_geom ON locations USING gist(geom);

-- 범위 타입
CREATE INDEX idx_reservations_period ON reservations USING gist(period);
SELECT * FROM reservations WHERE period && '[2024-01-01, 2024-01-31]';
```

## BRIN (Block Range Index)

**물리적으로 정렬된 대용량 테이블**에 적합합니다. 매우 작은 크기.

```sql
-- 시계열 데이터 (시간순 삽입)
CREATE INDEX idx_logs_time ON logs USING brin(created_at);

-- 적합: created_at이 삽입 순서와 일치할 때
SELECT * FROM logs WHERE created_at >= '2024-01-01';
```

# 2. 인덱스 선택 가이드

---

| 용도 | 인덱스 타입 |
|------|------------|
| 일반적인 조회 (=, <, >) | B-tree |
| 정확한 일치만 | Hash |
| 배열 포함 검색 | GIN |
| JSON 필드 검색 | GIN |
| 전문 검색 | GIN |
| 공간/범위 데이터 | GiST |
| 대용량 시계열 | BRIN |

# 3. 복합 인덱스

---

## 컬럼 순서가 중요

```sql
CREATE INDEX idx_orders ON orders(user_id, created_at);

-- 인덱스 사용 O
SELECT * FROM orders WHERE user_id = 1;
SELECT * FROM orders WHERE user_id = 1 AND created_at > '2024-01-01';

-- 인덱스 사용 X (첫 번째 컬럼 없음)
SELECT * FROM orders WHERE created_at > '2024-01-01';
```

**규칙:** 인덱스는 **왼쪽부터** 사용됩니다.

## 컬럼 순서 결정

```
1. WHERE 절에 자주 쓰이는 컬럼 → 앞쪽
2. 등호(=) 조건 → 범위 조건보다 앞쪽
3. 카디널리티 높은 컬럼 → 앞쪽
```

```sql
-- 예: user_id = ?, status = ?, created_at > ?
-- 좋은 순서: (user_id, status, created_at)
CREATE INDEX idx_orders_composite ON orders(user_id, status, created_at);
```

# 4. 부분 인덱스 (Partial Index)

---

조건을 만족하는 행만 인덱싱합니다.

```sql
-- 활성 사용자만 인덱싱
CREATE INDEX idx_users_active ON users(email)
WHERE is_active = true;

-- 미완료 주문만 인덱싱
CREATE INDEX idx_orders_pending ON orders(user_id)
WHERE status = 'pending';
```

**장점:** 인덱스 크기 감소, 쓰기 성능 향상

# 5. 커버링 인덱스 (Index Only Scan)

---

인덱스만으로 쿼리 결과를 반환합니다.

```sql
CREATE INDEX idx_orders_covering ON orders(user_id, status, total);

-- 테이블 접근 없이 인덱스만 스캔
SELECT user_id, status, total FROM orders WHERE user_id = 1;
```

## INCLUDE 절 (PostgreSQL 11+)

```sql
CREATE INDEX idx_orders ON orders(user_id)
INCLUDE (status, total);

-- user_id로 검색, status와 total도 인덱스에서 가져옴
```

# 6. 인덱스 확인 및 분석

---

## 인덱스 목록

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'orders';
```

## 인덱스 크기

```sql
SELECT
    indexrelname AS index_name,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE relname = 'orders';
```

## EXPLAIN으로 사용 확인

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE user_id = 1;

-- 결과 예시
-- Index Scan using idx_orders_user_id on orders
--   Index Cond: (user_id = 1)
--   Actual time: 0.025..0.030 rows=10
```

## 인덱스 사용률

```sql
SELECT
    relname AS table,
    indexrelname AS index,
    idx_scan AS scans,
    idx_tup_read AS tuples_read
FROM pg_stat_user_indexes
ORDER BY idx_scan DESC;
```

# 7. 인덱스 유지보수

---

## REINDEX

```sql
-- 인덱스 재구축 (테이블 잠금)
REINDEX INDEX idx_orders_user_id;

-- 동시 재구축 (PostgreSQL 12+)
REINDEX INDEX CONCURRENTLY idx_orders_user_id;
```

## VACUUM과 인덱스

```sql
-- 인덱스 팽창 확인
SELECT
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0  -- 사용 안 되는 인덱스
ORDER BY pg_relation_size(indexrelid) DESC;
```

# 8. 인덱스 안티 패턴

---

## 안티 패턴 1: 모든 컬럼에 인덱스

```sql
-- 나쁜 예: 불필요한 인덱스
CREATE INDEX idx1 ON users(id);       -- PK 이미 있음
CREATE INDEX idx2 ON users(name);     -- 사용 안 됨
CREATE INDEX idx3 ON users(created);  -- 사용 안 됨
```

## 안티 패턴 2: 함수 적용

```sql
-- 인덱스 사용 X
SELECT * FROM users WHERE LOWER(email) = 'user@example.com';

-- 해결: 함수 인덱스
CREATE INDEX idx_users_email_lower ON users(LOWER(email));
```

## 안티 패턴 3: 타입 불일치

```sql
-- 인덱스 사용 X (암시적 캐스팅)
SELECT * FROM users WHERE id = '123';  -- id가 integer일 때

-- 해결: 타입 일치
SELECT * FROM users WHERE id = 123;
```

## 안티 패턴 4: 와일드카드 앞에 %

```sql
-- 인덱스 사용 X
SELECT * FROM users WHERE email LIKE '%@gmail.com';

-- 인덱스 사용 O
SELECT * FROM users WHERE email LIKE 'user%';
```

# 9. 체크리스트

---

```
□ WHERE 절에 자주 쓰이는 컬럼에 인덱스가 있는가?
□ 복합 인덱스의 컬럼 순서가 적절한가?
□ 사용되지 않는 인덱스를 정리했는가?
□ EXPLAIN으로 인덱스 사용을 확인했는가?
□ 부분 인덱스로 크기를 줄일 수 있는가?
□ 인덱스 유지보수(REINDEX)를 하고 있는가?
```

# Reference

---

- [PostgreSQL Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [Use The Index, Luke](https://use-the-index-luke.com/)
