---
layout: post
title: "Databricks Serverless에서 ThreadPoolExecutor + persist Race Condition 디버깅 및 Backfill"
date: 2026-03-05
categories: [DataEngineering]
tags: [Databricks, PySpark, DeltaLake, ThreadPoolExecutor, UTXO, Bitcoin, Backfill, Debugging, Serverless, RaceCondition]
---

## 들어가며

Bitcoin on-chain ETL 파이프라인을 운영하다 보면, "왜 이 블록만 이상한 값이지?"라는 상황을 마주할 때가 있다. 이번 글에서는 `utxo_sca_age_distribution_block` (A-3) 테이블의 특정 블록 데이터가 전부 0으로 저장된 문제를 시작으로, **10개 테이블 x 수십만 블록 범위의 전수 검사**를 진행하고, 누락된 57개 블록을 Backfill한 과정을 기록한다.

**핵심 원인**은 `ThreadPoolExecutor(max_workers=4)`로 복잡한 PIVOT 쿼리를 동시에 실행할 때, `persist()`된 DataFrame에서 **간헐적으로 빈 결과가 반환**되는 race condition이었다. Databricks Serverless 환경 특유의 자원 스케줄링이 이 현상을 유발했고, 전용 클러스터(existing_cluster_id)로 전환하여 해결했다.

이 글을 통해 다음을 배울 수 있다:

- Delta Lake `DESCRIBE HISTORY`의 `operationMetrics`를 활용한 데이터 누락 진단법
- `ThreadPoolExecutor` + `persist()` 조합에서 발생하는 race condition의 증거 수집 방법
- 체계적인 가설 수립 및 기각 과정
- Serverless compute 제약 사항과 Backfill 전략

## 전제 조건

- **Databricks Workspace**: Unity Catalog가 활성화된 환경
- **Delta Lake**: `DESCRIBE HISTORY` 명령어 사용 가능 (Delta Lake 기본 기능)
- **PySpark**: `DataFrame.persist()`, `ThreadPoolExecutor` 사용 경험
- **도메인 지식**: Bitcoin UTXO(Unspent Transaction Output) 개념에 대한 기본 이해

## 파이프라인 구조

`utxo_stat_and_age_dist_block.ipynb`는 Bitcoin UTXO 상태를 나이(age) 기준으로 분류하여 7개 테이블을 동시에 생성하는 파이프라인이다.

| 코드명 | 테이블 | 설명 |
|---|---|---|
| A-1 | `utxo_statistics_block` | UTXO 집계 통계 (단순 GROUP BY) |
| A-2 | `utxo_age_distribution_block` | 나이별 공급량 분포 (PIVOT) |
| A-3 | `utxo_sca_age_distribution_block` | 나이별 Satoshi-Coin-Age 분포 (PIVOT) |
| A-4 | `utxo_count_age_distribution_block` | 나이별 UTXO 개수 분포 (PIVOT) |
| A-5 | `utxo_realized_age_distribution_block` | 나이별 realized value 분포 (PIVOT) |
| A-6 | `utxo_realized_price_age_distribution_block` | 나이별 realized price 분포 (PIVOT) |
| A-7 | `utxo_spent_output_age_distribution_block` | 소비된 UTXO 나이 분포 (PIVOT) |

처리 흐름은 세 단계로 구성된다:

```
1. utxo_unspent_snapshot (10K 블록 간격 스냅샷) + utxo_events_block (delta)
   → unspent_age_v (임시 뷰)

2. unspent_age_v → age_agg_v (13개 age bin별 집계)
   → persist() 호출로 메모리/디스크에 캐시

3. ThreadPoolExecutor(max_workers=4)로 7개 테이블 병렬 write
   → 각 테이블마다 age_agg_v를 읽어 PIVOT SQL 실행 후 Delta Lake에 replaceWhere write
```

여기서 중요한 점은, **6개 테이블(A-2~A-7)이 모두 동일한 `persist()`된 DataFrame을 동시에 읽는다**는 것이다. A-1만 PIVOT 없이 단순 GROUP BY를 사용한다.

## 증상 발견

Block 939,333의 A-3 테이블 데이터가 전부 0임을 발견했다.

```sql
-- block 939,330 ~ 939,340 범위 조회
SELECT block_height, range_0d_1d, range_1d_1w, range_1w_1m
FROM bitcoin.utxo_sca_age_distribution_block
WHERE block_height BETWEEN 939330 AND 939340
ORDER BY block_height;
```

939,333만 모든 컬럼이 `0.00000000`이었다. 인접 블록은 정상이었고, 소스 테이블인 `utxo_events_block`과 `index_price_block`에는 939,333 데이터가 모두 정상 존재했다. **소스는 정상인데 결과만 이상한 상황**으로, 파이프라인의 변환(transform) 또는 쓰기(write) 단계에 문제가 있음을 시사한다.

