---
title: "[Spark] Pre-aggregation 패턴 - 조인 전에 데이터 규모를 줄이는 기법"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, PreAggregation, JoinOptimization, Performance]
---

# Introduction

---

대규모 조인의 성능 문제는 대부분 **조인에 참여하는 행 수**에서 비롯됩니다. 예를 들어, `orders`(1억 행) JOIN `stores`(1만 행)에서 1억 행을 그대로 조인하는 대신, **`store_id`별로 먼저 GROUP BY**(1억→1만)해둔 뒤 조인하면 셔플 데이터가 100배 줄어듭니다.

이것이 **Pre-aggregation** 패턴입니다. 관계 대수에서는 **"pushing aggregation below the join"**이라고 부르며, Spark의 Catalyst optimizer는 이 변환을 자동으로 수행하지 않기 때문에 개발자가 직접 적용해야 합니다.

이 글은 이 패턴이 왜 동작하는지, 어떤 집계 함수가 안전하게 분해 가능한지(가법성), 그리고 재집계 시 어떤 함정이 있는지를 정리합니다.

# 1. 조인 비용과 행 수의 관계

---

Spark가 조인을 실행할 때 발생하는 비용을 나눠보면:

## 셔플(Shuffle) 비용

```text
SortMergeJoin 기준:
  1. 양쪽 테이블을 조인 키로 repartition (전체 행을 네트워크 전송)
  2. 같은 키를 가진 행이 같은 파티션에 모임
  3. 파티션 내에서 정렬 후 매칭
```

셔플에서 전송되는 데이터량 = **행 수 × 행 크기**. 행 수를 10분의 1로 줄이면 셔플 데이터도 10분의 1로 줄어듭니다.

## 비교(Comparison) 비용

```text
NestedLoopJoin (range join):
  비교 횟수 = 행 수A × 행 수B

HashJoin:
  해시 테이블 크기 = 작은쪽 행 수
  프로빙 = 큰쪽 행 수 × O(1)
```

어떤 조인 전략이든, 행 수가 줄면 비용이 줄어듭니다.

## 메모리 비용

```text
BroadcastHashJoin:
  작은쪽 전체를 executor 메모리에 로드
  행 수가 많으면 broadcast 불가 → 느린 SortMergeJoin으로 퇴화

Cache/Persist:
  중간 결과를 메모리에 올릴 때, 행 수가 적으면 메모리 압박 감소
```

## 예시: 행 수 축소의 효과

```text
Before: orders(1억 행) JOIN products(10만 행)
  → 셔플: 1억 행 전송
  → 해시 테이블: 10만 행

After:  orders_agg(100만 행) JOIN products(10만 행)
  → 셔플: 100만 행 전송 (100배 감소)
  → 해시 테이블: 10만 행 (동일)
```

# 2. Pre-aggregation의 원리: "Aggregate Below the Join"

---

관계 대수(relational algebra)에서 이 최적화는 **"pushing aggregation below the join"**이라고 불립니다.

```text
원래 쿼리:
  SELECT region, SUM(o.amount)
  FROM orders o
  JOIN stores s ON o.store_id = s.store_id
  GROUP BY s.region

실행 순서: JOIN → GROUP BY (1억 행 조인 후 집계)
```

orders에서 최종적으로 필요한 정보는 `store_id`별 `SUM(amount)`입니다. 그렇다면:

```text
최적화된 쿼리:
  -- Step 1: 조인 전에 집계 (1억 → store_id 수 = 수천)
  WITH orders_agg AS (
      SELECT store_id, SUM(amount) AS total_amount
      FROM orders
      GROUP BY store_id
  )
  -- Step 2: 집계된 결과로 조인 (수천 행 조인)
  SELECT s.region, SUM(oa.total_amount)
  FROM orders_agg oa
  JOIN stores s ON oa.store_id = s.store_id
  GROUP BY s.region
```

핵심 변환:

```text
JOIN(1억) → GROUP BY
         ↓ 변환
GROUP BY → JOIN(수천) → GROUP BY
```

