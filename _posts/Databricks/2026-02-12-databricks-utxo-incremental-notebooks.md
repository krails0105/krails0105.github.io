---
title: "Databricks 멀티태스크 잡을 위한 UTXO 증분 처리 노트북 설계"
date: 2026-02-12
categories:
  - Databricks
tags:
  - Spark
  - Delta Lake
  - Bitcoin
  - UTXO
  - Notebook
  - Global Temp View
  - Incremental Processing
---

## Introduction

비트코인 블록체인 UTXO 메트릭 계산 시스템을 Python/RocksDB 기반에서 Spark/Databricks로 마이그레이션하는 과정에서, 증분 배치 처리를 위한 4개의 Databricks 노트북을 구현했다. 이 노트북들은 멀티태스크 잡(Multi-task Job) 아키텍처로 실행되며, **global temp view와 persist를 활용해 태스크 간 데이터를 공유**한다.

이 글에서 다루는 내용:

- 4개 노트북의 역할과 데이터 흐름
- Global temp view + persist를 활용한 멀티태스크 잡 데이터 공유 패턴
- Delta Lake `replaceWhere`를 통한 idempotent write 전략
- Spark PIVOT + WINDOW 함수를 활용한 분포 테이블 생성
- 실제 구현에서 발견한 gotcha와 버그 패턴

기존 시스템이 ~100시간 걸리던 계산을 ~10시간 이내로 단축하는 것이 이 마이그레이션의 목표다.

## 전제 조건 (Prerequisites)

이 글의 내용을 따라가려면 다음에 대한 기본 이해가 필요하다:

- **Databricks Workflows**: 멀티태스크 잡, shared cluster 개념
- **Delta Lake**: 테이블 읽기/쓰기, `mode("overwrite")` 동작
- **Spark SQL**: CTE(WITH), WINDOW 함수, PIVOT 구문
- **Bitcoin UTXO 모델**: UTXO 생성/소비, 블록 높이 개념

이 프로젝트의 전체 아키텍처(Phase 0~2)와 스냅샷/델타 전략에 대한 배경은 `docs/spark/06_optimized_queries.md`를 참고한다.

## 배경: 기존 시스템의 한계와 Spark 마이그레이션 전략

### 기존 시스템의 한계

기존 Python 기반 시스템은:

- RocksDB K-V 저장소를 사용해 UTXO 상태를 관리
- 단일 서버에서 순차 처리
- 블록당 처리 시간이 길어 전체 계산에 ~100시간 소요
- 병렬 처리가 제한적 (일부 메트릭만 가능)

### Spark 마이그레이션 전략

전체 파이프라인을 3단계로 나눴다:

1. **Phase 0/0.5**: `utxo_base` 테이블(~2.5B rows)을 1회 full scan해 이벤트 로그 생성 (~200M rows인 `utxo_events_block`)
2. **Phase 1**: 스냅샷 테이블 3개 생성 (10,000 블록 간격) -- unspent/supply/realized
3. **Phase 2**: 증분 배치 처리 -- 스냅샷 + 델타를 결합해 10개 output 테이블 생성

Phase 2는 다시 2개 프로세스로 분리된다:

- **Process A**: age 기반 메트릭 + 분포 (7 tables, A-1 ~ A-7)
- **Process B**: supply/realized 분포 (3 tables, B-1 ~ B-3)

두 프로세스는 완전히 독립적이므로 병렬 실행이 가능하다. 이 글은 **Phase 2 증분 배치 처리를 담당하는 4개 노트북**의 구현에 집중한다.

### 왜 멀티태스크 잡인가

Databricks Job을 단일 노트북으로 실행하면:

- 중간 결과를 Delta 테이블로 저장해야 함 (I/O 오버헤드)
- 실패 시 전체를 재실행해야 함
- Process A, B의 병렬 처리가 불가능

멀티태스크 잡으로 전환하면:

- Prep 태스크가 중간 뷰를 생성하고, 3개 output 태스크가 **병렬 실행**
- Global temp view + persist로 중간 Delta 테이블 없이 데이터 공유
- 태스크 단위 재실행 가능 (`replaceWhere`로 idempotent write)

## 핵심 개념: Global Temp View, replaceWhere, AQE

노트북 구현을 보기 전에, 이 시스템의 핵심 메커니즘 3가지를 짚어본다.

### Global Temp View vs 일반 Temp View

Spark의 temp view는 두 가지 범위(scope)를 가진다:

| 구분 | 일반 Temp View | Global Temp View |
|------|---------------|-----------------|
| 범위 | SparkSession 레벨 | SparkContext(클러스터) 레벨 |
| 접근 | 생성한 세션에서만 | 같은 클러스터 내 모든 세션 |
| SQL 참조 | `SELECT * FROM my_view` | `SELECT * FROM global_temp.my_view` |
| 생성 API | `df.createOrReplaceTempView()` | `df.createOrReplaceGlobalTempView()` |
| 수명 | 세션 종료 시 삭제 | Databricks Runtime 종료 시 삭제 |

Databricks 공식 문서에 따르면, global temp view는 시스템이 보존하는 `global_temp` 스키마에 연결된다. 같은 Databricks Runtime(클러스터) 내에서 세션을 넘어 접근할 수 있어, 멀티태스크 잡에서 태스크 간 데이터 공유에 적합하다.

**중요**: 멀티태스크 잡에서 global temp view를 등록할 때 `persist()`를 반드시 먼저 호출해야 한다. persist 없이 view만 등록하면 **query plan만 저장**되므로, 다른 세션에서 참조하는 소스 temp view가 없어 실행이 실패한다.

```python
# 잘못된 예 -- query plan만 저장됨
df.createOrReplaceGlobalTempView("my_view")

# 올바른 예 -- 실제 데이터가 캐시된 후 view가 등록됨
df.persist()
df.createOrReplaceGlobalTempView("my_view")
```

### replaceWhere를 통한 Idempotent Write

모든 Delta 테이블 쓰기를 `replaceWhere` + `mode("overwrite")`로 통일했다. Delta Lake 공식 문서에서 "Selective overwrite"로 소개하는 패턴이다:

```python
df.write.format("delta") \
    .option("replaceWhere",
            f"block_height BETWEEN {batch_start} AND {batch_end}") \
    .mode("overwrite") \
    .saveAsTable(table_name)
```

이 방식의 동작 원리와 장점:

- **파일 단위 atomic 교체**: Delta log에 remove + add를 하나의 commit으로 기록
- **Idempotent**: 같은 배치를 재실행해도 결과가 동일 (기존 파일을 교체할 뿐)
- **Liquid Clustering data skipping**: `replaceWhere` predicate에 해당하는 파일만 교체하므로 전체 테이블을 스캔하지 않음

단, `replaceWhere`는 **연속된 predicate 범위**에만 적합하다. 흩어진 row UPDATE가 필요하면 `MERGE`를 사용해야 한다.

### Spark AQE (Adaptive Query Execution) 설정

Prep 노트북에서 AQE 관련 설정을 명시적으로 조정한다:

```python
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.sql.adaptive.advisoryPartitionSizeInBytes", "128MB")
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "100MB")
```

Databricks는 AQE를 기본적으로 활성화(`spark.databricks.optimizer.adaptive.enabled = true`)하지만, 여기서는 두 가지를 기본값 대비 상향 조정했다:

| 설정 | Databricks 기본값 | 조정값 | 이유 |
|------|-------------------|--------|------|
| `advisoryPartitionSizeInBytes` | 64MB | **128MB** | UTXO 이벤트 데이터가 균일해서 파티션을 크게 잡아도 skew가 적음 |
| `autoBroadcastJoinThreshold` | 30MB | **100MB** | age_bins(13 rows), target_blocks(~10K rows) 등 작은 테이블의 broadcast를 보장 |

`skewJoin.enabled`는 Databricks에서 기본 `true`이지만, 명시적으로 설정해 의도를 드러낸다.

## 노트북 구조와 데이터 흐름

4개 노트북으로 Phase 2 배치 처리를 구현했다:

```
utxo_prep (준비)
    | global temp view 4개 발행 + snapshot 캐시
    |
    +---> utxo_statistics (A-1) --------> btc_utxo_block_metrics (22 cols)
    |
    +---> utxo_age_distribution (A-2~A-7) --> age 분포 6 tables
    |
    +---> utxo_supply_distribution (B-1~B-3) --> supply/realized 분포 3 tables
```

- **utxo_prep**: 공통 데이터를 준비하고 global temp view로 발행
- **utxo_statistics**: Process A의 블록 메트릭 (A-1)
- **utxo_age_distribution**: Process A의 age 분포 (A-2~A-7)
- **utxo_supply_distribution**: Process B의 supply/realized 분포 (B-1~B-3)

멀티태스크 잡에서는 prep 완료 후 나머지 3개가 **동시에** 실행된다. 각 노트북은 단독으로도 테스트 가능하다.

모든 노트북은 `dbutils.widgets`를 통해 파라미터를 받는다:

```python
# 공통 위젯 -- 모든 노트북에 동일
dbutils.widgets.text("batch_start", "", "batch_start (block height)")
dbutils.widgets.text("batch_end", "", "batch_end (block height)")
dbutils.widgets.text("catalog", "tech_lakehouse_prod", "catalog")
dbutils.widgets.text("schema", "bitcoin", "schema")
```

## 구현 1: utxo_prep.py -- 공유 뷰 준비

Prep 노트북은 4개 global temp view를 생성하고 persist한다. 각 뷰가 어떤 역할을 하는지, 왜 이런 순서로 생성되는지 살펴보자.

### min_base_snapshot 정렬

증분 배치에서 가장 먼저 해야 할 일은, 델타 이벤트 범위의 하한(lower bound)을 올바르게 설정하는 것이다:

```python
# CRITICAL: batch_start를 직접 사용하면 스냅샷 경계와 batch_start 사이의
# 델타 이벤트가 누락된다. 반드시 interval 경계로 내림해야 한다.
min_base_snapshot = (batch_start // interval) * interval
print(f"min_base_snapshot={min_base_snapshot}")
```

예를 들어 `batch_start=45000`, `interval=10000`이면 `min_base_snapshot=40000`이 된다. 블록 45000의 base_snapshot은 40000이므로, 40001~45000 사이의 델타 이벤트도 반영해야 한다. 이 정렬을 빠뜨리면 **데이터 누락 또는 이중 집계** 버그가 발생한다.

### target_blocks_v: 배치 대상 블록 + base_snapshot 매핑

```python
target_blocks_df = spark.sql(f"""
    SELECT
        block_height, datetime,
        timestamp AS target_timestamp,
        price AS target_price,
        CASE
            WHEN block_height < {interval} THEN -1
            ELSE CAST(FLOOR(block_height / {interval}) * {interval} AS INT)
        END AS base_snapshot
    FROM {PRICE_TABLE}
    WHERE block_height BETWEEN {batch_start} AND {batch_end}
""")
target_blocks_df.createOrReplaceTempView("target_blocks_v")
target_blocks_df.persist()
target_blocks_df.createOrReplaceGlobalTempView("target_blocks")
```

`base_snapshot` 컬럼은 각 블록이 어느 스냅샷 위에서 계산을 시작하는지 나타낸다. 블록 높이가 interval(10,000) 미만이면 `-1`을 할당해 "스냅샷 없음"을 표시한다.

3단계 패턴을 주목하자:
1. `createOrReplaceTempView()` -- 현재 세션의 SQL 쿼리에서 사용
2. `persist()` -- 데이터를 메모리에 캐시
3. `createOrReplaceGlobalTempView()` -- 다른 태스크 세션에서 접근 가능하도록 등록

### batch_utxo_v: 델타 이벤트 필터링

```python
batch_utxo_df = spark.sql(f"""
    SELECT *
    FROM {EVENTS_TABLE}
    WHERE event_block_height > {min_base_snapshot}
      AND event_block_height <= {batch_end}
""").repartition(800)
batch_utxo_df.createOrReplaceTempView("batch_utxo_v")
batch_utxo_df.persist()
batch_utxo_df.createOrReplaceGlobalTempView("batch_utxo")
```

두 가지 주의할 점:

