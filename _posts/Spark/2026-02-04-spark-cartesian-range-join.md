---
title: "[Spark SQL] 카테시안 곱(Cartesian)과 Range Join - 왜 플랜에 CartesianProduct가 뜰까?"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Join, CartesianProduct, RangeJoin, Databricks]
---

# Introduction

---

Spark SQL/Databricks에서 조인 플랜을 보다 보면 `CartesianProduct` 또는 `BroadcastNestedLoopJoin`이 뜨는 경우가 있습니다.

> 참고: Databricks에서 자주 쓰는 `/*+ ... */` 힌트 주석은 Spark SQL 힌트 문법이며, 물리 플랜으로 반영됐는지 `explain`으로 확인하는 게 핵심입니다.  
이 글은 “카테시안 곱이 뭐고 왜 뜨는지”, 그리고 실무에서 어떻게 완화하는지 정리합니다.

# 1. 카테시안 곱(Cartesian Product)이란?

---

두 테이블의 모든 행을 서로 짝지어 붙이는 연산입니다.

- A가 3행, B가 4행이면 결과는 12행(3×4)

```text
A(3 rows) × B(4 rows) = 12 rows
```

# 1.5 한 번에 이해하는 비유 (중요)

---

카테시안 곱은 쉽게 말해:

- 왼쪽 테이블의 **각 행**이
- 오른쪽 테이블의 **모든 행**을 한 번씩 “만나서”
- 가능한 조합을 전부 만드는 것

즉, “소개팅 매칭”을 생각하면 됩니다.

- A에 3명, B에 4명이 있으면 가능한 매칭은 3×4 = 12개

이게 데이터에서 벌어지면, 행 수가 곱으로 커져서 금방 감당 불가가 됩니다.

# 2.5 그런데 왜 항상 '완전한 곱'이 되진 않나?

---

플랜에 `BroadcastNestedLoopJoin`이 보인다고 해서 **항상 결과가 A×B 전체가 되는 건 아닙니다.**

- Nested Loop는 보통 “작은쪽을 들고(broadcast)”
- 큰쪽을 스캔하면서 **조건을 만족하는 것만** 통과시키는 방식입니다.

그럼에도 느릴 수 있는 이유는:
- `=` 조인처럼 해시로 바로 매칭하는 게 아니라
- 후보 비교/조건 평가가 많이 필요하고
- 조건이 느슨하면(매칭이 많으면) 결과가 크게 늘어나기 때문입니다.

# 3.5 range join이 특히 위험한 이유

---

비등가 조인은 “키 하나로 딱 매칭”이 아니라 범위 조건 때문에 **여러 후보가 매칭**될 수 있습니다.

예를 들어 `created_block_height <= t.block_height`는
- `t`가 커질수록 매칭되는 `created`가 계속 늘어납니다.

또 `spent_block_height > t.block_height`는
- “t 시점에 아직 안 쓴 UTXO”를 찾는 조건이라
- t마다 살아있는 UTXO가 많으면 매칭이 급증합니다.

그래서 range join에서는 아래가 필수입니다.

- 작은쪽 broadcast (가능하면)
- 큰쪽을 bounds로 **먼저 줄이기**
- target이 크면 **chunking(구간 분할)**

# 6. 실전 체크리스트

---

- 플랜에 `BroadcastNestedLoopJoin`이 보이면:
  - 브로드캐스트되는 쪽이 정말 작은지
  - 큰쪽 스캔이 줄었는지(푸시다운/프루닝/LC)
  - 조건이 너무 느슨하지 않은지(매칭 폭발)
- 플랜에 `CartesianProduct`가 보이면:
  - 조인 조건(ON)이 누락된 건 아닌지
  - 비등가 조인인데 broadcast/후보군 선필터가 없는지

# 2. 왜 위험한가?

---

행 수가 “곱셈”으로 폭발합니다.

- 큰 테이블(예: 수억~수십억 행) × 타겟(수천~수만 행) → 중간 결과가 감당 불가 수준으로 커질 수 있습니다.

# 3. 왜 Spark가 CartesianProduct / NestedLoop로 가나?

---

대표적인 원인은 **비등가(range) 조인**입니다.

예:

```sql
u.created_block_height <= t.block_height
AND (u.spent_block_height IS NULL OR u.spent_block_height > t.block_height)
```

- `=` 기반 equi-join이 아니라 `<=`, `>` 기반 조건이라
- Spark가 `HashJoin`으로 풀기 어렵고
- 다음 형태로 계획될 수 있습니다.
  - `CartesianProduct` (전체 매칭 후보 후 조건 적용)
  - `BroadcastNestedLoopJoin` (작은쪽 broadcast 후 큰쪽을 훑으며 조건 검사)

# 4. 플랜에서 어떻게 보이나?

---

`df.explain("formatted")` 결과에 아래가 보이면 주의 신호입니다.

- `CartesianProduct`
- `BroadcastNestedLoopJoin`

# 5. 완화 전략 (실전)

---

## 5.1 작은쪽(타겟)을 브로드캐스트로 고정

```sql
JOIN /*+ BROADCAST */ target_info t ON ...
```

- 큰쪽 셔플을 피하는 데 도움
- 다만 “큰쪽 스캔량” 자체가 크면 여전히 느릴 수 있음

## 5.2 큰쪽 후보군을 bounds로 선필터 (가장 중요)

타겟 블록 범위가 `[min_h, max_h]`라면:

- `created_block_height <= max_h`
- `spent_block_height IS NULL OR spent_block_height >= min_h`

처럼 **큰 테이블을 먼저 줄여**야 합니다.

```sql
SELECT u.*
FROM utxo_snapshot u
CROSS JOIN (SELECT MIN(block_height) min_h, MAX(block_height) max_h FROM target_info) b
WHERE u.created_block_height <= b.max_h
  AND (u.spent_block_height IS NULL OR u.spent_block_height >= b.min_h)
```

## 5.3 target이 너무 크면 chunking(구간 분할)

- 예: 10,000 블록을 한 번에 하지 말고 1,000~5,000 단위로 나눠 실행
- 카테시안에 준하는 폭발을 완화

# 7. 정리: Equi-Join vs Range Join

---

| 구분 | Equi-Join (`=`) | Range Join (`<`, `>`, `<=`, `>=`) |
|------|-----------------|-----------------------------------|
| 조인 전략 | HashJoin, SortMergeJoin | NestedLoop, CartesianProduct |
| 성능 | 빠름 (해시/정렬 기반) | 느림 (비교 연산 많음) |
| 주의점 | 키 분포 확인 | **반드시** bounds 선필터 |
| 힌트 | `BROADCAST`, `SHUFFLE_HASH` | `BROADCAST` (작은쪽만) |

## 핵심 원칙

```
Range Join에서 성능을 확보하려면:
1. 작은쪽 BROADCAST
2. 큰쪽 bounds로 선필터 (가장 중요!)
3. 그래도 크면 chunking
```

# Reference

---

- [Spark SQL Join Hints](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html)
- [Databricks Performance Tuning](https://docs.databricks.com/en/optimizations/index.html)
- [Understanding Spark Physical Plans](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
