---
title: "[Spark] 조인 최적화 플레이북 - broadcast, 스큐, 셔플, 조인 순서"
categories:
  - Spark
tags:
  - [Spark, Join, Broadcast, Skew, Shuffle, Optimization]
---

# Introduction

---

Spark 성능 이슈의 대부분은 조인에서 터집니다. 이 글은 조인 문제를 "증상 → 원인 → 처방"으로 정리한 플레이북입니다.

# 1. 먼저 진단: 조인이 어떤 형태인가?

---

`explain()`으로 조인 타입을 확인하는 것이 첫 단계입니다.

```python
df_joined = df_large.join(df_small, "key")
df_joined.explain()
```

## 조인 타입별 특징

| Join 타입 | 설명 | 성능 |
|-----------|------|------|
| `BroadcastHashJoin` | 작은쪽 broadcast + equi-join | **가장 좋음** |
| `SortMergeJoin` | 큰-큰 조인 (셔플+정렬) | 보통 |
| `ShuffledHashJoin` | 해시 기반, 특정 조건에서 사용 | 보통 |
| `BroadcastNestedLoopJoin` | 비-equi/range 조인 | **주의** |
| `CartesianProduct` | 조건 없는 조인 | **매우 위험** |

## 진단 질문

- 작은-큰 조인인가? → broadcast 가능성
- 큰-큰 조인인가? → 셔플/스큐 관리 필요
- 비-equi/range 조인인가? → NestedLoop 위험

# 2. 처방 1: Broadcast 활용

---

작은 테이블을 broadcast하면 큰쪽 셔플을 제거할 수 있습니다.

```python
from pyspark.sql.functions import broadcast

# 작은 테이블을 broadcast
result = df_large.join(broadcast(df_small), "key")
```

```sql
-- SQL 힌트 사용
SELECT /*+ BROADCAST(small_table) */ *
FROM large_table
JOIN small_table ON large_table.key = small_table.key
```

## Broadcast 조건

```python
# broadcast 임계값 확인 (기본 10MB)
spark.conf.get("spark.sql.autoBroadcastJoinThreshold")

# 임계값 조정
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "50MB")
```

**주의사항:**
- 작은 테이블이 실제로는 크면 driver OOM 위험
- collect 크기 확인 후 적용

```python
# 테이블 크기 확인
df_small.cache()
print(f"Row count: {df_small.count()}")
# Spark UI의 Storage 탭에서 실제 크기 확인
```

# 3. 처방 2: 스큐(Skew) 해결

---

스큐는 "특정 키로 데이터가 몰리는 현상"입니다.

## 증상

- 특정 task만 오래 걸림
- stage가 끝나지 않고 꼬리(스트래글러)가 생김
- Spark UI에서 task 시간 분포가 불균형

## 해결책 1: Salting

핫 키에 salt를 추가해서 분산시킵니다.

```python
from pyspark.sql.functions import col, lit, concat, rand, floor

# 왼쪽 테이블에 salt 추가
num_salts = 10
df_left_salted = df_left.withColumn(
    "salted_key",
    concat(col("key"), lit("_"), (floor(rand() * num_salts)).cast("string"))
)

# 오른쪽 테이블 explode
from pyspark.sql.functions import explode, array

df_right_exploded = df_right.withColumn(
    "salt_array",
    array([lit(str(i)) for i in range(num_salts)])
).withColumn(
    "salt",
    explode("salt_array")
).withColumn(
    "salted_key",
    concat(col("key"), lit("_"), col("salt"))
).drop("salt_array", "salt")

# salted key로 조인
result = df_left_salted.join(df_right_exploded, "salted_key")
```

## 해결책 2: AQE Skew Join

Spark 3.0+에서 AQE가 자동으로 스큐를 처리합니다.

```python
# AQE 스큐 조인 활성화 (기본 true)
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")

# 스큐 감지 임계값 조정
spark.conf.set("spark.sql.adaptive.skewJoin.skewedPartitionFactor", "5")
spark.conf.set("spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes", "256MB")
```

## 해결책 3: 핫 키 분리 처리

```python
# 핫 키 식별
hot_keys = df.groupBy("key").count() \
    .filter(col("count") > threshold) \
    .select("key").collect()

hot_key_list = [row.key for row in hot_keys]

# 핫 키와 일반 키 분리
df_hot = df.filter(col("key").isin(hot_key_list))
df_normal = df.filter(~col("key").isin(hot_key_list))

# 각각 다른 전략으로 처리
result_hot = df_hot.join(broadcast(df_dim), "key")
result_normal = df_normal.join(df_dim, "key")

# 합치기
result = result_hot.union(result_normal)
```

# 4. 처방 3: 조인 순서 최적화

---

## 원칙

1. 필터로 많이 줄어드는 테이블부터 처리
2. 폭발(카디널리티 증가) 조인 전에 집계/축약
3. 필요한 컬럼만 유지 (projection)

```python
# 나쁜 예: 조인 후 필터/선택
result = df_large.join(df_medium, "key") \
    .join(df_small, "key2") \
    .filter(col("status") == "active") \
    .select("id", "amount")

# 좋은 예: 필터 먼저, 필요한 컬럼만
result = df_large \
    .filter(col("status") == "active") \
    .select("key", "key2", "id", "amount") \
    .join(broadcast(df_small.select("key2", "dim1")), "key2") \
    .join(df_medium.select("key", "dim2"), "key")
```

## 조인 순서 패턴

```
(필터로 많이 줄어드는 테이블) → (조인) → (집계)
```

폭발 조인(카디널리티 증가) 전에는 집계/축약을 먼저 고려합니다.

# 5. 빠른 디버깅 루틴 (10분 컷)

---

```python
# 1) explain에서 Join 타입 확인
df_joined.explain()

# 2) Join 주변 Exchange 개수 확인 (셔플 횟수)
# → Exchange가 많으면 비용 큼

# 3) 스캔 확인 (파티션 프루닝)
# → FileScan에서 PartitionFilters 확인

# 4) 스큐 의심이면 task 시간 분포 확인
# → Spark UI > Stages > Task Duration

# 5) broadcast 가능하면 크기 확인 후 적용
df_small.cache()
df_small.count()
# Storage 탭에서 크기 확인
```

# 6. 체크리스트

---

```
□ explain에서 Join 타입을 확인했다
□ 작은쪽 broadcast가 가능한지 bytes 기준으로 확인했다
□ 스큐 키가 있는지 task 분포로 확인했다
□ 조인 전에 필터/프로젝션으로 데이터 폭을 줄였다
□ AQE가 활성화되어 있는지 확인했다
```

# Reference

---

- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Spark SQL Join Hints](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html)
- [Adaptive Query Execution](https://spark.apache.org/docs/latest/sql-performance-tuning.html#adaptive-query-execution)
- [Broadcast Variables](https://spark.apache.org/docs/latest/rdd-programming-guide.html#broadcast-variables)
