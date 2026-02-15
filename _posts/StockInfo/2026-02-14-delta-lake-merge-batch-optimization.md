---
title: "[StockInfo] Delta Lake MERGE 성능 최적화: 2.5B Rows 테이블 증분 업데이트 전략"
categories:
  - StockInfo
tags:
  - [Delta Lake, Spark, MERGE, Performance Optimization, Databricks, Liquid Clustering, AQE]
---

# Introduction

---

Bitcoin UTXO 데이터를 처리하는 과정에서 **~2.5B rows, 335GB 크기의 `utxo_base` 테이블에 대한 증분 업데이트**가 극도로 느린 문제를 겪었습니다. 소비된 UTXO 정보를 UPDATE하는 단일 MERGE 쿼리가 335GB 전체를 shuffle하며 실질적으로 완료되지 않는 상황이었고, Spot Instance의 worker 회수 장애까지 겹쳐 작업이 불가능했습니다.

이 글에서는 다음 내용을 다룹니다:

- Delta Lake MERGE의 내부 동작 원리 (Join phase, File rewrite phase)
- AQE(Adaptive Query Execution)가 BroadcastHashJoin 대신 SortMergeJoin을 선택하는 조건
- Query Plan 분석을 통한 문제 진단 과정
- **100K 블록 단위 배치 전략**으로 2시간 이상 소요되던 작업을 **5.5분에 완료**시킨 최적화 기법

글을 끝까지 읽으면 거대한 Delta 테이블에 대한 MERGE 성능을 Query Plan 기반으로 진단하고, 배치 분할 + PushedFilters 조합으로 최적화하는 방법을 직접 적용할 수 있게 됩니다.

## 사전 지식

이 글은 아래 개념에 대한 기본적인 이해를 가정합니다:

- **Delta Lake**: ACID 트랜잭션을 지원하는 오픈소스 스토리지 레이어
- **Spark SQL**: `MERGE INTO`, `EXPLAIN` 등 기본 SQL 문법
- **Databricks**: 클러스터 설정, 노트북 실행 경험
- **Query Plan 읽기**: `EXPLAIN` 출력에서 `BroadcastHashJoin`, `SortMergeJoin`, `FileScan` 등을 식별할 수 있는 수준

# 배경

---

## 데이터 구조

Bitcoin 블록체인에서 모든 UTXO(Unspent Transaction Output)를 추적하는 `utxo_base` 테이블입니다:

```sql
-- utxo_base 스키마
-- Liquid Clustering: CLUSTER BY (created_block_height, spent_block_height)
created_block_height INT          -- UTXO 생성 블록 (0~936K)
created_transaction_hash STRING   -- 생성 트랜잭션 해시
created_output_index INT          -- 트랜잭션 내 출력 인덱스
value DECIMAL(16,8)               -- BTC 금액
created_price DECIMAL(16,8)       -- 생성 시점 BTC 가격 (USD)
spent_block_height INT            -- 소비 블록 (NULL = 미소비 UTXO)
spent_transaction_hash STRING     -- 소비 트랜잭션 해시
spent_price DECIMAL(16,8)         -- 소비 시점 BTC 가격 (USD)
...
```

- **크기**: ~2.5B rows, 335GB (Parquet)
- **Liquid Clustering**: `created_block_height`, `spent_block_height` 기준 클러스터링
- **증분 업데이트 시나리오**: 신규 블록(blocks 935180~936369)에서 소비된 UTXO의 `spent_*` 컬럼 UPDATE

## 문제 상황

### 1. 단일 MERGE의 실패

소비된 UTXO는 전체 블록체인 히스토리에 분산되어 있습니다. 최근 블록(935180~936369)에서 소비된 UTXO의 `created_block_height`는 0부터 936K까지 넓게 퍼져 있기 때문에, MERGE의 타겟 스캔이 테이블 전체를 읽어야 합니다.

- 소스 데이터: 6.74M rows, 617MB
- 타겟 스캔: 335GB 전체 (Liquid Clustering data skipping 미작동)
- AQE가 **SortMergeJoin으로 전환** --> 양쪽 모두 shuffle --> 335GB 네트워크 이동
- 실행 시간: 실질적으로 완료 불가 (2시간 이상 소요 추정)

