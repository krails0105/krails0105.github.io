---
title: "[Databricks] Delta Table에 데이터가 있는데 빈 결과가 반환되는 문제 분석"
date: 2026-03-24
categories: [Databricks]
tags: [Databricks, Delta Lake, PySpark, Debugging, ETL, Multi-Task Job]
---

## 들어가며

Databricks multi-task Job에서 Delta 테이블을 읽을 때, **데이터가 분명히 존재하는데 빈 결과가 반환**되는 현상이 간헐적으로 발생했다. 같은 파라미터로 다른 클러스터에서 재실행하면 성공하고, 같은 클러스터에서는 4회 retry 모두 실패한다.

이 글은 root cause를 추적하는 과정을 기록한다. 결론부터 말하면 -- **원인을 확정하지 못했다.** 대신, 무엇을 확인했고 무엇을 기각했는지, 그리고 어떤 방어 코드를 적용했는지를 공유한다. "원인 불명"인 채로 끝나는 디버깅 기록이 실무에서는 오히려 유용할 때가 있다.

### 이 글에서 다루는 내용

- Multi-task Job 환경에서 발생하는 Delta 테이블 phantom empty read 증상
- 기각된 가설 6가지와 그 근거
- 진단 로그 + `REFRESH TABLE` + retry 방어 패턴
- `max()`와 `WHERE` 절이 서로 다른 경로를 타는 이유

### 전제 조건

- Databricks Workspace에서 multi-task Job을 운영한 경험
- Delta Lake 기본 개념 (transaction log, OPTIMIZE, VACUUM)
- PySpark `persist()`, `foreachPartition()` 사용 경험

---

## 파이프라인 아키텍처

문제가 발생한 ETL 파이프라인의 구조다. 메인 Job은 multi-task 구성으로, **4-worker 전용 클러스터**(instance pool 기반)에서 실행된다. 모든 task가 같은 클러스터와 SparkContext를 공유한다.

```
etl_job (4-worker dedicated cluster, shared SparkContext)
  ├── ingestion tasks      (bronze WRITE)
  ├── transform tasks      (silver WRITE)
  ├── events_task          (WRITE)
  ├── snapshot_check_task  ← snapshot 테이블 READ → 경계 체크 → exit
  ├── compute_task_A       ← snapshot 테이블 READ → 7개 output WRITE
  ├── compute_task_B       ← snapshot 테이블 READ → 4개 output WRITE
  └── aggregation, ingestion tasks...
```

핵심 포인트:

- `snapshot_check_task`는 snapshot 테이블의 최신 상태를 확인하고, 새 snapshot이 필요한 경우에만 write한다. 대부분의 실행에서는 **읽기만 하고 exit**한다.
- `compute_task_A`와 `compute_task_B`는 `snapshot_check_task` 완료 후 실행되며, 같은 snapshot 테이블을 읽어 파생 메트릭을 계산한다.
- 세 task 모두 **같은 클러스터의 같은 SparkContext**에서 실행된다.

---

## 증상: 직전 task는 성공, 다음 task에서 빈 결과

타임라인을 보면 문제가 명확하다.

```
18:01:36~18:01:46  SUCCESS  snapshot_check_task  (max() 읽기 성공, skip)
18:01:46~18:02:16  FAILED   compute_task_A       (WHERE partition_key=X → 0 rows)
18:01:53~18:02:16  FAILED   compute_task_B       (WHERE partition_key=X → 0 rows)
  → 4회 retry 모두 같은 클러스터에서 실패
```

에러 메시지:

```
ValueError: snapshot is EMPTY for partition_key=X.
Aborting to prevent zero-data writes.
```

이 가드(`count() == 0` 체크)가 없었다면 여러 output 테이블에 빈 데이터가 조용히 commit됐을 것이다. Delta Lake는 빈 DataFrame write를 에러 없이 허용하기 때문이다.

---

## 같은 패턴의 반복

한 번이 아니라 연속 이틀 발생했다.

