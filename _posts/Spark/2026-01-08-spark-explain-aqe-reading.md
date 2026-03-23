---
title: "[Spark] explain/AQE 읽는 법 - Exchange, Join 타입으로 병목 찾기"
categories:
  - Spark
tags: [Spark, AQE, Explain, Exchange, Join, Shuffle]
---

## Introduction

---

Spark 성능 튜닝에서 가장 중요한 스킬은 **explain(Physical Plan)을 읽는 능력**입니다.

특히 AQE(Adaptive Query Execution)가 켜져 있으면 "실행 중" 플랜이 바뀌기 때문에, 핵심 표식만 빠르게 읽어도 병목을 찾는 속도가 크게 빨라집니다.

## 1. explain 사용법

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

## 2. 가장 먼저 볼 것: Exchange(셔플)

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

## 3. Join 종류 빠르게 구분하기

---

explain에서 보이는 Join 타입은 Spark가 **자동으로 선택한 조인 전략**입니다. 각 타입이 뜨는 이유와 성능 특성을 알아야 병목을 정확히 판단할 수 있습니다.

| Join 타입 | 셔플 | 조건 | 성능 |
|-----------|:---:|------|:---:|
| `BroadcastHashJoin` | 없음 | 등가 조인 + 한쪽이 작음 | ★★★ |
| `SortMergeJoin` | 양쪽 | 등가 조인 + 양쪽 다 큼 | ★★ |
| `ShuffledHashJoin` | 양쪽 | 등가 조인 + 한쪽이 상대적으로 작음 | ★★ |
| `BroadcastNestedLoopJoin` | 없음 | 비등가 조인 + 한쪽이 작음 | ★~★★ |
| `CartesianProduct` | 양쪽 | 조인 조건 없음 | ★ (위험) |

### BroadcastHashJoin — 가장 이상적

작은 테이블 전체를 각 executor에 복제(broadcast)한 뒤, **해시맵**으로 O(1) 조인합니다. 셔플이 발생하지 않아 가장 빠릅니다.

```
큰 테이블 (파티션별)     작은 테이블 (broadcast)
┌──────────┐            ┌──────────┐
│ Executor 1│ ←── JOIN ──│ 전체 복사  │
│ Executor 2│ ←── JOIN ──│ 전체 복사  │
│ Executor 3│ ←── JOIN ──│ 전체 복사  │
└──────────┘            └──────────┘
셔플 없음!
```

**발생 조건**: 등가 조인(`=`) + 한쪽이 `spark.sql.autoBroadcastJoinThreshold`(기본 10MB) 이하.

**explain에서 확인**:
```
+- BroadcastHashJoin [key#1], [key#2], Inner, BuildRight
   :- * Filter ...
   +- BroadcastExchange HashedRelationBroadcastMode(...)  ← broadcast 표식
```

`BuildRight` 또는 `BuildLeft`는 어느 쪽을 broadcast했는지 알려줍니다.

### SortMergeJoin — 양쪽 다 클 때

양쪽 테이블을 **조인 키 기준으로 셔플 + 정렬**한 뒤, 정렬된 순서대로 병합(merge)합니다. 대용량 조인의 기본 전략입니다.

```
테이블 A (셔플 후 정렬)     테이블 B (셔플 후 정렬)
┌─ key=1 ─┐               ┌─ key=1 ─┐
│  key=2  │  ←── merge ──  │  key=2  │
│  key=3  │               │  key=3  │
└─────────┘               └─────────┘
```

**발생 조건**: 등가 조인 + 양쪽 모두 broadcast 임계값 초과.

**explain에서 확인**:
```
+- SortMergeJoin [key#1], [key#2], Inner
   :- * Sort [key#1 ASC]
   :  +- Exchange hashpartitioning(key#1, 200)  ← 양쪽 셔플
   +- * Sort [key#2 ASC]
      +- Exchange hashpartitioning(key#2, 200)  ← 양쪽 셔플
```

Exchange가 2번 보이면 양쪽 모두 셔플이 발생한 것입니다. **한쪽을 broadcast할 수 있다면 힌트로 BroadcastHashJoin으로 변경하는 것이 일반적인 튜닝 방향**입니다.

