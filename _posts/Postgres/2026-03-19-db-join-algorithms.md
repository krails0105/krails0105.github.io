---
title: "[PostgreSQL] DB 조인 알고리즘 -- Nested Loop, Hash Join, Sort Merge Join 비교"
categories:
  - Postgres
tags: [PostgreSQL, Join, Nested Loop, Hash Join, Merge Join, Query Optimizer, EXPLAIN]
---

## Introduction

---

SQL에서 `JOIN`은 자주 쓰는 문법이지만, 실제로 DB 엔진이 어떻게 두 테이블을 합치는지는 잘 모르고 넘어가는 경우가 많습니다.

PostgreSQL은 조인을 수행할 때 상황에 따라 3가지 알고리즘 중 하나를 선택합니다.

- **Nested Loop Join** -- 이중 for문으로 행을 하나씩 매칭
- **Hash Join** -- 해시 테이블로 매칭
- **Sort Merge Join** -- 양쪽을 정렬한 뒤 동시에 훑기

옵티마이저가 자동으로 선택해 주지만, 각 알고리즘의 동작 원리와 선택 조건을 이해해야 쿼리 성능 문제를 진단하고 적절한 튜닝 방향을 잡을 수 있습니다.

이 글에서는 각 알고리즘의 동작 원리, 유리한 상황, 그리고 `EXPLAIN ANALYZE`로 실행 계획을 확인하는 방법까지 다룹니다.

## 1. Nested Loop Join

---

가장 단순한 알고리즘입니다. 외부 테이블(outer)의 행을 하나씩 꺼내면서, 내부 테이블(inner)에서 매칭되는 행을 찾습니다. 구조는 이중 `for` 루프와 동일합니다.

```
for each row in outer_table:
    for each row in inner_table:
        if join_condition matches:
            output row
```

PostgreSQL 공식 문서의 표현에 따르면, "the right relation is scanned once for every row found in the left relation"입니다. 단순하지만, inner 테이블에 인덱스가 있으면 매우 효율적입니다.

### 3가지 변형

| 변형 | 내부 테이블 접근 방식 | 연산 횟수 예시 (outer=1,000, inner=10,000) |
|------|----------------------|------------------------------------------|
| Simple NLJ | 풀 스캔 | 1,000 x 10,000 = **1,000만 번** |
| Index NLJ | 인덱스 탐색 | 1,000 x log(10,000) = **약 14,000번** |
| Batched Key Access (BKA) | outer 행을 배치로 모아 인덱스 탐색 | Index NLJ의 I/O 최적화 버전 |

인덱스 유무에 따라 연산 횟수가 천 배 이상 차이 납니다. Simple NLJ에서 inner 테이블에 인덱스가 없으면 매번 풀 스캔이 반복되므로 대용량에는 적합하지 않습니다.

### 언제 유리한가

- outer 테이블이 **소량**일 때
- inner 테이블 조인 컬럼에 **인덱스**가 있을 때
- `LIMIT`이 있는 쿼리 -- 원하는 행 수가 채워지면 즉시 중단할 수 있어 전체를 순회하지 않아도 됩니다

```sql
-- LIMIT이 있으면 Nested Loop가 유리합니다
-- 인덱스로 빠르게 매칭하고 10건이 나오면 바로 종료합니다
SELECT o.id, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'pending'
LIMIT 10;
```

### 주의사항

Nested Loop는 **모든 조인 조건(등가, 부등호, 비동치 조건)**에 사용할 수 있는 유일한 알고리즘입니다. 하지만 inner 테이블에 인덱스가 없고 양쪽 테이블이 모두 대용량이면 성능이 급격히 나빠집니다. `EXPLAIN ANALYZE`에서 Nested Loop가 나왔는데 실행 시간이 느리다면, inner 테이블의 조인 컬럼에 인덱스가 있는지 확인해 보는 것이 좋습니다.

## 2. Hash Join

---

