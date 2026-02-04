---
title: "[Spark SQL] DECIMAL/Timestamp 캐스팅 함정 - overflow, 정밀도, 단위 실수 방지"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Decimal, Timestamp, Casting, DataType]
---

# Introduction

---

대용량 파이프라인에서 타입 실수는 "조용히 틀린 값"을 만들거나, 대규모 실행 중 overflow로 장애를 냅니다.

이 글은 Spark에서 특히 자주 만나는 함정을 정리합니다:
- DECIMAL 정밀도/스케일
- epoch timestamp 단위(초/밀리/마이크로)
- 나눗셈/곱셈 중간 결과 precision 폭증

# 1. DECIMAL(p, s) 기초

---

```
DECIMAL(p, s)
- p: precision (전체 자릿수)
- s: scale (소수점 이하 자릿수)
- 정수부 최대: p - s 자리
```

## 예시

```sql
DECIMAL(10, 2)  -- 최대 99999999.99
DECIMAL(18, 8)  -- 최대 9999999999.99999999
DECIMAL(38, 0)  -- 최대 38자리 정수
```

## 자주 하는 실수

```python
# 문제: DECIMAL(10,2)에 큰 값을 넣으려 함
df.withColumn("amount", col("amount").cast("decimal(10,2)"))
# 99999999.99를 초과하면 overflow!
```

# 2. 연산 시 Precision 폭증

---

Spark는 DECIMAL 연산 시 중간 결과의 precision을 자동으로 키웁니다.

## 곱셈

```
DECIMAL(p1, s1) * DECIMAL(p2, s2)
= DECIMAL(p1 + p2 + 1, s1 + s2)
```

```python
# DECIMAL(10,2) * DECIMAL(10,2) = DECIMAL(21,4)
# 예상보다 큰 precision이 필요!
```

## 나눗셈

```
DECIMAL(p1, s1) / DECIMAL(p2, s2)
= DECIMAL(p1 - s1 + s2 + max(6, s1 + p2 + 1), max(6, s1 + p2 + 1))
```

나눗셈은 precision이 급격히 커져서 38자리 제한에 도달하기 쉽습니다.

## 안전한 패턴

```python
from pyspark.sql.functions import col
from pyspark.sql.types import DecimalType

# 나쁜 예: 연산 결과를 바로 사용
df.withColumn("ratio", col("a") / col("b"))  # precision 폭발 가능

# 좋은 예: 중간은 크게, 마지막에 cast down
df.withColumn(
    "ratio",
    (col("a") / col("b")).cast(DecimalType(18, 8))
)
```

# 3. Timestamp 단위 혼동 (가장 흔한 실수)

---

epoch 시간을 다룰 때 단위 혼동이 자주 발생합니다.

| 단위 | 값 예시 | 설명 |
|------|---------|------|
| seconds | 1704067200 | Unix epoch (초) |
| milliseconds | 1704067200000 | epoch × 1000 |
| microseconds | 1704067200000000 | epoch × 1000000 |

## 단위 혼동 예시

```python
# 문제: 밀리초를 초로 착각
from pyspark.sql.functions import from_unixtime

df.withColumn("ts", from_unixtime(col("epoch_ms")))
# 1704067200000초 = 54000년 후!

# 해결: 단위 변환
df.withColumn("ts", from_unixtime(col("epoch_ms") / 1000))
```

## 권장: 컬럼명에 단위 포함

```python
# 명확한 네이밍
df.withColumn("created_ts_sec", ...)
df.withColumn("updated_ts_ms", ...)
df.withColumn("event_ts_us", ...)
```

# 4. Timestamp 변환 함수 정리

---

## epoch → timestamp

```python
from pyspark.sql.functions import from_unixtime, to_timestamp

# 초 단위 epoch → timestamp
df.withColumn("ts", from_unixtime(col("epoch_sec")))

# 밀리초 → timestamp
df.withColumn("ts", from_unixtime(col("epoch_ms") / 1000))

# 마이크로초 → timestamp
df.withColumn("ts", from_unixtime(col("epoch_us") / 1000000))
```