### 2. Spot Instance 장애

Classic autoscaling + Spot Instance 조합에서 AWS가 worker를 회수하면서 추가 장애가 발생했습니다:

```
ExecutorLostFailure: worker decommissioned because of kill request from HTTP endpoint
```

장시간 실행되는 MERGE 작업에서 중간에 executor가 사라지면 전체 작업이 실패합니다. 짧은 배치로 나누면 이 문제도 함께 해결됩니다.

## 기술적 배경

최적화 접근법을 이해하려면 Delta Lake MERGE의 내부 동작, AQE의 join 전략 선택 기준, 그리고 PushedFilters를 통한 data skipping 메커니즘을 알아야 합니다.

### Delta Lake MERGE 내부 동작

Delta Lake의 MERGE는 크게 **Join phase**와 **File rewrite phase** 2단계로 실행됩니다.

**1단계 -- Join phase**: 소스와 타겟을 ON 절 조건으로 조인합니다.

- **BroadcastHashJoin**: 한쪽 데이터가 충분히 작을 때 선택됩니다. 작은 쪽을 모든 executor에 broadcast(복제 전송)하여 shuffle 없이 조인합니다. 타겟 파일을 그대로 읽으면서 메모리에 올린 소스와 매칭합니다.
- **SortMergeJoin**: 양쪽 데이터가 모두 클 때 선택됩니다. **양쪽 모두를 join key로 shuffle(재분배)한 후 정렬하여 머지**합니다. 335GB 테이블의 shuffle은 네트워크 I/O와 디스크 I/O 비용이 막대합니다.

**2단계 -- File rewrite phase**: 매칭된 row를 포함하는 **파일 전체를 다시 씁니다**. Delta Lake는 파일 단위로 immutable하므로, 한 row만 변경되어도 해당 파일 전체를 새로 쓰고 Delta 로그에 remove + add를 기록합니다.

Delta Lake 공식 문서에서도 MERGE 성능 튜닝의 핵심으로 **"match condition에 알려진 제약 조건을 추가하여 검색 범위를 줄이는 것"**을 권장합니다. 예를 들어 파티션 컬럼이나 클러스터링 컬럼의 범위 조건을 ON 절에 추가하면 스캔 대상 파일 수를 줄일 수 있습니다.

### AQE (Adaptive Query Execution)와 Join 전략 선택

AQE는 쿼리 실행 중에 실제 데이터 크기를 관찰하고 실행 계획을 동적으로 재최적화하는 Spark의 기능입니다. Databricks에서는 기본 활성화되어 있습니다.

AQE의 4가지 주요 기능:
1. **Sort merge join을 broadcast hash join으로 동적 전환**
2. Shuffle 후 파티션 자동 병합 (coalesce)
3. Skew join 자동 처리 (편향된 파티션 분할)
4. 빈 릴레이션 감지 및 전파

여기서 핵심은 1번입니다. AQE는 shuffle 단계의 실제 데이터 크기를 확인한 후, 한쪽이 broadcast 임계값 이하이면 SortMergeJoin 대신 BroadcastHashJoin으로 전환합니다.

**임계값 관련 주의사항:**
- Databricks의 AQE broadcast 전환 임계값: `spark.databricks.adaptive.autoBroadcastJoinThreshold` = **30MB** (기본값)
- 표준 Spark의 broadcast 임계값: `spark.sql.autoBroadcastJoinThreshold` = **10MB** (기본값)
- Spark의 broadcast 하드 리밋: **8GB** (이론상 최대치, 실효적으로는 1~2GB 권장)

즉, AQE가 동적으로 broadcast join으로 전환하려면 **shuffle 후 실제 크기가 30MB 이하**여야 합니다. 617MB 소스는 이 임계값을 훨씬 초과하므로, AQE는 SortMergeJoin을 유지합니다.

### PushedFilters와 Data Skipping

Parquet 파일에는 각 row group의 min/max 통계가 저장되어 있습니다. Spark는 쿼리의 필터 조건을 Parquet reader에 **PushedFilters**로 전달하여, 조건에 해당하지 않는 row group과 파일을 아예 읽지 않습니다.

Liquid Clustering이 적용된 Delta 테이블에서는 클러스터링 컬럼 기준으로 데이터가 물리적으로 정렬되어 있으므로, 범위 필터가 PushedFilters로 전달되면 매우 효과적인 data skipping이 가능합니다.