### ShuffledHashJoin — SortMerge보다 빠를 수 있는 대안

양쪽을 셔플하지만, 정렬 없이 **작은 쪽으로 해시맵**을 만들어 조인합니다. SortMergeJoin의 정렬 비용을 생략하므로 한쪽이 상대적으로 작을 때 유리합니다.

**발생 조건**: `spark.sql.join.preferSortMergeJoin=false`로 설정하거나, AQE가 런타임에 한쪽이 작다고 판단할 때.

기본값은 SortMergeJoin 우선이므로, explain에서 보기 드뭅니다. 의도적으로 사용하려면 설정 변경이 필요합니다.

### BroadcastNestedLoopJoin — 비등가 조인 시 등장

등가 조건(`=`)이 없는 조인(범위, 부등호)에서 작은 테이블을 broadcast한 뒤, **모든 행을 1:1로 비교**합니다.

```sql
-- 이 조인은 BroadcastNestedLoopJoin이 됨
FROM big_table b
JOIN small_table s
  ON b.timestamp >= s.start_time
 AND b.timestamp <  s.end_time
```

**발생 조건**: 비등가 조인 + 한쪽이 작음.

해시맵을 구축할 수 없어 O(N×M) 비교가 발생합니다. 작은 테이블이 수백 행이면 괜찮지만, 수만 행 이상이면 급격히 느려집니다. 등가 조건을 추가할 수 있다면 BroadcastHashJoin으로 전환하는 것이 좋습니다.

### CartesianProduct — 조인 조건이 없을 때

조인 조건 자체가 없거나(cross join), Spark가 조건을 인식하지 못할 때 발생합니다. 양쪽의 **모든 행 조합**(N×M)을 생성합니다.

```sql
-- 명시적 cross join (의도적)
FROM table_a CROSS JOIN table_b

-- 의도하지 않은 CartesianProduct (ON 절 누락!)
FROM table_a, table_b
WHERE table_a.col > 100
```

**explain에서 보이면 거의 항상 문제**입니다. 100만 × 100만 = 1조 행이 생성될 수 있습니다. 대부분의 경우 조인 조건을 추가하면 해결됩니다.

### 요약: explain에서 Join 타입 보고 판단하기

```
BroadcastHashJoin     → 문제 없음
SortMergeJoin         → 한쪽을 broadcast 가능한지 검토
ShuffledHashJoin      → 대체로 문제 없음
BroadcastNestedLoopJoin → 등가 조건 추가 가능한지 검토
CartesianProduct      → 반드시 원인 확인 (조인 조건 누락?)
```

## 4. AQE 표식 읽기

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

### AQE 주요 설정

```sql
-- AQE 활성화 여부 (기본 true)
SET spark.sql.adaptive.enabled;

-- 파티션 병합 (기본 true)
SET spark.sql.adaptive.coalescePartitions.enabled;

-- 스큐 조인 최적화 (기본 true)
SET spark.sql.adaptive.skewJoin.enabled;
```

## 5. "데이터가 줄었는데 왜 느리지?"

---

자주 하는 착각:
- 최종 결과 row가 적으면 빨라야 한다

하지만 실제 비용은:
- 조인/집계 **전에** 얼마나 많이 읽고, 얼마나 셔플했는지에 달려 있습니다.

**explain에서 확인할 것:**
- 조인 직전 스캔 크기
- 셔플 파티션 수
- 조인 형태

## 6. 실전 체크리스트

---

```
□ Join 주변에 Exchange가 몇 번 뜨는가?
□ Broadcast가 가능한 테이블인데 SortMergeJoin이 뜨진 않는가?
□ AQE가 파티션 수를 과도하게 키워 잡을 느리게 만들진 않는가?
□ 스큐 키로 특정 파티션만 커지는 흔적이 있는가?
□ Filter가 Scan 가까이에서 적용되고 있는가?
```

## Reference

---

- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Adaptive Query Execution](https://spark.apache.org/docs/latest/sql-performance-tuning.html#adaptive-query-execution)
- [DataFrame.explain() API](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.explain.html)
