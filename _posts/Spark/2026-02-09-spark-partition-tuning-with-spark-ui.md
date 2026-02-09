---
title: "[Spark] Spark UI 기반 파티션 튜닝 - CPU 미사용, Executor 사망, 스큐 해결"
categories:
  - Spark
tags:
  - [Spark, Partition, Tuning, SparkUI, Skew, Spill, AQE, Performance, Databricks]
---

# Introduction

---

Spark 클러스터의 CPU 사용률이 10% 미만인데 작업이 느리다면, 노드를 더 추가하는 건 답이 아닙니다.

이 글은 실제 UTXO 메트릭 계산 프로젝트에서 겪은 사례를 바탕으로, **Spark UI의 Executor/Stage/Task 탭을 읽고 파티션 문제를 진단하고 해결하는 과정**을 정리합니다.

# 1. 증상: CPU 10% 미만, Executor 대량 사망

---

## 클러스터 구성

```text
인스턴스: i3.xlarge (또는 i3.2xlarge) × 20대
코어: 8 per executor × 18 active = 136 cores
메모리: 23.1 GiB per executor
스토리지: NVMe SSD (DISK_ONLY 캐시용)
```

## Spark UI - Executors 탭에서 본 것

```text
Active executors:  18
Dead executors:    99  ← 85% 사망률!
Total cores:       136 (active)
```

- Executor가 끊임없이 생성/소멸 (ID가 165까지 증가)
- 일부 executor는 생성 2분 만에 task 0개 처리 후 사망
- **특정 executor의 Shuffle Write가 비정상적으로 큼** (33 GiB vs 나머지 100~250 MiB)

# 2. 원인 분석: Stage/Task 탭 읽기

---

## Stage 탭에서 병목 찾기

Spark UI의 **Stages 탭**에서 Duration이 긴 stage를 찾습니다:

```text
Stage 7354: Duration 33 min, Tasks 4/4,   Shuffle Write 20.2 GiB
Stage 7350: Duration 27 min, Tasks 15/15,  Shuffle Write 32.7 GiB
```

**136코어인데 task가 4개.** 이게 CPU 10%의 원인입니다.

## Task 탭에서 스큐 확인

Stage 7354의 Task 상세:

| Task | Input Records | Shuffle Write | Spill (Memory) | Duration |
|------|--------------|---------------|----------------|----------|
| 0 | 212 | 9.3 GiB (1.06B rows) | **94.4 GiB** | 33 min |
| 1 | 6 | 3.7 GiB (496M rows) | 38 GiB | 14 min |
| 2 | 1 | 0 | 0 | 0.7 s |
| 3 | 70 | 7.2 GiB (963M rows) | **85.5 GiB** | 32 min |

핵심 관찰:

1. **289 input records → 2.5B output records**: RANGE_JOIN으로 인한 레코드 폭발 (target_blocks 55K bins과 매칭)
2. **단일 task에서 94 GiB 메모리 스필**: Executor 메모리(23 GiB)의 4배. 디스크 I/O 폭탄
3. **Task 2는 0.7초에 끝나는데 Task 0은 33분**: 극심한 스큐

## 진단 흐름: "파일 수 문제"라고 어떻게 알았나?

이 문제를 진단한 사고 과정을 단계별로 정리합니다.

### Step 1: Executors 탭 — "CPU가 낮다"

```text
Active: 18 executors (136 cores)
CPU 사용률: < 10%
```

첫 번째 의문: 136코어가 있는데 왜 10%만 쓰나?

**가능한 원인 3가지:**
- (A) I/O bound — 디스크/네트워크 대기
- (B) 메모리 부족 — GC에 시간 소모
- (C) **task 수 부족 — 코어는 있는데 할 일이 없음**

GC Time은 29분 / 20.8시간 = 1.4%로 정상 → (B) 제외.
이제 (A)와 (C)를 구분해야 합니다.

### Step 2: Stages 탭 — "task가 몇 개인지 확인"

Duration이 가장 긴 stage를 클릭합니다:

```text
Stage 7354: Tasks 4/4, Duration 33 min
```