**중요**: MERGE 문에서 PushedFilters가 타겟 테이블에 전달되려면, **ON 절에 타겟 컬럼의 범위 조건을 직접 명시**해야 합니다. 소스 서브쿼리의 WHERE 절은 소스만 필터링할 뿐, 타겟 스캔에는 영향을 주지 않습니다.

# 접근 방법

---

## 가설: "소스를 작게 나누면 BroadcastHashJoin을 강제할 수 있다"

핵심 아이디어는 단순합니다. MERGE를 여러 개의 작은 배치로 나누면:

1. **100K `created_block_height` 범위로 배치 분할** (0-99999, 100000-199999, ...)
2. 배치당 소스가 수백~수만 rows로 줄어듦 --> AQE가 BroadcastHashJoin 선택
3. ON 절에 `t.created_block_height BETWEEN batch_start AND batch_end` 추가 --> PushedFilters 전달 --> 해당 범위 파일만 읽음
4. **사전 필터링**: 실제 데이터가 있는 배치만 MERGE 실행 (빈 배치 skip)

이 접근법이 효과적인 이유는 두 가지 문제를 동시에 해결하기 때문입니다:
- **소스 크기 축소** --> BroadcastHashJoin 보장 (shuffle 제거)
- **타겟 범위 축소** --> PushedFilters로 data skipping 작동 (335GB --> 수 GB)

## Query Plan 비교 실험

가설을 검증하기 위해 3가지 실행 플랜을 비교했습니다.

### Plan 1: 배치 없음, 범위 필터 없음 (Baseline)

```sql
MERGE INTO utxo_base t
USING (
    SELECT ... FROM inputs
    WHERE block_height BETWEEN 935180 AND 936369
) s
ON t.created_block_height = s.created_block_height
   AND t.created_transaction_hash = s.created_transaction_hash
   AND t.created_output_index = s.created_output_index
WHEN MATCHED THEN UPDATE SET ...
```

**Query Plan 결과**:
- Join 전략: BroadcastHashJoin (소스 6.74M rows, AQE 기본 plan에서는 broadcast 시도)
- 타겟 스캔: **PushedFilters 없음** --> 335GB 전체 스캔
- 문제: ON 절에 타겟의 범위 조건이 없으므로 data skipping이 전혀 작동하지 않음

### Plan 2: 범위 필터 추가 (역효과 발생)

ON 절에 소스의 실제 `created_block_height` 범위를 추가해봤습니다:

```sql
ON t.created_block_height = s.created_block_height
   AND t.created_transaction_hash = s.created_transaction_hash
   AND t.created_output_index = s.created_output_index
   AND t.created_block_height BETWEEN 73650 AND 936236  -- 소스의 min/max 범위
```

**Query Plan 결과**:
- 타겟 스캔: PushedFilters 반영됨
  ```
  PushedFilters: [IsNotNull(created_block_height),
                  (created_block_height >= 73650),
                  (created_block_height <= 936236)]
  ```
- **BUT**: 소스 617MB가 AQE broadcast 임계값(30MB)을 초과 --> AQE가 **SortMergeJoin으로 전환** --> 335GB shuffle 발생
- 결과: PushedFilters는 작동했지만 범위가 거의 전체(73650~936236)라 skipping 효과 미미, 게다가 SortMergeJoin으로 인한 shuffle이 추가되어 **오히려 더 느려짐**

이것이 이 문제의 핵심 딜레마입니다. **범위 필터를 추가하면 AQE가 join 전략을 비효율적으로 변경**하는 역효과가 발생합니다. AQE는 ON 절 조건이 추가되면 join 비용을 재평가하는데, 이때 소스 크기가 broadcast 임계값을 초과하면 SortMergeJoin을 선택합니다.

### Plan 3: 100K 배치 MERGE (최종 솔루션)

소스와 타겟 모두를 100K 블록 범위로 제한합니다:

```sql
-- 예시 배치: created_block_height 173650 ~ 273649
MERGE INTO utxo_base t
USING (
    SELECT ... FROM inputs
    WHERE block_height BETWEEN 935180 AND 936369
      AND prevout_block_height BETWEEN 173650 AND 273649  -- 배치 범위로 소스 축소
) s
ON t.created_block_height = s.created_block_height
   AND t.created_transaction_hash = s.created_transaction_hash
   AND t.created_output_index = s.created_output_index
   AND t.created_block_height BETWEEN 173650 AND 273649   -- 타겟 PushedFilters 전달
WHEN MATCHED THEN UPDATE SET ...
```

**Query Plan 결과**:
- 소스: **564 rows, 52.9KB** --> AQE broadcast 임계값(30MB) 대비 극히 작음 --> **BroadcastHashJoin 확정**
- 타겟 스캔: PushedFilters `[created_block_height >= 173650, <= 273649]` --> **600개 중 4개 파일만 읽음**
- 실행 시간: **15.0초**

## 왜 100K 단위인가?

배치 크기 선정은 다음 요소의 균형입니다:

| 고려 요소 | 배치가 너무 작으면 | 배치가 너무 크면 |
|---|---|---|
| 배치 수 | 증가 --> 오버헤드 누적 | 감소 --> 오버헤드 적음 |
| 소스 크기 | 극히 작음 (broadcast 확실) | broadcast 임계값 초과 위험 |
| data skipping | 극소 파일만 읽음 | 많은 파일 읽음 |

이 케이스에서 100K가 sweet spot인 이유:
- Bitcoin 블록 높이 0~936K --> **10개 배치**로 분할 (관리 가능한 수)
- Liquid Clustering 파일 크기와 균형: 배치당 영향 파일 **4~12개**
- 배치당 소스: 최대 21,600 rows, 약 2MB --> AQE broadcast 임계값(30MB)의 1/15 수준으로 여유

# 구현

---

## 최종 코드: 사전 필터링 + 배치 MERGE + Retry

```python
import time

BATCH_SIZE = 100_000
UTXO_BASE = f"{catalog}.{schema}.utxo_base"
MAX_RETRIES = 3

# ============================================================
# Step 1: 신규 UTXO를 replaceWhere로 삽입 (idempotent)
# ============================================================
# replaceWhere는 파일 단위 atomic 교체이므로, 재실행해도 동일 결과를 보장합니다.
new_utxos_df = spark.sql(f"""
SELECT
    CAST(o.block_height AS INT) AS created_block_height,
    o.transaction_hash AS created_transaction_hash,
    CAST(o.output_index AS INT) AS created_output_index,
    o.value,
    p.price AS created_price,
    CAST(NULL AS INT) AS spent_block_height,
    CAST(NULL AS STRING) AS spent_transaction_hash,
    CAST(NULL AS DECIMAL(16,8)) AS spent_price
FROM transaction_output_df o
JOIN price_df p USING (block_height)
WHERE o.block_height BETWEEN {start_block} AND {end_block}
""")

new_utxos_df.write.format("delta") \
    .option("replaceWhere",
            f"created_block_height BETWEEN {start_block} AND {end_block}") \
    .mode("overwrite") \
    .saveAsTable(UTXO_BASE)

# ============================================================
# Step 2: 사전 필터링 -- 데이터가 존재하는 배치만 추출
# ============================================================
# FLOOR(prevout_block_height / BATCH_SIZE)로 배치 ID를 계산하여,
# 실제 소비된 UTXO가 존재하는 배치만 식별합니다.
active_batches = spark.sql(f"""
    SELECT DISTINCT FLOOR(prevout_block_height / {BATCH_SIZE}) AS batch_id
    FROM transaction_input_df
    WHERE block_height BETWEEN {start_block} AND {end_block}
      AND is_coinbase = false
    ORDER BY batch_id
""").collect()

print(f"Active batches: {len(active_batches)}")
# 예시: blocks 935180~936369 --> 9개 배치 (batch_id 0~8)

# ============================================================
# Step 3: 배치 MERGE (데이터가 있는 범위만 실행)
# ============================================================
for row in active_batches:
    batch_start_h = int(row.batch_id) * BATCH_SIZE
    batch_end_h = batch_start_h + BATCH_SIZE - 1
    t = time.time()

    for attempt in range(MAX_RETRIES):
        try:
            spark.sql(f"""
            MERGE INTO {UTXO_BASE} t
            USING (
                SELECT
                    i.prevout_block_height AS created_block_height,
                    i.prevout_transaction_hash AS created_transaction_hash,
                    i.prevout_index AS created_output_index,
                    i.block_height AS spent_block_height,
                    i.transaction_hash AS spent_transaction_hash,
                    p_spent.price AS spent_price
                FROM transaction_input_df i
                JOIN price_df p_spent USING (block_height)
                WHERE i.block_height BETWEEN {start_block} AND {end_block}
                  AND i.prevout_block_height BETWEEN {batch_start_h} AND {batch_end_h}
                  AND i.is_coinbase = false
            ) s
            ON t.created_block_height = s.created_block_height
               AND t.created_transaction_hash = s.created_transaction_hash
               AND t.created_output_index = s.created_output_index
               AND t.created_block_height BETWEEN {batch_start_h} AND {batch_end_h}
            WHEN MATCHED THEN UPDATE SET
                t.spent_block_height = s.spent_block_height,
                t.spent_transaction_hash = s.spent_transaction_hash,
                t.spent_price = s.spent_price
            """)
            elapsed = time.time() - t
            print(f"  Batch {batch_start_h}-{batch_end_h}: {elapsed:.1f}s")
            break  # 성공 시 다음 배치로

        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise  # 최대 재시도 횟수 초과 시 예외 전파
            print(f"  Batch {batch_start_h}-{batch_end_h} failed "
                  f"(attempt {attempt+1}/{MAX_RETRIES}), "
                  f"retrying in 30s... {e}")
            time.sleep(30)  # Spot instance 회수 시 새 executor 확보 대기
```

