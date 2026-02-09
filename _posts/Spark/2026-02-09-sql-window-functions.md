---
title: "[SQL] 윈도우 함수 & 집계 확장 정리 - LEAD, RANK, ROLLUP 한눈에"
categories:
  - Spark
tags:
  - [SQL, Window Function, LEAD, LAG, RANK, ROLLUP, CUBE, Spark, Databricks]
---

# Introduction

---

SQL 윈도우 함수는 **행 간 관계**를 다루는 함수입니다. GROUP BY가 행을 묶어서 하나로 만든다면, 윈도우 함수는 **원본 행을 유지하면서** 다른 행의 값을 참조합니다.

이 글에서는 윈도우 함수와 집계 확장(ROLLUP, CUBE)을 **용도별로 묶어서** 정리합니다.

# 1. 이웃 행 참조: LEAD / LAG

---

현재 행 기준으로 **앞/뒤 행의 값**을 가져옵니다.

## LEAD — 다음 행

```sql
LEAD(col, n, default) OVER (ORDER BY col)
--   col: 가져올 컬럼
--   n: 몇 행 뒤 (기본값 1)
--   default: 다음 행이 없을 때 반환값 (기본값 NULL)
```

```text
seq_id | LEAD(seq_id)
-------------|-------------------
100          | 101
101          | 102
102          | 105    ← gap 발견! (103, 104 missing)
105          | 106
106          | NULL   ← 마지막 행, 다음 없음
```

## LAG — 이전 행

```sql
LAG(col, n, default) OVER (ORDER BY col)
```

```text
seq_id | LAG(seq_id)
-------------|------------------
100          | NULL   ← 첫 행, 이전 없음
101          | 100
102          | 101
105          | 102    ← 이전 블록과 비교 가능
```

## 실전 예시: 연속성 검증

```sql
-- seq_id에 빠진 구간 찾기
SELECT * FROM (
    SELECT seq_id AS gap_start,
           LEAD(seq_id) OVER (ORDER BY seq_id) AS next_id,
           LEAD(seq_id) OVER (ORDER BY seq_id) - seq_id - 1 AS missing_count
    FROM my_table
) t
WHERE missing_count > 0
```

> `HAVING`은 GROUP BY와 함께 쓰는 절입니다. 윈도우 함수 결과를 필터링하려면 **서브쿼리 + WHERE**를 사용해야 합니다.

## 실전 예시: 일별 변화량

```sql
SELECT date, revenue,
       revenue - LAG(revenue) OVER (ORDER BY date) AS daily_change
FROM sales
```

```text
date       | revenue | daily_change
-----------|---------|-------------
2026-01-01 | 100     | NULL
2026-01-02 | 150     | 50
2026-01-03 | 120     | -30
```

# 2. 순위: ROW_NUMBER / RANK / DENSE_RANK

---

행에 **순번이나 등수**를 매깁니다. 동점 처리 방식이 다릅니다.

## 차이점

```text
score | ROW_NUMBER | RANK | DENSE_RANK
------|------------|------|-----------
100   | 1          | 1    | 1
95    | 2          | 2    | 2
95    | 3          | 2    | 2       ← 동점
90    | 4          | 4    | 3       ← 핵심 차이
85    | 5          | 5    | 4
```

| 함수 | 동점 처리 | 다음 순위 | 용도 |
|------|----------|----------|------|
| `ROW_NUMBER` | 동점 무시, 무조건 1,2,3,4... | 항상 연속 | 고유 번호 필요 시 |
| `RANK` | 동점 같은 등수 | 건너뜀 (2,2,**4**) | 경쟁 순위 (올림픽 방식) |
| `DENSE_RANK` | 동점 같은 등수 | 연속 (2,2,**3**) | 빠짐 없는 등급 |

## 기본 구문

```sql
ROW_NUMBER() OVER (ORDER BY score DESC)
RANK()       OVER (ORDER BY score DESC)
DENSE_RANK() OVER (ORDER BY score DESC)
```

## PARTITION BY와 조합

그룹 내 순위를 매길 때:

```sql
-- 부서별 급여 순위
SELECT department, name, salary,
       RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank
FROM employees
```

```text
department | name   | salary | dept_rank
-----------|--------|--------|----------
개발       | 철수   | 8000   | 1
개발       | 영희   | 7000   | 2
개발       | 민수   | 7000   | 2
영업       | 지수   | 9000   | 1
영업       | 현우   | 6000   | 2
```

## 실전 예시: 그룹별 Top N

```sql
-- 부서별 급여 상위 3명
SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rn
    FROM employees
)
WHERE rn <= 3
```