**136코어인데 task 4개 = 코어 활용률 3%.** (C)가 확정됩니다.

> **핵심 판단 기준**: `Tasks 수 << 총 코어 수`이면 파티션/파일 수 문제입니다.
> I/O bound라면 task 수는 충분한데 각 task의 I/O wait이 길어지는 패턴으로 나타납니다.

### Step 3: Tasks 탭 — "Input 컬럼으로 소스 파악"

Task 상세에서 **Input Size / Records**를 봅니다:

```text
Task 0: Input 91.5 MiB / 212 records, Shuffle Read 364.3 KiB / 55,000 records
Task 1: Input 2.4 MiB / 6 records,    Shuffle Read 364.3 KiB / 55,000 records
Task 2: Input 262.1 KiB / 1 record,   Shuffle Read 364.3 KiB / 55,000 records
Task 3: Input 27.5 MiB / 70 records,  Shuffle Read 364.3 KiB / 55,000 records
```

**읽는 법:**
- **Input**: 디스크(Parquet/Delta)에서 직접 스캔한 데이터 = **probe side** (이 stage의 소스 테이블)
- **Shuffle Read**: 다른 stage에서 셔플로 받은 데이터 = **broadcast side** (여기선 target_blocks_v의 RANGE_JOIN bins)

Input이 4개 task에 걸쳐 289 records뿐 → **이 소스 테이블의 Parquet 파일이 4개**라는 뜻입니다.

### Step 4: 어떤 테이블이 4개 파일인지 특정

쿼리 플랜(Physical Plan)에서 이 stage가 스캔하는 테이블을 확인합니다:

```text
(11) Scan parquet tech_lakehouse_prod.bitcoin.unspent_utxo_snapshot
     PushedFilters: [IsNotNull(snapshot_block_height), ...]
```

그리고 Delta 테이블의 파일 수를 확인:

```sql
DESCRIBE DETAIL tech_lakehouse_prod.bitcoin.unspent_utxo_snapshot;
-- numFiles: 15
```

15개 파일 중 `snapshot_block_height = 220000` 필터에 매칭되는 파일이 **4개뿐**.
Delta의 data skipping(min/max 통계)이 나머지 11개를 건너뛰었습니다.

### Step 5: 연결 — 파일 수 → task 수 → 코어 미활용

```text
Delta 테이블 15 files
    → snapshot_block_height 필터 → data skipping → 4 files
    → Spark scan: 파일당 1 task → 4 tasks
    → 136코어 중 4개만 사용 → CPU 3%
    → 4 task에 전체 데이터 집중 → task당 94 GiB 스필
    → executor OOM → 사망
```

**이 체인을 역추적하면**: CPU 낮음 ← task 부족 ← 파일 수 적음 ← 필터 후 data skipping.

### 진단 요약 플로우차트

```text
CPU < 10%
  │
  ├─ GC Time > 10%? ──→ Yes: 메모리 문제 (executor 메모리 늘리기)
  │
  └─ No
      │
      ├─ 병목 Stage의 task 수 확인
      │
      ├─ task 수 >= 코어 수? ──→ Yes: I/O bound (디스크/네트워크)
      │                              → 인스턴스 타입 변경 (NVMe, 네트워크 대역폭)
      │
      └─ task 수 << 코어 수? ──→ Yes: 파티션/파일 수 문제 ★
           │
           ├─ Stages > Tasks > Input 컬럼 확인
           ├─ Physical Plan에서 스캔 테이블 특정
           ├─ DESCRIBE DETAIL로 파일 수 확인
           └─ 해결: repartition(N) — 조인 패턴에 따라 키 유무 결정
```

## 왜 task가 4개뿐인가? — 기술적 원인

Spark의 scan task 수 = **소스 데이터의 파일(파티션) 수**

```text
utxo_events_block:      386 files
unspent_utxo_snapshot:   15 files
```

`unspent_utxo_snapshot`에서 `snapshot_block_height = 220000` 필터 적용 시, CLUSTER BY (또는 Liquid Clustering)로 인해 **실제 데이터가 들어있는 파일이 4개뿐**. 나머지 11개 파일은 data skipping으로 건너뜀.

