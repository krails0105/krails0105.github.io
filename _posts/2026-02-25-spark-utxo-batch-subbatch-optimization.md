---
title: "[Bitcoin UTXO] Spark Cross-Product Spill 해결 -- Sub-Batch 전략"
date: 2026-02-25
categories:
  - Databricks
tags:
  - spark
  - databricks
  - utxo
  - bitcoin
  - performance
  - pyspark
  - memory-optimization
  - delta-lake
  - replaceWhere
---

## 들어가며

Bitcoin UTXO 메트릭 파이프라인을 Spark/Databricks로 마이그레이션하면서, 블록 높이가 올라갈수록 처리 속도가 급격히 떨어지는 현상을 겪었다. Spark UI를 열어보니 태스크당 **5.5 GiB 메모리 spill + 2 GiB 디스크 spill**이 2,000개 태스크 전체에서 균일하게 발생하고 있었다. Skew(데이터 쏠림)가 아니라 전체적인 볼륨 문제였다.

이 글에서는 원인 분석부터 Sub-Batch 전략으로 해결한 과정까지를 정리한다. 다음 내용을 다룬다.

- Cross-product 폭발의 근본 원인과 진단 방법
- BROADCAST hint를 적용할 수 없었던 이유
- 2-Level Sub-Batch 루프 설계와 adaptive sizing
- Delta Lake `replaceWhere`와 sub-batch 범위 일치의 중요성
- `persist()`/`unpersist()` 사이클 관리와 불필요한 Spark action 제거

### 대상 독자 및 사전 지식

- Spark SQL과 PySpark DataFrame API에 익숙한 데이터 엔지니어
- Delta Lake의 기본 읽기/쓰기 패턴(`mode("overwrite")`, `replaceWhere`)을 알고 있는 사람
- Bitcoin UTXO 도메인 지식은 이 글에서 필요한 만큼 설명한다

---

## 배경: Snapshot + Delta Events 아키텍처

이 파이프라인은 Python(BlockSci + RocksDB)으로 돌던 UTXO 메트릭 계산을 Spark/Databricks로 마이그레이션하는 프로젝트의 일부다. 전체 비트코인 블록(약 88만 개)에 대해 UTXO의 연령대별 분포, 실현 가치(realized cap), SCA(Supply Coin Age) 등 **7개 출력 테이블**을 생성한다.

### Snapshot + Delta Events 패턴이란

UTXO 계산의 핵심 아이디어는 **스냅샷 + 델타 이벤트** 조합이다.

| 테이블 | 역할 | 갱신 주기 |
|---|---|---|
| `utxo_unspent_snapshot` | 10,000 블록 간격으로 저장된 UTXO 잔액 스냅샷 | 10K 블록마다 |
| `utxo_events_block` | 블록별 UTXO 변화량 (delta) | 매 블록 |

특정 블록 N의 UTXO 상태를 구하려면, 가장 가까운 이전 스냅샷에 해당 스냅샷 이후의 delta를 합산하면 된다.

```
블록 N의 UTXO 상태 = snapshot(floor(N, 10K)) + SUM(delta_events[snapshot+1 .. N])
```

이 방식은 전체 UTXO 셋을 매번 재스캔하지 않고 증분 계산을 가능하게 한다. 그러나 **한 번에 처리하는 블록 범위가 클수록 중간 데이터가 폭발적으로 커진다**는 문제가 잠재되어 있었다.

---

## 문제 진단: Cross-Product 폭발

### 원인이 된 SQL

문제의 핵심은 `snapshot_state` CTE였다.

```sql
-- snapshot_state: target_blocks x snapshot rows의 카테시안 곱
WITH snapshot_state AS (
    SELECT t.block_height, s.created_block_height, s.unspent_value, ...
    FROM target_blocks_v t
    JOIN unspent_utxo_snapshot_v s
        ON s.snapshot_block_height = t.base_snapshot
)
```