| 날짜 | 실패 task | partition_key | 클러스터 |
|---|---|---|---|
| 03-17 | compute_A + compute_B | X | `cluster-aaa` |
| 03-18 | compute_A + compute_B | X | `cluster-bbb` |

다른 날, 다른 클러스터에서 동일 증상. 그런데 **새 클러스터에서 재실행하면 즉시 성공**한다:

```
실패: cluster-aaa → FAILED (4회 retry, 모두 같은 클러스터)
성공: cluster-ccc → SUCCESS (같은 파라미터, 새 클러스터)
```

이것은 데이터나 코드 문제가 아니라 **클러스터 상태에 의존하는 문제**임을 시사한다.

---

## 확인한 것들

### 1. 데이터는 존재한다

진단 노트북에서 직접 확인했다:

```
partition_key=X: 약 830K rows (현재 정상)
numFiles: 18, sizeInBytes: 0.7 GB
```

### 2. DESCRIBE HISTORY -- 실패 전후 테이블 변경 없음

```
v99  2026-03-11  WRITE    (마지막 write — 실패보다 6일 전)
v97  2026-03-05  VACUUM END
v95  2026-02-26  OPTIMIZE (93개 파일 compaction)
```

실패 시점(03-17, 03-18)에 테이블을 변경한 operation이 전혀 없었다. concurrent write에 의한 conflict 가능성은 배제된다.

### 3. 직전 task에서 같은 테이블을 성공적으로 읽었다

```python
# snapshot_check_task — 성공 (실패 task 실행 10초 전)
latest = spark.read.table(snapshot_table) \
    .agg(spark_max(col("partition_key"))).collect()[0]["v"]
# → X 반환 (정상)
```

같은 클러스터, 같은 SparkContext에서 불과 10초 전에 같은 테이블을 성공적으로 읽었다.

### 4. 단독 실행으로는 재현 불가

Always-on 클러스터와 동일 설정의 fresh job cluster에서 같은 코드를 단독 실행했다:

```
step1_target_count: 1
step2_direct_count: 828823            ← 직접 WHERE 쿼리 OK
step3_subquery_count: 828823          ← IN (subquery) 패턴 OK
step4_cached_view_count: 828823       ← persist + foreachPartition 패턴 OK
```

4가지 경로 모두 정상. **Multi-task Job 환경에서만 발생하고, 단독으로는 재현되지 않는다.**

---

## 실패하는 코드 패턴

실패하는 task들은 공통적으로 아래 `cached_view()` 패턴을 사용한다:

```python
def cached_view(name, df):
    """DataFrame을 temp view로 등록하고 persist하여 강제 materialize한다."""
    df.createOrReplaceTempView(name)
    df.persist()
    df.foreachPartition(lambda _: None)  # action을 발생시켜 강제 materialize
    return df

# snapshot 테이블에서 필요한 파티션만 로드
snapshot_df = cached_view("snapshot_v", spark.sql(f"""
    SELECT *
    FROM {snapshot_table}
    WHERE partition_key IN (
        SELECT DISTINCT target_partition FROM {target_view}
    )
"""))

# persist된 snapshot_df를 여러 output 테이블에서 공유하여 병렬 write
with ThreadPoolExecutor(max_workers=7) as pool:
    futures = {pool.submit(write_table, tbl, query, params): tbl
               for tbl, query, params in tasks}
```

이 패턴의 의도: `persist()` + `foreachPartition(lambda _: None)`으로 강제 materialize한 뒤, `ThreadPoolExecutor`로 7개 테이블을 병렬 write한다. DataFrame을 한 번만 읽고 여러 output에 재사용하기 위한 구조다.

주목할 점은 `WHERE partition_key IN (SELECT DISTINCT target_partition FROM {target_view})` 부분이다. 직접 `WHERE partition_key = X`가 아니라 subquery를 경유한다.

---

## 기각된 가설 6가지

