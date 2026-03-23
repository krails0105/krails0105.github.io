---
title: "[Databricks] replaceWhere + CDF 조합에서 만난 2가지 버그와 수정 방법"
categories:
  - Databricks
tags:
  - Databricks
  - DeltaLake
  - CDF
  - replaceWhere
  - PySpark
  - BugFix
---

### 들어가며

대규모 이벤트 데이터 파이프라인을 운영하면서 Delta Lake의 `replaceWhere`를 증분 적재 패턴으로 적극 활용하고 있습니다. 멱등성(idempotency)이 보장되고 Liquid Clustering과 궁합이 좋아서 채택한 방식인데, 실제 운영 중에 두 가지 예상 못한 버그를 만났습니다.

1. **CDF + replaceWhere 충돌** -- 같은 commit 안의 delete와 insert 사이에서 `row_number()`가 비결정적으로 동작해, 교체된 row가 삭제로 처리되는 문제
2. **Rollup replaceWhere 범위 불일치** -- `date_trunc('day', ...)` 결과가 `replaceWhere` 하한 밖으로 벗어나 constraint 위반이 발생하는 문제

두 버그 모두 코드만 보면 틀린 게 없어 보여서 원인을 찾는 데 시간이 걸렸습니다. 이 글에서는 각 버그의 원인, 수정 방법, 그리고 사이드이펙트 분석까지 정리합니다.

---

### 파이프라인 배경

파이프라인의 전체 구조는 다음과 같습니다.

```
이벤트 데이터 (S3)
  -> Bronze (DLT streaming / Auto Loader)
  -> Silver (address_transfer, balance_diff)
  -> Derived (source_table, output_table, metrics_table ...)
  -> Rollup (network_day, market_indicator_day ...)
  -> CDF ingestion -> PostgreSQL / BigQuery
```

핵심 흐름을 요약하면 두 가지입니다.

- **쓰기**: 각 노트북이 `replaceWhere` + `mode("overwrite")`로 Delta 테이블에 증분 적재
- **읽기**: CDF(`table_changes()`)로 변경분을 읽어 downstream(PostgreSQL, BigQuery)으로 내보냄

Rollup 작업(`network_rollup`, `market_rollup`)에서는 `end_ts - 2days` 같은 방식으로 `start_ts`를 자동 계산하고, 이 값을 `replaceWhere` 조건의 하한으로 사용합니다.

이 두 패턴(replaceWhere 쓰기 + CDF 읽기)이 결합되면서 아래 두 가지 버그가 발생했습니다.

---

### 버그 1: CDF + replaceWhere -- delete가 insert를 이기는 비결정적 동작

#### 증상

CDF ingestion 후 PostgreSQL에서 특정 row가 사라져 있었습니다. Delta 테이블에는 정상적으로 존재하는데, downstream에서만 삭제된 상태였습니다.

#### 원인 분석

`replaceWhere`는 Delta 내부적으로 하나의 commit 안에서 **delete + insert를 동시에** 생성합니다. 지정한 범위의 기존 파일을 제거(delete)하고, 새 DataFrame의 데이터를 추가(insert)하는 것이 단일 atomic commit으로 처리됩니다.

CDF를 읽으면 같은 `_commit_version`과 `_commit_timestamp`에 두 종류의 `_change_type`이 나타납니다.

```
commit_version = 100:
  row A  ->  _change_type = 'delete'     # 기존 row 제거
  row A  ->  _change_type = 'insert'     # 새 row 추가 (값이 같거나 변경됨)
```

기존 CDF dedup 함수 `get_cdf_table()`은 동일 primary key에 대해 최신 변경만 남기기 위해 다음과 같은 Window를 사용하고 있었습니다.

```python
# 버그 버전
win = Window.partitionBy(*primary_key_cols).orderBy(
    F.col("_commit_version").desc(),
    F.col("_commit_timestamp").desc()
)
deduped = df.withColumn("rn", F.row_number().over(win)).filter("rn = 1")
```

**문제는 Spark의 `row_number()`가 정렬 키가 동일한 row 사이에서 순서를 보장하지 않는다는 점입니다.** 같은 commit에서 생성된 delete와 insert는 `_commit_version`과 `_commit_timestamp`가 완전히 동일하므로, `row_number() = 1`로 선택되는 row가 실행마다 달라질 수 있습니다.

