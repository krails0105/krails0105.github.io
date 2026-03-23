---
title: "[Spark] Snapshot x Target Block 크로스 조인 병목을 range 사전 집계로 3.5~7배 개선한 방법"
categories:
  - Spark
tags:
  - Spark
  - Databricks
  - PySpark
  - Delta Lake
  - 성능최적화
date: 2026-02-28
---

### 들어가며

대규모 이벤트 데이터 파이프라인의 분포 집계 프로세스를 Databricks에서 full build하던 중, 배치 처리 시간이 블록 높이가 올라갈수록 선형으로 증가하는 문제를 발견했습니다. 원인을 추적해 보니 `build_aggregated_view()` 함수 내부의 **스냅샷 x 타깃 블록 크로스 조인**이 핵심 병목이었습니다.

이 글에서는 해당 병목을 찾아낸 과정과, 중간 데이터를 **최대 8행 이하**로 축소하는 range 레벨 사전 집계로 재설계하여 **3.5~7배 성능 개선**을 달성한 경험을 정리합니다. 동일한 "불변 속성을 기준으로 사전 집계" 패턴은 Spark뿐 아니라 다른 분산 처리 시스템에서도 적용할 수 있는 범용적인 최적화 기법입니다.

**이 글에서 다루는 것:**
- Snapshot + Delta 패턴에서 크로스 조인이 만드는 중간 데이터 폭발 문제
- 불변 속성(range)을 활용한 사전 집계 최적화 설계
- Spark SQL의 VALUES 인라인 테이블, RANGE_JOIN 힌트 활용법
- 최적화 전후 성능 비교와 QA 검증 방법

---

### 배경: 분포 집계 프로세스가 계산하는 것

#### 분포 테이블

파이프라인의 분포 집계 프로세스는 3개 테이블을 생성합니다.

| 테이블 | 내용 | 컬럼 수 |
|---|---|---|
| `category_distribution` (Table-1) | 이벤트별 값 x 8개 구간 | 32 |
| `value_bucket_distribution` (Table-2) | 이벤트별 집계값 x 8개 구간 | 16 |
| `spent_output_category_distribution` (Table-3) | 이벤트별 소비 이벤트 분포 | 24 |

"현재 활성 상태인 엔티티가 값 구간(구간 1, 구간 2, ... , 구간 8)별로 얼마나 존재하는가"를 매 이벤트 집계하는 테이블들입니다.

#### Snapshot + Delta 패턴

트랜잭션 상태를 매 이벤트마다 전체 재계산하면 비용이 너무 크기 때문에, **10,000 블록 간격**으로 저장해 둔 스냅샷에 이후 이벤트(delta)를 더하는 방식으로 계산합니다.

```
state[event_id] = snapshot[base] + delta[base+1 .. event_id]
```

기존 `build_aggregated_view()`는 이 과정을 5개의 CTE로 구현했는데, 문제는 스냅샷을 `created_event_id`(트랜잭션 생성 이벤트 ID) 단위 그대로 유지한 채 타깃 이벤트들과 조인했다는 점입니다.

---

### 문제 진단: 크로스 조인이 만드는 중간 데이터 폭발

#### 수치로 보는 병목

특정 구간 부근의 실제 수치를 보면 상황이 명확합니다.

| 항목 | 값 |
|---|---|
| 스냅샷 행 수 (`created_event_id`별 그룹) | ~수십만 행 |
| 한 배치의 타깃 블록 수 | N개 |
| 크로스 조인 중간 데이터 | 수십만 x N = **수십억 행** |

배치가 진행될수록 스냅샷 행 수가 선형으로 증가하므로 처리 시간도 함께 증가합니다.

#### 실측 배치 시간 추이

```
Batch A (snap= 수십만 rows): ~900s
Batch B (snap= ~100만 rows): ~1,070s
Batch C (snap= ~110만 rows): ~1,120s
```

스냅샷 크기가 ~25% 증가하면 처리 시간도 ~24% 증가하는 선형 관계입니다. 이 추세라면 후반 구간에서는 배치당 2,000초 이상이 예상되었습니다.

#### 왜 크로스 조인이 발생하는가

기존 로직의 핵심 구조를 단순화하면 다음과 같습니다:

```sql
-- 기존: 스냅샷을 created_event_id 단위로 유지한 채 조인
SELECT t.event_id, s.created_event_id, s.category, s.current_value
FROM target_blocks t
CROSS JOIN snapshot s  -- 수십만 행 x N 이벤트 = 수십억 행
WHERE s.snapshot_event_id = t.base_snapshot
```

