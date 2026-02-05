---
title: "[Spark] Snapshot + Delta 패턴 - 대규모 Range Join을 우회하는 사고법"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, RangeJoin, Architecture, SnapshotDelta, BatchProcessing]
---

# Introduction

---

"1.5억 행 × N블록 range join"처럼 규모가 커서 직접 조인이 불가능한 경우, **문제 자체를 재정의**해서 조인 규모를 줄이는 패턴입니다.

핵심 아이디어는 "매번 처음부터 전체를 계산"하는 대신, **미리 계산된 상태(Snapshot) + 변경분(Delta)**로 결과를 구성하는 것입니다. 이렇게 하면 range join의 범위가 전체 데이터에서 **스냅샷 간격 이내**로 제한되어, `BroadcastNestedLoopJoin` 대신 `HashJoin`이나 `RANGE_JOIN` 힌트를 활용할 수 있게 됩니다.

이 글은 이 패턴의 구조, 배치 경계 설계, UNION ALL 분리 전략 등을 정리합니다.

# 1. 왜 직접 Range Join이 안 되는가?

---

```sql
FROM utxo_snapshot u              -- 1.5억 행
JOIN target_blocks t              -- N개 블록
    ON u.created_block_height <= t.block_height
   AND (u.spent_block_height IS NULL
        OR u.spent_block_height > t.block_height)
```

- 등가 조인(`=`)이 아니라 범위 조건 → HashJoin 불가
- Spark는 `BroadcastNestedLoopJoin` 또는 `CartesianProduct`로 처리
- N이 크면 중간 결과가 **곱으로 폭발**

# 2. 사고의 전환: "전체 스캔" → "이전 상태 + 변경분"

---

블록 100,123의 상태를 구하고 싶다면:

```text
❌ 기존: 처음부터 100,123까지의 모든 이벤트를 스캔
✅ 변환: 블록 100,000의 상태(스냅샷) + 100,001~100,123의 변경분(델타)
```

이렇게 하면:
- 스냅샷 조인: equi-join (`snapshot_block = base_snapshot`) → **HashJoin 가능**
- 델타 조인: 범위가 최대 10,000블록으로 제한 → **RANGE_JOIN 힌트로 최적화 가능**

## 조인 종류의 변화

| 구간 | 조인 방식 | 규모 |
|------|----------|------|
| 스냅샷 → 타겟 | equi-join (`=`) | 50만 × 10K |
| 델타 → 타겟 | range join (≤10K 범위) | 수만 × 10K |
| **기존** | range join (전체 범위) | **1.5억 × N** |

# 3. 배치 경계와 스냅샷 경계의 정렬

---

**핵심 원칙**: 배치 범위는 반드시 스냅샷 간격에 맞춰야 합니다.

```python
SNAPSHOT_INTERVAL = 10000

# base_snapshot 계산
base_snapshot = FLOOR(block_height / 10000) * 10000
```

```text
스냅샷: 0, 10000, 20000, 30000, ...
배치:   [0~9999], [10000~19999], [20000~29999], ...
```

만약 배치가 `[5000~14999]`처럼 스냅샷 경계를 걸치면:
- 블록 5000~9999: base_snapshot=0, 델타 최대 9,999블록
- 블록 10000~14999: base_snapshot=10000, 델타 최대 4,999블록
- 이건 동작하지만, **한 배치 내에서 2개 스냅샷을 참조**해야 해서 비효율적

경계를 맞추면 **한 배치 = 한 스냅샷 + 최대 9,999 델타**로 깔끔합니다.

# 4. UNION ALL 분리: 기존 블록 vs 신규 블록

---

스냅샷 이후의 블록을 처리할 때, 두 종류를 분리해야 합니다:

```sql
-- (A) 스냅샷에 존재하는 블록: snapshot + delta
SELECT
    s.unspent_value + COALESCE(d.delta_value, 0) AS unspent_value
FROM snapshot_state s
LEFT JOIN delta_events d USING (target_block, created_block_height)
WHERE s.unspent_value + COALESCE(d.delta_value, 0) > 0

UNION ALL

-- (B) 스냅샷 이후 새로 생성된 블록: delta만
SELECT
    SUM(e.delta_value) AS unspent_value
FROM block_events e
WHERE e.created_block_height > base_snapshot  -- 신규 블록
GROUP BY ...
HAVING SUM(e.delta_value) > 0
```