1. **하한이 exclusive(`>`)**: `min_base_snapshot`은 이미 스냅샷에 반영된 블록이므로, 그 다음 블록부터 델타로 가져와야 한다.
2. **`repartition(800)`**: `utxo_events_block` 테이블은 `CLUSTER BY (event_block_height, created_block_height)`으로 저장되어 있어, 읽을 때 파일 수가 많을 수 있다. 800 파티션으로 재분배해 후속 JOIN 성능을 안정화한다.

### unspent_utxo_snapshot_v: 스냅샷 필터링 + 캐시

```python
snapshot_df = spark.sql(f"""
    SELECT s.*
    FROM {UNSPENT_SNAPSHOT_TABLE} s
    WHERE s.snapshot_block_height IN (
        SELECT DISTINCT base_snapshot FROM target_blocks_v
    )
""").repartition(800)
snapshot_df.createOrReplaceTempView("unspent_utxo_snapshot_v")
snapshot_df.persist()
```

이 뷰는 **global temp view로 발행하지 않는다**. 이유: `unspent_utxo_snapshot_v`는 다음에 정의할 `unspent_age_v` VIEW의 소스로만 사용되고, `unspent_age_v`는 prep 노트북 내에서 `age_agg_df`를 materialized할 때 한 번만 소비된다. 즉, 이 데이터는 prep 세션 밖으로 나갈 필요가 없다.

### unspent_age_v: VIEW만 등록 (캐시 없음)

unspent_age_v는 스냅샷 + 델타를 결합해 "각 target 블록 시점의 미소비 UTXO 상태"를 age 정보와 함께 계산하는 뷰다:

```python
spark.sql("""
CREATE OR REPLACE TEMP VIEW unspent_age_v AS
WITH
snapshot_state AS (
    -- 스냅샷에 있는 UTXO (created_block_height <= base_snapshot)
    SELECT
        t.block_height AS target_block, t.datetime, t.target_timestamp, t.target_price,
        s.created_block_height, s.created_timestamp, s.created_price,
        s.unspent_value, s.unspent_realized, s.unspent_count
    FROM target_blocks_v t
    JOIN unspent_utxo_snapshot_v s ON s.snapshot_block_height = t.base_snapshot
),
delta_events AS (
    -- 스냅샷 이후 발생한 델타 (기존 UTXO의 소비/변경)
    SELECT /*+ RANGE_JOIN(e, 1000) */
        t.block_height AS target_block, e.created_block_height,
        SUM(e.delta_value) AS delta_value,
        SUM(e.delta_realized) AS delta_realized,
        SUM(e.delta_count) AS delta_count
    FROM target_blocks_v t
    JOIN batch_utxo_v e
        ON e.event_block_height > t.base_snapshot
        AND e.event_block_height <= t.block_height
        AND e.created_block_height <= t.base_snapshot
    GROUP BY t.block_height, e.created_block_height
),
final_unspent AS (
    -- 스냅샷 + 델타 결합 (LEFT JOIN)
    SELECT
        s.target_block, s.datetime, s.target_timestamp, s.target_price,
        s.created_block_height, s.created_timestamp, s.created_price,
        s.unspent_value + COALESCE(d.delta_value, 0) AS unspent_value,
        s.unspent_realized + COALESCE(d.delta_realized, 0) AS unspent_realized,
        s.unspent_count + COALESCE(d.delta_count, 0) AS unspent_count
    FROM snapshot_state s
    LEFT JOIN delta_events d
        ON s.target_block = d.target_block
        AND s.created_block_height = d.created_block_height
    WHERE s.unspent_value + COALESCE(d.delta_value, 0) > 0

    UNION ALL

    -- 스냅샷 이후 새로 생성된 UTXO
    SELECT /*+ RANGE_JOIN(e, 1000) */
        t.block_height,
        ANY_VALUE(t.datetime), ANY_VALUE(t.target_timestamp), ANY_VALUE(t.target_price),
        e.created_block_height,
        ANY_VALUE(e.created_timestamp), ANY_VALUE(e.created_price),
        SUM(e.delta_value), SUM(e.delta_realized), SUM(e.delta_count)
    FROM target_blocks_v t
    JOIN batch_utxo_v e
        ON e.event_block_height > t.base_snapshot
        AND e.event_block_height <= t.block_height
        AND e.created_block_height > t.base_snapshot
    GROUP BY t.block_height, e.created_block_height
    HAVING SUM(e.delta_value) > 0
),
with_age AS (
    SELECT *,
        (target_timestamp - created_timestamp) / 86400.0 AS age_days,
        FLOOR((target_timestamp - created_timestamp) / 86400) AS age_day_int
    FROM final_unspent
)
SELECT
    u.target_block, u.datetime, u.target_timestamp, u.target_price,
    u.created_block_height, u.created_timestamp, u.created_price,
    u.unspent_value, u.unspent_realized, u.unspent_count,
    u.age_days, u.age_day_int
FROM with_age u
""")
```

이 뷰가 길지만 구조는 명확하다:

1. **snapshot_state**: 스냅샷에서 기존 UTXO 상태를 읽음
2. **delta_events**: 스냅샷 이후 ~ target 블록까지의 변경분을 집계 (기존 UTXO에 대한 소비)
3. **final_unspent**: LEFT JOIN으로 결합 + UNION ALL로 신규 UTXO 추가
4. **with_age**: 나이(age_days) 계산

기존 설계에서는 이 뷰를 `DISK_ONLY`로 캐시했으나(~880GB), consumer가 `age_agg_df` 하나뿐이므로 **캐시를 제거하고 VIEW로만 등록**했다. age_agg_df가 이 뷰를 한 번 streaming pass로 소비한다.

`RANGE_JOIN(e, 1000)` 힌트는 Databricks 고유의 range join 최적화로, `bin_size=1000`은 interval의 P99/10 기반으로 설정했다. 이 힌트가 없으면 Spark가 자동으로 range join을 감지하지 않아 Cartesian product로 처리될 수 있다.

### age_agg_v: age_bins BROADCAST JOIN + A-1 metrics 사전 집계