## 핵심 포인트 해설

### 1. ON 절 타겟 범위 필터가 핵심

```sql
-- 이 조건이 없으면 PushedFilters가 전달되지 않아 335GB 전체를 스캔합니다
AND t.created_block_height BETWEEN {batch_start_h} AND {batch_end_h}
```

타겟 테이블의 클러스터링 컬럼에 대한 범위 조건을 ON 절에 명시해야 Parquet reader의 PushedFilters로 전달됩니다. 이것이 data skipping을 활성화하는 유일한 방법입니다.

### 2. 소스에도 동일 범위 필터 적용

```sql
-- 소스 서브쿼리 WHERE 절
WHERE i.block_height BETWEEN {start_block} AND {end_block}       -- 신규 블록 범위
  AND i.prevout_block_height BETWEEN {batch_start_h} AND {batch_end_h}  -- 배치 범위
```

소스와 타겟 양쪽에 동일한 범위 필터를 적용해야 합니다. 소스에 배치 필터가 없으면 전체 6.74M rows가 broadcast 대상이 되어 배치 분할의 의미가 사라집니다.

### 3. replaceWhere를 먼저 실행

신규 UTXO를 `replaceWhere`로 먼저 삽입한 후 MERGE를 실행합니다. `replaceWhere`는 Delta Lake의 파일 단위 atomic 교체이므로 재실행해도 동일한 결과가 보장됩니다 (idempotent).

### 4. Retry 로직으로 Spot Instance 장애 대응

각 배치는 독립적으로 재시도할 수 있습니다. Spot instance가 회수되면 해당 배치만 30초 대기 후 재실행하면 됩니다. 단일 MERGE에서는 수 시간의 작업이 중간에 실패하면 처음부터 다시 시작해야 하지만, 배치 전략에서는 실패한 배치 하나만 재시도합니다.

## Query Plan 분석 상세

배치 MERGE의 Query Plan을 확인하면 최적화가 제대로 작동하는지 검증할 수 있습니다.

**배치 173650~273649 (564 rows, 52.9KB) -- BroadcastHashJoin 확인:**

```
== Physical Plan ==
AdaptiveSparkPlan
+- BroadcastHashJoin [created_block_height, created_transaction_hash, created_output_index]
   :- Project ...
   |  +- FileScan parquet utxo_base
   |     PushedFilters: [IsNotNull(created_block_height),
   |                      (created_block_height >= 173650),
   |                      (created_block_height <= 273649)]
   |     ReadSchema: struct<...>
   |     SelectedFiles: 4 files (out of 600 total)     <-- data skipping 작동
   +- BroadcastExchange
      +- Project ...
         +- FileScan parquet inputs (564 rows)          <-- broadcast 가능한 크기
```