## 조사 과정

### 1단계: 전수 검사로 피해 범위 파악

1블록만 이상한 게 아닐 수 있다. 경험상 **1건의 이상은 빙산의 일각**인 경우가 많으므로, 939,000 이후 전 블록을 스캔했다.

```sql
-- 각 테이블에 존재해야 하는 블록 목록(기준)과 실제 블록을 비교
-- index_price_block을 기준 테이블로 사용: 가격이 존재하는 블록만 UTXO 테이블에 기록됨
WITH expected AS (
    SELECT block_height
    FROM bitcoin.index_price_block
    WHERE block_height >= 939000
),
actual AS (
    SELECT DISTINCT block_height
    FROM bitcoin.utxo_age_distribution_block  -- 각 테이블별로 반복 실행
    WHERE block_height >= 939000
)
SELECT e.block_height
FROM expected e
LEFT JOIN actual a ON e.block_height = a.block_height
WHERE a.block_height IS NULL
ORDER BY 1;
```

결과: **57개 고유 블록**이 1개 이상의 테이블에서 누락되었다 (범위: 939,106 ~ 939,378).

| 테이블 | 누락 유형 | 영향 블록 수 |
|---|---|---|
| A-1 (statistics) | 행 누락 | 1 |
| A-2 (age_dist) | 행 누락 | 48 |
| A-3 (sca) | 행 누락 2 + all-zeros 1 | 3 |
| A-4 (count) | 행 누락 | 44 |
| A-5 (realized_age) | 행 누락 | 45 |
| A-6 (realized_price) | 행 누락 | 2 |
| A-7 (spent_output) | 행 누락 | 4 |

주목할 만한 패턴이 있다:
- **A-2, A-4, A-5가 가장 많은 누락** (44~48개) --- 이들은 모두 `max_workers=4`에서 첫 번째 batch로 실행되는 PIVOT 테이블이다
- **A-6, A-7은 누락이 적다** (2~4개) --- 두 번째 batch에서 실행된다
- **A-1은 거의 영향 없음** (1개) --- PIVOT 없이 단순 GROUP BY를 사용한다

### 2단계: 가설 수립 및 검증

#### 가설 1: 두 Job run 간 replaceWhere 범위 겹침

동시에 실행된 두 Job run의 `replaceWhere` 범위가 겹쳐서, 나중에 끝난 run이 데이터를 덮어쓴 것 아닐까?

`DESCRIBE HISTORY`로 Delta write 이력을 확인했다. Delta Lake는 모든 write 연산의 이력을 30일간 보관하며, `operationMetrics`에 기록된 파일 수와 행 수를 통해 각 write의 결과를 사후 검증할 수 있다.

```sql
DESCRIBE HISTORY bitcoin.utxo_age_distribution_block;
```

확인 결과, 각 블록이 `block_height >= X AND block_height <= X` (1블록씩) 별도의 `replaceWhere`로 실행되었다. 범위 겹침 없음. **기각**.

#### 가설 2: Serverless 환경에서 temp view 공유

`max_concurrent_runs: 10` 설정으로 여러 run이 동시에 실행되므로, 서로의 temp view나 persist cache를 침범한 것은 아닐까?

Job 실행 로그를 확인한 결과, 각 run은 별도의 Serverless 클러스터에 격리된 SparkSession으로 실행되었다 (예: `0303-094108-pkwveluo`, `0303-091335-7yubv0nl`). 클러스터 간 SparkContext 공유는 불가능하다. **기각**.

#### 가설 3 (최종): ThreadPoolExecutor + persist cache race condition

`DESCRIBE HISTORY`에서 확인한 `operationMetrics`의 `numFiles` 값과 타임스탬프를 교차 분석한 결과, 결정적인 패턴이 드러났다.

```
특정 block에 대한 7개 테이블 write 이력 (DESCRIBE HISTORY 결과):

A-1: 17:12:46  numFiles=1  ← OK    (첫 번째 batch, 단순 GROUP BY)
A-2: 17:12:45  numFiles=0  ← EMPTY (첫 번째 batch, PIVOT)
A-4: 17:12:46  numFiles=0  ← EMPTY (첫 번째 batch, PIVOT)
A-5: 17:12:46  numFiles=0  ← EMPTY (첫 번째 batch, PIVOT)
---
A-6: 17:12:48  numFiles=1  ← OK    (두 번째 batch, PIVOT)
A-7: 17:12:48  numFiles=1  ← OK    (두 번째 batch, PIVOT)
A-3: 17:12:49  numFiles=1  ← OK    (두 번째 batch, PIVOT)
```

여기서 `numFiles=0`은 **빈 DataFrame이 실제로 Delta Lake에 commit된 증거**다. Delta Lake는 빈 DataFrame write를 오류 없이 허용하기 때문에, 파이프라인은 exit code 0(성공)으로 종료되었다.

