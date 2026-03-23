---
title: "[Spark] Spark Cross-Product Spill 해결 -- Sub-Batch 전략"
date: 2026-02-25
categories:
  - Spark
tags:
  - Spark
  - Databricks
  - PySpark
  - Delta Lake
  - replaceWhere
---

### 들어가며

트랜잭션 메트릭 파이프라인을 Spark/Databricks로 마이그레이션하면서, 블록 높이가 올라갈수록 처리 속도가 급격히 떨어지는 현상을 겪었다. Spark UI를 열어보니 태스크당 **수 GiB의 메모리 spill + 디스크 spill**이 수천 개 태스크 전체에서 균일하게 발생하고 있었다. Skew(데이터 쏠림)가 아니라 전체적인 볼륨 문제였다.

이 글에서는 원인 분석부터 Sub-Batch 전략으로 해결한 과정까지를 정리한다. 다음 내용을 다룬다.

- Cross-product 폭발의 근본 원인과 진단 방법
- BROADCAST hint를 적용할 수 없었던 이유
- 2-Level Sub-Batch 루프 설계와 adaptive sizing
- Delta Lake `replaceWhere`와 sub-batch 범위 일치의 중요성
- `persist()`/`unpersist()` 사이클 관리와 불필요한 Spark action 제거

#### 대상 독자 및 사전 지식

- Spark SQL과 PySpark DataFrame API에 익숙한 데이터 엔지니어
- Delta Lake의 기본 읽기/쓰기 패턴(`mode("overwrite")`, `replaceWhere`)을 알고 있는 사람
- 트랜잭션 메트릭 도메인 지식은 이 글에서 필요한 만큼 설명한다

---

### 배경: Snapshot + Delta Events 아키텍처

이 파이프라인은 레거시 싱글 프로세스로 돌던 트랜잭션 메트릭 계산을 Spark/Databricks로 마이그레이션하는 프로젝트의 일부다. 전체 데이터셋(약 수십만 이벤트)에 대해 트랜잭션의 연령대별 분포, 집계 메트릭, 가중 수명 지표 등 **7개 출력 테이블**을 생성한다.

#### Snapshot + Delta Events 패턴이란

트랜잭션 메트릭 계산의 핵심 아이디어는 **스냅샷 + 델타 이벤트** 조합이다.

| 테이블 | 역할 | 갱신 주기 |
|---|---|---|
| `state_snapshot` | 10,000 이벤트 간격으로 저장된 상태 스냅샷 | 10K 이벤트마다 |
| `events_block` | 이벤트별 트랜잭션 변화량 (delta) | 매 이벤트 |

특정 블록 N의 엔티티 상태를 구하려면, 가장 가까운 이전 스냅샷에 해당 스냅샷 이후의 delta를 합산하면 된다.

```
블록 N의 엔티티 상태 = snapshot(floor(N, 10K)) + SUM(delta_events[snapshot+1 .. N])
```

이 방식은 전체 트랜잭션 셋을 매번 재스캔하지 않고 증분 계산을 가능하게 한다. 그러나 **한 번에 처리하는 블록 범위가 클수록 중간 데이터가 폭발적으로 커진다**는 문제가 잠재되어 있었다.

---

### 문제 진단: Cross-Product 폭발

#### 원인이 된 SQL

문제의 핵심은 `snapshot_state` CTE였다.

```sql
-- snapshot_state: target_blocks x snapshot rows의 카테시안 곱
WITH snapshot_state AS (
    SELECT t.event_id, s.created_event_id, s.state_value, ...
    FROM target_blocks_v t
    JOIN snapshot_v s
        ON s.snapshot_event_id = t.base_snapshot
)
```

`target_blocks_v`의 모든 행에서 `t.base_snapshot`이 동일한 값(예: N)을 가진다. JOIN 조건이 equi-join 형태이지만 `base_snapshot` 컬럼의 cardinality가 1이므로, 실질적으로는 **cross join과 동일한 결과**를 만든다.

#### 데이터 규모 추정

```
target_blocks: 10,000 rows (10K 블록 배치)
snapshot:      수십만 rows (특정 시점의 트랜잭션 잔액)

cross-product = 10,000 x 수십만 = 수십억 rows
추정 크기: 수백 GiB (중간 데이터)
```

#### 블록 높이에 따른 증가 패턴

데이터가 오래될수록 더 많은 트랜잭션이 누적되므로, **이벤트 ID가 올라갈수록 snapshot 행 수가 선형으로 증가**한다. 이에 따라 cross-product 크기도 함께 커진다.