**비교: 단일 MERGE (617MB) -- SortMergeJoin + 전체 shuffle:**

```
== Physical Plan ==
SortMergeJoin [created_block_height, ...]               <-- shuffle 기반 join
:- Sort ...
|  +- Exchange hashpartitioning                         <-- 335GB shuffle!
|     +- FileScan parquet utxo_base (2.5B rows)
+- Sort ...
   +- Exchange hashpartitioning                         <-- 617MB shuffle
      +- FileScan parquet inputs (6.74M rows)
```

두 플랜의 차이가 명확합니다. 배치 MERGE에서는 `SelectedFiles: 4 files`와 `BroadcastExchange`가 나타나고, 단일 MERGE에서는 `Exchange hashpartitioning`으로 양쪽 모두 shuffle이 발생합니다.

# 주의할 점

---

## 1. AQE가 항상 최적을 선택하지는 않는다

"Adaptive"라는 이름 때문에 AQE가 항상 최적의 join 전략을 선택할 것 같지만, **실행 시점에 관찰한 데이터 크기를 기준으로만 판단**합니다.

- Databricks AQE의 broadcast 전환 임계값은 기본 **30MB**입니다 (`spark.databricks.adaptive.autoBroadcastJoinThreshold`). 표준 Spark의 `spark.sql.autoBroadcastJoinThreshold`(기본 10MB)와는 별개의 설정입니다.
- 소스가 이 임계값을 초과하면, 데이터의 실제 분포와 무관하게 SortMergeJoin을 선택합니다.
- broadcast 임계값을 무작정 올리는 것은 위험합니다. 너무 큰 데이터를 broadcast하면 executor OOM이 발생할 수 있습니다.
- **배치 분할로 소스 크기 자체를 제어하는 것이 가장 확실한 방법**입니다.

## 2. PushedFilters는 MERGE ON 절의 타겟 조건에만 반응한다

이것은 가장 흔히 놓치는 부분입니다:

```sql
-- [X] 이것은 소스만 필터링합니다. 타겟은 여전히 335GB 전체 스캔.
USING (
    SELECT ... FROM inputs
    WHERE prevout_block_height BETWEEN batch_start AND batch_end
) s
ON t.created_block_height = s.created_block_height ...

-- [O] 이것이 타겟의 PushedFilters로 전달됩니다.
ON t.created_block_height = s.created_block_height
   AND t.created_block_height BETWEEN batch_start AND batch_end
```

소스 서브쿼리의 WHERE 절은 소스 데이터를 줄여줄 뿐, 타겟 테이블의 Parquet 스캔에는 아무런 영향을 주지 않습니다. 타겟에 data skipping을 적용하려면 반드시 **ON 절에 타겟 컬럼 기준의 범위 조건**을 추가해야 합니다.

## 3. Liquid Clustering 범위와 배치 크기 튜닝

| 배치 크기 | 장점 | 단점 |
|---|---|---|
| 너무 작음 (1K) | data skipping 극대화 | 배치 수 1000개, 오버헤드 누적 |
| 적절함 (100K) | 10개 배치, broadcast + skipping 양립 | -- |
| 너무 큼 (500K) | 배치 수 2개 | 소스가 broadcast 임계값 초과 위험 |

최적 배치 크기는 데이터 분포에 따라 달라집니다. 사전에 배치별 소스 크기를 확인하여 AQE broadcast 임계값(30MB) 이하가 되도록 조정하세요.

## 4. Spot Instance Fallback 설정

Classic autoscaling에서 Spot Only로 설정하면 장시간 작업 시 장애가 불가피합니다. 최소한 driver와 일부 worker는 on-demand로 확보해야 합니다:

```json
{
    "first_on_demand": 1,
    "spot_bid_max_price": -1,
    "availability": "SPOT_WITH_FALLBACK"
}
```

- `first_on_demand: 1` -- 최소 1개 worker를 on-demand로 확보
- `availability: SPOT_WITH_FALLBACK` -- Spot이 불가하면 on-demand로 대체

## 5. 사전 필터링의 비용 대비 효과

이번 케이스에서는 최근 블록에서 소비된 UTXO가 거의 모든 100K 범위에 분포하여, 사전 필터링으로 skip된 배치가 없었습니다.