모든 타깃 이벤트에 대해 스냅샷 전체를 복제한 뒤, `created_event_id` 단위로 delta를 적용해야 했기 때문에 이 크로스 조인은 불가피한 것처럼 보였습니다. 하지만 정말 그럴까요?

---

### 핵심 인사이트: range는 트랜잭션 생성 시점에 결정되는 불변 속성이다

문제를 해결하는 열쇠는 `category`와 `value_bucket`의 성질에 있었습니다.

> **`category`와 `value_bucket`는 트랜잭션이 생성될 때 결정되고, 이후 절대 바뀌지 않는다.**

예를 들어, 특정 값의 트랜잭션이 생성되면 그 트랜잭션은 영원히 해당 category에 속합니다. 소비되거나 소비되지 않거나, 어느 타깃 이벤트 기준으로 보더라도 range가 달라지지 않습니다.

이 불변성이 의미하는 것은 명확합니다. "타깃 이벤트별로 `created_event_id` 단위를 유지해야 한다"는 가정이 틀렸습니다. 스냅샷을 타깃 이벤트와 조인하기 **전에** range 단위로 미리 합산해도 결과가 달라지지 않습니다.

```
수십만 행 (created_event_id별)
    --> SUM(value) GROUP BY category
    --> 8행 (range별)
```

#### 정밀도 보장: DECIMAL 타입의 결합법칙

이 최적화가 안전한 이유는 DECIMAL 타입의 수학적 성질에 있습니다. Python float과 달리 **DECIMAL은 교환법칙과 결합법칙이 정확히 성립**하므로, 그룹을 먼저 합산해도 최종 합계가 달라지지 않습니다. 완전히 소비된 트랜잭션 그룹(양수 delta와 음수 delta가 상쇄)도 SUM 과정에서 정확히 0이 되어 사전 집계 시 정보 손실이 없습니다.

---

### 해결책: 5-CTE를 3-CTE 구조로 재설계

기존 5-CTE 구조를 3-CTE로 줄이면서, 스냅샷 사전 집계를 첫 번째 CTE에서 처리합니다.

#### 핵심 SQL 구조 (3-CTE)

함수 시그니처는 기존과 동일하게 유지하여 호출 코드 수정 없이 적용할 수 있습니다.

```
CTE 1: snapshot_base
  → 스냅샷을 category 기준 GROUP BY (수십만 행 → 8행)

CTE 2: delta_existing
  → 기존 엔티티의 변화량 집계 (RANGE_JOIN 힌트로 범위 조인 최적화)

CTE 3: new_created
  → 신규 엔티티의 변화량 집계

최종 SELECT:
  → target_blocks × 8개 category (VALUES 인라인 테이블)
  → LEFT JOIN으로 CTE 1~3 결과 조합
  → COALESCE로 NULL → 0 처리
```

핵심 포인트:
- **CTE 1**에서 `GROUP BY category`로 수십만 행을 8행으로 축소
- **CTE 2, 3**에서 범위 조인에 `RANGE_JOIN` 힌트 적용 (Databricks 전용)
- **최종 SELECT**에서 VALUES 인라인 테이블로 category 완전성 보장

#### 구조 변화 요약

| | 기존 | 최적화 후 |
|---|---|---|
| CTE 수 | 5개 | 3개 |
| 스냅샷 조인 단위 | `created_event_id` (~수십만 행) | `category` (8행) |
| 최종 크로스 조인 크기 | N x 수십만 = 수십억 행 | N x 8 = 최대 수만 행 |
| 함수 시그니처 변경 | - | 없음 (호출 코드 수정 불필요) |

---

### 설계 세부 사항

#### VALUES 인라인 테이블로 range 완전성 보장

```sql
CROSS JOIN (
    SELECT category FROM VALUES
        ('bucket_1'), ('bucket_2'), ..., ('bucket_N')
    AS t(category)
) r
```

Spark SQL의 `VALUES` 절은 별도 테이블 없이 인라인으로 임시 데이터를 생성하는 표준 문법입니다. 여기서 VALUES 테이블을 사용한 이유는 두 가지입니다:

1. **range 완전성 보장**: 특정 range에 트랜잭션이 한 번도 존재한 적 없으면 스냅샷에 해당 row가 없습니다. VALUES 테이블을 CROSS JOIN한 뒤 LEFT JOIN으로 받으면, 데이터가 없는 range도 `COALESCE(..., 0)`으로 0이 채워져 항상 8개 range가 결과에 포함됩니다.