한쪽 테이블(Build side)로 해시 테이블을 메모리에 구성한 뒤, 다른 쪽 테이블(Probe side)을 순회하며 해시 테이블에서 매칭 행을 찾습니다. PostgreSQL에서는 일반적으로 작은 쪽 테이블을 Build side로 선택합니다.

```
-- Build phase: 작은 테이블로 해시 테이블 구성
hash_table = {}
for each row in build_table:
    hash_table[hash(row.join_key)] = row

-- Probe phase: 큰 테이블을 순회하며 매칭
for each row in probe_table:
    if hash(row.join_key) in hash_table:
        output (hash_table[row.join_key], row)
```

해시 테이블 조회는 O(1)이므로, 인덱스가 없는 대용량 등가 조인에서 Nested Loop보다 훨씬 빠릅니다.

### 제약 사항

**등가 조건(`=`)만 가능합니다.** 해시 함수는 같음 여부만 판단할 수 있으므로 `>`, `<` 같은 부등호 조인에는 사용할 수 없습니다.

### work_mem과 디스크 Spill

해시 테이블이 메모리에 다 들어가지 않으면 디스크로 내보내는 **배치 처리(Batched Hash Join)**가 발생하고 성능이 떨어집니다.

PostgreSQL에서 해시 연산에 할당되는 메모리는 `work_mem * hash_mem_multiplier`로 계산됩니다. `hash_mem_multiplier`의 기본값은 2.0이므로, `work_mem`이 기본값 4MB라면 해시 테이블에는 최대 8MB가 할당됩니다.

```sql
-- EXPLAIN ANALYZE로 Batches 확인
EXPLAIN ANALYZE
SELECT * FROM orders o JOIN users u ON o.user_id = u.id;

-- 출력 예시
-- Hash Join  (cost=... rows=...)
--   Hash Cond: (o.user_id = u.id)
--   ->  Seq Scan on orders ...
--   ->  Hash  (cost=...)
--        Buckets: 1024  Batches: 1  Memory Usage: 42kB   -- Batches: 1이면 메모리에 전부 올라간 것
--        Buckets: 1024  Batches: 8  Memory Usage: ...     -- Batches > 1이면 디스크 spill 발생
```

`Batches: 1`이면 해시 테이블 전체가 메모리에 올라간 것입니다. `Batches` 값이 높을수록 디스크 I/O가 증가합니다. PostgreSQL 공식 문서에 따르면, "If the number of batches exceeds one, there will also be disk space usage involved"입니다.

세션 수준에서 `work_mem`을 늘려 spill을 방지할 수 있습니다.

```sql
-- 세션 단위로 work_mem 조정 (전체 서버 설정을 바꾸지 않음)
SET work_mem = '256MB';
```

**주의:** `work_mem`은 쿼리 내 **각 정렬/해시 연산마다 별도로** 할당됩니다. 복잡한 쿼리에서 여러 해시/정렬이 동시에 발생하면 실제 메모리 사용량이 `work_mem`의 몇 배가 될 수 있으므로, 전역 설정을 과도하게 높이는 것은 위험합니다.

### 언제 유리한가

- 조인 대상이 **대용량**이고 인덱스가 없을 때
- 조인 조건이 **등가(`=`)** 일 때
- Build side 테이블이 `work_mem` 범위 내에 들어갈 때

## 3. Sort Merge Join

---

양쪽 테이블을 조인 키로 정렬한 뒤, 두 포인터를 동시에 앞으로 이동하며 매칭 행을 찾습니다. 머지 정렬(Merge Sort)의 병합 단계와 동일한 방식입니다.

```
sort table_a by join_key
sort table_b by join_key

pointer_a = 0, pointer_b = 0
while pointer_a < len(table_a) and pointer_b < len(table_b):
    if table_a[pointer_a].key == table_b[pointer_b].key:
        output match
        advance both pointers (handling duplicates)
    elif table_a[pointer_a].key < table_b[pointer_b].key:
        pointer_a++
    else:
        pointer_b++
```

각 테이블을 한 번씩만 훑으므로, 정렬 비용을 제외한 조인 자체는 O(N+M)입니다.