```text
15 files → filter → 4 files touched → 4 scan tasks → 4/136 cores used = 3% CPU
```

> **AQE auto (`spark.sql.shuffle.partitions = auto`)는 셔플 '이후' 파티션만 자동 조정합니다.
> 소스 스캔의 task 수는 조정하지 않습니다.**

# 3. AQE가 해결하는 것과 안 하는 것

---

## AQE의 4가지 자동 최적화 (Databricks docs)

| 기능 | 설명 | 스캔 task 수 조정? |
|------|------|:---:|
| Sort Merge → Broadcast 전환 | 런타임에 작은 테이블 감지 시 broadcast로 변경 | X |
| 파티션 자동 병합 (coalesce) | 셔플 후 작은 파티션을 `advisoryPartitionSizeInBytes`(기본 64MB) 기준으로 병합 | X |
| Skew Join 처리 | SortMergeJoin의 편향된 파티션을 분할 | X |
| Empty Relation 전파 | 빈 결과 감지 시 불필요한 연산 제거 | X |

**모두 셔플 이후 단계에서 동작합니다.** 소스 Parquet/Delta 스캔의 task 수(= 파일 수)는 AQE 관할 밖입니다.

## AQE 관련 주요 설정

```sql
-- 이미 기본 활성화
SET spark.sql.shuffle.partitions = auto;           -- Databricks Runtime 기본값. 표준 Spark 기본값은 200
SET spark.sql.adaptive.coalescePartitions.enabled = true;
SET spark.sql.adaptive.advisoryPartitionSizeInBytes = 64MB;
SET spark.sql.adaptive.coalescePartitions.initialPartitionNum = <2 × total cores>;  -- 미설정 시 shuffle.partitions 값 사용
SET spark.sql.adaptive.skewJoin.enabled = true;
```

# 4. 해결: 필터 후 repartition

---

## 핵심 원칙

```text
소스 파일 수가 적으면 → 필터 후 repartition으로 task 수를 늘린다
```

## 실제 파티션 수 확인 (검증 결과)

`repartition` 적용 전, 실제 파티션 수를 먼저 확인했습니다:

```text
target_blocks_v: 59 partitions
batch_utxo_v:     4 partitions  ← 문제의 원인
```

`batch_utxo_v`가 4 파티션 — Stage에서 본 4 tasks와 정확히 일치합니다.

## 적용 예시

```python
# Before: 4 tasks (4 files after data skipping)
snapshot_df = spark.sql(f"""
    SELECT * FROM unspent_utxo_snapshot
    WHERE snapshot_block_height = {base_snapshot}
""")
# log_partitions("snapshot", snapshot_df) → 4 partitions ← 이게 문제

# After: 200 tasks (round robin)
snapshot_df = spark.sql(f"""
    SELECT * FROM unspent_utxo_snapshot
    WHERE snapshot_block_height = {base_snapshot}
""").repartition(200)
snapshot_df.createOrReplaceTempView("unspent_utxo_snapshot_v")
snapshot_df.persist()
```

```python
# batch_utxo_v도 동일하게
batch_utxo_df = get_batch_utxo_events_block(base, end) \
    .repartition(200)
batch_utxo_df.createOrReplaceTempView("batch_utxo_v")
batch_utxo_df.persist()
```

## 실측 결과 (20 nodes, repartition(200))

Before: repartition 미적용 시 with_age_v의 action이 **1시간 이상 경과해도 완료되지 않음**.
20개 노드를 띄워놔도 4개 task만 실행되어 **대부분의 노드가 유휴 상태** — 비용만 발생하고 성능 개선 없음.
After: repartition(200) 적용 후 첫 배치 전체 결과:

```text
target_blocks_v: 59 partitions   (0.3s)
unspent_snapshot_v:              (0.4s)
batch_utxo_v: 200 partitions     (1.0s)
with_age_v: 280 partitions       (762.9s ≈ 12.7분)  ← 병목
age_agg_v: 320 partitions        (59.4s)
spent_age_v:                     (0.2s)
A-1 block_metrics:               (109.9s ≈ 1.8분)
A-2 age_dist:                    (295.2s ≈ 4.9분)   ← 두 번째 병목
A-3 realized_age_dist:           (17.0s)
A-4 count_age_dist:              (6.0s)
A-5 spent_output_age:            (7.7s)
A-6 realized_price_age:          (4.7s)
A-7 sca_age_dist:                (5.1s)
──────────────────────────────────────────────
[ProcessA] 1/72  batch 1273s (21.2분)  ETA 1505.9분 (≈25시간)
```

| 항목 | Before (4 partitions) | After (200 partitions) |
|------|:---:|:---:|
| 코어 활용률 | 3% (4/136) | 100%+ (200/136) |
| Task당 스필 | 94 GiB | ~1.9 GiB |
| Executor 사망 | 빈번 (OOM 위험) | 안정 |
| with_age_v | **1시간+ (미완료)** | **12.7분** |
| 배치당 시간 | 측정 불가 (미완료) | 21.2분 |
| 전체 ETA (72 batches) | - | ~25시간 |

> `with_age_v`의 280 파티션과 `age_agg_v`의 320 파티션은 AQE가 셔플 이후 자동 결정한 값입니다.

## 최종 실측 결과 (50 nodes, repartition(800))

i3.2xlarge × 50으로 스케일업 + repartition(800) 적용 후:

| 항목 | Before (repartition 없음) | After (repartition 800) |
|------|:---:|:---:|
| 인스턴스 | i3.2xlarge × 30 | i3.2xlarge × 50 |
| 220K blocks | **18시간** | - |
| 190K blocks | - | **1시간 11분** |
| 처리 속도 | 12.2K blocks/hour | 160K blocks/hour |

```text
처리 속도 향상: ~13x
노드 수 증가분 보정 (50/30 = 1.67x): 노드당 효율 ~8x 향상
```

노드를 1.67배 늘렸지만 속도는 13배 빨라짐 — **비용 대비 효율이 8배 개선**된 셈입니다.
repartition 없이 노드만 늘렸다면 여전히 4개 task에 몰리며 나머지 노드는 유휴 상태였을 것입니다.

## repartition 키 선택: Round Robin vs Hash

일반적인 SortMergeJoin 시나리오에서는 조인 키로 repartition하면 co-partitioning 효과로 이후 셔플을 생략할 수 있습니다. 하지만 **RANGE_JOIN + BROADCAST 패턴**에서는 다릅니다.

### 이 프로젝트의 조인 구조

```text
batch_utxo_v (probe side, 대형)
  RANGE_JOIN
target_blocks_v (build side, BROADCAST)
```

`target_blocks_v`는 **BROADCAST**됩니다. 즉, 모든 executor에 전체 복사본이 전달되므로 probe side의 파티셔닝 키가 무엇이든 **셔플이 발생하지 않습니다**.

### Round Robin이 더 나은 이유

```python
# ✅ 권장: 키 없이 repartition (Round Robin)
df.repartition(200)
```

Round Robin은 행을 순서대로 0, 1, 2, ..., 199, 0, 1, ... 식으로 **순환 배분**합니다.
결과: **모든 파티션이 정확히 동일한 크기**.

```python
# ⚠️ 비권장 (이 패턴에서): 키로 repartition (Hash)
df.repartition(200, "created_block_height")
```

Hash 파티셔닝은 `hash(created_block_height) % 200`으로 파티션을 결정합니다.
특정 `created_block_height` 값에 데이터가 편중되면 **파티션 간 크기 불균형(스큐)** 발생.

### 판단 기준 정리

| 조건 | 추천 방식 | 이유 |
|------|----------|------|
| 이후 SortMergeJoin 예정 | `repartition(N, "join_key")` | co-partitioning으로 셔플 제거 |
| 이후 BroadcastJoin/RANGE_JOIN | `repartition(N)` | 셔플 없으므로 키 무관, 균등 분배가 유리 |
| 키 값 분포가 편중 | `repartition(N)` | Hash 스큐 방지 |
| 키 값 분포가 균일 | 둘 다 OK | 차이 미미 |

