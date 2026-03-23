---
title: "[Databricks] ThreadPoolExecutor + persist() Race Condition — Serverless에서 빈 DataFrame이 반환되는 이유"
categories:
  - Databricks
tags: [Databricks, PySpark, ThreadPoolExecutor, persist, RaceCondition, Serverless, Delta Lake]
---

## Introduction

---

PySpark에서 `persist()`된 DataFrame을 `ThreadPoolExecutor`로 **여러 쿼리에서 동시에 읽으면**, Databricks Serverless 환경에서 간헐적으로 빈 결과가 반환될 수 있습니다. 전용 클러스터에서는 재현되지 않는 이 문제는, `persist()`의 lazy evaluation과 Serverless의 자원 스케줄링 특성이 결합되어 발생합니다.

이 글에서 다루는 내용:

- `persist()` + `ThreadPoolExecutor` 조합에서 race condition이 발생하는 원인
- Delta Lake `DESCRIBE HISTORY`로 빈 write를 진단하는 방법
- 체계적인 가설 검증 과정 (3개 가설 → 데이터로 기각/채택)
- Serverless vs 전용 클러스터의 동작 차이

## 문제의 코드 패턴

---

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

# 1. 공유 DataFrame을 persist + 강제 materialize
shared_df = spark.sql("SELECT ... FROM source GROUP BY ...").persist()
shared_df.foreachPartition(lambda _: None)  # materialize 시도

# 2. persist된 DataFrame을 4개 쿼리에서 동시에 읽기
with ThreadPoolExecutor(max_workers=4) as executor:
    futures = {
        executor.submit(write_table, tbl, query, params): tbl
        for tbl, query, params in tasks  # 7개 task → 4+3으로 나뉨
    }
    for future in as_completed(futures):
        future.result()  # 빈 DataFrame도 예외 없이 성공
```

이 패턴은 Spark 공식 문서의 `persist → write → unpersist` 패턴과 유사하지만, **동시 쿼리 수가 4개이고 각각이 복잡한 PIVOT 연산**이라는 점에서 Serverless 환경의 자원 경합이 발생할 조건이 됩니다.

## 증상

---

다수의 output 테이블에서 특정 배치의 데이터가 **전부 0이거나 행이 누락**되었습니다. 인접 배치는 정상이었고, 소스 데이터도 정상 존재했습니다. 파이프라인은 에러 없이 성공으로 종료되었습니다.

## 진단: DESCRIBE HISTORY로 빈 write 확인

---

Delta Lake의 `DESCRIBE HISTORY`는 모든 write의 `operationMetrics`를 기록합니다. 여기서 `numFiles` 값으로 빈 write를 식별할 수 있습니다.

```sql
DESCRIBE HISTORY my_catalog.my_schema.output_table;
```

결과에서 결정적인 패턴이 드러났습니다:

```
[첫 번째 batch] 4개 동시 실행 (max_workers=4):
  Table-1: numFiles=1  ← OK    (단순 GROUP BY)
  Table-2: numFiles=0  ← EMPTY (PIVOT)
  Table-4: numFiles=0  ← EMPTY (PIVOT)
  Table-5: numFiles=0  ← EMPTY (PIVOT)

[두 번째 batch] 남은 3개:
  Table-6: numFiles=1  ← OK
  Table-7: numFiles=1  ← OK
  Table-3: numFiles=1  ← OK
```

`numFiles=0`은 **빈 DataFrame이 Delta Lake에 commit된 증거**입니다. Delta Lake는 빈 write를 오류 없이 허용합니다.

## 가설 검증 과정

---

### 가설 1: 동시 실행 Job 간 replaceWhere 범위 겹침

→ `DESCRIBE HISTORY`로 확인. 각 배치가 별도 범위로 실행됨. 겹침 없음. **기각.**

### 가설 2: Serverless 환경에서 temp view/cache 공유

→ 각 Job run은 별도 Serverless 클러스터에 격리된 SparkSession으로 실행. 클러스터 간 SparkContext 공유 불가능. **기각.**

### 가설 3: ThreadPoolExecutor + persist cache race condition ✅

`DESCRIBE HISTORY`의 타임스탬프와 `numFiles`를 교차 분석한 결과:

- **단순 GROUP BY 테이블은 항상 성공** → persist cache 부하가 낮음
- **두 번째 batch는 항상 성공** → 첫 번째 batch가 cache를 이미 안정화
- **대량 배치(수백 건)에서는 미발생** → DataFrame이 크면 materialize 완료 후 쿼리 실행

## 근본 원인

---

PySpark의 `persist()`는 **lazy**합니다. 호출해도 즉시 메모리에 올라가지 않고, action 실행 시 비로소 materialize됩니다.

```python
df.persist()                              # 캐시 등록만 (데이터 로딩 X)
df.foreachPartition(lambda _: None)       # materialize 시도
# ↓ 즉시 4개 복잡한 쿼리 동시 실행
# → Serverless의 자원 스케줄링 특성상, cache가 완전히 안정화되기 전에
#   일부 쿼리가 읽기를 시작하면 빈 결과 반환
```

**전용 클러스터에서는 재현 안 됨**: 자원이 고정되어 있어 cache materialization이 안정적으로 완료됩니다.

## 해결 방법

---

| 방법 | 설명 |
|------|------|
| **전용 클러스터 사용** | Serverless 대신 `existing_cluster_id` 지정. 가장 확실 |
| **max_workers 줄이기** | `max_workers=4` → `2`로 동시성 제한 |
| **2-phase 실행** | 첫 batch 완료 후 두 번째 batch 실행 (순차화) |
| **persist 후 count()** | `foreachPartition` 대신 `df.count()`로 확실한 materialize 보장 |

## 핵심 교훈

---

1. **`persist()`는 materialize를 보장하지 않는다.** `foreachPartition(lambda _: None)`도 Serverless에서는 불충분할 수 있다.
2. **Delta Lake `DESCRIBE HISTORY`의 `numFiles`가 핵심 진단 도구다.** 빈 write는 에러 없이 성공하므로, 사후에 `numFiles=0`으로만 발견할 수 있다.
3. **1건의 이상은 전수 검사의 시작이다.** 1개 배치의 이상을 발견하면 전체 범위를 검사해야 한다.
4. **가설은 반드시 데이터로 검증해야 한다.** "아마 이거겠지"로 수정하면 진짜 원인을 놓친다.

## Reference

---

- [PySpark DataFrame.persist() API](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.persist.html)
- [Delta Lake DESCRIBE HISTORY](https://docs.delta.io/latest/delta-utility.html#describe-history)
- [Spark RDD Persistence and Storage Levels](https://spark.apache.org/docs/latest/rdd-programming-guide.html#rdd-persistence)
- [Databricks Serverless Compute](https://docs.databricks.com/en/compute/serverless.html)