**조인 전에 GROUP BY를 끌어내림으로써, 조인에 참여하는 행 수를 줄입니다.**

## Spark optimizer는 이걸 자동으로 하는가?

**하지 않습니다.** Spark의 Catalyst optimizer는 predicate pushdown(필터 조건 밀어내기)은 자동으로 하지만, aggregate pushdown(집계 밀어내기)은 하지 않습니다. 이유는:

- 집계를 조인 아래로 옮겼을 때 결과가 동일한지 판단이 어려움
- 모든 집계가 이 변환에 안전한 것이 아님 (비가법적 집계)
- 사용자가 의도한 semantics를 보장할 수 없음

따라서 **개발자가 직접 pre-aggregation 테이블을 설계**해야 합니다.

# 3. 가법성(Additivity): Pre-aggregation이 가능한 집계 함수

---

Pre-aggregation의 핵심 조건은 **집계의 가법성**입니다. 부분 집계를 다시 집계해서 전체 결과를 복원할 수 있는가?

## 가법적(Additive) 집계

```text
"부분합의 합 = 전체합"

SUM:
  그룹1의 SUM = 100, 그룹2의 SUM = 200
  전체 SUM = 100 + 200 = 300 ✅

COUNT:
  그룹1의 COUNT = 50, 그룹2의 COUNT = 30
  전체 COUNT = SUM(50, 30) = 80 ✅
  주의: COUNT(COUNT)가 아니라 SUM(COUNT)!

MIN / MAX:
  그룹1의 MIN = 3, 그룹2의 MIN = 7
  전체 MIN = MIN(3, 7) = 3 ✅
```

가법적 집계는 pre-aggregation 후에도 올바른 결과를 복원할 수 있습니다.

## 비가법적(Non-Additive) 집계

```text
"부분 결과를 합쳐도 전체 결과를 복원할 수 없음"

AVG:
  그룹1: 값=[10, 20], AVG=15, COUNT=2
  그룹2: 값=[30],     AVG=30, COUNT=1
  전체 AVG = (10+20+30)/3 = 20
  AVG(AVG) = (15+30)/2 = 22.5 ❌ (틀림!)

  → 복원하려면 SUM과 COUNT를 별도 보관 후 SUM/COUNT 필요

MEDIAN:
  그룹1: 값=[1,2,3],   MEDIAN=2
  그룹2: 값=[10,20,30], MEDIAN=20
  전체 MEDIAN = MEDIAN(1,2,3,10,20,30) = 6.5
  MEDIAN(2, 20) = 11 ❌ (틀림!)

  → 개별 값이 필요, pre-agg로 복원 불가

COUNT DISTINCT:
  그룹1: distinct_users = {A, B, C} → COUNT=3
  그룹2: distinct_users = {B, C, D} → COUNT=3
  전체 COUNT DISTINCT = {A, B, C, D} → 4
  SUM(3, 3) = 6 ❌ (중복!)

  → 정확한 복원 불가 (HyperLogLog 근사치로만 가능)
```

## 반가법적(Semi-Additive) 집계

시간 축이나 특정 차원에서만 가법적인 경우:

```text
계좌 잔액:
  일별 잔액은 SUM이 아니라 마지막 값(snapshot)
  → 날짜 차원으로는 SUM 불가, 계좌 차원으로는 SUM 가능
```

## 정리: 집계 함수 분류

| 분류 | 함수 | Pre-agg 후 복원 | 방법 |
|------|------|----------------|------|
| 가법적 | SUM | O | SUM(SUM) |
| 가법적 | COUNT | O | SUM(COUNT) |
| 가법적 | MIN, MAX | O | MIN(MIN), MAX(MAX) |
| 비가법적 | AVG | 조건부 | SUM/COUNT 보관 → 나눗셈 |
| 비가법적 | MEDIAN, PERCENTILE | X | 개별 값 필요 |
| 비가법적 | COUNT DISTINCT | X | HyperLogLog로 근사만 가능 |

# 4. Pre-aggregation 후 재집계의 함정