`target_blocks_v`의 모든 행에서 `t.base_snapshot`이 동일한 값(예: 800,000)을 가진다. JOIN 조건이 equi-join 형태이지만 `base_snapshot` 컬럼의 cardinality가 1이므로, 실질적으로는 **cross join과 동일한 결과**를 만든다.

### 데이터 규모 추정

```
target_blocks: 10,000 rows (10K 블록 배치)
snapshot:      534,000 rows (block 800K 시점의 UTXO 잔액)

cross-product = 10,000 x 534,000 = 5,340,000,000 rows (약 53.4억)
추정 크기: ~457 GiB (중간 데이터)
```

### 블록 높이에 따른 증가 패턴

비트코인 체인이 오래될수록 더 많은 UTXO가 누적되므로, **블록 높이가 올라갈수록 snapshot 행 수가 선형으로 증가**한다. 이에 따라 cross-product 크기도 함께 커진다.

| 블록 범위 | snapshot 행 수 (approx.) | cross-product 크기 | 증상 |
|---|---|---|---|
| 0 ~ 10K | ~수천 | 수천만 | 빠름, spill 없음 |
| 400K ~ 410K | ~200K | ~20억 | 느려지기 시작 |
| 800K ~ 810K | ~534K | ~53.4억 | 태스크당 5.5 GiB spill |

Spark UI에서 확인한 핵심 지표는 **모든 태스크에서 균일한 spill**이었다. Skew라면 일부 태스크만 spill이 심해야 하지만, 전체 2,000개 태스크 모두가 동일한 수준의 spill을 보이고 있었다. 이는 cross-product의 전체 데이터 볼륨 자체가 문제라는 신호다.

---

## 접근 방법: 왜 BROADCAST가 아닌가

### BROADCAST Join의 원리

Spark에서 BROADCAST join은 작은 쪽 테이블을 driver에서 수집한 뒤 모든 executor에 복사(broadcast)해서, shuffle 없이 각 파티션에서 로컬로 join을 수행하는 전략이다.

```sql
-- Spark SQL에서의 BROADCAST hint 사용 예
SELECT /*+ BROADCAST(small_table) */ *
FROM large_table
JOIN small_table ON large_table.key = small_table.key
```

### 적용할 수 없었던 이유

두 가지 제약이 있었다.

**1. LEFT OUTER JOIN에서 broadcast 가능한 위치 제한**

Spark 공식 문서에 따르면, LEFT OUTER JOIN에서 broadcast hash join을 사용하려면 **right-side(작은 쪽)만 broadcast**할 수 있다. 이 파이프라인의 SQL에서 snapshot은 JOIN의 right-side에 위치하지만, 문제는 snapshot이 "작은 쪽"이 아니라 **큰 쪽(534K rows)**이라는 점이다.

```sql
-- 이 경우 BROADCAST(s)를 쓰려면 s가 작아야 의미가 있다
SELECT /*+ BROADCAST(s) */ t.block_height, s.*
FROM target_blocks_v t
LEFT JOIN unspent_utxo_snapshot_v s
    ON s.snapshot_block_height = t.base_snapshot
```

**2. 데이터 크기가 broadcast 한계를 초과**

Spark의 broadcast join에는 실효 한계가 있다.

| 설정 / 한계 | 값 | 비고 |
|---|---|---|
| `autoBroadcastJoinThreshold` 기본값 | 10 MB (OSS Spark) | 이 크기 이하면 AQE가 자동 broadcast |
| Databricks `autoBroadcastJoinThreshold` 기본값 | 30 MB | Databricks Runtime에서 상향 |
| 공식 최대 | 8 GB / 512M records | `spark.sql.broadcastTimeout` 초과 시 실패 |
| 실효 권장 한계 | ~1-2 GB | 네트워크/직렬화 오버헤드 고려 |