```python
age_agg_df = spark.sql("""
WITH age_bins AS (
    SELECT * FROM VALUES
        (0, 1, '0d_1d'),     (1, 7, '1d_1w'),       (7, 30, '1w_1m'),
        (30, 90, '1m_3m'),   (90, 180, '3m_6m'),    (180, 365, '6m_12m'),
        (365, 545, '12m_18m'), (545, 730, '18m_2y'), (730, 1095, '2y_3y'),
        (1095, 1825, '3y_5y'), (1825, 2555, '5y_7y'), (2555, 3650, '7y_10y'),
        (3650, 2147483647, '10y_inf')
    AS t(min_day, max_day, age_range)
)
SELECT /*+ BROADCAST(b) */
    target_block AS block_height,
    ANY_VALUE(datetime) AS datetime,
    ANY_VALUE(target_price) AS target_price,
    b.age_range,
    SUM(unspent_value) AS supply,
    SUM(unspent_realized) AS realized,
    SUM(unspent_count) AS cnt,
    SUM(unspent_value * age_days) AS sca,
    SUM(unspent_realized) / NULLIF(SUM(unspent_value), 0) AS realized_price,
    SUM(unspent_value * age_days * created_price) AS scda,
    -- profit/loss metrics (A-1에서 사용)
    SUM(CASE WHEN target_price > created_price
        THEN unspent_value * (target_price - created_price) ELSE 0 END) AS profit_usd,
    SUM(CASE WHEN target_price < created_price
        THEN unspent_value * (created_price - target_price) ELSE 0 END) AS loss_usd,
    SUM(CASE WHEN target_price > created_price THEN unspent_value ELSE 0 END) AS profit_supply,
    SUM(CASE WHEN target_price < created_price THEN unspent_value ELSE 0 END) AS loss_supply,
    SUM(CASE WHEN target_price > created_price THEN unspent_count ELSE 0 END) AS profit_cnt,
    SUM(CASE WHEN target_price < created_price THEN unspent_count ELSE 0 END) AS loss_cnt,
    SUM(CASE WHEN target_price > created_price THEN 1 ELSE 0 END) AS blk_profit_cnt,
    SUM(CASE WHEN target_price < created_price THEN 1 ELSE 0 END) AS blk_loss_cnt,
    SUM(CASE WHEN target_price = created_price THEN 1 ELSE 0 END) AS blk_same_cnt
FROM unspent_age_v u
JOIN age_bins b ON u.age_day_int >= b.min_day AND u.age_day_int < b.max_day
GROUP BY target_block, b.age_range
""")
age_agg_df.persist()
age_agg_df.createOrReplaceGlobalTempView("age_agg")
```

이 뷰의 설계 포인트:

- **age_bins VALUES 테이블**: 13개 age 범위를 인라인 VALUES로 정의하고 `BROADCAST` 힌트로 join. 기존 13-clause `CASE WHEN`을 대체해 가독성과 유지보수성이 향상됨
- **A-1 metrics 사전 집계**: `profit_usd`, `loss_usd`, `sca`, `scda` 등 블록 메트릭 원재료를 age_range 레벨에서 미리 계산. `utxo_statistics` 노트북에서는 age_range를 GROUP BY로 합산만 하면 됨
- **~130K rows**: 10K 블록 x 13 age_ranges = 약 130K rows로 작아서 메모리 persist가 충분

### spent_age_v: 멀티태스크에서만 persist 필요

```python
spent_age_df = spark.sql("""
WITH
age_bins AS (...),  -- age_agg와 동일한 VALUES 테이블
spent_raw AS (
    SELECT
        t.block_height AS spent_block,
        ANY_VALUE(t.datetime) AS datetime,
        ANY_VALUE(t.target_timestamp) AS spent_timestamp,
        ANY_VALUE(t.target_price) AS spent_price,
        u.created_block_height,
        ANY_VALUE(u.created_timestamp) AS created_timestamp,
        ANY_VALUE(u.created_price) AS created_price,
        SUM(-u.delta_value) AS spent_value,         -- delta가 음수이므로 부호 반전
        SUM(-u.delta_realized) AS spent_realized_value,
        SUM(-u.delta_count) AS spent_count
    FROM target_blocks_v t
    JOIN batch_utxo_v u
        ON u.event_block_height = t.block_height AND u.delta_count < 0
    GROUP BY t.block_height, u.created_block_height
),
with_age AS (
    SELECT s.*,
        (s.spent_timestamp - s.created_timestamp) / 86400.0 AS age_days,
        CAST(FLOOR((s.spent_timestamp - s.created_timestamp) / 86400) AS INT) AS age_day_int
    FROM spent_raw s
)
SELECT /*+ BROADCAST(b) */
    u.*, b.age_range
FROM with_age u
JOIN age_bins b ON u.age_day_int >= b.min_day AND u.age_day_int < b.max_day
""")
spent_age_df.persist()
spent_age_df.createOrReplaceGlobalTempView("spent_age")
```

spent_age_v는 A-5(btc_spent_output_age_distribution) 한 곳에서만 소비된다. 단일 노트북 모드라면 persist가 불필요하지만, 멀티태스크 잡에서는 prep와 output이 다른 SparkSession이므로 persist가 필수다.

### Prep 노트북 요약

Prep 노트북이 완료되면 다음 global temp view가 사용 가능하다:

| Global Temp View | 크기 (예상) | 용도 |
|------------------|-------------|------|
| `global_temp.target_blocks` | ~10K rows | 배치 대상 블록 + base_snapshot 매핑 |
| `global_temp.batch_utxo` | ~120MB | 델타 이벤트 (min_base_snapshot ~ batch_end) |
| `global_temp.age_agg` | ~130K rows | age_bins JOIN + A-1 metrics 사전 집계 |
| `global_temp.spent_age` | ~수만 rows | spent output의 age 분포 |

추가로 `unspent_utxo_snapshot_v`가 로컬 temp view + persist로 캐시되지만, prep 세션 내에서만 사용된다.

## 구현 2: utxo_statistics.py -- A-1 블록 메트릭

A-1은 age_agg를 블록 단위로 합산해 22개 메트릭 컬럼을 생성한다. 코드가 비교적 간결하다:

```python
BRANCHING_POINT = 220_000

# 초기 블록은 데이터 부족으로 메트릭 계산이 무의미
if batch_start < BRANCHING_POINT:
    print(f"batch_start ({batch_start}) < BRANCHING_POINT ({BRANCHING_POINT}), skipping A-1")
    dbutils.notebook.exit("SKIPPED: batch below branching point")

result_df = spark.sql(f"""
WITH block_agg AS (
    SELECT
        block_height, ANY_VALUE(datetime) AS datetime, ANY_VALUE(target_price) AS target_price,
        SUM(supply) AS total_supply,
        SUM(realized) AS total_realized,
        SUM(cnt) AS total_count,
        SUM(sca) AS sca, SUM(scda) AS scda,
        SUM(profit_usd) AS profit_usd, SUM(loss_usd) AS loss_usd,
        SUM(profit_supply) AS profit_supply, SUM(loss_supply) AS loss_supply,
        SUM(profit_cnt) AS profit_cnt, SUM(loss_cnt) AS loss_cnt,
        SUM(blk_profit_cnt) AS blk_profit_cnt,
        SUM(blk_loss_cnt) AS blk_loss_cnt,
        SUM(blk_same_cnt) AS blk_same_cnt
    FROM global_temp.age_agg
    GROUP BY block_height
)
SELECT
    block_height, datetime, target_price,
    CAST(total_supply AS DECIMAL(22,8)),
    CAST(total_realized AS DECIMAL(28,8)),
    CAST(total_count AS BIGINT),
    CAST(sca AS DECIMAL(28,8)), CAST(scda AS DECIMAL(38,8)),
    CAST(profit_usd AS DECIMAL(22,8)), CAST(loss_usd AS DECIMAL(22,8)),
    -- NUPL = (profit - loss) / market_cap
    CAST((profit_usd - loss_usd) / NULLIF(total_supply * target_price, 0) AS DECIMAL(12,8)),
    CAST(profit_supply AS DECIMAL(22,8)), CAST(loss_supply AS DECIMAL(22,8)),
    CAST(profit_supply / NULLIF(total_supply, 0) * 100 AS DECIMAL(12,8)),
    CAST(loss_supply / NULLIF(total_supply, 0) * 100 AS DECIMAL(12,8)),
    CAST(profit_cnt AS BIGINT), CAST(loss_cnt AS BIGINT),
    CAST(profit_cnt / NULLIF(total_count, 0) * 100 AS DECIMAL(12,8)),
    CAST(loss_cnt / NULLIF(total_count, 0) * 100 AS DECIMAL(12,8)),
    CAST(blk_profit_cnt AS BIGINT), CAST(blk_loss_cnt AS BIGINT),
    CAST(blk_profit_cnt / NULLIF(blk_profit_cnt + blk_loss_cnt + blk_same_cnt, 0) * 100 AS DECIMAL(12,8)),
    CAST(blk_loss_cnt / NULLIF(blk_profit_cnt + blk_loss_cnt + blk_same_cnt, 0) * 100 AS DECIMAL(12,8))
FROM block_agg
""")

result_df.write.format("delta") \
    .option("replaceWhere",
            f"block_height BETWEEN {batch_start} AND {batch_end}") \
    .mode("overwrite") \
    .saveAsTable(OUTPUT_TABLE)
```

핵심: age_agg_v에서 이미 SUM-additive한 중간 값을 계산해뒀기 때문에, 여기서는 age_range를 GROUP BY로 합산하고 비율/퍼센트를 계산하면 된다.

## 구현 3: utxo_age_distribution.py -- A-2~A-7 age 분포

A-2 ~ A-7은 공통 패턴을 따른다:

1. `age_agg_v` (또는 `spent_age_v`) 읽기
2. WINDOW 함수로 백분율 정규화
3. **PIVOT**으로 age_range를 컬럼으로 전환
4. `target_blocks` LEFT JOIN으로 누락 블록에 NULL 채움
5. `replaceWhere` write

### Global temp view의 로컬 alias 생성

멀티태스크 잡에서 다른 세션의 global temp view를 참조하려면 `global_temp.` 접두사가 필요하다. 매번 붙이면 SQL이 길어지므로, 노트북 시작 시 로컬 alias를 생성한다:

```python
# Global temp view → 로컬 temp view alias
spark.sql("CREATE OR REPLACE TEMP VIEW age_agg_v AS SELECT * FROM global_temp.age_agg")
spark.sql("CREATE OR REPLACE TEMP VIEW spent_age_v AS SELECT * FROM global_temp.spent_age")
spark.sql("CREATE OR REPLACE TEMP VIEW target_blocks_v AS SELECT * FROM global_temp.target_blocks")
```

이 패턴은 global temp view의 데이터를 **복사하지 않는다**. persist된 데이터를 참조하는 가벼운 뷰만 생성한다.

### Python helper: pivot_cols()

PIVOT 출력 컬럼과 INSERT 대상 테이블의 컬럼명을 매핑하는 SELECT 절을 자동 생성한다:

```python
AGE_RANGES = [
    '0d_1d', '1d_1w', '1w_1m', '1m_3m', '3m_6m', '6m_12m',
    '12m_18m', '18m_2y', '2y_3y', '3y_5y', '5y_7y', '7y_10y', '10y_inf',
]

def pivot_cols(ranges, metrics, prefix="p."):
    """
    Generate SELECT columns for PIVOT output with alias mapping.

    metrics: list of (pivot_suffix, target_suffix, default)
        pivot_suffix: PIVOT output column suffix (e.g. 'val', 'usd', 'pct')
                      empty string for single-agg PIVOT
        target_suffix: INSERT target alias suffix (e.g. '', '_usd', '_percent')
        default:
            - number (0): COALESCE(col, 0)
            - string ('_total'): conditional on total > 0
            - None: pass NULL through
    NOTE: metric-first iteration to match INSERT INTO positional order.
    """
    parts = []
    for col_sfx, tgt_sfx, default in metrics:
        for r in ranges:
            pivot_col = f"{r}_{col_sfx}" if col_sfx else r
            alias = f"range_{r}{tgt_sfx}"
            col_ref = f"{prefix}`{pivot_col}`"
            if isinstance(default, str):
                # 조건부: 분모가 0보다 클 때만 백분율 계산
                parts.append(
                    f"CASE WHEN {prefix}{default} > 0 "
                    f"THEN COALESCE({col_ref}, 0) ELSE NULL END AS {alias}"
                )
            elif default is not None:
                parts.append(f"COALESCE({col_ref}, {default}) AS {alias}")
            else:
                parts.append(f"{col_ref} AS {alias}")
    return ",\n    ".join(parts)


def pivot_in(ranges):
    """PIVOT IN 절에 값 목록을 생성한다."""
    return ", ".join(f"'{r}'" for r in ranges)
```