`ThreadPoolExecutor(max_workers=4)` 동작 방식을 고려하면 다음과 같다:

```
[첫 번째 batch] 4개 동시 실행 (max_workers=4):
  A-1, A-2, A-4, A-5  →  A-2, A-4, A-5에서 numFiles=0 발생

[두 번째 batch] 남은 3개 (첫 번째 batch 중 하나가 끝나면 순차 투입):
  A-6, A-7, A-3       →  전부 numFiles=1 (정상)
```

추가로 관찰된 패턴:

- **A-1은 항상 성공**: PIVOT 없이 단순 GROUP BY만 사용하므로, persist cache에 대한 부하가 낮다
- **두 번째 batch는 항상 성공**: 첫 번째 batch가 이미 persist cache를 읽어 materialization을 트리거한 후 실행되므로, cache가 안정화된 상태에서 읽는다
- **280블록 일괄 처리 시에는 미발생**: DataFrame이 충분히 크면 persist + `foreachPartition` materialize가 완료된 후에 PIVOT 쿼리가 실행될 가능성이 높다. 1블록 단위 처리에서만 발생했다

## 근본 원인

Databricks Serverless compute 환경에서 `persist()`된 DataFrame에 대해 복수의 복잡한 PIVOT SQL이 `ThreadPoolExecutor`를 통해 동시에 실행될 때, **일부 쿼리가 빈 결과를 반환하는 race condition**이 발생한다.

PySpark의 `persist()`는 lazy evaluation을 따른다. `persist()`를 호출해도 즉시 데이터가 메모리에 올라가는 것이 아니라, 해당 DataFrame에 대한 action이 실행될 때 비로소 materialize된다. 코드에서는 `foreachPartition(lambda _: None)`으로 강제 materialize를 시도하고 있었지만, Serverless 환경의 자원 스케줄링 특성상 materialize 완료 직후 4개의 복잡한 PIVOT 쿼리가 동시에 cache를 읽으면 간헐적으로 빈 결과가 반환되었다.

```python
# 문제가 발생한 코드 패턴 (간략화)
from concurrent.futures import ThreadPoolExecutor, as_completed

# 1. persist + 강제 materialize
age_agg_v = spark.sql("SELECT ... FROM unspent_age_v GROUP BY ...").persist()
age_agg_v.foreachPartition(lambda _: None)  # 강제 materialize 시도

# 2. 즉시 4개 쿼리 동시 실행 → race condition 발생 지점
with ThreadPoolExecutor(max_workers=4) as executor:
    futures = {
        executor.submit(write_table, tbl, pivot_query, params): tbl
        for tbl, pivot_query, params in tasks  # 7개 task
    }
    for future in as_completed(futures):
        table_name = futures[future]
        future.result()  # 예외 발생 없음 (빈 DataFrame도 정상 write)
```

이 패턴은 Spark 공식 문서의 `foreachBatch`에서 권장하는 `persist -> write -> unpersist` 패턴과 유사하지만, **동시 쿼리 수가 4개이고 각각이 복잡한 PIVOT 연산**이라는 점에서 Serverless 환경의 자원 경합(resource contention)이 발생할 조건이 된다.

## Backfill 실행

### 문제: Serverless에서 PERSIST TABLE 미지원

누락 블록을 재처리하기 위해 `databricks jobs submit`으로 Serverless 실행을 시도했으나 오류가 발생했다:

```
PERSIST TABLE is not supported on serverless compute
```

노트북 내부에서 Global temp view를 SQL `CACHE TABLE` / `PERSIST TABLE`로 사용하는 코드가 있어, Serverless compute에서는 실행 자체가 불가능했다.

### 해결: 전용 클러스터(existing_cluster_id) 지정

항상 켜져 있는 general purpose 클러스터를 지정하여 Backfill을 실행했다.

```bash
# Process A Backfill: 누락 57개 블록이 포함된 범위 (939,106 ~ 939,385)
databricks jobs submit --no-wait --json '{
  "run_name": "utxo_stat_backfill_939106_939385",
  "tasks": [{
    "task_key": "backfill",
    "existing_cluster_id": "1212-080724-pnunwmc0",
    "notebook_task": {
      "notebook_path": "/Workspace/.../utxo_stat_and_age_dist_block",
      "base_parameters": {
        "start_block_height": "939106",
        "end_block_height": "939385"
      }
    }
  }]
}'
```

전용 클러스터에서는 280블록을 일괄 처리하므로 persist cache가 충분히 안정화된 상태에서 쿼리가 실행된다. Process A (939,106~939,385)와 Process B (939,333) 모두 SUCCESS로 완료되었다.

## 검증 결과

