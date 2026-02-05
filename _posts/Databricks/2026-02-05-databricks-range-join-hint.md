---
title: "[Databricks] RANGE_JOIN 힌트 Deep Dive - bin의 개념과 BroadcastNestedLoopJoin 탈출"
categories:
  - Databricks
tags:
  - [Databricks, Spark, RangeJoin, BroadcastNestedLoopJoin, QueryPlan, Performance]
---

# Introduction

---

Spark SQL에서 조인 조건이 `=`이 아니라 `BETWEEN`, `<=`, `>=` 같은 **범위 조건**일 때, Spark는 해시 기반 매칭이 불가능하여 `BroadcastNestedLoopJoin`이나 `CartesianProduct`와 같은 O(N×M) 전략을 사용합니다. 이를 **비등가 조인(range join)**이라고 합니다.

Databricks에서는 `RANGE_JOIN` 힌트로 이 범위 조인을 **binning 기반 equi-join으로 변환**하여 O(N+M) 수준으로 개선할 수 있습니다.

이 글은 **왜 range join이 느린지**, **RANGE_JOIN 힌트가 내부에서 무엇을 하는지**, **bin이란 무엇인지**를 정리합니다.

# 1. Spark가 조인을 처리하는 방식

---

Spark의 조인 전략은 **조인 조건의 종류**에 따라 결정됩니다.

## 등가 조인 (Equi-Join): `=` 조건

```sql
SELECT * FROM A JOIN B ON A.id = B.id
```

- `=` 조건이므로 **키를 해시**하여 같은 파티션끼리 매칭
- 물리 플랜: `BroadcastHashJoin` 또는 `SortMergeJoin`
- 핵심: 해시 함수로 후보군을 **O(1)**에 찾음

## 비등가 조인 (Non-Equi / Range Join): `<`, `>`, `<=`, `>=`, `BETWEEN`

```sql
SELECT * FROM A JOIN B ON A.start <= B.value AND A.end >= B.value
```

- 범위 조건이므로 해시 불가 → **후보군을 좁힐 수단이 없음**
- Spark는 두 가지 중 하나로 처리:
  - `CartesianProduct`: 양쪽 모든 행의 조합을 만든 후 조건 필터
  - `BroadcastNestedLoopJoin`: 작은쪽을 broadcast 후 큰쪽을 순회하며 조건 검사

## 정리

| 조건 | 전략 | 복잡도 |
|------|------|--------|
| `A.id = B.id` | HashJoin / SortMergeJoin | O(N + M) |
| `A.x <= B.y` | NestedLoopJoin / CartesianProduct | O(N × M) |

# 2. BroadcastNestedLoopJoin이란?

---

## 동작 방식

```text
1. 작은쪽 테이블을 모든 executor에 broadcast (복사)
2. 큰쪽 테이블의 각 행에 대해:
   → broadcast된 작은쪽의 모든 행을 순회
   → 조인 조건을 하나씩 평가
   → 조건 만족하면 결과에 포함
```

## 왜 느린가?

```text
큰쪽 1,000만 행 × 작은쪽 10,000행 = 1,000억 번 조건 비교
```

- HashJoin처럼 해시로 바로 찾는 게 아니라 **모든 후보를 순회하며 비교** (사전에서 인덱스 없이 첫 페이지부터 넘기는 것과 같음)
- 조건이 느슨하면(매칭이 많으면) 출력 행도 폭발
- 플랜에서 `BroadcastNestedLoopJoin`이 보이면 "행 수 × 행 수" 비교가 발생한다고 생각하면 됨

## CartesianProduct와의 차이

| 항목 | CartesianProduct | BroadcastNestedLoopJoin |
|------|-----------------|------------------------|
| 데이터 이동 | 양쪽 셔플 | 작은쪽만 broadcast |
| 적용 조건 | 조인 조건 없음 또는 비등가 | 한쪽이 broadcast 가능한 크기 |
| 출력 | 모든 조합 → 필터 | 순회하며 조건 평가 |
| 성능 | 가장 느림 | 작은쪽이 작으면 상대적으로 나음 |

두 전략 모두 **O(N × M)** 비교가 필요하다는 점은 동일합니다. 차이는 데이터를 이동시키는 방식뿐입니다.

# 3. RANGE_JOIN 힌트란?

---

Databricks 전용 힌트로, 비등가 조인을 **binning 기반 equi-join으로 변환**합니다.

```sql
SELECT /*+ RANGE_JOIN(e, 1000) */ *
FROM target_blocks t
JOIN block_events e
    ON e.event_block > t.base_snapshot
    AND e.event_block <= t.block_height
```

