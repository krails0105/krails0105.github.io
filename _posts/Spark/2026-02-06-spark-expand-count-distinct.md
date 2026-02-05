---
title: "[Spark] Expand 연산자 - COUNT DISTINCT가 느린 진짜 이유"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Expand, CountDistinct, QueryPlan, Performance]
---

# Introduction

---

Spark SQL에서 `COUNT(DISTINCT col)`은 단순한 집계처럼 보이지만, 내부적으로는 **Expand 연산자**를 사용하여 행을 복제합니다. 하나의 GROUP BY에서 COUNT DISTINCT가 여러 개 있으면 행이 **N배**로 늘어나며, 셔플 데이터와 메모리 사용량도 함께 증가합니다.

"직업 종류"와 "근무지 수"를 동시에 세려면, 같은 명단을 두 장 복사해서 한쪽에선 직업만, 다른 쪽에선 근무지만 세는 것과 같습니다. Expand는 이 "명단 복사" 단계입니다.

이 글은 Expand가 왜 필요한지, 어떻게 동작하는지, 그리고 불필요한 COUNT DISTINCT를 제거하는 방법을 정리합니다.

# 1. 일반 집계 vs COUNT DISTINCT

---

```text
일반 집계 (SUM, COUNT, MAX, MIN):
  → 값을 순차적으로 누적하면 됨
  → 하나의 hash table에서 여러 컬럼을 동시에 처리 가능
  → 예: SUM(a), SUM(b), MAX(c) → 한 번의 GROUP BY로 완료

COUNT DISTINCT:
  → 중복을 제거해야 하므로, 값을 모아서 유일한 것만 세야 함
  → COUNT(DISTINCT col_A)와 COUNT(DISTINCT col_B)는 중복 제거 기준이 다름
  → 하나의 hash table로 동시에 처리할 수 없음
```

핵심: **COUNT DISTINCT가 여러 개이면, 각각 별도의 중복 제거가 필요**합니다. 한 번에 여러 기준으로 동시에 "유일한 것만 골라내기"가 불가능하므로, Spark은 행을 복제하여 기준별로 따로 처리하는 Expand 연산자를 사용합니다.

# 2. Expand 연산자의 동작

---

## 예시 상황

```sql
SELECT
    department,
    COUNT(DISTINCT job_title) AS unique_jobs,
    COUNT(DISTINCT location)  AS unique_locations
FROM employees
GROUP BY department
```

COUNT DISTINCT가 2개이므로, Spark은 각 행을 **2배로 복제**합니다 (COUNT DISTINCT 수 = N일 때 N배).

## 복제 과정

```text
원본 (3행):
  department | job_title  | location
  ─────────────────────────────────
  Engineering| Engineer   | Seoul
  Engineering| Designer   | Seoul
  Engineering| Engineer   | Busan

Expand 후 (6행 = 3행 × 2):
  gid | department  | job_title  | location
  ──────────────────────────────────────────
   1  | Engineering | Engineer   | NULL       ← job_title용 (location 마스킹)
   2  | Engineering | NULL       | Seoul      ← location용 (job_title 마스킹)
   1  | Engineering | Designer   | NULL       ← job_title용
   2  | Engineering | NULL       | Seoul      ← location용
   1  | Engineering | Engineer   | NULL       ← job_title용
   2  | Engineering | NULL       | Busan      ← location용
```

각 gid별로 별도의 GROUP BY가 수행됩니다:

```text
gid=1 그룹: (department, job_title)으로 GROUP BY → COUNT DISTINCT job_title
gid=2 그룹: (department, location)으로 GROUP BY  → COUNT DISTINCT location
```

## 왜 NULL을 넣는가

```text
gid=1 행에서 location=NULL:
  → location은 이 그룹에서 사용하지 않으므로 NULL로 마스킹
  → GROUP BY 시 다른 컬럼의 값이 결과에 영향을 주지 않도록 함

gid=2 행에서 job_title=NULL:
  → 같은 이유로 job_title을 마스킹
```

# 3. 비용

---

```text
COUNT DISTINCT 개수    행 배수    셔플 데이터
─────────────────────────────────────────
1개                    Expand 없음 (two-phase aggregation)
2개                    2배        2배
3개                    3배        3배
N개 (N≥2)             N배        N배

※ 일반 집계(SUM, COUNT(*) 등)와 혼합 시:
   일반 집계용 gid가 추가되어 (N+1)배로 증가
```

단일 COUNT DISTINCT는 Expand 없이 **two-phase aggregation** (중복 제거 → 카운트)으로 처리됩니다. 2개 이상부터 Expand가 발생합니다.

## 실제 영향

```text
with_age_v: 45만 행 × 10K 블록 = ~45억 중간 행 (가정)

COUNT DISTINCT 3개:
  Expand 후: 45억 × 3 = ~135억 행
  → 셔플 데이터 3배 증가
  → 메모리 사용 3배 증가
  → 처리 시간 증가
```

# 4. EXPLAIN으로 Expand 확인하기

---

```sql
EXPLAIN FORMATTED
SELECT department,
       COUNT(DISTINCT job_title),
       COUNT(DISTINCT location)
FROM employees
GROUP BY department
```

쿼리 플랜에서 확인할 부분:

```text
+- Expand [List(department, job_title, null, 1),
           List(department, null, location, 2)]
   → 각 행이 2개의 투영(projection)으로 복제됨

+- Aggregate [department, gid] [count(distinct job_title), count(distinct location)]
   → gid별로 별도 집계 수행
```

`Expand`가 보이면 COUNT DISTINCT에 의한 행 복제가 발생하고 있는 것입니다.

# 5. Expand를 제거하는 방법

---

## 방법 1: 데이터가 이미 unique하면 SUM CASE로 대체

```text
조건: GROUP BY 대상 내에서 COUNT DISTINCT 대상 컬럼이 이미 unique한 경우
```

```sql
-- Before: Expand 발생 (COUNT DISTINCT 3개 → 행 3배)
SELECT
    target_block,
    COUNT(DISTINCT CASE WHEN price > cost THEN block_id END) AS profit_blocks,
    COUNT(DISTINCT CASE WHEN price < cost THEN block_id END) AS loss_blocks,
    COUNT(DISTINCT CASE WHEN price = cost THEN block_id END) AS same_blocks
FROM pre_aggregated_data  -- block_id가 이미 unique
GROUP BY target_block

-- After: Expand 없음 (행 1배)
SELECT
    target_block,
    SUM(CASE WHEN price > cost THEN 1 ELSE 0 END) AS profit_blocks,
    SUM(CASE WHEN price < cost THEN 1 ELSE 0 END) AS loss_blocks,
    SUM(CASE WHEN price = cost THEN 1 ELSE 0 END) AS same_blocks
FROM pre_aggregated_data
GROUP BY target_block
```

**데이터가 이미 unique하면 DISTINCT가 제거할 중복이 없으므로**, 단순 조건 카운트와 결과가 동일합니다.

## 방법 2: 서브쿼리로 분리

```sql
-- COUNT DISTINCT를 별도 서브쿼리로 분리하면 Expand 대신
-- 각각 독립적인 GROUP BY + JOIN으로 처리

WITH jobs AS (
    SELECT department, COUNT(DISTINCT job_title) AS unique_jobs
    FROM employees GROUP BY department
),
locations AS (
    SELECT department, COUNT(DISTINCT location) AS unique_locations
    FROM employees GROUP BY department
)
SELECT j.department, j.unique_jobs, l.unique_locations
FROM jobs j JOIN locations l USING (department)
```

이 방식은 Expand는 제거되지만, 테이블을 여러 번 스캔하고 JOIN이 추가됩니다. 데이터 크기와 COUNT DISTINCT 개수에 따라 어느 쪽이 나은지 다릅니다.

## 방법 3: approx_count_distinct 사용

```sql
-- 정확한 값이 필요 없다면 근사치 사용 (HyperLogLog 기반)
SELECT
    department,
    approx_count_distinct(job_title) AS approx_unique_jobs,
    approx_count_distinct(location) AS approx_unique_locations
FROM employees
GROUP BY department
```

`approx_count_distinct`는 일반 집계처럼 동작하므로 **Expand가 발생하지 않습니다**. 오차는 기본 2% 이내이며, 대규모 데이터에서 성능 차이가 큽니다.

# 6. 판단 기준

---

```text
COUNT DISTINCT를 써야 하는가?

1. 대상 컬럼이 GROUP BY 내에서 이미 unique한가?
   ├─ Yes → SUM(CASE WHEN ... THEN 1 ELSE 0 END)로 대체
   └─ No → 2번으로

2. 정확한 값이 필요한가?
   ├─ No → approx_count_distinct 사용
   └─ Yes → 3번으로

3. COUNT DISTINCT가 몇 개인가?
   ├─ 1개 → Expand 없음, two-phase aggregation으로 처리
   └─ 2개 이상 → Expand N배 발생, 서브쿼리 분리 또는 데이터 구조 재설계 검토
```

# 7. 정리

---

| 항목 | 설명 |
|------|------|
| **Expand란** | COUNT DISTINCT를 처리하기 위해 행을 복제하는 Spark 내부 연산자 |
| **복제 배수** | COUNT DISTINCT N개(N≥2) → 행 N배, 일반 집계 혼합 시 (N+1)배 |
| **영향** | 셔플 데이터, 메모리 사용, 처리 시간 모두 증가 |
| **확인 방법** | EXPLAIN에서 `Expand` 노드 존재 여부 |
| **제거 조건** | 대상이 이미 unique하면 SUM CASE로 대체 가능 |

```text
핵심:
  COUNT DISTINCT는 보기보다 비싸다.
  Spark은 내부적으로 행을 복제(Expand)하여 처리한다.
  N개 COUNT DISTINCT → N배 행 복제 (일반 집계 혼합 시 N+1배).
  데이터가 이미 unique하면 DISTINCT는 불필요 → SUM CASE로 대체.
  EXPLAIN에서 Expand를 확인하는 습관이 중요.
```

# Reference

---

- [Spark SQL Query Execution](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Databricks COUNT DISTINCT Optimization](https://docs.databricks.com/en/sql/language-manual/functions/count.html)
- [Spark Logical Plan - Expand](https://jaceklaskowski.gitbooks.io/mastering-spark-sql/content/spark-sql-Expression-Expand.html)