534K rows x 여러 컬럼의 snapshot 데이터는 실효 한계를 초과할 가능성이 높다. 무리하게 broadcast하면 driver OOM이나 broadcast timeout 에러로 이어질 수 있다.

결국, **데이터 자체를 줄여서 처리하는** 방향이 올바른 접근이다.

---

## 해법: 2-Level Sub-Batch 전략

### 핵심 아이디어

10K 블록 배치를 더 작은 sub-batch로 쪼개되, **공유 데이터(snapshot, batch_utxo)는 10K 단위로 한 번만 로딩**한다. 변경되는 것은 `target_blocks`의 범위뿐이다.

```
기존 (1-Level):
  [10K 블록 루프]
    snapshot 로딩 + target_blocks 로딩 -> cross-product 10K x 534K = 53.4억

변경 후 (2-Level):
  [10K 블록 루프] (outer)
    snapshot 로딩 (1회) .............. persist()
    batch_utxo 로딩 (1회) ........... persist()
    [2K sub-batch 루프] (inner)
      target_blocks 로딩 (2K만) -> cross-product 2K x 534K = 10.7억 (5배 감소)
      age_agg / spent_age 계산 ..... persist()
      7개 output 테이블 병렬 write
      unpersist(age_agg, spent_age, target_blocks)
    unpersist(batch_utxo, snapshot)
```

총 연산량은 동일하지만, **한 시점에 메모리에 올라가는 peak 데이터가 5분의 1**로 줄어든다.

### Adaptive Sub-Batch Sizing

모든 배치에 고정 2K를 적용하면, 초기 배치(snapshot이 거의 비어 있을 때)에서 불필요한 루프 오버헤드가 발생한다. 그래서 snapshot의 실제 행 수를 카운트한 뒤, 동적으로 sub-batch 크기를 결정했다.

| snapshot rows | sub-batch 크기 | cross-product (최대) | 설명 |
|---|---|---|---|
| < 200K | 10K (분할 없음) | ~20억 | 초기 배치, spill 미발생 구간 |
| 200K ~ 400K | 5K | ~20억 | 중간 단계 |
| >= 400K | 2K | ~10.7억 | 후반부, 최대 압축 |

threshold 기준(200K, 400K)은 클러스터 사양(i3.2xlarge x 50 worker)에서 spill이 발생하지 않는 경험적 수치다. 다른 클러스터 사양을 사용하는 경우 Spark UI의 peak execution memory를 모니터링하며 조정해야 한다.

---

## 구현 상세

### write_table 함수 -- explicit 범위 파라미터 추가

```python
# src/bitcoin_etl_job/bitcoin_utxo_stat_and_age_dist_block_init.ipynb (cell-8)

# === 변경 전 (v1): 클로저로 batch_start/batch_end 캡처 ===
# sub-batch를 적용해도 replaceWhere 범위가 항상 10K 전체를 덮어쓴다
def write_table(table, query, param):
    df = query(*param)
    df.write.format("delta") \
        .option("replaceWhere",
                f"block_height BETWEEN {batch_start} AND {batch_end}") \
        .mode("overwrite") \
        .saveAsTable(table)
    return table

# === 변경 후: start, end를 명시적 파라미터로 전달 ===
# replaceWhere 범위가 sub-batch 단위와 정확히 일치
def write_table(table, query, param, start, end):
    df = query(*param)
    df.write.format("delta") \
        .option("replaceWhere",
                f"block_height BETWEEN {start} AND {end}") \
        .mode("overwrite") \
        .saveAsTable(table)
    return table
```

**왜 이 변경이 중요한가:** Delta Lake의 `replaceWhere`는 조건에 매칭되는 파일을 atomic하게 교체(Delta log에서 remove + add)한다. 범위가 sub-batch 단위와 일치해야 non-overlapping write가 보장된다. 기존 코드는 클로저로 `batch_start`/`batch_end`를 캡처했기 때문에, sub-batch를 도입해도 replaceWhere가 10K 전체 범위를 지정하여 데이터가 유실될 수 있었다.