`delete`가 먼저 선택되면 해당 row는 `is_deleted=True`로 처리되어, 실제로는 값이 교체(또는 유지)된 row가 downstream에서 **삭제**로 처리됩니다.

> **Spark Window 함수의 비결정성**: `row_number()`는 파티션 내에서 ORDER BY 키가 동일한 row에 대해 어떤 row가 1번을 받을지 보장하지 않습니다. 이는 Spark 공식 문서에서도 "assigns a unique, sequential number based on a specified order"라고만 기술하며, 동일 키에 대한 순서 보장은 명시하지 않습니다.

#### 영향 범위

CDF ingestion checkpoint 테이블을 조회한 결과, 대상 테이블이 **11개**였습니다.

- downstream 테이블 다수
- 
- 


모두 `replaceWhere`로 쓰는 테이블이라 같은 버그에 노출되어 있었습니다.

#### 수정 방법

`_change_type`을 tiebreaker로 추가해서, insert/update_postimage가 delete보다 **항상** 높은 우선순위를 갖도록 했습니다.

```python
# 수정 후
win = Window.partitionBy(*primary_key_cols).orderBy(
    F.col("_commit_version").desc(),
    F.col("_commit_timestamp").desc(),
    # tiebreaker: insert/update_postimage(1) > delete(0)
    F.when(F.col("_change_type") == "delete", F.lit(0)).otherwise(F.lit(1)).desc()
)
deduped = df.withColumn("rn", F.row_number().over(win)).filter("rn = 1")
```

이렇게 하면 같은 commit 내에서 delete와 insert가 공존할 때, insert가 반드시 `rn = 1`을 받습니다. Delta Lake CDF의 `_change_type`은 `'insert'`, `'update_preimage'`, `'update_postimage'`, `'delete'` 네 가지 값을 가지므로, delete만 0으로 매핑하고 나머지는 모두 1로 매핑하면 됩니다.

#### 사이드이펙트 분석

수정 후 기존 케이스들이 영향받지 않는지 확인했습니다.

| 케이스 | CDF에 나타나는 레코드 | dedup 결과 |
|--------|----------------------|------------|
| replaceWhere에서 기존 row가 새 데이터에 **없는** 경우 | delete만 존재 (유일한 row) | `is_deleted=True` -- 정상 삭제 |
| replaceWhere에서 기존 row가 **동일 값**으로 교체된 경우 | delete + insert 공존 | insert 우선 선택 -- 값 유지 |
| replaceWhere에서 기존 row가 **변경된 값**으로 교체된 경우 | delete + insert 공존 | insert 우선 선택 -- 새 값 반영 |
| MERGE INTO 사용 테이블 | update_postimage만 생성 (delete+insert 쌍 없음) | 기존과 동일 -- 영향 없음 |

모든 케이스에서 의도한 동작이 보장됩니다.

---

### 버그 2: Rollup replaceWhere 범위 불일치 -- date_trunc vs start_ts

#### 에러 메시지

```
DELTA_VIOLATE_CONSTRAINT_WITH_VALUES: CHECK constraint violated
  datetime >= '2026-02-24 07:00:00+00:00'
  violated by row with values:
    datetime : 1771891200000000 (= 2026-02-24 00:00:00 UTC)
```

Delta Lake의 `replaceWhere`는 쓰려는 데이터가 지정된 조건을 만족하는지 검증합니다. 조건 밖의 데이터가 포함되면 위와 같은 constraint 위반 에러를 발생시킵니다. 이 동작은 의도하지 않은 데이터 덮어쓰기를 방지하기 위한 안전장치입니다.

#### 원인 분석

문제의 원인은 `start_ts` 계산과 rollup SQL의 `date_trunc` 결과 사이의 **정렬 불일치(alignment mismatch)**입니다.

구체적인 흐름을 따라가 보겠습니다.

```
1. Job이 end_ts = '2026-02-26 07:00:00 UTC'로 실행됨

2. get_rollup_job_args()가 start_ts를 계산:
   start_ts = end_ts - 2days = '2026-02-24 07:00:00 UTC'

3. replaceWhere 조건이 설정됨:
   datetime >= '2026-02-24 07:00:00 UTC'

4. Rollup SQL에서 집계:
   SELECT date_trunc('day', datetime) AS datetime, ...
   -> 2026-02-24 07:xx:xx ~ 2026-02-24 23:59:59 범위의 데이터가
      date_trunc에 의해 '2026-02-24 00:00:00 UTC'로 변환됨

5. 결과: 00:00:00 < 07:00:00 -> replaceWhere 하한 밖 -> CONSTRAINT VIOLATION
```