| 블록 범위 | snapshot 행 수 (approx.) | cross-product 크기 | 증상 |
|---|---|---|---|
| 0 ~ 10K | ~수천 | 수천만 | 빠름, spill 없음 |
| 400K ~ 410K | ~200K | ~20억 | 느려지기 시작 |
| 후반 구간 | ~수십만 | ~수십억 | 태스크당 수 GiB spill |

Spark UI에서 확인한 핵심 지표는 **모든 태스크에서 균일한 spill**이었다. Skew라면 일부 태스크만 spill이 심해야 하지만, 전체 수천 개 태스크 모두가 동일한 수준의 spill을 보이고 있었다. 이는 cross-product의 전체 데이터 볼륨 자체가 문제라는 신호다.

---

### 접근 방법: 왜 BROADCAST가 아닌가

#### BROADCAST Join의 원리

Spark에서 BROADCAST join은 작은 쪽 테이블을 driver에서 수집한 뒤 모든 executor에 복사(broadcast)해서, shuffle 없이 각 파티션에서 로컬로 join을 수행하는 전략이다.

```sql
-- Spark SQL에서의 BROADCAST hint 사용 예
SELECT /*+ BROADCAST(small_table) */ *
FROM large_table
JOIN small_table ON large_table.key = small_table.key
```

#### 적용할 수 없었던 이유

두 가지 제약이 있었다.

**1. LEFT OUTER JOIN에서 broadcast 가능한 위치 제한**

Spark 공식 문서에 따르면, LEFT OUTER JOIN에서 broadcast hash join을 사용하려면 **right-side(작은 쪽)만 broadcast**할 수 있다. 이 파이프라인의 SQL에서 snapshot은 JOIN의 right-side에 위치하지만, 문제는 snapshot이 "작은 쪽"이 아니라 **큰 쪽(수십만 rows)**이라는 점이다.

```sql
-- 이 경우 BROADCAST(s)를 쓰려면 s가 작아야 의미가 있다
SELECT /*+ BROADCAST(s) */ t.event_id, s.*
FROM target_blocks_v t
LEFT JOIN snapshot_v s
    ON s.snapshot_event_id = t.base_snapshot
```

**2. 데이터 크기가 broadcast 한계를 초과**

Spark의 broadcast join에는 실효 한계가 있다.

| 설정 / 한계 | 값 | 비고 |
|---|---|---|
| `autoBroadcastJoinThreshold` 기본값 | 10 MB (OSS Spark) | 이 크기 이하면 AQE가 자동 broadcast |
| Databricks `autoBroadcastJoinThreshold` 기본값 | 30 MB | Databricks Runtime에서 상향 |
| 공식 최대 | 8 GB / 512M records | `spark.sql.broadcastTimeout` 초과 시 실패 |
| 실효 권장 한계 | ~1-2 GB | 네트워크/직렬화 오버헤드 고려 |

수십만 rows x 여러 컬럼의 snapshot 데이터는 실효 한계를 초과할 가능성이 높다. 무리하게 broadcast하면 driver OOM이나 broadcast timeout 에러로 이어질 수 있다.

결국, **데이터 자체를 줄여서 처리하는** 방향이 올바른 접근이다.

---

### 해법: 2-Level Sub-Batch 전략

#### 핵심 아이디어

10K 블록 배치를 더 작은 sub-batch로 쪼개되, **공유 데이터(snapshot, batch_events)는 10K 단위로 한 번만 로딩**한다. 변경되는 것은 `target_blocks`의 범위뿐이다.

```
기존 (1-Level):
  [10K 블록 루프]
    snapshot 로딩 + target_blocks 로딩 -> cross-product 10K x 수십만 = 수십억

변경 후 (2-Level):
  [10K 블록 루프] (outer)
    snapshot 로딩 (1회) .............. persist()
    batch_events 로딩 (1회) ........... persist()
    [2K sub-batch 루프] (inner)
      target_blocks 로딩 (2K만) -> cross-product 2K x 수십만 = 수억 (5배 감소)
      age_agg / spent_age 계산 ..... persist()
      7개 output 테이블 병렬 write
      unpersist(age_agg, spent_age, target_blocks)
    unpersist(batch_events, snapshot)
```

총 연산량은 동일하지만, **한 시점에 메모리에 올라가는 peak 데이터가 5분의 1**로 줄어든다.

#### Adaptive Sub-Batch Sizing