### 메인 루프 -- 2-Level Sub-Batch 구조

```python
# src/bitcoin_etl_job/bitcoin_utxo_stat_and_age_dist_block_init.ipynb (cell-10)
from concurrent.futures import ThreadPoolExecutor, as_completed

SUB_BATCH_DEFAULT = 2_000

for batch_idx, batch_start in enumerate(batches):
    batch_end = min(batch_start + SNAPSHOT_INTERVAL - 1, max_block)
    base_snapshot_val = -1 if batch_start == 0 else batch_start

    # ── Outer Loop: 공유 데이터를 10K 단위로 한 번만 로딩 ──
    snapshot_df = spark.sql(f"""
        SELECT s.* FROM {unspent_snapshot} s
        WHERE s.snapshot_block_height = {base_snapshot_val}
    """).repartition(PARTITION_NUM)
    snapshot_df.createOrReplaceTempView("unspent_utxo_snapshot_v")
    snapshot_df.persist()                 # DataFrame 기본: MEMORY_AND_DISK_DESER
    snapshot_rows = snapshot_df.count()   # 1회 action으로 adaptive sizing 결정

    batch_utxo_df = get_batch_utxo_events_block(
        base_snapshot=base_snapshot_val, batch_end=batch_end)
    batch_utxo_df = batch_utxo_df.repartition(PARTITION_NUM)
    batch_utxo_df.createOrReplaceTempView("batch_utxo_v")
    batch_utxo_df.persist()

    # ── Adaptive sub-batch size 결정 ──
    if snapshot_rows < 200_000:
        sub_batch_size = SNAPSHOT_INTERVAL   # 분할 없음
    elif snapshot_rows < 400_000:
        sub_batch_size = 5_000
    else:
        sub_batch_size = SUB_BATCH_DEFAULT   # 2K

    # ── Inner Loop: target_blocks만 sub-batch 단위로 교체 ──
    for sub_idx, sub_start in enumerate(
            range(batch_start, batch_end + 1, sub_batch_size)):
        sub_end = min(sub_start + sub_batch_size - 1, batch_end)

        target_blocks_df = get_target_block(
            start_block=sub_start, end_block=sub_end,
            interval=SNAPSHOT_INTERVAL)
        target_blocks_df.createOrReplaceTempView("target_blocks_v")
        target_blocks_df.persist()

        # unspent_age_v, age_agg_v, spent_age_v 계산 (SQL query)
        # ... (생략)
        age_agg_df.persist()
        spent_age_df.persist()

        # 7개 output 테이블 병렬 write (ThreadPoolExecutor)
        _sub_start, _sub_end = sub_start, sub_end  # 루프 변수 캡처 방어
        with ThreadPoolExecutor(max_workers=7) as pool:
            futures = {
                pool.submit(
                    write_table, tbl, q, p, _sub_start, _sub_end
                ): tbl
                for tbl, q, p in tasks
            }
            for f in as_completed(futures):
                f.result()  # 예외 전파

        # sub-batch 단위 캐시 해제
        for df in [age_agg_df, spent_age_df, target_blocks_df]:
            df.unpersist()

    # outer batch 단위 캐시 해제
    for df in [batch_utxo_df, snapshot_df]:
        df.unpersist()
```

코드에서 주목할 포인트를 정리한다.

**persist/unpersist 사이클 관리**: `persist()`로 캐시한 DataFrame은 해당 범위의 처리가 끝나면 반드시 `unpersist()`로 해제해야 한다. 그렇지 않으면 이전 배치의 캐시가 메모리에 남아 다음 배치의 가용 메모리를 줄인다. PySpark에서 DataFrame의 `persist()`는 기본 storage level이 `MEMORY_AND_DISK_DESER`이므로, 메모리가 부족하면 디스크로 spill되지만 여전히 관리 오버헤드가 남는다.