핵심은 `date_trunc('day', ...)`가 항상 해당 일의 **00:00:00 UTC**로 잘라내는데, `start_ts`는 시간 성분(07:00:00)을 그대로 가지고 있었다는 점입니다.

#### 수정 방법

`start_ts`를 window 경계(boundary)에 맞게 truncate하도록 수정했습니다.

```python
# 핵심: start_ts를 window 경계로 truncate
if window == "day":
    start_ts = start_ts.replace(hour=0, minute=0, second=0, microsecond=0)
else:  # hour
    start_ts = start_ts.replace(minute=0, second=0, microsecond=0)
```

수정 후 동작 흐름은 다음과 같습니다.

```
1. start_ts = '2026-02-24 07:00:00 UTC' (자동 계산)
2. truncate -> '2026-02-24 00:00:00 UTC' (day 경계)
3. replaceWhere: datetime >= '2026-02-24 00:00:00 UTC'
4. date_trunc('day', ...) 결과: '2026-02-24 00:00:00 UTC'
5. 00:00:00 >= 00:00:00 -> 정상 통과
```

공용 유틸 한 곳에서 truncate를 적용하면 모든 rollup 작업에 일괄 반영됩니다.

---

### 주의할 점 정리

#### row_number() tiebreaker는 명시적으로

Spark의 Window 함수에서 `row_number()`는 ORDER BY 키가 동일한 row의 순서를 보장하지 않습니다. 항상 같은 결과를 줄 것이라고 가정하면 안 됩니다. CDF처럼 delete/insert 쌍이 같은 commit에서 생성되는 경우에는 반드시 `_change_type` 기반 tiebreaker를 추가해야 합니다.

#### replaceWhere 범위와 실제 데이터 범위를 일치시킬 것

`replaceWhere`는 쓰려는 데이터가 지정한 조건 범위 밖이면 즉시 에러를 냅니다. 집계 쿼리가 `date_trunc`이나 `window` 함수로 timestamp를 변환하는 경우, 변환 후의 값이 `replaceWhere` 범위 안에 들어오는지 확인해야 합니다. 특히 UTC 기준 day boundary와 로컬 시간(예: KST, UTC+9) 사이의 차이가 이 문제를 유발하기 쉽습니다.

> Delta Lake에는 `spark.databricks.delta.replaceWhere.constraintCheck.enabled` 설정으로 이 검증을 비활성화할 수 있지만, 의도하지 않은 데이터 덮어쓰기를 방지하는 안전장치이므로 끄는 것은 권장하지 않습니다.

#### replaceWhere + CDF 조합의 함정

`replaceWhere` + CDF 조합은 구현이 간단해 보이지만, CDF 소비자 측에서 delete/insert 처리 순서를 정확히 제어하지 않으면 데이터 정합성이 무너질 수 있습니다. 반면 `MERGE INTO`를 사용하는 테이블은 CDF에 `update_postimage`만 생성되므로 이 문제가 발생하지 않습니다. 두 쓰기 패턴의 CDF 특성 차이를 이해하고 소비자 로직을 설계하는 것이 중요합니다.

---

---

### 핵심 요약

| 버그 | 원인 | 수정 | 교훈 |
|------|------|------|------|
| CDF dedup 비결정적 동작 | replaceWhere가 같은 commit에 delete+insert를 생성하고, `row_number()` ORDER BY에 tiebreaker가 없음 | `_change_type` 기반 tiebreaker 추가 (delete=0, 나머지=1) | Window 함수에서 동일 정렬 키의 순서는 보장되지 않는다 |
| Rollup constraint 위반 | `start_ts`에 시간 성분이 남아 있어 `date_trunc` 결과가 하한 밖으로 벗어남 | `start_ts`를 window 경계(day/hour)로 truncate | replaceWhere 범위와 쿼리 결과 범위를 반드시 정렬할 것 |

---

### 참고 자료

- [Delta Lake Change Data Feed -- 공식 문서](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Delta Lake Selective Overwrite (replaceWhere) -- 공식 문서](https://docs.delta.io/latest/delta-batch.html#selective-overwrite)
- [Delta Lake Protocol -- _change_type 스키마](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)
- [PySpark Window Functions -- 공식 문서](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Window.html)