이 helper가 필요한 이유: Spark PIVOT의 출력 컬럼명은 `{value}_{agg_alias}` 형식이지만, 기존 테이블의 컬럼명은 `range_{range_name}[_suffix]` 형식이다. 13개 범위 x 여러 metrics를 수동으로 매핑하면 실수가 불가피하므로 자동 생성한다.

### A-2 예시: supply age 분포 (39 cols)

전체 패턴을 보여주는 A-2를 자세히 살펴보자:

```python
a2_cols = pivot_cols(AGE_RANGES,
    [('val', '', 0), ('usd', '_usd', 0), ('pct', '_percent', '_total')])
a2_table = f"{catalog}.{schema}.btc_utxo_age_distribution"
a2_pivot_in = pivot_in(AGE_RANGES)

a2_df = spark.sql(f"""
WITH normalized AS (
    SELECT block_height, age_range,
           supply AS val,
           supply * target_price AS usd,
           supply / NULLIF(SUM(supply) OVER w, 0) * 100 AS pct,
           SUM(supply) OVER w AS _total
    FROM age_agg_v
    WINDOW w AS (PARTITION BY block_height)
),
pivoted AS (
    SELECT * FROM normalized
    PIVOT (FIRST(val) AS val, FIRST(usd) AS usd, FIRST(pct) AS pct
           FOR age_range IN ({a2_pivot_in}))
)
SELECT t.block_height, t.datetime,
    {a2_cols}
FROM target_blocks_v t
LEFT JOIN pivoted p ON t.block_height = p.block_height
""")

a2_df.write.format("delta") \
    .option("replaceWhere",
            f"block_height BETWEEN {batch_start} AND {batch_end}") \
    .mode("overwrite") \
    .saveAsTable(a2_table)
```

SQL 구조 분석:

1. **normalized CTE**: WINDOW 함수로 블록별 합계(`_total`)와 백분율(`pct`)을 계산. `WINDOW w AS (PARTITION BY block_height)` 선언으로 반복을 줄임
2. **PIVOT**: `FOR age_range IN (...)` 절에 13개 범위를 **명시적으로 나열**. 이것이 중요한데, 값을 생략하면 Spark가 모든 distinct 값을 찾기 위해 extra scan을 수행해 성능이 저하된다
3. **LEFT JOIN target_blocks_v**: 배치 내 모든 블록을 보장하고, 데이터가 없는 블록은 NULL로 채움

나머지 A-3(realized), A-4(count), A-5(spent), A-6(realized price), A-7(SCA)도 동일한 패턴이다. 다른 점은 `normalized` CTE의 소스 컬럼과 metrics 종류뿐이다.

**A-5만 다른 점**: A-5는 `age_agg_v` 대신 `spent_age_v`를 소스로 사용한다. spent output(소비된 UTXO)의 age 분포를 계산하기 때문이다.

## 구현 4: utxo_supply_distribution.py -- B-1~B-3 supply/realized 분포

Process B는 Process A와 독립적으로 동작한다. age_agg_v를 사용하지 않고, batch_utxo_v와 별도의 supply/realized 스냅샷 테이블을 소스로 한다.

### Python helper: build_distribution_view()

supply_snapshot / realized_snapshot과 batch_utxo_v 델타를 결합하는 뷰를 동적으로 생성하는 템플릿 함수다:

```python
def build_distribution_view(
    view_name,       # "with_supply_v" or "with_realized_v"
    range_col,       # "supply_range" or "realized_range"
    snapshot_table,  # full table name
    value_col,       # "delta_value" / "delta_realized"
    unspent_col,     # "unspent_value" / "unspent_realized"
    agg_source="batch_utxo_v",
):
    """Build a distribution view combining snapshot + delta events."""
    return f"""
CREATE OR REPLACE TEMP VIEW {view_name} AS
WITH
range_agg AS (
    -- 델타 이벤트를 range + created_block_height 단위로 사전 집계
    SELECT event_block_height, {range_col}, created_block_height,
           ANY_VALUE(created_timestamp) AS created_timestamp,
           SUM({value_col}) AS {value_col},
           SUM(delta_count) AS delta_count
    FROM {agg_source}
    GROUP BY event_block_height, {range_col}, created_block_height
),
snapshot_state AS (
    SELECT t.block_height AS target_block, t.target_price,
           s.{range_col}, s.created_block_height,
           s.{unspent_col}, s.unspent_count
    FROM target_blocks_v t
    JOIN {snapshot_table} s ON s.snapshot_block_height = t.base_snapshot
),
delta_events AS (
    -- 기존 UTXO에 대한 델타
    SELECT /*+ RANGE_JOIN(e, 1000) */
        t.block_height AS target_block, e.{range_col}, e.created_block_height,
        SUM(e.{value_col}) AS {value_col}, SUM(e.delta_count) AS delta_count
    FROM target_blocks_v t
    JOIN range_agg e
        ON e.event_block_height <= t.block_height
        AND e.created_block_height <= t.base_snapshot
    GROUP BY t.block_height, e.{range_col}, e.created_block_height
),
new_created AS (
    -- 스냅샷 이후 새로 생성된 UTXO
    SELECT /*+ RANGE_JOIN(e, 1000) */
        t.block_height AS target_block, t.target_price,
        e.{range_col}, e.created_block_height,
        SUM(e.{value_col}) AS {unspent_col}, SUM(e.delta_count) AS unspent_count
    FROM target_blocks_v t
    JOIN range_agg e
        ON e.created_block_height > t.base_snapshot
        AND e.event_block_height <= t.block_height
    GROUP BY t.block_height, t.target_price, e.{range_col}, e.created_block_height
    HAVING SUM(e.{value_col}) > 0
),
combined AS (
    -- LEFT JOIN (기존) + UNION ALL (신규)
    SELECT s.target_block, s.target_price, s.{range_col},
           s.{unspent_col} + COALESCE(d.{value_col}, 0) AS {unspent_col},
           s.unspent_count + COALESCE(d.delta_count, 0) AS unspent_count
    FROM snapshot_state s
    LEFT JOIN delta_events d
        ON s.target_block = d.target_block
        AND s.{range_col} = d.{range_col}
        AND s.created_block_height = d.created_block_height
    WHERE s.{unspent_col} + COALESCE(d.{value_col}, 0) > 0
    UNION ALL
    SELECT target_block, target_price, {range_col}, {unspent_col}, unspent_count
    FROM new_created
)
-- 최종: range_col 단위로 재집계 (created_block_height 제거)
SELECT target_block, target_price, {range_col},
       SUM({unspent_col}) AS {unspent_col},
       SUM(unspent_count) AS unspent_count
FROM combined
GROUP BY target_block, target_price, {range_col}
"""
```

