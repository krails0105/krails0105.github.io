---
title: "[Spark] median/percentile 계산 - 정확도와 비용 트레이드오프"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Median, Percentile, Aggregation, Performance]
---

# Introduction

---

대용량 데이터에서 median(중앙값)은 "평균보다 훨씬 안정적인 지표"라 많이 씁니다.

하지만 median은 계산 비용이 큰 편이라, Spark에서는 함수 선택이 중요합니다.

# 1. median이 비싼 이유

---

median을 정확히 구하려면:
- 전체 값을 정렬하거나
- 최소한 "순위"를 알아야 합니다.

분산 환경에서 정렬/순위는 곧 **셔플**로 이어지고 비용이 커집니다.

# 2. Spark에서 median을 구하는 방법

---

## 정확한 계산

```sql
-- percentile_cont (ANSI SQL 표준)
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)
FROM sales

-- percentile (Spark 내장)
SELECT percentile(amount, 0.5)
FROM sales
```

## 근사 계산 (권장)

```sql
-- percentile_approx (빠르고 대용량에 적합)
SELECT percentile_approx(amount, 0.5)
FROM sales

-- 정확도 조절 (accuracy 파라미터)
SELECT percentile_approx(amount, 0.5, 10000)
FROM sales
```

| 함수 | 정확도 | 비용 | 용도 |
|------|--------|------|------|
| `percentile_cont` | 정확 | 높음 | 정산/리포팅 |
| `percentile` | 정확 | 높음 | 정산/리포팅 |
| `percentile_approx` | 근사 | 낮음 | 모니터링/추세 |

# 3. 정확도 vs 비용: 언제 approx가 맞나?

---

## approx가 좋은 경우
- 대규모 모니터링 지표 (추세가 중요)
- 정확한 값보다 상대 비교가 중요한 경우
- 그룹별 median을 많이 계산할 때

## 정확 median이 필요한 경우
- 정산/정책/리포팅 등 "숫자 하나"가 중요할 때
- 법적/재무적 의미가 있는 지표

# 4. 실전 팁: median을 '원천에서' 줄이기

---

```python
# 나쁜 예: 전체 데이터에서 그룹별 median
df.groupBy("category").agg(
    percentile_approx("amount", 0.5)
)

# 좋은 예: 필터 먼저, 필요한 컬럼만
df.filter(col("date") >= "2024-01-01") \
  .select("category", "amount") \
  .groupBy("category") \
  .agg(percentile_approx("amount", 0.5))
```

**핵심 원칙:**
- median 대상 row를 필터로 줄이기
- median 전에 그룹 수를 줄이기 (집계 단계 설계)
- 필요한 컬럼만 유지 (project)

# 5. 그룹별 median이 느린 이유

---

그룹 수가 많아질수록, 각 그룹에서 percentile 계산이 필요해져 비용이 급증합니다.

```python
# 1000개 그룹 × 각 그룹 median = 1000번 계산
df.groupBy("user_id").agg(percentile_approx("score", 0.5))
```

**대안:**
- 그룹을 줄이는 전처리 (상위 N개 그룹만)
- 샘플링 후 계산
- approx 함수 사용

# 6. 체크리스트

---

```
□ median이 꼭 필요한가? (p50 vs 평균 vs trimmed mean)
□ 정확도가 필요한가? 그렇지 않으면 approx로 비용 낮추기
□ median 계산 전에 필터/축약으로 데이터 크기를 줄였는가?
□ 그룹 수가 너무 많지 않은가?
```

# Reference

---

- [Spark SQL Functions - percentile_approx](https://spark.apache.org/docs/latest/api/sql/index.html#percentile_approx)
- [Spark SQL Functions - percentile_cont](https://spark.apache.org/docs/latest/api/sql/index.html#percentile_cont)
- [Approximate Algorithms in Spark](https://spark.apache.org/docs/latest/ml-statistics.html)