2. **BROADCAST 자동 적용**: 8행짜리 인라인 테이블은 Spark의 AQE(Adaptive Query Execution)가 자동으로 broadcast 처리합니다. `spark.sql.adaptive.autoBroadcastJoinThreshold` 기본값이 30MB이므로 8행은 당연히 해당됩니다. 별도의 `/*+ BROADCAST(r) */` 힌트가 필요 없습니다.

#### RANGE_JOIN 힌트

```sql
SELECT /*+ RANGE_JOIN(events, bin_size) */
    t.target_id, e.category,
    SUM(e.delta_val) AS delta_val
FROM targets t
JOIN events e
    ON e.event_id > t.base_snapshot
    AND e.event_id <= t.target_id
GROUP BY t.target_id, e.category
```

`delta_existing`과 `new_created` CTE에서 `event_event_id BETWEEN base_snapshot AND event_id` 형태의 범위 조건을 사용합니다. 이런 부등식 조인은 Spark가 기본적으로 SortMergeJoin이나 BroadcastNestedLoopJoin으로 처리하는데, 두 가지 모두 범위 조인에는 비효율적입니다.

`RANGE_JOIN` 힌트는 **Databricks 전용 최적화 기능**으로, 범위 조건을 binned equi-join으로 변환합니다. 내부적으로 조인 키를 `bin_size` 단위로 버킷화하여 동일 버킷 내에서만 비교하므로 전체 비교 횟수가 대폭 줄어듭니다.

> **참고**: `RANGE_JOIN` 힌트는 Databricks Runtime 전용이며, 오픈소스 Apache Spark에서는 지원되지 않습니다. 오픈소스 환경에서는 수동으로 bucket column을 추가하는 방식으로 유사한 최적화를 구현할 수 있습니다.

`bin_size=1000`은 event_id interval의 P90~P99 값을 10으로 나눈 경험적 기준으로 설정했습니다. 너무 작으면 버킷 수가 과도하게 늘어나고, 너무 크면 버킷 내 비교 대상이 많아져 효과가 줄어듭니다.

#### delta_existing 경계 조건의 중요성

```sql
ON e.event_id > t.base_snapshot    -- strict > (경계 이벤트 제외)
AND e.event_id <= t.target_id
AND e.created_id <= t.base_snapshot
```

`event_event_id > t.base_snapshot`에서 strict `>` (초과)를 사용하는 이유는, 스냅샷 경계 블록의 이벤트가 이미 스냅샷 값에 반영되어 있기 때문입니다. `>=`를 사용하면 경계 블록의 이벤트가 이중 계산(double counting)됩니다.