핵심: `BroadcastNestedLoopJoin` → `BroadcastHashJoin`(또는 `SortMergeJoin`)으로 전환.

## PySpark DataFrame에서 사용하기

SQL 외에 PySpark DataFrame API에서도 `.hint()`로 적용할 수 있습니다.

```python
# DataFrame API에서 RANGE_JOIN 힌트 사용
result = (
    target_blocks
    .join(
        block_events.hint("range_join", 1000),  # 힌트를 조인할 DataFrame에 적용
        on=[
            block_events.event_block > target_blocks.base_snapshot,
            block_events.event_block <= target_blocks.block_height
        ]
    )
)
```

# 4. bin이란?

---

## 개념

bin은 **연속적인 범위를 이산적인 구간(bucket)으로 나누는 것**입니다. 핵심은 범위 조건을 **구간 번호의 등가 조건**으로 바꿔서, Spark가 해시 기반 조인을 사용할 수 있게 만드는 것입니다.

```text
bin_size = 1000일 때:

값 0~999    → bin 0
값 1000~1999 → bin 1
값 2000~2999 → bin 2
...
값 N → bin = FLOOR(N / 1000)
```

## RANGE_JOIN에서 bin이 하는 역할

범위 조건을 bin 기반 equi-join으로 변환합니다:

```text
원래 조건: e.event_block > 50000 AND e.event_block <= 59999

bin_size = 1000일 때:
  event_block 50001~50999 → bin 50
  event_block 51000~51999 → bin 51
  ...
  event_block 59000~59999 → bin 59

→ 이 target은 bin 50~59에 매칭
→ bin이 같은 행끼리만 비교하면 됨!
```

**핵심 변환**:

```text
Before: 큰쪽 전체를 순회하며 범위 비교 (NestedLoop)
After:  bin이 같은 행끼리만 매칭 (HashJoin) + bin 내에서 정확한 범위 필터
```

이것이 RANGE_JOIN이 `BroadcastNestedLoopJoin`을 `BroadcastHashJoin`으로 바꿀 수 있는 원리입니다.

## Query Plan에서 확인

RANGE_JOIN이 적용되면 플랜에 `RangeJoinBinGenerator`가 나타납니다:

```text
+- BroadcastHashJoin [bin#123], [bin#456], Inner
   +- Generate RangeJoinBinGenerator(1000, ...)
```

- `RangeJoinBinGenerator`: 각 행에 해당하는 bin 번호를 생성
- `BroadcastHashJoin [bin#...]`: bin을 키로 해시 조인
- 이후 조인 결과에서 정확한 범위 조건을 다시 필터

# 5. bin_size 선택법

---

## bin_size가 크면?

```text
bin_size = 10000, 범위 = 10000블록

→ 전체 범위가 1개 bin에 들어감
→ 모든 행이 같은 bin → 사실상 CartesianProduct
→ 힌트 효과 없음!
```

## bin_size가 작으면?

```text
bin_size = 10, 범위 = 10000블록

→ 1000개 bin 생성
→ 각 target이 최대 1000개 bin에 매칭
→ bin 생성 오버헤드 + 데이터 복제(한 행이 여러 bin에 걸칠 수 있음)
```

## 데이터 타입에 따른 bin_size 해석

bin_size는 조인 키의 **데이터 타입에 따라 단위가 달라집니다**:

```text
숫자형 (INT, BIGINT, DOUBLE 등): bin_size = 숫자 그대로
DATE:       bin_size = 일(day) 단위     → bin_size=30이면 30일 구간
TIMESTAMP:  bin_size = 초(second) 단위  → bin_size=3600이면 1시간 구간
DECIMAL:    동일한 precision/scale이어야 함
```

예를 들어 `TIMESTAMP` 컬럼으로 range join을 할 때, 1시간 단위로 bin을 나누고 싶다면 `bin_size = 3600`을 지정합니다.

## 적정 bin_size 기준

```text
원칙: bin_size < 조인 범위 (range)
경험칙: 조인 범위 / 10 ~ 조인 범위 / 5

예시:
  숫자형 - 배치 10,000블록 → bin_size = 1000~2000
  숫자형 - 배치 1,000블록  → bin_size = 100~200
  DATE   - 30일 범위      → bin_size = 3~6 (일 단위)
  TIMESTAMP - 1시간 범위   → bin_size = 360~720 (초 단위)
```