**repartition의 역할**: `snapshot_df`와 `batch_utxo_df`에 `repartition(PARTITION_NUM)`을 적용하는 이유는 다음 단계의 SQL join에서 파티션 수를 제어하기 위함이다. `PARTITION_NUM`은 클러스터 코어 수에 맞춰 설정한다(이 프로젝트에서는 2,000).

### 제거한 코드: log_partitions

v1에서는 각 뷰마다 `log_partitions()`를 호출해 실제 파티션 수를 출력했다.

```python
# v1 -- 각 뷰마다 불필요한 Spark action 발생
def log_partitions(name, df):
    n = df.select(spark_partition_id().alias("pid")).distinct().count()  # action!
    print(f"  {name}: {n} partitions")

log_partitions("target_blocks_v", target_blocks_df)
log_partitions("unspent_snapshot_v", snapshot_df)
```

10K 배치 x sub-batch 5회 x 뷰 3~4개 = 약 **190회의 불필요한 Spark action**이 발생하고 있었다. 매 action마다 Spark job이 트리거되므로, 이 로깅만으로도 상당한 오버헤드가 추가된다. 현재 버전에서는 완전히 제거했다.

> **참고**: 파티션 수를 확인하고 싶다면 `df.rdd.getNumPartitions()`를 사용하면 action 없이 lazy하게 파티션 수를 얻을 수 있다. 다만 이 값은 `repartition()` 호출 시 지정한 파티션 수를 반환할 뿐, 실제 데이터 분포는 반영하지 않는다.

---

## 주의할 점 (Gotchas)

### 1. replaceWhere 범위와 실제 데이터 범위 불일치

Delta Lake의 `replaceWhere`는 조건에 해당하는 기존 파일을 모두 제거하고, 새 데이터로 교체한다. 이 동작에서 중요한 점은 다음과 같다.

```
replaceWhere = "block_height BETWEEN 800000 AND 809999"  (10K 범위)
실제 데이터   = block_height 800000 ~ 801999             (2K sub-batch)
```

이 경우 block_height 802000~809999에 해당하는 기존 파일이 **삭제되고 새 데이터로 대체되지 않는다**. 이전 배치에서 이미 write한 데이터가 사라지는 것이다.

Sub-batch를 적용할 때는 반드시 `replaceWhere` 범위를 sub-batch 단위(2K)로 좁혀야 한다. 이것이 `write_table` 함수에 `start`, `end` 파라미터를 명시적으로 추가한 이유다.

### 2. ThreadPoolExecutor의 루프 변수 캡처

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

### 3. snapshot_rows 카운트 비용 vs 이득

`snapshot_df.count()`는 Spark action이므로 실행 비용이 있다. 그러나 이 1회 카운트로 10K 배치 전체의 sub-batch 전략을 결정하면, 이후 수 회~수십 회의 sub-batch 처리에서 메모리 spill을 방지해 훨씬 큰 이득을 얻는다.

더 나아가, `persist()` 직후에 `count()`를 호출하면 캐시 materialization도 함께 트리거되므로, 단순 카운트 이상의 역할을 한다. `persist()`는 lazy하게 등록만 하고, 이후 첫 action(`count()`)에서 실제 캐시가 생성된다.

### 4. BROADCAST hint의 실제 한계 정리

Spark 공식 문서(Context7 검증)에서 확인한 BROADCAST join 관련 제약을 정리한다.

| 항목 | 내용 |
|---|---|
| **hint 문법** | `/*+ BROADCAST(table) */` 또는 DataFrame `.hint("broadcast")` |
| **LEFT OUTER JOIN** | right-side만 broadcast 가능 |
| **AQE 자동 broadcast** | `autoBroadcastJoinThreshold` 이하일 때만 동작 (OSS: 10 MB, Databricks: 30 MB) |
| **공식 최대** | 8 GB / 512M records |
| **실효 권장 한계** | ~1-2 GB (네트워크 전송 + 직렬화 오버헤드) |
| **초과 시 증상** | `BroadcastTimeout` 예외 또는 driver OOM |

