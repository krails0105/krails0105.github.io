---
title: "[Spark] repartition vs coalesce - 셔플 여부를 결정하는 실전 기준"
categories:
  - Spark
tags:
  - [Spark, Partition, Repartition, Coalesce, Shuffle, Performance]
---

# Introduction

---

Spark에서 파티션 조정은 성능에 직결됩니다.

- 파티션이 너무 많으면: task 오버헤드, 작은 파일 증가
- 파티션이 너무 적으면: 병렬성 부족, 스큐 악화

`repartition`과 `coalesce`의 차이를 이해하고 상황에 맞게 선택해야 합니다.

# 1. repartition: 셔플을 '의도적으로' 만든다

---

```python
# 파티션 수 지정
df.repartition(100)

# 키 기준 재분배
df.repartition("user_id")

# 키 기준 + 파티션 수
df.repartition(100, "user_id")
```

## 동작 방식

- **항상 셔플 발생** (네트워크 비용 있음)
- 데이터를 해시 또는 라운드로빈으로 재분배
- 파티션 수를 늘리거나 줄이는 것 모두 가능

## 언제 사용하나?

- 조인/집계 전에 키 기준으로 데이터를 정렬하고 싶을 때
- 파티션 수를 늘려야 할 때 (coalesce로는 불가)
- 스큐 해소를 위해 데이터를 균등 분배하고 싶을 때

```python
# 조인 성능 향상을 위한 키 기준 repartition
df_orders = df_orders.repartition("customer_id")
df_customers = df_customers.repartition("customer_id")
result = df_orders.join(df_customers, "customer_id")
```

# 2. coalesce: 셔플을 '가능하면' 피한다

---

```python
# 파티션 수 줄이기
df.coalesce(10)
```

## 동작 방식

- **셔플 없이** 여러 파티션을 합치려 시도
- 기존 파티션을 그대로 유지하면서 논리적으로 병합
- **파티션 수를 줄이는 것만 가능** (늘리기 불가)

## 언제 사용하나?

- write 전에 출력 파일 수를 줄이고 싶을 때
- 필터링 후 파티션이 과도하게 많아졌을 때
- 셔플 비용을 피하면서 파티션을 조정하고 싶을 때

```python
# write 전에 파일 수 조정
df.filter(col("status") == "active") \
  .coalesce(20) \
  .write.parquet("/output/path")
```

# 3. 핵심 차이점 비교

---

| 항목 | repartition | coalesce |
|------|-------------|----------|
| 셔플 | **항상 발생** | 발생 안 함 |
| 파티션 수 | 늘리기/줄이기 모두 가능 | 줄이기만 가능 |
| 데이터 분포 | 균등 분배 | 기존 분포 유지 |
| 비용 | 높음 | 낮음 |
| 주 용도 | 키 기반 재분배, 파티션 증가 | write 전 파일 수 조정 |

# 4. 실전 판단 기준

---

```
"키 기준으로 데이터 분포를 바꿔야 한다" → repartition
"그냥 결과 파일 수만 줄이고 싶다" → coalesce
"파티션 수를 늘려야 한다" → repartition (coalesce 불가)
```

## 판단 플로우차트

```
파티션 수를 늘려야 하나?
├─ Yes → repartition
└─ No → 키 기준 재분배가 필요한가?
         ├─ Yes → repartition("key")
         └─ No → coalesce
```

# 5. Write 전 파티션 수 결정 가이드

---

## 목표 파일 크기 기반

```python
# 대략적인 계산
# 결과 데이터 크기 / 목표 파일 크기 ≈ 목표 파티션 수

# 예: 10GB 데이터, 목표 파일 크기 128MB
# 10 * 1024 / 128 ≈ 80 파티션
df.coalesce(80).write.parquet("/output")
```

## 권장 파일 크기

- **너무 작은 파일** (< 10MB): 메타데이터 비용 증가, 읽기 성능 저하
- **너무 큰 파일** (> 1GB): 병렬성 저하, 메모리 압박
- **권장**: 128MB ~ 512MB

## 실제 크기 확인

```python
# 샘플로 파티션당 크기 추정
sample_df = df.limit(10000)
sample_df.write.parquet("/tmp/sample")

# 파일 시스템에서 크기 확인 후 전체 추정
```

# 6. 흔한 실수와 해결책

---

## 실수 1: coalesce로 너무 많이 줄이기

```python
# 문제: 한 파티션이 너무 커짐
df.coalesce(1).write.parquet("/output")  # OOM 위험!

# 해결: 적절한 수로 유지
df.coalesce(10).write.parquet("/output")
```

## 실수 2: coalesce 후 스큐

coalesce는 기존 데이터 분포를 유지하므로, 이미 스큐가 있으면 악화됩니다.

```python
# 문제: 스큐가 있는 상태에서 coalesce
df_skewed.coalesce(10)  # 한 파티션만 거대해짐

# 해결: repartition으로 균등 분배
df_skewed.repartition(10)
```

## 실수 3: 불필요한 repartition

```python
# 문제: 바로 write할 건데 repartition
df.repartition(100).write.parquet("/output")  # 불필요한 셔플

# 해결: coalesce 사용
df.coalesce(100).write.parquet("/output")
```

# 7. 고급 패턴

---

## partitionBy와 함께 사용

```python
# partitionBy 전에 repartition
df.repartition("date", "region") \
  .write \
  .partitionBy("date", "region") \
  .parquet("/output")
```

이렇게 하면 각 파티션 디렉토리에 파일이 적절히 분배됩니다.

## maxRecordsPerFile 옵션

```python
# Spark 2.2+
df.write \
  .option("maxRecordsPerFile", 1000000) \
  .parquet("/output")
```

파티션 수를 직접 조정하지 않고도 파일 크기를 제어할 수 있습니다.

# 8. 체크리스트

---

```
□ repartition은 반드시 셔플 비용을 감당할 가치가 있는가?
□ coalesce 후 특정 파티션이 너무 커지진 않는가?
□ write 시 작은 파일(small files)을 만들지 않는 파티션 수를 골랐는가?
□ 파티션 수를 늘려야 하면 repartition을 사용했는가?
□ 키 기반 재분배가 필요 없으면 coalesce를 사용했는가?
```

# Reference

---

- [Spark RDD repartition](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.repartition.html)
- [Spark RDD coalesce](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.coalesce.html)
- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