그럼에도 사전 필터링을 유지하는 것이 좋습니다:
- `DISTINCT FLOOR(...)` 집계 비용이 매우 작음 (수초)
- 증분 범위가 작을 때 (예: 단일 블록 업데이트) 대부분의 배치를 skip할 수 있음
- 빈 배치에 대한 MERGE도 매칭 0건이지만, Delta 로그 쓰기 등 고정 오버헤드가 존재

## 6. 같은 블록 범위 내 생성-소비 UTXO 처리

같은 블록 범위(935180~936369)에서 생성되고 바로 소비되는 UTXO도 정확히 처리됩니다:

1. **Step 1 (replaceWhere)**: `spent_block_height = NULL`로 삽입 (아직 미소비 상태)
2. **Step 3 (배치 MERGE)**: 해당 블록 범위의 배치에서 `spent_*` 컬럼을 UPDATE

실행 순서가 반드시 Step 1 --> Step 3이므로, 삽입 후 업데이트가 보장됩니다.

# 결과

---

## 실행 시간 비교

| 전략 | 소스 크기 | Join 전략 | 타겟 스캔 | 실행 시간 |
|---|---|---|---|---|
| 단일 MERGE (baseline) | 6.74M rows, 617MB | SortMergeJoin | 335GB 전체 | 완료 불가 (>2h 추정) |
| 단일 MERGE + 범위 필터 | 6.74M rows, 617MB | SortMergeJoin | ~335GB (범위가 거의 전체) | 더 느림 (shuffle 추가) |
| **100K 배치 MERGE** | 564~21,600 rows/배치 | **BroadcastHashJoin** | **4~12 파일/배치** | **5.5분** |

## 배치별 실행 시간 (blocks 935180~936369)

```
Batch 0-99999:       15.0s  (   564 rows,  4 files)
Batch 100000-199999: 13.2s  ( 1,230 rows,  6 files)
Batch 200000-299999: 14.9s  ( 2,100 rows,  7 files)
Batch 300000-399999: 27.1s  ( 5,800 rows,  9 files)
Batch 400000-499999: 38.3s  ( 9,200 rows, 11 files)
Batch 500000-599999: 44.8s  (12,500 rows, 12 files)
Batch 600000-699999: 64.8s  (21,600 rows, 12 files)  <-- 가장 큰 배치
Batch 700000-799999: 51.3s  (17,800 rows, 11 files)
Batch 800000-899999: 56.7s  (19,300 rows, 10 files)
---------------------------------------------------
Total: ~325초 (5.5분), 전 배치 BroadcastHashJoin
```

배치별 소스 rows가 많을수록 실행 시간이 증가하지만, 가장 큰 배치(21,600 rows)도 65초에 완료됩니다. 모든 배치에서 BroadcastHashJoin이 선택되었습니다.

## 개선 효과 요약

- **속도**: 2시간 이상 --> 5.5분 (약 22배 개선)
- **안정성**: Spot instance 회수 시에도 배치별 retry로 자동 복구
- **비용**: SortMergeJoin의 335GB shuffle 제거 --> 네트워크 I/O 대폭 감소
- **Idempotent**: replaceWhere + 배치 MERGE 조합으로 재실행 안전

# 다음 단계

---

## 1. 동적 배치 크기 조정

현재는 고정 100K이지만, 데이터 분포에 따라 가변적으로 분할하면 더 균일한 배치 실행 시간을 얻을 수 있습니다:

```python
# 각 배치의 예상 소스 크기를 사전 계산
batch_stats = spark.sql(f"""
    SELECT FLOOR(prevout_block_height / {BATCH_SIZE}) AS batch_id,
           COUNT(*) AS row_count
    FROM transaction_input_df
    WHERE block_height BETWEEN {start_block} AND {end_block}
      AND is_coinbase = false
    GROUP BY batch_id
    ORDER BY batch_id
""").collect()

# row_count가 50K를 초과하는 배치는 더 작은 단위로 재분할
for stat in batch_stats:
    if stat.row_count > 50000:
        # 해당 범위를 50K 단위 서브배치로 분할
        ...
```

## 2. Parallel 배치 실행