이 프로젝트에서는 RANGE_JOIN + BROADCAST 패턴이므로 **키 없는 `repartition(N)`** 이 최적입니다.

## 함정: 모든 소스 테이블을 점검하라

`batch_utxo_v`를 repartition(200)으로 수정 후 재실행했지만, **with_age_v 단계에서 다시 스큐가 발생**했습니다.

```text
Stage Tasks: 15/15 (14 completed, 1 RUNNING)

Task 5 (RUNNING):  Shuffle Write 16.8 GiB / 1,026,361,389 rows  ← 혼자 10억 행
Task 0 (SUCCESS):  Duration 0.6 s
Task 6 (SUCCESS):  Duration 3 s
...나머지 13개: 0.5~3초에 완료
```

with_age_v는 두 테이블을 조인합니다:
- `batch_utxo_v` — repartition(200) 적용 완료 ✅
- `unspent_utxo_snapshot` — **repartition 미적용** ❌ ← 15 files, 1 file에 집중

**원인**: `unspent_utxo_snapshot`은 `CLUSTER BY (snapshot_block_height, created_block_height)`로 저장되어 있어, 특정 `snapshot_block_height` 필터 시 소수 파일만 히트. 그 파일 간에도 데이터 분포가 불균등.

### 해결: snapshot도 repartition

```python
# target_blocks_v에서 필요한 snapshot만 동적 필터링 + repartition
snapshot_df = spark.sql("""
    SELECT s.*
    FROM unspent_utxo_snapshot s
    WHERE s.snapshot_block_height IN (
        SELECT DISTINCT base_snapshot FROM target_blocks_v
    )
""").repartition(800)
snapshot_df.createOrReplaceTempView("unspent_utxo_snapshot_v")
snapshot_df.persist()
```

with_age_v 쿼리에서 참조도 변경:

```sql
-- Before
JOIN unspent_utxo_snapshot s ON s.snapshot_block_height = t.base_snapshot

-- After (repartitioned temp view 사용)
JOIN unspent_utxo_snapshot_v s ON s.snapshot_block_height = t.base_snapshot
```

> **교훈**: repartition은 하나의 소스만 적용하면 안 됩니다. **조인에 참여하는 모든 대형 소스 테이블**의 파티션 수를 점검해야 합니다.

## 파티션 수 결정: 노드 수 기반 공식

repartition의 N은 클러스터 코어 수에 비례해야 합니다.

### 공식

```text
총 코어 수 = 노드 수 × executor당 코어 수
권장 파티션 수 = 총 코어 수 × 2~3
```

### 실전 예시

| 클러스터 | 노드 | 코어 (추정) | 권장 repartition |
|----------|:---:|:---:|:---:|
| i3.xlarge × 20 | 20 | ~136 | 200~400 |
| i3.xlarge × 50 | 50 | ~340 | **800** |
| i3.2xlarge × 20 | 20 | ~280 | 600 |

### 왜 2~3배인가?

```text
1x 코어 수: 모든 코어가 정확히 1 task씩 — 빨리 끝난 코어는 놀게 됨 (straggler 문제)
2x 코어 수: 첫 task 끝나면 즉시 다음 task 할당 — straggler 완화
3x 이상:   스케줄링 오버헤드 증가, 파티션당 데이터가 너무 작아짐
```

### task당 스필 추정

```text
50 nodes (340 cores), repartition(800):
  총 스필 ~376 GiB (고정) / 800 tasks = ~0.47 GiB/task → 매우 안전

비교:
   4 tasks: 94.0 GiB/task → OOM 위험 (executor 메모리 23 GiB)
  200 tasks:  1.9 GiB/task → 안전
  800 tasks:  0.5 GiB/task → 매우 안전
```

# 5. 파티션 수 확인 방법

---

## Shared Cluster (Unity Catalog)에서의 제약

Databricks Shared Cluster에서는 RDD API 사용이 불가합니다:

```python
# ❌ Shared Cluster에서 에러
df.rdd.getNumPartitions()
# → "Using custom code using PySpark RDDs is not allowed on shared clusters"
```

## 대안: spark_partition_id() 사용

```python
from pyspark.sql.functions import spark_partition_id

def log_partitions(name, df):
    n = df.select(spark_partition_id().alias("pid")).distinct().count()
    print(f"  {name}: {n} partitions")

# 사용
log_partitions("target_blocks_v", target_blocks_df)
# → target_blocks_v: 59 partitions  ← 충분
log_partitions("batch_utxo_v", batch_utxo_df)
# → batch_utxo_v: 4 partitions  ← 문제 발견!

# repartition 후
batch_utxo_df = batch_utxo_df.repartition(200)
log_partitions("batch_utxo_v", batch_utxo_df)
# → batch_utxo_v: 200 partitions  ← 해결
```

## 프로세스 전체에 로깅 적용

```python
from pyspark import StorageLevel

REPART = 800  # 총 코어 수 × 2~3 (50 nodes × ~7 cores × 2.3)

def log_partitions(name, df):
    n = df.select(spark_partition_id().alias("pid")).distinct().count()
    print(f"  {name}: {n} partitions")

# 각 단계마다 파티션 수 확인
target_blocks_df = get_target_block(batch_start, batch_end, SNAPSHOT_INTERVAL)
target_blocks_df.createOrReplaceTempView("target_blocks_v")
target_blocks_df.persist()
log_partitions("target_blocks_v", target_blocks_df)

snapshot_df = spark.sql("""
    SELECT s.* FROM unspent_utxo_snapshot s
    WHERE s.snapshot_block_height IN (
        SELECT DISTINCT base_snapshot FROM target_blocks_v)
""").repartition(REPART)
snapshot_df.createOrReplaceTempView("unspent_utxo_snapshot_v")
snapshot_df.persist()
log_partitions("unspent_utxo_snapshot_v", snapshot_df)

batch_utxo_df = get_batch_utxo_events_block(batch_base, batch_end) \
    .repartition(REPART)
batch_utxo_df.createOrReplaceTempView("batch_utxo_v")
batch_utxo_df.persist()
log_partitions("batch_utxo_v", batch_utxo_df)

with_age_df = spark.sql(WITH_AGE_V_QUERY)
with_age_df.persist(StorageLevel.DISK_ONLY)
with_age_df.createOrReplaceTempView("with_age_v")
log_partitions("with_age_v", with_age_df)

age_agg_df = spark.sql(AGE_AGG_CACHE_SQL)
age_agg_df.createOrReplaceTempView("age_agg_v")
age_agg_df.persist()
log_partitions("age_agg_v", age_agg_df)
```

> **Note**: `log_partitions`의 `distinct().count()`는 action이므로 `.persist()` 직후에 호출하면 캐시 빌드를 겸합니다.

# 6. 스필(Spill) 이해하기

---

## 스필이란?

Spark executor의 메모리가 부족할 때 중간 데이터를 **디스크로 내리는 것**:

```text
Spill (Memory): 94.4 GiB  ← 정렬/조인 시 메모리에 올린 데이터 총량
Spill (Disk):    9.3 GiB  ← 실제 디스크에 쓴 양 (직렬화 압축 후)
```

메모리 스필 > 디스크 스필인 이유: 직렬화(serialization) + 압축으로 크기가 줄어들기 때문.

## 스필이 위험한 이유

```text
1. 디스크 I/O 발생 → task 느려짐
2. GC 압력 증가 → executor 불안정
3. 단일 task 스필이 과도하면 → executor OOM → 사망
4. 사망한 executor의 캐시 데이터 유실 → 재계산 필요
```

## 스필 줄이기 = 파티션 늘리기

```text
total spill = 고정 (데이터 총량에 의존)
task당 spill = total spill / task 수

4 tasks:   94 GiB / task → 위험
100 tasks:  3.8 GiB / task → 안전
```

# 7. Executor 사망 원인과 대응

---

## Spark UI Executors 탭 체크리스트