### 정렬 비용이 0이 되는 경우

이미 정렬된 데이터를 조인하면 Sort 단계를 건너뛸 수 있습니다. PostgreSQL 공식 문서에 따르면, "The required sorting might be achieved either by an explicit sort step, or by scanning the relation in the proper order using an index on the join key"입니다. 인덱스 스캔 결과가 이미 정렬되어 있거나, 선행 `ORDER BY`가 있는 경우 Sort가 생략되어 Merge Join이 가장 빠른 선택이 됩니다.

```sql
-- 두 테이블 모두 id 컬럼에 인덱스가 있으면
-- Sort 없이 Merge Join을 수행할 수 있습니다
SELECT a.id, b.value
FROM table_a a
JOIN table_b b ON a.id = b.id
ORDER BY a.id;
```

### Hash Join과 비교

| 비교 항목 | Hash Join | Sort Merge Join |
|-----------|-----------|-----------------|
| 부등호 조인 | 불가 | 가능 (`<`, `>`, `BETWEEN`) |
| 메모리 부족 시 | Batched Hash Join -- 디스크 I/O 급증 | 외부 정렬(external sort)로 처리 -- 상대적으로 안정적 |
| 이미 정렬된 입력 | 이점 없음 | Sort 비용 0 -- 매우 빠름 |
| 인덱스 필요 여부 | 필요 없음 | 정렬 비용 제거를 위해 인덱스가 도움됨 |

메모리가 부족하면 Hash Join은 디스크 spill로 성능이 급락하지만, Merge Join은 외부 정렬을 사용하여 더 안정적으로 처리합니다.

### 언제 유리한가

- 조인 컬럼이 **이미 정렬**되어 있을 때 (인덱스 스캔 결과 등)
- 조인 조건이 **부등호**(`<`, `>`, `BETWEEN`)일 때
- 대용량이지만 **메모리가 부족**할 때

## 4. 세 알고리즘 비교 정리

---

| 항목 | Nested Loop Join | Hash Join | Sort Merge Join |
|------|-----------------|-----------|-----------------|
| 시간 복잡도 | O(N x M) / O(N x logM) with index | O(N + M) | O(NlogN + MlogM + N + M) |
| 등가 조인(`=`) | 가능 | 가능 | 가능 |
| 부등호 조인(`<`, `>`) | 가능 | **불가** | 가능 |
| 인덱스 활용 | inner 인덱스가 핵심 | 불필요 | 정렬 비용 제거에 도움 |
| 메모리 민감도 | 낮음 | **높음** (해시 테이블) | 중간 (정렬 버퍼) |
| LIMIT 최적화 | 가능 (조기 종료) | 불가 (전체 빌드 필요) | 불가 (전체 정렬 필요) |

## 5. 옵티마이저의 자동 선택

---

실제 쿼리에서 어떤 알고리즘을 쓸지는 **쿼리 옵티마이저**가 비용(cost) 기반으로 자동 결정합니다.

### 옵티마이저가 고려하는 요소

- **pg_stats 통계**: 테이블의 행 수, 고유값 수(n_distinct), 데이터 분포(most_common_vals)
- **인덱스 유무**: 조인 컬럼에 인덱스가 있는지
- **work_mem 크기**: 해시 테이블이나 정렬 버퍼가 메모리에 들어갈 수 있는지

```sql
-- 옵티마이저가 선택한 알고리즘 확인
EXPLAIN ANALYZE
SELECT o.id, u.name
FROM orders o
JOIN users u ON o.user_id = u.id;

-- 출력 예시
-- Hash Join  (cost=25.00..87.50 rows=1000 width=...)
--   Hash Cond: (o.user_id = u.id)
--   ->  Seq Scan on orders  (cost=... rows=...)
--   ->  Hash  (cost=... rows=...)
--        ->  Seq Scan on users  (cost=... rows=...)
```

### 통계가 오래되면 잘못된 알고리즘을 선택한다