모든 배치에 고정 2K를 적용하면, 초기 배치(snapshot이 거의 비어 있을 때)에서 불필요한 루프 오버헤드가 발생한다. 그래서 snapshot의 실제 행 수를 카운트한 뒤, 동적으로 sub-batch 크기를 결정했다.

| snapshot rows | sub-batch 크기 | cross-product (최대) | 설명 |
|---|---|---|---|
| < 200K | 10K (분할 없음) | ~20억 | 초기 배치, spill 미발생 구간 |
| 200K ~ 400K | 5K | ~20억 | 중간 단계 |
| >= 400K | 2K | ~수억 | 후반부, 최대 압축 |

threshold 기준(200K, 400K)은 50노드 클러스터 환경에서 spill이 발생하지 않는 경험적 수치다. 다른 클러스터 사양을 사용하는 경우 Spark UI의 peak execution memory를 모니터링하며 조정해야 한다.

---

### 구현 핵심

#### replaceWhere 범위는 sub-batch와 정확히 일치해야 한다

Delta Lake의 `replaceWhere`는 조건에 매칭되는 파일을 atomic하게 교체한다. sub-batch를 도입하면 **replaceWhere 범위도 sub-batch 단위로 좁혀야** 한다. 전체 배치 범위를 지정하면 sub-batch에 포함되지 않은 기존 데이터가 삭제된다.

#### 2-Level Sub-Batch 루프 구조 (의사코드)

```
for each outer_batch (10K 단위):
    # 공유 데이터 1회 로딩 + persist
    snapshot = load_snapshot(base).persist()
    events   = load_events(range).persist()

    # adaptive sub-batch size 결정
    sub_size = adaptive_size(snapshot.count())

    for each sub_batch (sub_size 단위):
        target = load_target_blocks(sub_range).persist()
        results = compute(snapshot, events, target)

        # 병렬 write (ThreadPoolExecutor)
        parallel_write(results, sub_range)

        target.unpersist()  # sub-batch 캐시 해제

    snapshot.unpersist()    # outer batch 캐시 해제
    events.unpersist()
```

#### 핵심 패턴 3가지

**1. persist/unpersist 사이클**: outer loop의 공유 데이터는 1회만 로딩하고, inner loop의 타깃 데이터는 매번 교체한다. 해제하지 않으면 이전 배치 캐시가 메모리를 점유하여 GC 압박이 누적된다.

**2. Adaptive sizing**: `snapshot.count()` 1회 호출로 데이터 규모를 파악하고, 규모에 따라 sub-batch 크기를 조정한다. `persist()` 직후 `count()`를 호출하면 캐시 materialization도 함께 트리거되므로 일석이조다.

**3. 불필요한 Spark action 제거**: 디버깅용 `distinct().count()` 같은 action이 매 sub-batch마다 반복되면 수백 회의 불필요한 Spark job이 발생한다. 파티션 수만 확인하고 싶다면 action 없이 `df.rdd.getNumPartitions()`를 사용한다.

---

### 주의할 점 (Gotchas)

#### 1. replaceWhere 범위와 실제 데이터 범위 불일치

Delta Lake의 `replaceWhere`는 조건에 해당하는 기존 파일을 모두 제거하고, 새 데이터로 교체한다. 이 동작에서 중요한 점은 다음과 같다.

```
replaceWhere = "event_id BETWEEN 800000 AND 809999"  (10K 범위)
실제 데이터   = event_id 800000 ~ 801999             (2K sub-batch)
```

이 경우 event_id 802000~809999에 해당하는 기존 파일이 **삭제되고 새 데이터로 대체되지 않는다**. 이전 배치에서 이미 write한 데이터가 사라지는 것이다.

Sub-batch를 적용할 때는 반드시 `replaceWhere` 범위를 sub-batch 단위(2K)로 좁혀야 한다. 이것이 `write_table` 함수에 `start`, `end` 파라미터를 명시적으로 추가한 이유다.

#### 2. ThreadPoolExecutor의 루프 변수 캡처

Python의 `ThreadPoolExecutor`에서 클로저를 쓸 때 루프 변수가 의도치 않게 마지막 값으로 캡처될 수 있다.

```python
# 잠재적 위험: sub_start가 루프 끝 값으로 캡처될 가능성
futures = {
    pool.submit(write_table, tbl, q, p, sub_start, sub_end): tbl
    for tbl, q, p in tasks
}

# 방어적 처리: 현재 값을 명시적으로 바인딩
_sub_start, _sub_end = sub_start, sub_end
futures = {
    pool.submit(write_table, tbl, q, p, _sub_start, _sub_end): tbl
    for tbl, q, p in tasks
}
```