# 3. 누적/이동 집계: SUM / AVG / COUNT OVER

---

GROUP BY 없이 **집계 함수를 윈도우로** 사용합니다.

## 누적 합계 (Running Total)

```sql
SELECT date, revenue,
       SUM(revenue) OVER (ORDER BY date) AS cumulative_revenue
FROM sales
```

```text
date       | revenue | cumulative_revenue
-----------|---------|-------------------
2026-01-01 | 100     | 100
2026-01-02 | 150     | 250
2026-01-03 | 120     | 370
2026-01-04 | 200     | 570
```

## 이동 평균 (Moving Average)

`ROWS BETWEEN`으로 윈도우 범위를 지정합니다:

```sql
-- 최근 3일 이동 평균
SELECT date, revenue,
       AVG(revenue) OVER (
           ORDER BY date
           ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
       ) AS ma_3d
FROM sales
```

```text
date       | revenue | ma_3d
-----------|---------|------
2026-01-01 | 100     | 100.0    (100만)
2026-01-02 | 150     | 125.0    (100+150)/2
2026-01-03 | 120     | 123.3    (100+150+120)/3
2026-01-04 | 200     | 156.7    (150+120+200)/3
```

## 윈도우 범위 옵션

```sql
ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW   -- 처음부터 현재까지 (기본값)
ROWS BETWEEN 2 PRECEDING AND CURRENT ROW            -- 이전 2행 + 현재
ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING            -- 이전 1행 ~ 다음 1행
ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING    -- 현재부터 끝까지
```

## 파티션 내 비율

```sql
-- 전체 대비 비율
SELECT department, name, salary,
       salary / SUM(salary) OVER (PARTITION BY department) * 100 AS pct
FROM employees
```

이 패턴으로 **그룹 내 구성비**를 계산할 수 있습니다:

```sql
amount / SUM(amount) OVER (PARTITION BY group_id) * 100 AS pct
```

# 4. 범위 값: FIRST_VALUE / LAST_VALUE / NTH_VALUE

---

윈도우 내 **특정 위치의 값**을 가져옵니다.

```sql
SELECT date, price,
       FIRST_VALUE(price) OVER (ORDER BY date) AS first_price,
       LAST_VALUE(price)  OVER (
           ORDER BY date
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
       ) AS last_price
FROM stock_prices
```

> `LAST_VALUE`는 기본 윈도우가 "처음~현재"이므로 `ROWS BETWEEN ... UNBOUNDED FOLLOWING`을 명시해야 진짜 마지막 값을 가져옵니다.

## 실전 예시: 최고가 대비 하락률

```sql
SELECT date, price,
       price / FIRST_VALUE(price) OVER (ORDER BY price DESC) * 100 AS pct_of_ath
FROM stock_prices
```

# 5. 분위수: NTILE / PERCENT_RANK / CUME_DIST

---

데이터를 **균등 분할**하거나 **백분위**를 계산합니다.

## NTILE — 균등 분할

```sql
-- 4분위로 나누기
SELECT name, salary,
       NTILE(4) OVER (ORDER BY salary DESC) AS quartile
FROM employees
```

```text
name   | salary | quartile
-------|--------|--------
철수   | 9000   | 1   (상위 25%)
영희   | 8000   | 1
민수   | 7000   | 2
지수   | 6000   | 2
현우   | 5000   | 3
동훈   | 4000   | 3
서연   | 3000   | 4
준호   | 2000   | 4
```

## PERCENT_RANK / CUME_DIST

```sql
SELECT name, salary,
       PERCENT_RANK() OVER (ORDER BY salary) AS pct_rank,  -- 0~1, (rank-1)/(n-1)
       CUME_DIST()    OVER (ORDER BY salary) AS cume_dist  -- 0~1, rank/n
FROM employees
```

# 6. 집계 확장: ROLLUP / CUBE / GROUPING SETS

---

GROUP BY의 확장으로, **소계/총계 행을 자동 생성**합니다. 윈도우 함수는 아니지만 집계와 함께 자주 쓰입니다.

## ROLLUP — 계층적 소계

```sql
SELECT department, team, SUM(salary)
FROM employees
GROUP BY ROLLUP (department, team)
```

```text
department | team   | sum(salary)
-----------|--------|------------
개발       | 백엔드 | 15000       ← 그룹별
개발       | 프론트 | 12000       ← 그룹별
개발       | NULL   | 27000       ← 부서 소계 (ROLLUP이 추가)
영업       | 국내   | 10000
영업       | 해외   | 8000
영업       | NULL   | 18000       ← 부서 소계
NULL       | NULL   | 45000       ← 전체 총계 (ROLLUP이 추가)
```