| # | 가설 | 기각 근거 |
|---|---|---|
| 1 | Serverless compute에서 persist race condition | Serverless 미사용. 4-worker 전용 클러스터 |
| 2 | 상위 스케줄러에서 동시 실행으로 순서 역전 | Run 타임라인 겹치지 않음. 순차 실행 확인 |
| 3 | autoCompact가 file layout 변경 | DESCRIBE HISTORY에 실패 전후 compaction 기록 없음 |
| 4 | 클러스터 재사용으로 stale cache | 실패/성공 run이 서로 다른 cluster_id, 다른 SparkContext |
| 5 | Delta metadata cache 문제 (단독 환경) | 단독 job cluster에서 4가지 경로 모두 재현 불가 |
| 6 | `cached_view()` 패턴 자체의 버그 | 다른 task도 같은 패턴을 사용하지만 정상 동작 |

가설 4는 처음에 유력했으나, 실패와 성공이 서로 다른 cluster ID에서 발생했기 때문에 "이전 run의 stale cache가 남아있다"는 설명이 성립하지 않았다.

---

## 좁혀진 범위: 실패하는 task와 성공하는 task의 차이

기각된 가설을 제외하고 남은 차이점을 정리했다:

| | compute_task (실패) | other_task (성공) |
|---|---|---|
| 대상 테이블 | snapshot 테이블 | events 테이블 |
| 쿼리 패턴 | `WHERE col IN (SELECT ... FROM temp_view)` | `WHERE col BETWEEN X AND Y` |
| 직전 task가 같은 테이블을 읽었는지 | **O** (snapshot_check_task) | X |
| OPTIMIZE + VACUUM 이력 | **O** (compaction + vacuum 수행됨) | 미확인 |

snapshot 테이블만 실패하는 결정적 요인을 특정하지 못했다. `IN (subquery)` 패턴, OPTIMIZE/VACUUM 이력, 직전 task의 동일 테이블 읽기 -- 이 중 어떤 것이 원인인지, 혹은 조합인지 불명이다.

---

## 적용한 방어 코드

원인을 확정하지 못했으므로, **빈 결과 감지 시 진단 로그 수집 + `REFRESH TABLE` + retry** 패턴을 적용했다. 다음 발생 시 원인을 특정할 수 있도록 설계했다.

```python
snapshot_df = _load_snapshot()

snap_count = snapshot_df.count()
if snap_count == 0:
    # ── 1단계: 진단 로그 수집 ──
    # Delta 테이블의 물리적 파일 상태 확인
    detail = spark.sql(f"DESCRIBE DETAIL {snapshot_table}").first()
    print(f"[DIAG] numFiles={detail['numFiles']}, size={detail['sizeInBytes']}")

    # 최근 3개 operation 확인 (concurrent write 여부 판별)
    history = spark.sql(f"DESCRIBE HISTORY {snapshot_table} LIMIT 3").collect()
    for h in history:
        print(f"[DIAG] v{h['version']} {h['timestamp']} op={h['operation']}")

    # column stats 경로로 읽기 (max — statistics 기반)
    max_val = spark.read.table(snapshot_table) \
        .selectExpr("max(partition_key)").first()[0]
    print(f"[DIAG] max(partition_key) via DataFrame API: {max_val}")

    # file scan 경로로 읽기 (COUNT — 실제 파일 스캔)
    direct = spark.sql(f"SELECT COUNT(*) FROM {snapshot_table} "
                       f"WHERE partition_key = {target}").first()[0]
    print(f"[DIAG] COUNT(*) via SQL: {direct}")

    # ── 2단계: unpersist 후 캐시 없이 재쿼리 ──
    snapshot_df.unpersist()
    raw = spark.sql(f"SELECT COUNT(*) FROM {snapshot_table} "
                    f"WHERE partition_key = {target}").first()[0]
    print(f"[DIAG] raw re-query (no cache): {raw}")

    # ── 3단계: REFRESH TABLE로 메타데이터 캐시 무효화 + retry ──
    spark.sql(f"REFRESH TABLE {snapshot_table}")
    print("[DIAG] REFRESH TABLE completed")

    snapshot_df = _load_snapshot()
    snap_count = snapshot_df.count()
    print(f"[DIAG] count after refresh: {snap_count:,}")

# REFRESH 후에도 빈 결과면 안전하게 실패
if snap_count == 0:
    raise ValueError(f"snapshot is EMPTY for partition_key={target}")
```