## timestamp → epoch

```python
from pyspark.sql.functions import unix_timestamp

# timestamp → 초 단위 epoch
df.withColumn("epoch_sec", unix_timestamp(col("ts")))

# timestamp → 밀리초
df.withColumn("epoch_ms", (unix_timestamp(col("ts")) * 1000).cast("long"))
```

## 문자열 → timestamp

```python
from pyspark.sql.functions import to_timestamp

df.withColumn("ts", to_timestamp(col("date_str"), "yyyy-MM-dd HH:mm:ss"))
```

# 5. 타임존 함정

---

```python
# Spark 세션 타임존 확인
spark.conf.get("spark.sql.session.timeZone")

# 타임존 설정
spark.conf.set("spark.sql.session.timeZone", "UTC")
```

## 주의사항

- `from_unixtime`은 세션 타임존을 적용
- 타임존이 다르면 날짜/시간 버킷이 달라짐
- 프로젝트 전체에서 타임존 기준을 고정할 것

```python
# UTC 기준으로 통일
spark.conf.set("spark.sql.session.timeZone", "UTC")

# 또는 명시적 변환
from pyspark.sql.functions import from_utc_timestamp, to_utc_timestamp

df.withColumn("ts_kst", from_utc_timestamp(col("ts_utc"), "Asia/Seoul"))
```

# 6. Overflow 점검 순서

---

overflow가 의심될 때:

```python
# 1) 중간 결과 타입 확인
df.select(col("a") / col("b")).schema

# 2) 계산식을 단계로 쪼개서 cast 위치 조정
df.withColumn("step1", col("a").cast(DecimalType(38, 10))) \
  .withColumn("step2", col("step1") / col("b")) \
  .withColumn("result", col("step2").cast(DecimalType(18, 8)))

# 3) 최종 출력만 원하는 precision으로 cast down

# 4) 샘플 데이터로 경계값(최대/최소) 테스트
df.select(
    max("amount").alias("max_amount"),
    min("amount").alias("min_amount")
).show()
```

# 7. 실전 팁

---

## DECIMAL 계산 공통 패턴

```python
from pyspark.sql.types import DecimalType

def safe_divide(df, col_a, col_b, result_col, precision=18, scale=8):
    """안전한 나눗셈 (precision 제어)"""
    return df.withColumn(
        result_col,
        (col(col_a) / col(col_b)).cast(DecimalType(precision, scale))
    )
```

## Timestamp 변환 공통 함수

```python
from pyspark.sql.functions import col, from_unixtime

def epoch_ms_to_timestamp(df, source_col, target_col):
    """밀리초 epoch → timestamp 변환"""
    return df.withColumn(target_col, from_unixtime(col(source_col) / 1000))

def epoch_us_to_timestamp(df, source_col, target_col):
    """마이크로초 epoch → timestamp 변환"""
    return df.withColumn(target_col, from_unixtime(col(source_col) / 1000000))
```

# 8. 체크리스트

---

```
□ 중간 계산의 DECIMAL precision이 overflow를 낼 수 있는가?
□ 나눗셈 결과를 적절한 precision으로 cast down 했는가?
□ timestamp bigint 단위가 초/밀리/마이크로 중 무엇인지 문서화했는가?
□ 컬럼명에 단위를 포함했는가? (_ts_sec, _ts_ms, _ts_us)
□ 타임존 기준이 프로젝트 전체에서 일관된가?
□ 최종 cast는 마지막 단계에서만 수행하는가?
```

# Reference

---

- [Spark SQL Data Types](https://spark.apache.org/docs/latest/sql-ref-datatypes.html)
- [Spark SQL Date and Timestamp Functions](https://spark.apache.org/docs/latest/sql-ref-functions-builtin.html#date-and-timestamp-functions)
- [DecimalType in PySpark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.types.DecimalType.html)