Backfill 후 동일한 전수 검사 쿼리를 재실행하여 누락이 해소되었음을 확인했다.

```sql
-- Backfill 후 A-2 테이블 누락 블록 재확인 (나머지 테이블도 동일하게 검증)
WITH expected AS (
    SELECT block_height FROM bitcoin.index_price_block
    WHERE block_height BETWEEN 939106 AND 939385
),
actual AS (
    SELECT DISTINCT block_height FROM bitcoin.utxo_age_distribution_block
    WHERE block_height BETWEEN 939106 AND 939385
)
SELECT e.block_height
FROM expected e
LEFT JOIN actual a ON e.block_height = a.block_height
WHERE a.block_height IS NULL;
-- 결과: 0 rows
```

최종 검증 결과:

| 검증 대상 | 범위 | 결과 |
|---|---|---|
| A-1 ~ A-7 (Process A) | 939,106 ~ 939,385 | 누락 0 -- PASS |
| B-1 ~ B-3 (Process B) | 939,333 | 누락 0 -- PASS |
| A-3 block 939,333 | all-zeros 복구 확인 | 정상 값 (`0.00290717`, `924.88223535` 등) -- PASS |

## 핵심 교훈

### 1. Delta Lake `DESCRIBE HISTORY`의 `numFiles`가 핵심 진단 도구다

`DESCRIBE HISTORY`는 Delta Lake 테이블의 모든 write 연산에 대한 이력을 30일간 보관한다. `operationMetrics`에 포함된 `numFiles` 값이 0이면, 해당 `replaceWhere` 범위에 **빈 DataFrame이 commit된 것**이다. Delta Lake는 빈 DataFrame write를 오류로 처리하지 않으므로, 파이프라인이 성공으로 끝나도 데이터가 실제로 기록되었는지 `DESCRIBE HISTORY`로 사후 검증해야 한다.

### 2. 가설은 반드시 데이터로 검증해야 한다

"동시 실행 Job run 간 temp view 공유"는 그럴듯한 가설이었지만, 실제 클러스터 ID 확인 결과 각 run이 별도 SparkSession에서 격리 실행됨이 확인되어 기각되었다. **Delta History의 타임스탬프 비교**를 통해 같은 run 내부의 문제임을 증명한 것이 결정적이었다.

### 3. ThreadPoolExecutor + persist + PIVOT 조합은 Serverless에서 주의가 필요하다

persist된 DataFrame에 대해 복수의 복잡한 쿼리를 동시에 실행하면, Serverless 환경의 자원 스케줄링 특성상 간헐적으로 빈 결과가 반환될 수 있다. 대안으로는:

- `max_workers` 축소 (4 -> 2)
- 첫 번째 batch 완료를 명시적으로 대기한 후 두 번째 batch 실행
- persist 대신 temp view를 별도로 생성하여 쿼리별 독립적인 실행 계획 확보
- Serverless 대신 전용 클러스터에서 실행

### 4. 1건의 이상은 전수 검사의 시작이다

1개 블록에서 이상을 발견했을 때 "이 블록만 특수한 상황"이라고 넘기면 안 된다. 이번 케이스에서 **1건으로 보였던 문제가 57건**이었다. 전수 검사 쿼리(기준 테이블 LEFT JOIN 대상 테이블)는 간단하지만 피해 범위를 정확히 파악하는 데 필수적이다.

## 다음 단계

- `utxo_stat_and_age_dist_block.ipynb`에서 `max_workers=4` -> `max_workers=2`로 조정하거나, 첫 번째 batch 완료 후 두 번째 batch를 실행하는 2-phase 방식으로 변경 검토
- 정기적인 데이터 품질 체크 자동화: `index_price_block`과 각 UTXO 테이블 간 블록 커버리지 비교 쿼리를 모니터링 Job으로 추가
- Serverless compute에서의 persist 동작에 대한 추가 벤치마크: DataFrame 크기별, 동시 쿼리 수별 재현 테스트

## 참고 자료

- [Delta Lake - DESCRIBE HISTORY](https://docs.delta.io/latest/delta-utility.html#history-schema) -- operationMetrics 스키마 및 활용법
- [PySpark DataFrame.persist()](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.persist.html) -- StorageLevel 및 lazy materialization
- [Python concurrent.futures.ThreadPoolExecutor](https://docs.python.org/3/library/concurrent.futures.html#threadpoolexecutor) -- max_workers 동작 방식
- 프로젝트 내부 참조:
  - 노트북: `src/bitcoin_etl_job/utxo_stat_and_age_dist_block.ipynb`
  - PIVOT 함수: `src/bitcoin_etl_job/utxo_insert_template.ipynb`
  - Job 설정: `resources/tech_databricks_workflow.job.yml`
  - QA 리포트: `qa/QA_REPORT_v2.md`