| 지표 | 정상 | 위험 |
|------|------|------|
| Dead executors | 0~5% | **>20%** |
| GC Time / Task Time | <5% | >10% |
| Shuffle Write 편차 | 균등 | 특정 executor에 집중 |
| Disk Used (DISK_ONLY) | 수백 GB | 0 (캐시 유실 의미) |

## 사망 원인별 대응

```text
1. OOM (메모리 부족)
   → 파티션 늘리기 (task당 데이터 감소)
   → DISK_ONLY 캐시로 메모리 압박 해소

2. Spot Instance Preemption
   → On-demand로 전환 (장시간 실행 워크로드)
   → 또는 Spot + checkpointing

3. Autoscaling 과도한 스케일다운
   → 고정 클러스터 사용
   → 또는 min workers 설정 높이기

4. 데이터 스큐
   → repartition으로 균등 분배
   → skewJoin.enabled = true 확인
```

# 8. 노드 수 결정 기준

---

## CPU bound vs I/O bound 판단

```text
CPU < 10% + 스필 많음    → I/O bound (디스크/셔플)
CPU > 70% + 스필 적음    → CPU bound
CPU < 10% + 스필 없음    → task 수 부족 (파티션 문제)
```

## 판단 후 액션

```text
I/O bound:
  → 노드 수 줄이기 가능 (어차피 CPU 안 씀)
  → 하지만 NVMe 대역폭 감소 주의 (DISK_ONLY 캐시)
  → 파티션 튜닝이 먼저!

CPU bound:
  → 노드 수 늘리기 또는 큰 인스턴스
  → 파티션 수도 코어 수에 맞게 조정

Task 수 부족:
  → repartition으로 해결 (노드 수 변경 불필요!)
```

## 실전 사이징 예시

```text
with_age_v (880GB DISK_ONLY) 기준:

20대 유지 → 파티션 튜닝으로 활용률 3% → 70%+ 개선
 ↓
안정화 후 노드 줄이기 테스트:
  i3.2xlarge × 8대 (64 cores, 15.2 TB NVMe)
  → 880GB 캐시 수용 가능
  → 코어 활용률 확인 후 추가 조정
```

# Summary

---

| 단계 | 액션 | 확인 방법 |
|------|------|----------|
| 1. 증상 발견 | CPU 낮은데 느림 | Spark UI → Executors |
| 2. 원인 파악 | Task 수 확인 | Spark UI → Stages → Tasks |
| 3. 소스 확인 | 파일/파티션 수 확인 | `DESCRIBE DETAIL table` 또는 `spark_partition_id()` |
| 4. 튜닝 | repartition 적용 | 조인 패턴에 따라 round robin / hash 선택 |
| 5. **모든 소스** | 조인 참여 테이블 전수 점검 | 하나만 고치면 다음 병목이 드러남 |
| 6. 파티션 수 결정 | 코어 × 2~3 | 노드 수 변경 시 같이 조정 |
| 7. 검증 | 파티션 수 로깅 | `log_partitions()` 함수 |
| 8. 안정화 | Executor 사망 감소 확인 | Dead executor 수 모니터링 |
| 9. 사이징 | 노드 수 조정 | 활용률 기반 점진적 축소 |

**핵심 원칙**:
1. 노드를 늘리기 전에 기존 코어를 제대로 쓰고 있는지 확인하라. `repartition` 한 줄이 노드 10대 추가보다 효과적일 수 있다.
2. repartition은 **조인에 참여하는 모든 대형 소스 테이블**에 적용해야 한다. 하나만 고치면 다음 병목이 드러날 뿐이다.
3. 파티션 수는 클러스터 사이즈에 연동하라: `N = 총 코어 × 2~3`.

# Reference

---

- [Spark SQL Performance Tuning - Adaptive Query Execution](https://spark.apache.org/docs/latest/sql-performance-tuning.html#adaptive-query-execution)
- [Spark Web UI - Monitoring and Instrumentation](https://spark.apache.org/docs/latest/web-ui.html)
- [PySpark DataFrame.repartition API](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.repartition.html)
- [PySpark spark_partition_id](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.spark_partition_id.html)