옵티마이저는 `pg_stats`의 통계를 기반으로 비용을 추정합니다. 대량 INSERT/DELETE 이후 통계가 갱신되지 않으면 실제 행 수와 통계가 달라져 잘못된 알고리즘을 선택할 수 있습니다.

```sql
-- 통계 갱신 (테이블 단위)
ANALYZE orders;
ANALYZE users;
```

PostgreSQL은 autovacuum 데몬이 자동으로 `ANALYZE`를 수행하지만, 대량 데이터 변경 직후에는 수동으로 실행하는 것이 좋습니다.

### 알고리즘 강제 지정 (디버깅/테스트 용도)

특정 알고리즘을 비활성화하여 다른 알고리즘을 강제로 선택하게 할 수 있습니다.

```sql
-- Hash Join 비활성화 (Nested Loop 또는 Merge Join 강제)
SET enable_hashjoin = off;

-- Nested Loop 비활성화
SET enable_nestloop = off;

-- Merge Join 비활성화
SET enable_mergejoin = off;
```

단, **99%의 경우 옵티마이저가 올바르게 선택합니다.** 강제 지정은 `EXPLAIN ANALYZE`로 실행 계획을 분석한 뒤, 명확한 이유가 있을 때만 사용해야 합니다. 프로덕션 환경에서 이 설정을 전역으로 변경하는 것은 권장하지 않습니다.

## 6. 실무에서 자주 만나는 함정

---

### 함정 1: Hash Join인데 느리다면 Batches를 확인

`EXPLAIN ANALYZE` 결과에서 Hash Join이 선택되었는데 예상보다 느리다면, `Batches` 값을 확인합니다. `Batches`가 1보다 크면 디스크 spill이 발생한 것입니다. 세션 수준에서 `work_mem`을 올려보고 성능 변화를 확인합니다.

### 함정 2: Nested Loop가 선택되었는데 느리다면 인덱스를 확인

옵티마이저가 Nested Loop를 선택했는데 inner 테이블에 인덱스가 없으면 매번 Seq Scan이 반복됩니다. 조인 컬럼에 인덱스를 추가하거나, `ANALYZE`로 통계를 갱신하여 옵티마이저가 Hash Join 또는 Merge Join을 선택하도록 유도합니다.

### 함정 3: 통계가 오래되어 잘못된 계획이 선택됨

대량 데이터 변경(벌크 INSERT, DELETE, UPDATE) 후에는 반드시 `ANALYZE`를 실행합니다. 통계가 실제 데이터와 크게 다르면 옵티마이저가 잘못된 비용을 추정하여 비효율적인 조인 알고리즘을 선택할 수 있습니다.

## 7. 상황별 권장 알고리즘 요약

---

| 상황 | 권장 알고리즘 | 이유 |
|------|-------------|------|
| outer 소량 + inner 인덱스 있음 | Nested Loop | 인덱스 탐색으로 O(N x logM) |
| 대용량 + 인덱스 없음 + 등가 조건(`=`) | Hash Join | 해시 테이블 O(1) 조회 |
| 대용량 + 조인 컬럼 이미 정렬됨 | Merge Join | Sort 비용 0, 병합만 수행 |
| 대용량 + 부등호 조인(`<`, `>`) | Merge Join | Hash Join은 부등호 불가 |
| 대용량 + 메모리 부족 | Merge Join | 외부 정렬이 해시 spill보다 안정적 |
| LIMIT이 있는 소량 결과 쿼리 | Nested Loop | 조기 종료 가능 |

쿼리 성능 문제를 진단할 때는 `EXPLAIN ANALYZE`로 실제 실행 계획을 확인하는 것이 출발점입니다. 옵티마이저가 예상과 다른 알고리즘을 선택했다면, 먼저 `ANALYZE`로 통계를 갱신하고 다시 확인합니다.

## Reference

---

- [PostgreSQL 공식 문서 -- Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [PostgreSQL 공식 문서 -- Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL 공식 문서 -- work_mem](https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-WORK-MEM)
- [PostgreSQL 공식 문서 -- Planner Statistics](https://www.postgresql.org/docs/current/planner-stats.html)