이 파이프라인의 snapshot 데이터(534K rows x 다수 컬럼)는 실효 한계를 초과하므로, BROADCAST보다 배치 분할이 올바른 접근이다.

---

## 결과 요약

| 항목 | 변경 전 (v1) | 변경 후 (v2) |
|---|---|---|
| cross-product peak | 10K x 534K = 53.4억 rows | 2K x 534K = 10.7억 rows |
| 태스크당 memory spill | 5.5 GiB | 해소 |
| 태스크당 disk spill | 2 GiB | 해소 |
| 불필요한 Spark action | ~190회 (`log_partitions`) | 0회 |
| replaceWhere 범위 | 10K (outer batch 고정) | sub-batch 단위 (2K/5K/10K adaptive) |
| 공유 데이터 재로딩 | 매 루프 | outer loop에서 1회 (persist) |

---

## 다음 단계

- **`stat_new.ipynb` (incremental)에 동일 패턴 적용**: Full init은 수정했지만, 운영 cron으로 돌아가는 incremental 노트북에도 `GREATEST` clamp와 함께 sub-batch 패턴 적용 필요
- **Sub-batch 크기 튜닝**: 현재 2K/5K/10K는 i3.2xlarge x 50 기준의 경험적 수치. 다른 클러스터 사양에서는 Spark UI의 **Stages > Task Metrics > Peak Execution Memory** 를 모니터링하며 threshold 조정
- **Process B 구현**: supply/realized 분포 출력 노트북(B-1~B-3)은 아직 미구현 상태. 동일한 sub-batch 패턴을 적용할 예정

---

## 핵심 교훈

1. **Spark UI에서 "균일한 spill"은 skew가 아니라 볼륨 문제다.** 일부 태스크만 느린 것이 skew, 전체가 균일하게 느리면 데이터 자체가 너무 큰 것이다.
2. **equi-join처럼 보여도 cardinality가 1이면 cross join이다.** JOIN 조건의 selectivity를 반드시 확인해야 한다.
3. **BROADCAST는 만능이 아니다.** 데이터 크기, join 유형, 클러스터 사양을 모두 고려해야 한다. 크기가 안 맞으면 데이터를 줄이는 것이 정답이다.
4. **persist/unpersist 사이클 관리는 장시간 배치 작업에서 필수다.** 이전 배치의 캐시를 해제하지 않으면 GC 압박과 eviction이 누적된다.
5. **replaceWhere 범위와 실제 쓰기 범위는 반드시 일치시켜야 한다.** 불일치하면 기존 데이터가 의도치 않게 삭제된다.

---

## 참고 자료

### 프로젝트 파일

- 수정 파일: `src/bitcoin_etl_job/bitcoin_utxo_stat_and_age_dist_block_init.ipynb`
- 백업 (v1): `src/bitcoin_etl_job/bitcoin_utxo_stat_and_age_dist_block_init_v1.ipynb`
- 관련 노트북: `src/bitcoin_etl_job/bitcoin_utxo_insert_template.ipynb` (7개 output 함수 라이브러리)
- 설계 문서: `docs/spark/` (전체 파이프라인 설계)

### 공식 문서

- [Delta Lake - Selective overwrite with replaceWhere](https://docs.delta.io/latest/delta-batch.html#selective-overwrite)
- [Spark SQL - Join Hints (BROADCAST, SHUFFLE_HASH, etc.)](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html)
- [Spark - RDD Persistence and Storage Levels](https://spark.apache.org/docs/latest/rdd-programming-guide.html#rdd-persistence)
- [Spark - Performance Tuning (autoBroadcastJoinThreshold)](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
