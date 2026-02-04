---
title: "[Spark SQL] PIVOT - 스키마 폭발 방지와 컬럼명 설계"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, PIVOT, Aggregation, Schema]
---

# Introduction

---

PIVOT은 row를 column으로 변환하는 강력한 기능입니다. 리포팅이나 피처 테이블에서 자주 쓰이지만, 잘못 설계하면 **스키마 폭발(wide explosion)**로 운영이 어려워집니다.

# 1. PIVOT 기본 사용법

---

```sql
-- 기본 PIVOT 문법
SELECT *
FROM sales
PIVOT (
    SUM(amount)
    FOR category IN ('Electronics', 'Clothing', 'Food')
)
```

```python
# PySpark PIVOT
df.groupBy("date") \
  .pivot("category", ["Electronics", "Clothing", "Food"]) \
  .agg(sum("amount"))
```

**결과:**

| date | Electronics | Clothing | Food |
|------|-------------|----------|------|
| 2024-01-01 | 1000 | 500 | 300 |
| 2024-01-02 | 1200 | 600 | 400 |

# 2. PIVOT이 만드는 문제

---

## 스키마 폭발

- 범주 값이 늘어나면 컬럼도 계속 증가
- 다운스트림 스키마가 자주 깨짐
- wide table은 저장/네트워크 비용 증가

```python
# 위험: 범주가 동적으로 늘어나는 경우
df.groupBy("date").pivot("user_id").agg(sum("amount"))
# → user_id가 수천 개면 컬럼도 수천 개!
```

## 성능 문제

- PIVOT은 내부적으로 범주별 aggregation을 수행
- 범주를 명시하지 않으면 먼저 distinct 값을 수집해야 함

```python
# 느림: 범주 값을 미리 수집해야 함
df.groupBy("date").pivot("category").agg(sum("amount"))

# 빠름: 범주를 명시적으로 지정
df.groupBy("date").pivot("category", ["A", "B", "C"]).agg(sum("amount"))
```

# 3. 컬럼명을 원하는 형태로 만드는 방법

---

## 방법 1: PIVOT 후 rename

가장 단순하지만, 범주가 고정일 때만 적합합니다.

```python
pivoted = df.groupBy("date") \
    .pivot("status", ["active", "inactive", "pending"]) \
    .agg(sum("count"))

# 컬럼명 변경
pivoted = pivoted \
    .withColumnRenamed("active", "active_count") \
    .withColumnRenamed("inactive", "inactive_count") \
    .withColumnRenamed("pending", "pending_count")
```

## 방법 2: PIVOT 전에 범주 값 매핑

범주 문자열을 원하는 컬럼명으로 미리 변환합니다.

```python
from pyspark.sql.functions import when, col

# 범주를 코드화
df_mapped = df.withColumn(
    "status_code",
    when(col("status") == "active", "cnt_active")
    .when(col("status") == "inactive", "cnt_inactive")
    .otherwise("cnt_other")
)

# 코드로 PIVOT
df_mapped.groupBy("date") \
    .pivot("status_code") \
    .agg(sum("count"))
```

## 방법 3: Long 형태 유지 (권장)

스키마 안정성이 중요하면 PIVOT을 하지 않는 것이 최선입니다.

```python
# Long 형태 유지 - 스키마가 안정적
df.groupBy("date", "category").agg(sum("amount").alias("total"))

# BI 도구에서 필요할 때 pivot
```

**장점:**
- 범주가 늘어나도 스키마 변경 없음
- 다운스트림 파이프라인 안정성 확보
- 저장 효율 향상 (sparse data에서)

# 4. 실전 패턴: Bucket을 고정값으로 매핑

---

PIVOT 대상을 시간에 따라 변하지 않는 "코드"로 매핑하면 스키마가 안정됩니다.

```python
from pyspark.sql.functions import when, col

# 점수 구간을 고정 코드로 매핑
df_bucketed = df.withColumn(
    "score_bucket",
    when(col("score") < 50, "bucket_0_low")
    .when(col("score") < 80, "bucket_1_mid")
    .otherwise("bucket_2_high")
)

# 고정된 bucket으로 PIVOT
result = df_bucketed.groupBy("user_id") \
    .pivot("score_bucket", ["bucket_0_low", "bucket_1_mid", "bucket_2_high"]) \
    .agg(count("*"))
```

# 5. 체크리스트

---

```
□ 범주 값이 고정인가? 동적으로 늘어날 가능성이 있는가?
□ pivot() 호출 시 범주 리스트를 명시적으로 지정했는가?
□ wide 스키마가 다운스트림에 부담을 주지 않는가?
□ 컬럼명 규칙을 문서화했는가?
□ Long 형태 유지가 더 적합하지 않은가?
```

## 결정 가이드

| 상황 | 권장 방식 |
|------|-----------|
| 범주가 고정 (예: 요일, 상태코드) | PIVOT + 명시적 범주 리스트 |
| 범주가 늘어날 수 있음 | Long 유지 + BI에서 pivot |
| ML 피처 테이블 | bucket 코드화 + PIVOT |
| 리포팅용 wide table | PIVOT 후 스키마 버저닝 |

# Reference

---

- [Spark SQL PIVOT](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-pivot.html)
- [PySpark pivot() API](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.pivot.html)
- [Spark Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