### 진단 결과 해석 분기표

이 방어 코드가 실행되면, 각 단계의 결과 조합으로 원인을 좁힐 수 있다:

| max() 결과 | COUNT(*) 결과 | raw re-query | REFRESH 후 | 의미 |
|---|---|---|---|---|
| 정상 | 0 | 0 | **정상** | **Spark catalog cache 문제** -- REFRESH로 자동 복구됨 |
| 정상 | 0 | 0 | 0 | file listing 또는 data skipping 버그 -- support 케이스 필요 |
| 정상 | **정상** | - | - | **persist/foreachPartition 문제** -- 캐시에만 빈 데이터가 들어감 |
| 0 | 0 | 0 | 0 | 진짜 데이터 부재 -- 상위 파이프라인 문제 |

**`max()` 정상 + `COUNT(*)` = 0** 조합이 가장 흥미로운 케이스다. `max()`는 Delta Lake의 column statistics에서 해석할 수 있지만, `COUNT(*) WHERE partition_key = X`는 file listing 기반 data skipping에 의존한다. 이 두 경로가 불일치하는 상태는 metadata cache 오염을 강하게 시사한다.

---

## 핵심 교훈

**1. 빈 결과에 대한 가드는 필수다.** Delta Lake는 빈 DataFrame write를 에러 없이 허용한다. `count() == 0` 체크가 없었다면 여러 테이블에 빈 데이터가 조용히 commit됐을 것이다. ETL 파이프라인에서는 "데이터가 있을 것"을 가정하지 말고 반드시 검증해야 한다.

**2. "다른 클러스터에서 재실행하면 성공"은 강력한 단서다.** 이 패턴은 데이터나 코드 문제가 아니라 클러스터 상태(cache, metadata, SparkContext)에 의존하는 문제임을 가리킨다. 디버깅 시 "어디서 성공하고 어디서 실패하는가"를 먼저 파악하면 탐색 범위를 크게 줄일 수 있다.

**3. `max()`와 `WHERE`는 다른 경로를 탄다.** Delta Lake에서 `max()`는 column statistics에서 해석 가능하지만, `WHERE` 절은 file listing 기반 data skipping에 의존한다. 전자가 성공해도 후자가 실패할 수 있다. 한쪽만 테스트해서 "데이터 있음"을 단정하면 안 된다.

**4. 단독 재현 불가 = multi-task 상호작용 문제.** 같은 SparkContext에서 여러 task가 순차적으로 Delta 테이블을 읽을 때만 발생하는 문제는 단독 테스트로 잡을 수 없다. 재현 환경을 구성할 때 multi-task 구조를 포함해야 한다.

**5. Root cause를 모르더라도 방어 코드는 적용할 수 있다.** 진단 로그 + `REFRESH TABLE` + retry로 세 가지를 동시에 달성했다: (a) 다음 발생 시 원인 특정 가능, (b) cache 문제라면 자동 복구, (c) 복구 불가 시 빈 데이터 write 없이 안전하게 실패.

---

## Reference

- [Delta Lake - DESCRIBE HISTORY](https://docs.delta.io/latest/delta-utility.html#describe-history)
- [Spark SQL - REFRESH TABLE](https://spark.apache.org/docs/latest/sql-ref-syntax-aux-cache-refresh-table.html)
- [Databricks - Configure compute for jobs](https://docs.databricks.com/en/compute/configure.html#job-compute)
- [Delta Lake - Data skipping](https://docs.databricks.com/en/delta/data-skipping.html)
- [Databricks - Multi-task jobs](https://docs.databricks.com/en/workflows/jobs/create-run-jobs.html)