---

Pre-agg 결과를 조인한 뒤 다시 집계할 때 자주 실수하는 패턴입니다.

## 함정 1: COUNT(*) vs SUM(count)

```sql
-- 원본 테이블: orders (1억 행)
-- Pre-agg: store별 집계 (1만 행)
CREATE TABLE orders_agg AS
SELECT store_id,
       SUM(amount) AS total_amount,
       COUNT(*) AS order_count    -- 주문 건수 보관
FROM orders
GROUP BY store_id;
```

```sql
-- ❌ 틀린 쿼리
SELECT region, COUNT(*) AS total_orders
FROM orders_agg oa JOIN stores s USING (store_id)
GROUP BY region;
-- COUNT(*)는 "pre-agg 행의 수" = store 수이지 주문 수가 아님!

-- ✅ 올바른 쿼리
SELECT region, SUM(oa.order_count) AS total_orders
FROM orders_agg oa JOIN stores s USING (store_id)
GROUP BY region;
```

```text
원칙: pre-agg 후에는 COUNT(*)가 아니라 SUM(보관한_count)를 사용
```

## 함정 2: AVG의 재집계

```sql
-- Pre-agg에서 AVG를 저장했다면
CREATE TABLE orders_agg AS
SELECT store_id,
       AVG(amount) AS avg_amount,
       COUNT(*) AS order_count
FROM orders
GROUP BY store_id;
```

```sql
-- ❌ 틀림: AVG의 AVG
SELECT region, AVG(oa.avg_amount) AS region_avg
FROM orders_agg oa JOIN stores s USING (store_id)
GROUP BY region;
-- store마다 주문 수가 다르면 결과가 다름!

-- ✅ 가중 평균
SELECT region,
       SUM(oa.avg_amount * oa.order_count) / SUM(oa.order_count) AS region_avg
FROM orders_agg oa JOIN stores s USING (store_id)
GROUP BY region;
```

```text
원칙: AVG를 복원하려면 반드시 SUM과 COUNT를 같이 보관
      재집계 시 가중 평균(weighted average) 사용
```

## 함정 3: 곱셈 집계의 분배

```sql
-- 필요한 최종 계산: SUM(amount * price)

-- ✅ 방법 1: pre-agg 시 곱셈 집계를 미리 계산
SELECT store_id,
       SUM(amount * price) AS total_revenue  -- 미리 곱해서 합산
FROM orders
GROUP BY store_id;

-- ❌ 방법 2: pre-agg 후 곱셈 (틀림!)
SELECT store_id,
       SUM(amount) AS total_amount,
       AVG(price) AS avg_price
FROM orders
GROUP BY store_id;
-- SUM(amount) * AVG(price) ≠ SUM(amount * price)
```

```text
원칙: 곱셈이 포함된 집계는 pre-agg 시점에 미리 계산해야 함
      SUM(a) * SUM(b) ≠ SUM(a * b)
```

# 5. Pre-aggregation 설계 절차

---

```text
Step 1: 최종 쿼리에서 필요한 집계 식별
  → SUM(amount), COUNT(*), SUM(amount * price) 등

Step 2: 조인 키 식별
  → 어떤 컬럼으로 조인하는가? (store_id, date, category 등)

Step 3: 가법성 판단
  → 각 집계가 pre-agg 후에도 복원 가능한가?
  → 불가능하면 필요한 보조 값 추가 (SUM + COUNT for AVG)

Step 4: GROUP BY 키 결정
  → 조인 키 + 후속 집계에 필요한 차원

Step 5: Pre-agg 테이블 생성
  → 물리 테이블(Delta)로 저장, 적절한 CLUSTER BY
```

예시:

```sql
-- 최종 목표: 지역별, 카테고리별 매출 합계와 주문 수
-- 조인: orders × stores (store_id)
-- 필요한 집계: SUM(amount), COUNT(*), SUM(amount * price)

-- Pre-agg 설계
CREATE TABLE orders_agg AS
SELECT
    store_id,            -- 조인 키
    category,            -- 후속 GROUP BY에 필요
    SUM(amount) AS total_amount,
    SUM(amount * price) AS total_revenue,
    COUNT(*) AS order_count
FROM orders
GROUP BY store_id, category;
```