ROLLUP은 **왼쪽부터 오른쪽으로** 계층적 소계를 만듭니다:
- `(department, team)` — 그룹별
- `(department)` — 부서 소계
- `()` — 전체 총계

## CUBE — 모든 조합 소계

```sql
SELECT department, team, SUM(salary)
FROM employees
GROUP BY CUBE (department, team)
```

ROLLUP의 결과에 추가로:

```text
NULL       | 백엔드 | 15000       ← team별 소계 (CUBE만 추가)
NULL       | 프론트 | 12000
NULL       | 국내   | 10000
NULL       | 해외   | 8000
```

| 구문 | 생성하는 집계 레벨 | 조합 수 |
|------|-------------------|--------|
| `GROUP BY a, b` | `(a, b)` | 1 |
| `ROLLUP (a, b)` | `(a, b)`, `(a)`, `()` | n+1 |
| `CUBE (a, b)` | `(a, b)`, `(a)`, `(b)`, `()` | 2^n |

## GROUPING SETS — 명시적 지정

원하는 조합만 직접 지정:

```sql
SELECT department, team, SUM(salary)
FROM employees
GROUP BY GROUPING SETS (
    (department, team),   -- 그룹별
    (department),         -- 부서 소계
    ()                    -- 전체 총계
)
-- ROLLUP (department, team) 과 동일
```

## GROUPING() — 소계 행 식별

소계 행의 NULL과 데이터의 NULL을 구분:

```sql
SELECT
    CASE WHEN GROUPING(department) = 1 THEN '전체' ELSE department END AS department,
    CASE WHEN GROUPING(team) = 1 THEN '소계' ELSE team END AS team,
    SUM(salary)
FROM employees
GROUP BY ROLLUP (department, team)
```

```text
department | team   | sum(salary)
-----------|--------|------------
개발       | 백엔드 | 15000
개발       | 프론트 | 12000
개발       | 소계   | 27000       ← GROUPING(team)=1
영업       | 국내   | 10000
영업       | 해외   | 8000
영업       | 소계   | 18000
전체       | 소계   | 45000       ← GROUPING(department)=1
```

# Summary

---

## 한눈에 보기

| 분류 | 함수 | 용도 |
|------|------|------|
| **이웃 행** | `LEAD`, `LAG` | 다음/이전 행 값 참조 |
| **순위** | `ROW_NUMBER`, `RANK`, `DENSE_RANK` | 순번, 등수 매기기 |
| **누적/이동 집계** | `SUM/AVG/COUNT OVER` | 누적 합계, 이동 평균, 파티션 내 비율 |
| **범위 값** | `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE` | 윈도우 내 특정 위치 값 |
| **분위수** | `NTILE`, `PERCENT_RANK`, `CUME_DIST` | 균등 분할, 백분위 |
| **집계 확장** | `ROLLUP`, `CUBE`, `GROUPING SETS` | 소계/총계 자동 생성 |

## 윈도우 함수 구문 구조

```sql
함수() OVER (
    [PARTITION BY col1, ...]     -- 그룹 분할 (GROUP BY와 유사)
    [ORDER BY col2, ...]         -- 정렬 기준
    [ROWS/RANGE BETWEEN ...]     -- 윈도우 범위
)
```

| 절 | 역할 | 생략 시 |
|---|------|--------|
| `PARTITION BY` | 그룹 나누기 | 전체를 하나의 파티션으로 |
| `ORDER BY` | 행 순서 결정 | 함수에 따라 다름 |
| `ROWS BETWEEN` | 집계 범위 | `UNBOUNDED PRECEDING ~ CURRENT ROW` |

## GROUP BY vs 윈도우 함수

```text
GROUP BY:  원본 행 사라짐 → 그룹당 1행
WINDOW:    원본 행 유지 → 계산 결과가 옆에 붙음
```

```sql
-- GROUP BY: 3행 → 1행
SELECT department, SUM(salary) FROM employees GROUP BY department

-- WINDOW: 3행 → 3행 (각 행에 부서 합계가 추가)
SELECT name, department, salary,
       SUM(salary) OVER (PARTITION BY department) AS dept_total
FROM employees
```

# Reference

---

- [Spark SQL Window Functions](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-window.html)
- [Spark SQL ROLLUP / CUBE / GROUPING SETS](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-groupby.html)
- [Spark SQL Built-in Functions](https://spark.apache.org/docs/latest/api/sql/index.html)