| bin_size vs 범위 | 결과 |
|-----------------|------|
| bin_size >= 범위 | 1개 bin, 힌트 효과 없음 |
| bin_size ≈ 범위/10 | 적절한 분산, 효과적 |
| bin_size << 범위 | bin 수 과다, 오버헤드 |

# 6. RANGE_JOIN이 무시되는 경우 (함정)

---

## 함정 1: 조인 키 타입 불일치

```sql
-- unspent_snapshot.snapshot_block: BIGINT
-- target_blocks.base_snapshot: INT (FLOOR 결과)

JOIN unspent_snapshot s ON s.snapshot_block = t.base_snapshot
```

RANGE_JOIN 힌트를 걸어도 **INT와 BIGINT가 섞이면 힌트가 무시**됩니다.

```text
물리 플랜: BroadcastNestedLoopJoin (RANGE_JOIN이 아닌!)
```

해결:

```sql
CAST(FLOOR(block_height / 10000) * 10000 AS BIGINT) AS base_snapshot
-- 또는
CAST(... AS INT) AS base_snapshot  -- 상대방 타입에 맞춤
```

**중요**: 힌트가 무시되어도 **에러가 나지 않습니다**. 플랜에서 직접 확인해야 합니다.

## 함정 2: 등가 조건이 섞여 있을 때

```sql
ON a.id = b.id AND a.ts BETWEEN b.start_ts AND b.end_ts
```

- `=` 조건이 있으면 Spark가 자체적으로 `SortMergeJoin`이나 `HashJoin`을 선택할 수 있음
- 이 경우 RANGE_JOIN 힌트가 불필요하거나 무시될 수 있음
- equi 조건이 충분히 selective하면 RANGE_JOIN 없이도 빠를 수 있음

## 함정 3: OSS Spark에서는 동작하지 않음

RANGE_JOIN 힌트는 **Databricks Runtime 전용**입니다. OSS Apache Spark에서는 무시됩니다.

# 7. EXPLAIN으로 확인하는 체크리스트

---

```python
spark.sql("EXPLAIN FORMATTED <query>").show(truncate=False)
```

## RANGE_JOIN 적용 확인

```text
✅ 적용됨:
  +- BroadcastHashJoin [range_bin#123], [range_bin#456]
     +- Generate RangeJoinBinGenerator(1000, ...)

❌ 적용 안 됨:
  +- BroadcastNestedLoopJoin BuildRight, Inner, ...
```

## 확인 포인트

| 확인 항목 | 방법 |
|-----------|------|
| 힌트 적용 여부 | `RangeJoinBinGenerator` 존재 확인 |
| 조인 전략 | `BroadcastHashJoin` vs `BroadcastNestedLoopJoin` |
| 행 수 축소 | 조인 전후 rows estimates 비교 |
| 타입 일치 | 조인 키의 데이터 타입이 동일한지 |

# 8. 정리: 비등가 조인의 전략 선택 흐름

---

```text
비등가 조인 조건 발견
  ├─ Databricks Runtime인가?
  │   ├─ Yes → RANGE_JOIN 힌트 시도
  │   │   ├─ 타입 일치? → BroadcastHashJoin (binning)
  │   │   └─ 타입 불일치 → 힌트 무시 → BroadcastNestedLoopJoin
  │   └─ No (OSS Spark) → RANGE_JOIN 불가
  │
  └─ RANGE_JOIN 불가할 때:
      ├─ 작은쪽 broadcast 가능 → BroadcastNestedLoopJoin
      ├─ 양쪽 다 큼 → CartesianProduct
      └─ 최후의 수단: 데이터 모델 변경 (범위 조건 → equi-join 전환)
```

| 전략 | 복잡도 | 플랜 키워드 | 대응 |
|------|--------|------------|------|
| BroadcastHashJoin | O(N+M) | `BroadcastHashJoin` | equi-join 또는 RANGE_JOIN 적용 시 |
| SortMergeJoin | O(N log N) | `SortMergeJoin` | equi-join, 양쪽 다 큰 경우 |
| BroadcastNestedLoopJoin | O(N×M) | `BroadcastNestedLoopJoin` | 비등가 + 작은쪽 broadcast |
| CartesianProduct | O(N×M) | `CartesianProduct` | 비등가 + 양쪽 다 큼 |

# Reference

---

- [Databricks Range Join Optimization](https://docs.databricks.com/en/optimizations/range-join.html)
- [Spark SQL Join Strategies](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Spark Physical Plan Operators](https://jaceklaskowski.gitbooks.io/mastering-spark-sql/content/spark-sql-SparkPlan.html)