이 경계 처리 패턴은 Snapshot + Delta 아키텍처에서 반복적으로 나타나는 핵심 패턴입니다. 실제로 다른 노트북에서 `>` 대신 `>=`를 사용해 스냅샷 경계 블록의 spent output이 누락되는 off-by-one 버그(bug #16)를 경험한 바 있습니다.

---

### 성능 결과

최적화 코드 적용 후 실제 Databricks 실행 결과입니다.

#### 배치 시간 비교

```
# 최적화 전 (초기 구간)
Batch A (snap= 수십만 rows): ~900s
Batch B (snap= ~100만 rows): ~1,070s
Batch C (snap= ~110만 rows): ~1,120s

# 최적화 후 (전체 범위)
Batch D: ~265s
Batch E: ~270s
Batch F: ~260s
Batch G: ~280s
```

가장 주목할 점은 **블록 높이가 증가해도 배치 시간이 ~260-280초로 일정하게 유지**된다는 것입니다. 스냅샷 크기가 수십만에서 수백만으로 증가해도 사전 집계 후에는 항상 8행이기 때문에, 크로스 조인 크기에 변화가 없습니다.

#### 개선 비율

| 비교 구간 | 개선 비율 | 비고 |
|---|---|---|
| 초기 구간 기준 | **3.5배** (~900s -> ~265s) | 최적화 직후 구간 |
| 중간 구간 기준 | **4.3배** (~1,120s -> ~260s) | 최적화 전 마지막 배치 |
| 후반 구간 추정 | **7배 이상** | 기존 추세 외삽 기준 |

기존 로직은 스냅샷 크기에 비례하여 O(n)으로 악화되지만, 최적화 후에는 스냅샷 크기와 무관하게 O(1)에 가까운 특성을 보입니다. 블록 높이가 올라갈수록 개선 효과가 더 커지는 구조입니다.

---

### QA 검증

최적화가 수치를 바꾸지 않는다는 것을 검증하는 것이 성능 개선보다 더 중요합니다.

#### 경계 연속성 확인

기존 코드 마지막 블록과 최적화 코드 첫 블록의 경계에서 값의 불연속이 없는지 확인했습니다. 두 블록의 분포 값이 자연스럽게 연결되어 경계 이상 없음을 확인했습니다.

#### 전체 범위 QA

레거시 싱글 프로세스 출력 대비 전수 비교를 수행했습니다.

| 테이블 | 비교 범위 | 결과 |
|---|---|---|
| Table-1 `category_distribution` (값, %, count) | 전체 범위 | **PASS** |
| Table-2 `value_bucket_distribution` (USD) | 전체 범위 | **PASS** |
| Table-3 `spent_output_category_distribution` (값, USD) | 전체 범위 | **PASS** |

frontier 8개 이벤트에서만 mismatch가 나왔는데, 이는 최적화 버그가 아니라 기본 메트릭 프로세스(age 분포)와 분포 집계 프로세스(값 분포)의 실행 타이밍 차이로 인한 데이터 미완성 상태였습니다.

---

### 주의할 점과 적용 조건

이 최적화 패턴을 다른 상황에 적용할 때 확인해야 할 조건들입니다.

#### 사전 집계가 허용되는 조건

핵심 전제는 집계 기준(여기서는 `category`)이 **불변 속성**이어야 한다는 것입니다. 만약 range 분류 기준이 타깃 블록의 가격이나 다른 동적 값에 의존한다면 이 최적화를 적용할 수 없습니다.

이 파이프라인의 경우:
- `category`: 트랜잭션의 수량(value)으로 결정 --> 생성 후 불변
- `value_bucket`: 트랜잭션의 생성 시점 가격(created_price) x 수량으로 결정 --> 생성 후 불변

두 가지 모두 조건을 만족합니다.

#### DECIMAL 정밀도 통일

SUM 집계 전후로 DECIMAL 타입을 통일해야 합니다. 예를 들어 스냅샷이 `DECIMAL(38,8)`이고 delta 이벤트가 `DECIMAL(20,8)`이면 SUM 결과의 정밀도가 달라질 수 있습니다. 스키마 설계 시점에 동일한 DECIMAL 스펙을 사용하는 것이 안전합니다.

#### 스냅샷 경계의 일관성

`event_event_id > base_snapshot`(strict `>`)과 `event_event_id >= base_snapshot`(이상) 중 어떤 것을 사용하는지는 스냅샷이 경계 블록의 이벤트를 포함하는지 여부에 달려 있습니다. 이 결정은 파이프라인 전체에서 일관되어야 하며, 한 곳이라도 불일치하면 경계 블록에서 이중 계산 또는 누락이 발생합니다.

---

### 정리

| 항목 | 내용 |
|---|---|
| **문제** | 스냅샷(~수십만 행) x 타깃 블록(N) 크로스 조인으로 수십억 행 중간 데이터 발생 |
| **인사이트** | `category`/`value_bucket`는 트랜잭션 생성 시점에 결정되는 불변 속성 |
| **해결** | 스냅샷을 range 단위로 사전 집계 (수십만 행 -> 8행) 후 타깃 블록과 조인 |
| **결과** | 3.5~7배 성능 개선, 블록 높이 증가와 무관하게 일정한 배치 시간 |
| **검증** | 레거시 시스템 대비 전수 비교 PASS |

이 최적화의 핵심 교훈은 단순합니다. **크로스 조인 전에 "바뀌지 않는 것"을 찾아 먼저 합산하라.** 불변 속성을 기준으로 사전 집계하면 조인 크기를 카디널리티 수준으로 줄일 수 있고, 데이터가 커질수록 효과도 비례해서 커집니다.

---

### Reference

- [Spark SQL Inline Table (VALUES)](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-inline-table.html) -- VALUES 절 공식 문서
- [Spark SQL Join Hints](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html) -- BROADCAST 등 조인 힌트 공식 문서
- [Delta Lake Selective Overwrite (replaceWhere)](https://docs.delta.io/latest/delta-batch.html#selective-overwrite) -- replaceWhere 공식 문서