이 함수 하나로 두 뷰를 생성한다:

```python
spark.sql(build_distribution_view(
    "with_supply_v", "supply_range", SUPPLY_SNAPSHOT_TABLE,
    "delta_value", "unspent_value"))

spark.sql(build_distribution_view(
    "with_realized_v", "realized_range", REALIZED_SNAPSHOT_TABLE,
    "delta_realized", "unspent_realized"))
```

통합 뷰를 하나로 만들지 않은 이유: supply_range와 realized_range를 동시에 결합하면 중간 결과가 ~60B rows(약 6TB)로 폭발한다. 분리 + Python 템플릿으로 DRY를 유지하는 것이 실용적이다.

### B-1: supply 분포 (32 cols)

```python
b1_cols = pivot_aliases(SUPPLY_RANGES,
    [('val', ''), ('pct', '_percent'), ('cnt', '_count'), ('cnt_pct', '_count_percent')])

b1_df = spark.sql(f"""
WITH normalized AS (
    SELECT target_block AS block_height, supply_range,
           unspent_value AS val,
           unspent_value / NULLIF(SUM(unspent_value) OVER w, 0) * 100 AS pct,
           unspent_count AS cnt,
           unspent_count / NULLIF(SUM(unspent_count) OVER w, 0) * 100 AS cnt_pct
    FROM with_supply_v
    WINDOW w AS (PARTITION BY target_block)
),
pivoted AS (
    SELECT * FROM normalized
    PIVOT (FIRST(val) AS val, FIRST(pct) AS pct,
           FIRST(cnt) AS cnt, FIRST(cnt_pct) AS cnt_pct
           FOR supply_range IN ({b1_pivot_in}))
)
SELECT block_height,
    {b1_cols}
FROM pivoted
""")
```

### B-3: 혼합 ranges (supply BTC + realized USD + supply %)

B-3는 supply_range와 realized_range를 **모두** 사용하는 특수한 테이블이다. 두 개의 PIVOT을 수행하고 JOIN으로 결합한다:

```python
b3_df = spark.sql(f"""
WITH
by_supply AS (
    -- spent events를 supply_range로 집계
    SELECT t.block_height, u.supply_range,
           SUM(-u.delta_value) AS val
    FROM target_blocks_v t
    JOIN batch_utxo_v u
        ON u.event_block_height = t.block_height AND u.delta_count < 0
    GROUP BY t.block_height, u.supply_range
),
supply_norm AS (
    SELECT block_height, supply_range, val,
           val / NULLIF(SUM(val) OVER w, 0) * 100 AS pct
    FROM by_supply
    WINDOW w AS (PARTITION BY block_height)
),
by_realized AS (
    -- spent_output_usd_block에서 current_price 기준 realized_range 사용
    SELECT s.block_height, s.current_realized_range AS realized_range, s.spent_usd AS usd
    FROM {SPENT_USD_TABLE} s
    JOIN target_blocks_v t ON s.block_height = t.block_height
),
pivot_s AS (
    SELECT * FROM supply_norm
    PIVOT (FIRST(val) AS val, FIRST(pct) AS pct
           FOR supply_range IN ({b3_supply_pivot_in}))
),
pivot_r AS (
    SELECT * FROM by_realized
    PIVOT (FIRST(usd) AS usd
           FOR realized_range IN ({b3_realized_pivot_in}))
)
SELECT t.block_height,
    {supply_val_cols},   -- range_*: BTC 단위
    {realized_usd_cols}, -- range_*_usd: USD 단위
    {supply_pct_cols}    -- range_*_percent: 백분율
FROM target_blocks_v t
LEFT JOIN pivot_s s ON t.block_height = s.block_height
LEFT JOIN pivot_r r ON t.block_height = r.block_height
""")
```

B-3에서 realized_range를 `utxo_events_block`이 아닌 별도의 `spent_output_usd_block` 테이블에서 가져오는 이유: `utxo_events_block`의 `realized_range`는 **생성 시점 가격(created_price)** 기준이지만, B-3가 필요로 하는 것은 **현재 가격(current_price)** 기준 버케팅이다. 이벤트 테이블은 이미 개별 UTXO 금액이 집계되어 있어 current_price 기준으로 재버케팅이 불가능하므로, Phase 0.5에서 별도로 생성한 테이블을 사용한다.

## 주의할 점 (Gotchas)

### 1. Global temp view는 반드시 persist + createOrReplaceGlobalTempView 순서

```python
# 잘못된 순서 (query plan만 남음 -> 다른 세션에서 실패)
df.createOrReplaceGlobalTempView("my_view")

# 올바른 순서 (데이터가 캐시된 후 view 등록)
df.persist()
df.createOrReplaceGlobalTempView("my_view")
```

persist()가 없으면 global temp view에는 query plan만 저장된다. 다른 세션에서 이 view를 읽을 때, plan이 참조하는 소스 temp view(`target_blocks_v`, `batch_utxo_v` 등)가 해당 세션에 존재하지 않아 `AnalysisException`이 발생한다.

