---
title: "[Spark] explain/AQE 읽는 법 - Exchange, Join 타입으로 병목 찾기"
categories:
  - Spark
tags:
  - [Spark, AQE, Explain, Exchange, Join, Shuffle]
---

# Introduction

---

Spark 성능 튜닝에서 가장 중요한 스킬은 **explain(Physical Plan)을 읽는 능력**입니다.

특히 AQE(Adaptive Query Execution)가 켜져 있으면 "실행 중" 플랜이 바뀌기 때문에, 핵심 표식만 빠르게 읽어도 병목을 찾는 속도가 크게 빨라집니다.

# 1. explain 사용법

---

```python
# 기본 사용
df.explain()

# 상세 플랜 (Parsed → Analyzed → Optimized → Physical)
df.explain(extended=True)

# 포맷팅된 출력 (권장)
df.explain(mode="formatted")

# 비용 정보 포함
df.explain(mode="cost")
```

# 2. 가장 먼저 볼 것: Exchange(셔플)

---

`Exchange`는 "네트워크 셔플이 발생한다"는 신호입니다.

```
== Physical Plan ==
* Project (12)
+- * SortMergeJoin Inner (11)
   :- * Sort (5)
   :  +- Exchange (4)        ← 셔플 발생!
   :     +- * Filter (3)
   +- * Sort (10)
      +- Exchange (9)        ← 또 셔플 발생!
         +- * Filter (8)
```

- 조인/집계에서 `Exchange`가 많으면 비용이 커짐
- 튜닝의 목표는 보통 "Exchange를 줄이거나, 한 번으로 몰기"

# 3. Join 종류 빠르게 구분하기

---

| Join 타입 | 설명 | 성능 |
|-----------|------|------|
| `BroadcastHashJoin` | 작은쪽 broadcast + equi-join | **가장 좋음** |
| `SortMergeJoin` | 큰-큰 조인 (셔플+정렬) | 보통 |
| `ShuffledHashJoin` | 특정 조건에서 등장 | 보통 |
| `BroadcastNestedLoopJoin` | 비-equi/range 조인 | **주의 필요** |
| `CartesianProduct` | 조건 없는 조인 | **매우 위험** |

# 4. AQE 표식 읽기

---

Spark 3.0+에서 AQE가 기본 활성화되어 있습니다.

```
== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false  ← 아직 최종 플랜 확정 전
+- ...
   +- AQEShuffleRead             ← AQE가 셔플 최적화 중
      +- ShuffleQueryStage        ← 셔플 경계(스테이지)
```

| 표식 | 의미 |
|------|------|
| `isFinalPlan=false` | 아직 최종 플랜 확정 전 |
| `isFinalPlan=true` | 실행 완료된 최종 플랜 |
| `AQEShuffleRead` | AQE가 파티션 수 조정 또는 스큐 처리 |
| `ShuffleQueryStage` | 셔플 경계(스테이지) 단위 |

## AQE 주요 설정

```sql
-- AQE 활성화 여부 (기본 true)
SET spark.sql.adaptive.enabled;

-- 파티션 병합 (기본 true)
SET spark.sql.adaptive.coalescePartitions.enabled;

-- 스큐 조인 최적화 (기본 true)
SET spark.sql.adaptive.skewJoin.enabled;
```

# 5. "데이터가 줄었는데 왜 느리지?"

---

자주 하는 착각:
- 최종 결과 row가 적으면 빨라야 한다

하지만 실제 비용은:
- 조인/집계 **전에** 얼마나 많이 읽고, 얼마나 셔플했는지에 달려 있습니다.

**explain에서 확인할 것:**
- 조인 직전 스캔 크기
- 셔플 파티션 수
- 조인 형태

# 6. 실전 체크리스트

---

```
□ Join 주변에 Exchange가 몇 번 뜨는가?
□ Broadcast가 가능한 테이블인데 SortMergeJoin이 뜨진 않는가?
□ AQE가 파티션 수를 과도하게 키워 잡을 느리게 만들진 않는가?
□ 스큐 키로 특정 파티션만 커지는 흔적이 있는가?
□ Filter가 Scan 가까이에서 적용되고 있는가?
```

# Reference

---

- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Adaptive Query Execution](https://spark.apache.org/docs/latest/sql-performance-tuning.html#adaptive-query-execution)
- [DataFrame.explain() API](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.explain.html)