이 경우 `submit()`에 인자가 **값으로** 바로 전달되므로 실제로 문제가 발생하지 않을 가능성이 높다(클로저가 아니라 함수 인자 바인딩이기 때문). 그러나 나중에 lambda로 리팩토링하거나 `partial`을 사용할 때 함정에 빠지기 쉽기 때문에, 방어적으로 스냅샷 변수를 만드는 습관이 권장된다.

#### 3. snapshot_rows 카운트 비용 vs 이득

`snapshot_df.count()`는 Spark action이므로 실행 비용이 있다. 그러나 이 1회 카운트로 10K 배치 전체의 sub-batch 전략을 결정하면, 이후 수 회~수십 회의 sub-batch 처리에서 메모리 spill을 방지해 훨씬 큰 이득을 얻는다.

더 나아가, `persist()` 직후에 `count()`를 호출하면 캐시 materialization도 함께 트리거되므로, 단순 카운트 이상의 역할을 한다. `persist()`는 lazy하게 등록만 하고, 이후 첫 action(`count()`)에서 실제 캐시가 생성된다.

#### 4. BROADCAST hint의 실제 한계 정리

Spark 공식 문서(Context7 검증)에서 확인한 BROADCAST join 관련 제약을 정리한다.

| 항목 | 내용 |
|---|---|
| **hint 문법** | `/*+ BROADCAST(table) */` 또는 DataFrame `.hint("broadcast")` |
| **LEFT OUTER JOIN** | right-side만 broadcast 가능 |
| **AQE 자동 broadcast** | `autoBroadcastJoinThreshold` 이하일 때만 동작 (OSS: 10 MB, Databricks: 30 MB) |
| **공식 최대** | 8 GB / 512M records |
| **실효 권장 한계** | ~1-2 GB (네트워크 전송 + 직렬화 오버헤드) |
| **초과 시 증상** | `BroadcastTimeout` 예외 또는 driver OOM |

이 파이프라인의 snapshot 데이터(수십만 rows x 다수 컬럼)는 실효 한계를 초과하므로, BROADCAST보다 배치 분할이 올바른 접근이다.

---

### 결과 요약

| 항목 | 변경 전 (v1) | 변경 후 (v2) |
|---|---|---|
| cross-product 규모 | 전체 배치 × 스냅샷 (수십억 rows) | sub-batch × 스냅샷 (5배 축소) |
| 태스크당 memory spill | 수 GiB | 해소 |
| 태스크당 disk spill | 수 GiB | 해소 |
| 불필요한 Spark action | 수백 회 | 0회 |
| replaceWhere 범위 | outer batch 전체 (고정) | sub-batch 단위 (adaptive) |
| 공유 데이터 재로딩 | 매 루프 | outer loop에서 1회 (persist) |

---

---

### 핵심 교훈

1. **Spark UI에서 "균일한 spill"은 skew가 아니라 볼륨 문제다.** 일부 태스크만 느린 것이 skew, 전체가 균일하게 느리면 데이터 자체가 너무 큰 것이다.
2. **equi-join처럼 보여도 cardinality가 1이면 cross join이다.** JOIN 조건의 selectivity를 반드시 확인해야 한다.
3. **BROADCAST는 만능이 아니다.** 데이터 크기, join 유형, 클러스터 사양을 모두 고려해야 한다. 크기가 안 맞으면 데이터를 줄이는 것이 정답이다.
4. **persist/unpersist 사이클 관리는 장시간 배치 작업에서 필수다.** 이전 배치의 캐시를 해제하지 않으면 GC 압박과 eviction이 누적된다.
5. **replaceWhere 범위와 실제 쓰기 범위는 반드시 일치시켜야 한다.** 불일치하면 기존 데이터가 의도치 않게 삭제된다.

---

### 참고 자료

- [Delta Lake - Selective overwrite with replaceWhere](https://docs.delta.io/latest/delta-batch.html#selective-overwrite)
- [Spark SQL - Join Hints (BROADCAST, SHUFFLE_HASH, etc.)](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html)
- [Spark - RDD Persistence and Storage Levels](https://spark.apache.org/docs/latest/rdd-programming-guide.html#rdd-persistence)
- [Spark - Performance Tuning (autoBroadcastJoinThreshold)](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