### 2. batch_utxo_v 하한은 exclusive(`>`) 필수

```python
# 잘못된 예 -- min_base_snapshot 블록이 스냅샷과 델타 양쪽에 이중 집계됨
WHERE event_block_height BETWEEN {min_base_snapshot} AND {batch_end}

# 올바른 예 -- 스냅샷에 이미 포함된 블록은 제외
WHERE event_block_height > {min_base_snapshot}
  AND event_block_height <= {batch_end}
```

`min_base_snapshot` 블록 자체는 이미 스냅샷에 반영된 상태다. `>=` 또는 `BETWEEN`을 사용하면 해당 블록의 이벤트가 이중 집계된다.

### 3. PIVOT IN 절에 값을 명시하지 않으면 성능 저하

```sql
-- 잘못된 예: Spark가 모든 distinct 값을 찾기 위해 데이터를 한 번 더 스캔
PIVOT (MAX(val) FOR age_range)

-- 올바른 예: 값을 명시해 extra scan 제거
PIVOT (MAX(val) FOR age_range IN ('0d_1d', '1d_1w', ..., '10y_inf'))
```

Spark의 Native PIVOT은 IN 절 값을 명시하면 `MAX(CASE WHEN ...)` 패턴과 동일한 실행 계획을 생성한다. 하지만 IN 절을 생략하면 모든 distinct 값을 수집하는 추가 스캔이 발생한다.

### 4. replaceWhere는 연속 범위에만 적합

`replaceWhere`는 Liquid Clustering의 data skipping과 결합해 predicate에 해당하는 파일만 교체한다. 하지만 predicate가 비연속적이거나 row 단위 UPDATE가 필요한 경우에는 적합하지 않다. 그런 경우 `MERGE` 문을 사용해야 한다.

### 5. 멀티태스크 잡은 반드시 Shared Cluster에서 실행

Global temp view는 SparkContext(클러스터) 레벨에서 공유된다. 멀티태스크 잡에서 각 태스크가 별도 클러스터를 사용하면 view가 격리되어 데이터 공유가 불가능하다. **Shared cluster** 설정이 필수다.

## 요약

| 노트북 | 역할 | Output |
|--------|------|--------|
| `utxo_prep.py` | Global temp view 4개 발행 + 스냅샷 캐시 | target_blocks, batch_utxo, age_agg, spent_age |
| `utxo_statistics.py` | A-1 블록 메트릭 | btc_utxo_block_metrics (22 cols) |
| `utxo_age_distribution.py` | A-2~A-7 age 분포 | 6 tables (13~39 cols each) |
| `utxo_supply_distribution.py` | B-1~B-3 supply/realized 분포 | 3 tables (16~32 cols each) |

핵심 설계 결정:

1. **Global temp view + persist**: 멀티태스크 잡에서 중간 Delta 테이블 없이 데이터 공유
2. **replaceWhere + mode("overwrite")**: 모든 write를 idempotent하게 통일
3. **Python 템플릿(build_distribution_view, pivot_cols)**: 반복되는 SQL 패턴을 DRY하게 관리
4. **VIEW(unspent_age_v) vs persist(age_agg_v)**: consumer 수에 따라 캐시 전략 차별화
5. **AQE 설정 튜닝**: advisory partition size와 broadcast threshold를 워크로드에 맞게 조정

## 다음 단계

1. **Databricks Job Workflow 구성**
   - bb_mapper -> utxo_prep -> (statistics, age_distribution, supply_distribution 병렬) -> ingestion
   - Shared cluster 설정 (global temp view 공유를 위해 필수)

2. **실행 테스트 및 검증**
   - 샘플 배치(10,000 블록)로 end-to-end 테스트
   - PostgreSQL 기존 시스템 결과와 수치 비교 (sampling)

3. **성능 튜닝**
   - 클러스터 크기 최적화 (Process A: 대형, Process B: 소형)
   - repartition 전략 조정 (현재 800 기준)
   - persist storage level 조정 (MEMORY vs MEMORY_AND_DISK)

4. **Exchange Inflow 메트릭 노트북 구현**
   - 07 문서 설계 기반, 하이브리드 접근(entity_flow_transaction + utxo_base)
   - 3 output tables (age/supply distribution + CDD)

5. **Market 메트릭 Spark 이관**
   - SOPR, CDD, realized_cap 계산 로직 설계
   - 03 문서 기반 구현

## Reference

### 노트북 파일

- `notebooks/utxo_prep.py` -- 준비 노트북 (global temp view 4개 발행)
- `notebooks/utxo_statistics.py` -- A-1 블록 메트릭
- `notebooks/utxo_age_distribution.py` -- A-2~A-7 age 분포 6 tables
- `notebooks/utxo_supply_distribution.py` -- B-1~B-3 supply/realized 분포 3 tables

### 관련 설계 문서

- `docs/spark/06_optimized_queries.md` -- 전체 아키텍처, Phase 0/0.5/1, 배치 실행 코드
- `docs/spark/06a_process_a.md` -- Process A 상세 쿼리 (unspent_age_v, age_agg_v, spent_age_v, A-1~A-7)
- `docs/spark/06b_process_b.md` -- Process B 상세 쿼리 (build_distribution_view, B-1~B-3)
- `docs/spark/07_exchange_inflow_metrics.md` -- Exchange Inflow 메트릭 설계 (미구현)

### 공식 문서

- [Databricks: Global Temporary Views (SQL Reference)](https://docs.databricks.com/sql/language-manual/sql-ref-syntax-ddl-create-view.html)
- [Databricks: Adaptive Query Execution (AQE)](https://docs.databricks.com/optimizations/aqe.html)
- [Databricks: Notebook Workflows (global temp view 활용)](https://docs.databricks.com/notebooks/notebook-workflows.html)
- [Databricks: dbutils.widgets](https://docs.databricks.com/dev-tools/databricks-utils.html#widget-utilities)
- [Delta Lake: Selective Overwrite (replaceWhere)](https://docs.delta.io/latest/delta-batch.html#selective-overwrite)
- [Databricks: Multi-task Jobs](https://docs.databricks.com/workflows/jobs/jobs.html)
