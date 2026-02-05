---
title: "[Spark SQL] GROUP BY 결과에 Window 함수 쓰기 - SUM(agg) OVER 패턴"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, WindowFunction, GroupBy, Aggregation]
---

# Introduction

---

GROUP BY로 집계한 결과에 대해 "그룹 간 비율"이나 "전체 대비 비중"을 구해야 할 때가 있습니다. 이때 서브쿼리나 CTE를 추가로 만들지 않고, **같은 SELECT 절에서 GROUP BY 집계와 Window 함수를 함께 쓸 수 있습니다**.

이 글은 이 패턴이 왜 동작하는지(SQL의 논리적 실행 순서), `SUM(SUM(x)) OVER` 표현을 어떻게 읽는지, 그리고 실무에서의 주의사항을 정리합니다.

# 1. SQL 실행 순서와 Window 함수의 위치

---

SQL의 논리적 실행 순서를 이해하면 이 패턴이 왜 동작하는지 알 수 있습니다.

```text
1. FROM / JOIN
2. WHERE
3. GROUP BY
4. HAVING
5. SELECT  ← 집계 함수 평가
6. Window 함수 평가  ← GROUP BY 결과 "위에서" 동작
7. DISTINCT
8. ORDER BY
9. LIMIT
```

핵심: **Window 함수는 GROUP BY가 완료된 후 실행**됩니다. 따라서 Window 함수의 입력은 GROUP BY의 결과 행(그룹당 1행)입니다.

# 2. 패턴: 집계 결과의 비율 계산

---

## 문제 상황

```text
블록별(block_height) + 구간별(age_range) 집계를 한 뒤,
각 구간의 spent_output이 해당 블록의 전체 spent 대비 몇 %인지 구하고 싶다.
```

## 서브쿼리 방식 (전통적)

```sql
WITH agg AS (
    SELECT block_height, age_range,
           SUM(spent_value) AS spent_output
    FROM spent_data
    GROUP BY block_height, age_range
),
totals AS (
    SELECT block_height,
           SUM(spent_output) AS total_spent
    FROM agg
    GROUP BY block_height
)
SELECT a.block_height, a.age_range,
       a.spent_output,
       a.spent_output / t.total_spent * 100 AS spent_percent
FROM agg a
JOIN totals t ON a.block_height = t.block_height;
```

CTE 2개 + JOIN이 필요합니다.

## Window 함수 방식

```sql
SELECT block_height, age_range,
       SUM(spent_value) AS spent_output,
       SUM(spent_value)
           / SUM(SUM(spent_value)) OVER (PARTITION BY block_height)
           * 100 AS spent_percent
FROM spent_data
GROUP BY block_height, age_range;
```

한 번의 GROUP BY로 집계와 비율 계산을 동시에 수행합니다.

# 3. SUM(SUM(x)) OVER의 의미

---

이 표현이 처음 보면 "SUM 안에 SUM?"이라고 혼란스러울 수 있습니다. 핵심은 **안쪽 SUM은 GROUP BY의 집계**이고, **바깥 SUM은 Window 함수**라는 점입니다. 분해해보면:

```text
SUM(SUM(spent_value)) OVER (PARTITION BY block_height)
│   │                  │
│   │                  └─ Window 함수: GROUP BY 결과 행에 대해 작동
│   └─ 안쪽 SUM: GROUP BY 집계 (각 그룹의 합계)
└─ 바깥 SUM: Window 함수 (같은 block_height 내 모든 그룹의 합계)
```

실행 흐름:

```text
Step 1: GROUP BY block_height, age_range
  → block_height=100, age_range='0d_1d', SUM(spent_value)=10
  → block_height=100, age_range='1d_1w', SUM(spent_value)=30
  → block_height=100, age_range='1w_1m', SUM(spent_value)=60

Step 2: OVER (PARTITION BY block_height)
  → block_height=100의 모든 행: SUM(10 + 30 + 60) = 100

Step 3: 나눗셈
  → '0d_1d': 10 / 100 = 10%
  → '1d_1w': 30 / 100 = 30%
  → '1w_1m': 60 / 100 = 60%
```

## 다른 집계 함수도 가능

```sql
-- COUNT의 비율
COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY category) * 100

-- AVG에 대한 전체 범위
AVG(price) / AVG(AVG(price)) OVER () -- 전체 평균 대비 그룹 평균 비율
```