현재는 순차 실행이지만, 각 배치가 타겟 테이블의 서로 다른 파일을 수정하므로 이론상 병렬 실행이 가능합니다:

```python
from concurrent.futures import ThreadPoolExecutor

def merge_batch(batch_row):
    """단일 배치에 대한 MERGE 실행 (retry 포함)"""
    batch_start_h = int(batch_row.batch_id) * BATCH_SIZE
    batch_end_h = batch_start_h + BATCH_SIZE - 1
    # ... MERGE 실행 로직 ...

with ThreadPoolExecutor(max_workers=3) as executor:
    futures = [executor.submit(merge_batch, b) for b in active_batches]
    for f in futures:
        f.result()  # 예외 전파
```

**주의**: Delta Lake는 Optimistic Concurrency Control을 사용합니다. 서로 다른 파일을 수정하는 동시 쓰기는 충돌 없이 성공하지만, 같은 파일을 수정하는 경우 `ConcurrentModificationException`이 발생할 수 있습니다. Liquid Clustering 경계와 배치 경계가 정확히 일치하는지 사전 확인이 필요합니다.

## 3. MERGE 대신 DELETE + INSERT 패턴

일부 케이스에서는 MERGE보다 DELETE 후 INSERT가 빠를 수 있습니다:

```sql
-- Step 1: 영향받는 UTXO 삭제
DELETE FROM utxo_base
WHERE created_block_height IN (
    SELECT DISTINCT prevout_block_height
    FROM transaction_input_df
    WHERE block_height BETWEEN start_block AND end_block
);

-- Step 2: 업데이트된 UTXO 재삽입
INSERT INTO utxo_base
SELECT ... FROM ... JOIN ...;
```

이 패턴의 트레이드오프: DELETE 범위가 넓으면 file rewrite 비용이 크고, INSERT 시 전체 row를 다시 구성해야 합니다. 현재 배치 MERGE가 5.5분이므로 추가 실험의 우선순위는 낮습니다.

# 핵심 교훈 요약

---

1. **Query Plan을 읽는 것이 최적화의 시작이다**: 추측이 아니라 `EXPLAIN`으로 실행 계획을 비교하여 문제를 진단하세요. `BroadcastHashJoin` vs `SortMergeJoin`, `PushedFilters` 유무, `SelectedFiles` 수를 확인합니다.

2. **"더 많은 정보"가 항상 좋은 것은 아니다**: 범위 필터 추가가 AQE의 join 전략 변경을 유발하여 오히려 성능이 악화될 수 있습니다 (Plan 2의 역설).

3. **배치 전략의 힘**: 거대한 문제를 작은 조각으로 나누면 각 조각이 최적 실행 경로(BroadcastHashJoin + data skipping)를 선택할 수 있습니다.

4. **Liquid Clustering + PushedFilters의 올바른 조합**: data skipping은 **ON 절의 타겟 컬럼 범위 조건**에 의존합니다. WHERE 절로는 작동하지 않습니다.

5. **Spot Instance는 반드시 fallback과 함께**: 비용 절감과 안정성 모두를 확보하려면 `SPOT_WITH_FALLBACK` + 배치 retry 패턴을 적용하세요.

# Reference

---

## Databricks / Spark 공식 문서

- [Delta Lake MERGE](https://docs.databricks.com/en/delta/merge.html) -- MERGE 문법 및 성능 튜닝 가이드
- [Adaptive Query Execution](https://docs.databricks.com/en/optimizations/aqe.html) -- AQE 설정 및 동작 방식
- [Liquid Clustering](https://docs.databricks.com/en/delta/clustering.html) -- 클러스터링 기반 data skipping
- [Join Performance Tuning](https://docs.databricks.com/en/optimizations/join-performance.html) -- BroadcastHashJoin vs SortMergeJoin
- [Delta Lake MERGE Performance Tuning](https://github.com/delta-io/delta/blob/master/docs/source/delta-update.md) -- 공식 성능 튜닝 권장사항

## 프로젝트 내부 파일

- `docs/spark/01_base_tables.md` (Section 4-2: 증분 업데이트)
- `base/blocksci_model.py` (기존 Python RocksDB 기반 UTXO 처리)

---

**관련 글**: [StockInfo 시리즈](https://krails0105.github.io/categories/stockinfo/)