# 6. Spark에서의 실행 계획 차이

---

Pre-aggregation 전후로 EXPLAIN이 어떻게 달라지는지:

## Before (1억 행 조인)

```text
== Physical Plan ==
SortMergeJoin [store_id]
├── Exchange hashpartitioning(store_id, 200)  ← 1억 행 셔플!
│   └── Scan orders (100,000,000 rows)
└── Exchange hashpartitioning(store_id, 200)
    └── Scan stores (10,000 rows)
```

## After (Pre-agg 1만 행 조인)

```text
== Physical Plan ==
BroadcastHashJoin [store_id]            ← HashJoin으로 변경!
├── Scan orders_agg (10,000 rows)
└── BroadcastExchange
    └── Scan stores (10,000 rows)       ← broadcast 가능한 크기
```

변화:
- `SortMergeJoin` → `BroadcastHashJoin`: pre-agg 결과가 작아져서 broadcast 가능
- 1억 행 셔플 → 1만 행 로컬 스캔: 셔플 제거
- 조인 후 GROUP BY → 조인 전 GROUP BY: 집계 대상 행 수 감소

# 7. Pre-aggregation과 이벤트 스트림의 결합

---

여러 소스의 이벤트를 하나의 집계 스트림으로 통합하면, 조인 횟수 자체를 줄일 수 있습니다.

```sql
-- 입금/출금을 별도 테이블로 관리하는 경우:
-- deposits(입금), withdrawals(출금)

-- 각각 별도 조인 대신:
-- ❌ accounts JOIN deposits + accounts JOIN withdrawals (조인 2회)

-- 하나의 이벤트 스트림으로 통합:
-- ✅ accounts JOIN transactions (조인 1회)
CREATE TABLE transactions_agg AS
SELECT account_id,
       SUM(amount) AS net_amount,  -- 입금: +, 출금: -
       SUM(count) AS txn_count
FROM (
    SELECT account_id, +amount AS amount, 1 AS count
    FROM deposits
    UNION ALL
    SELECT account_id, -amount AS amount, 1 AS count
    FROM withdrawals
)
GROUP BY account_id;
```

부호(`+`/`-`)로 이벤트 종류를 표현하면, 한 번의 조인으로 순액(net) 계산이 가능합니다.

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Pre-aggregation** | 조인 전에 GROUP BY로 행 수를 줄이는 기법 |
| **Aggregate Below Join** | 관계 대수에서의 공식 명칭. Spark optimizer는 자동 수행하지 않음 |
| **가법적 집계** | SUM, COUNT, MIN, MAX → 부분합으로 전체 복원 가능 |
| **비가법적 집계** | AVG, MEDIAN, COUNT DISTINCT → pre-agg만으로 복원 불가 |
| **COUNT → SUM 변환** | pre-agg 후에는 `COUNT(*)`가 아니라 `SUM(보관한_count)` |
| **가중 평균** | AVG 복원 시 `SUM(avg * count) / SUM(count)` |
| **실행 계획 변화** | 행 수 축소 → broadcast 가능 → SortMergeJoin이 BroadcastHashJoin으로 변경 |

```text
핵심:
  조인 비용 ∝ 행 수
  Spark는 aggregate pushdown을 자동으로 하지 않는다
  개발자가 직접 pre-agg 테이블을 설계해야 한다
  가법적 집계만 pre-agg로 안전하게 분해 가능
```

# Reference

---

- [Spark SQL Aggregate Functions](https://spark.apache.org/docs/latest/sql-ref-functions-builtin.html#aggregate-functions)
- [Eager Aggregation in Query Optimization (Yan & Larson, 1995)](https://www.vldb.org/conf/1994/P345.PDF)
- [Kimball Group - Aggregate Fact Tables](https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/aggregate-fact-table/)
- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