# 4. COALESCE + ANY_VALUE와의 조합

---

LEFT JOIN으로 가져온 값에 Window 함수를 적용할 때:

```sql
SELECT
    w.block_height,
    w.age_range,
    SUM(w.value) AS supply,
    -- LEFT JOIN으로 가져온 spent_output: 그룹 내 모두 같은 값
    COALESCE(ANY_VALUE(s.spent_output), 0) AS spent_output,
    -- Window: 블록 내 전체 spent 합계로 비율 계산
    COALESCE(ANY_VALUE(s.spent_output), 0)
        / NULLIF(SUM(COALESCE(ANY_VALUE(s.spent_output), 0))
                 OVER (PARTITION BY w.block_height), 0) * 100
        AS spent_percent
FROM with_age_range w
LEFT JOIN spent_agg s ON w.block_height = s.block_height
                     AND w.age_range = s.age_range
GROUP BY w.block_height, w.age_range
```

여기서의 실행 순서:

```text
1. LEFT JOIN 수행
2. GROUP BY block_height, age_range
3. ANY_VALUE(s.spent_output) → 각 그룹에서 spent_output 값 추출
4. COALESCE(..., 0) → NULL을 0으로
5. SUM(...) OVER (PARTITION BY block_height) → 블록 내 합계
6. 나눗셈 → 비율
```

# 5. 성능 특성

---

## Window 함수 방식의 장점

```text
서브쿼리 방식: GROUP BY → 중간 결과 materialize → JOIN → 다시 스캔
Window 방식:   GROUP BY → 같은 결과 위에서 Window 계산 (추가 스캔 없음)
```

- 중간 CTE/서브쿼리의 materialization 불필요
- JOIN이 없으므로 셔플 1회 감소
- Spark는 Window 함수를 GROUP BY 결과 위에서 바로 실행

## 주의: PARTITION BY의 셔플

Window 함수의 `PARTITION BY` 키가 GROUP BY 키에 포함되어 있으면 **추가 셔플이 발생하지 않을 수 있습니다** (Spark AQE가 최적화).

```text
GROUP BY block_height, age_range
OVER (PARTITION BY block_height)

→ block_height로 이미 정렬/파티셔닝된 상태
→ 추가 셔플 불필요 (best case)
```

# 6. 주의사항

---

## SELECT 절의 혼란

```sql
-- 이건 동작하지 않음 (alias를 Window에서 사용)
SELECT SUM(value) AS total,
       total / SUM(total) OVER () * 100  -- ERROR: total은 아직 미정의
```

Window 함수에서 **같은 SELECT 절의 alias는 참조할 수 없습니다**. 집계 표현식을 그대로 반복해야 합니다.

## GROUP BY 없이는 다른 의미

```sql
-- GROUP BY 없으면: SUM은 전체 합, OVER는 1행에 대해 동작
SELECT SUM(value),
       SUM(value) / SUM(SUM(value)) OVER ()
FROM table;
-- → 항상 1.0 (자기 자신 / 자기 자신)
```

이 패턴은 **GROUP BY로 여러 그룹이 생길 때만 의미**가 있습니다.

# 7. 정리

---

| 항목 | 설명 |
|------|------|
| **실행 순서** | GROUP BY → 집계 → Window 함수 (GROUP BY 결과 위에서 동작) |
| **SUM(SUM(x)) OVER** | 안쪽 SUM = 그룹별 집계, 바깥 SUM = 그룹 간 Window |
| **장점** | CTE/서브쿼리 + JOIN 불필요, 셔플 감소 |
| **제약** | alias 참조 불가, GROUP BY 있어야 의미 있음 |

```text
핵심:
  Window 함수는 GROUP BY "이후에" 실행된다.
  따라서 집계 결과(그룹당 1행)가 Window의 입력이 된다.
  → 별도 CTE 없이 "전체 대비 비율"을 같은 쿼리에서 계산 가능.
```

# Reference

---

- [Spark SQL Window Functions](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-window.html)
- [SQL Logical Processing Order](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-transact-sql#logical-processing-order-of-the-select-statement)
- [Databricks Window Functions Guide](https://docs.databricks.com/en/sql/language-manual/sql-ref-functions-builtin.html#window-functions)