**왜 분리하는가?**
- (A)는 스냅샷 값이 있으므로 `LEFT JOIN + COALESCE`
- (B)는 스냅샷에 없으므로 이벤트만으로 집계
- 합치면 조건이 복잡해지고 optimizer가 비효율적 플랜을 생성

# 5. Incremental 스냅샷 생성

---

스냅샷을 만들 때도 같은 원리를 적용합니다.

```text
스냅샷 20000 = 스냅샷 10000 + 델타(10001~20000)
```

- **Cold Start**: 첫 스냅샷만 전체 이벤트 스캔 (방식 A)
- **이후**: 이전 스냅샷 + 델타 (방식 B, 훨씬 빠름)
- 순차 실행 필요 (각 스냅샷이 이전에 의존)

# 6. HAVING SUM(...) > 0의 의미

---

```sql
HAVING SUM(e.delta_value) > 0
```

`delta_value`는 생성이면 `+`, 소비면 `-`입니다.
누적합이 0 이하면 **완전히 소비된 블록**이므로 결과에서 제외합니다.

이 필터가 없으면 "잔액 0인 생성블록"까지 포함되어 불필요한 행이 증가합니다.

# 7. 이 패턴이 적용 가능한 조건

---

```
✅ "시점별 상태"를 구해야 하는 문제
✅ 상태가 이벤트(+/-)의 누적으로 표현됨
✅ 이벤트가 시간순으로 정렬 가능
✅ 스냅샷 간격 내의 변경분이 전체 대비 작음
```

유사한 문제:
- 포트폴리오 시점별 보유량
- 재고 시점별 잔량
- 은행 계좌 시점별 잔액
- 구독 서비스 시점별 활성 사용자 수

# 8. 관련 아키텍처 패턴

---

이 Snapshot + Delta 패턴은 다양한 소프트웨어 아키텍처에서 동일한 원리로 사용됩니다:

```text
Event Sourcing:
  이벤트 스트림(델타)의 상태를 주기적으로 스냅샷으로 저장
  전체 이벤트를 재처리하지 않고 특정 시점의 상태를 빠르게 복원

CQRS (Command Query Responsibility Segregation):
  쓰기(이벤트 저장)와 읽기(스냅샷 조회)를 분리하는 패턴
  읽기 모델이 스냅샷 역할을 하며, 쓰기 이벤트가 델타 역할

Delta Lake의 트랜잭션 로그:
  체크포인트 파일(스냅샷) + 이후 커밋 로그(델타)로 테이블 상태 복원
  _delta_log/00000000000000000010.checkpoint.parquet + 이후 *.json
```

공통점은 **"전체를 매번 재계산하지 않고, 중간 상태 + 변경분"**으로 최종 상태를 효율적으로 도출한다는 것입니다.

# 9. 정리

---

| 개념 | 설명 |
|------|------|
| **Snapshot** | 특정 시점의 상태를 미리 계산해둔 것 |
| **Delta** | 스냅샷 이후의 변경분 (이벤트 스트림) |
| **equi-join 전환** | 스냅샷 조회가 `=` 조인이 되어 HashJoin 가능 |
| **범위 제한** | 델타 조인의 범위가 스냅샷 간격으로 제한 |
| **배치 경계 정렬** | 스냅샷 경계에 맞춰야 효율적 |
| **UNION ALL 분리** | 기존 블록(snapshot+delta)과 신규 블록(delta only) |

```text
핵심 사고법:
  "전체를 매번 계산" → "이전 결과 + 변경분"
  O(N × 전체) → O(N × 스냅샷간격)
```

# Reference

---

- [Event Sourcing Pattern - Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)
- [CQRS Pattern - Martin Fowler](https://martinfowler.com/bliki/CQRS.html)
- [Databricks Range Join Optimization](https://docs.databricks.com/en/optimizations/range-join.html)
- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
