---
title: "[Spark] cache/persist vs stage 테이블 - 중간 결과 저장 전략"
categories:
  - Spark
tags:
  - [Spark, Cache, Persist, Checkpoint, Delta, Performance]
---

# Introduction

---

복잡한 쿼리를 튜닝하다 보면 결국 결론은 하나입니다:

> "중간 결과를 저장해서 재사용할 것인가, 매번 다시 계산할 것인가?"

Spark에서는 선택지가 2개로 자주 정리됩니다.

- `cache/persist`: 메모리/디스크에 임시로 보관
- stage 테이블(Delta/Parquet): 스토리지에 물리적으로 저장

# 1. cache/persist의 장단점

---

## 사용법

```python
# 기본 캐시 (메모리 우선)
df.cache()

# 저장 레벨 지정
from pyspark import StorageLevel
df.persist(StorageLevel.MEMORY_AND_DISK)

# 캐시 해제
df.unpersist()
```

## 장점
- 매우 빠른 재사용 (특히 반복 action에서)
- 코드 변경 없이 쉽게 적용

## 단점
- executor 메모리 압박 (OOM 위험)
- 클러스터 재시작/노드 교체 시 날아감
- lineage가 길면 재계산 트리거가 발생할 수 있음

# 2. stage 테이블의 장단점

---

## 사용법

```python
# Delta 테이블로 저장
df.write.format("delta").mode("overwrite").save("/path/to/stage")

# Parquet로 저장
df.write.parquet("/path/to/stage")
```

## 장점
- 결과가 "물리적으로 저장"되어 재실행/재처리가 안정적
- 파일 수/파티션/클러스터링 등 물리 설계로 성능 제어 가능
- 파이프라인 단계 분리가 쉬움 (관측/모니터링/재시도)

## 단점
- 쓰기 I/O 비용
- 스키마/버전 관리 필요
- 작은 파일 문제를 관리해야 함 (OPTIMIZE/compaction)

# 3. 언제 cache가 맞나?

---

- 동일 노트북/잡에서 **짧은 시간** 안에 반복 사용하는 데이터
- 사이즈가 충분히 작고, 메모리 여유가 있을 때
- "개발/실험" 구간

```python
# 좋은 예: 필터링된 작은 데이터를 여러 번 사용
filtered_df = big_df.filter(col("status") == "active").cache()

result1 = filtered_df.groupBy("category").count()
result2 = filtered_df.groupBy("region").avg("amount")
```

# 4. 언제 stage 테이블이 맞나?

---

- 배치 파이프라인에서 단계별 재처리가 필요할 때
- join/aggregation이 크고 재계산 비용이 큰 단계
- 운영에서 실패/재시도를 고려해야 할 때

```python
# 좋은 예: 복잡한 변환 결과를 저장
transformed_df.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save("/warehouse/stage/transformed")
```

# 5. 실전 패턴

---

## cache는 "폭을 줄인 뒤" 하라

```python
# 나쁜 예: 전체 테이블 캐시
big_df.cache()  # OOM 위험!

# 좋은 예: 필요한 것만 캐시
small_df = big_df \
    .filter(col("date") >= "2024-01-01") \
    .select("id", "amount", "category") \
    .cache()
```

## stage 테이블은 멱등성 설계를 같이

```python
# 파티션 키 단위 overwrite (replaceWhere)
df.write \
    .format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", "date = '2024-01-01'") \
    .save("/warehouse/table")
```

# 6. 체크리스트

---

```
□ 중간 결과 재사용 횟수가 충분히 큰가?
□ 재시작/재시도에도 결과가 필요하면 stage가 맞다
□ cache는 메모리 사용량을 모니터링하고 OOM 대비가 있는가?
□ stage는 파일 수/compaction 전략이 있는가?
```

# Reference

---

- [Spark RDD Persistence](https://spark.apache.org/docs/latest/rdd-programming-guide.html#rdd-persistence)
- [Storage Levels](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.StorageLevel.html)
- [Delta Lake Best Practices](https://docs.delta.io/latest/best-practices.html)
