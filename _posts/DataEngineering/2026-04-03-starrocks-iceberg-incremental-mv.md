---
title: "StarRocks + Databricks UniForm Iceberg V2에서 MV Incremental Refresh 적용기"
categories:
  - DataEngineering
tags:
  - StarRocks
  - Iceberg
  - Databricks
  - UniForm
  - MaterializedView
  - DeltaLake
  - IncrementalRefresh
  - replaceWhere
date: 2026-04-03
---

## Overview

StarRocks에서 Databricks Delta Lake 테이블을 Materialized View(MV)로 운영할 때 가장 큰 병목은 **매번 풀스캔**이라는 점이다. Delta Lake Catalog은 파티션 단위 변경 감지를 지원하지 않아서, refresh마다 전체 데이터를 읽어야 한다.

이 글에서는 Databricks UniForm(IcebergCompatV2)을 활용해 Iceberg Catalog 기반 incremental refresh를 프로덕션에 적용한 과정을 정리한다. 다루는 내용은 다음과 같다.

- Iceberg V2에서 incremental refresh가 실제로 동작하는지 검증
- 풀 refresh를 유발하는 진짜 원인(`replaceWhere` 패턴)과 해결법
- 프로덕션 마이그레이션 과정에서 발생한 3가지 에러와 대응
- 운영 중 발견한 타임존 불일치와 MV 스케줄러 미등록 이슈
- Iceberg 메타데이터 캐시 이슈와 주의사항

> 이 글은 CelerData BYOC **StarRocks 3.5.14-ee** 기준으로 작성되었다. Delta Lake MV의 풀스캔 제약에 대한 사전 분석은 [별도 포스트](/dataengineering/starrocks-delta-lake-mv-limitations/)를 참고하자.

---

## 기존 구조와 문제점

기존 구조는 다음과 같았다.

| 항목 | 설정 |
|---|---|
| Catalog 타입 | Delta Lake Catalog |
| MV 파티션 | UNPARTITIONED |
| Incremental Refresh | 미지원 (매번 풀스캔) |
| Refresh 소요 시간 | 50~700초 |

StarRocks 공식 문서에 따르면, **Iceberg Catalog은 v3.1.4부터 파티션 단위 변경 감지를 지원**한다. 반면 Delta Lake Catalog은 이 기능이 없다. Databricks UniForm을 사용하면 Delta 테이블을 Iceberg 포맷으로 노출할 수 있으므로, 이를 통해 incremental refresh가 가능한지 테스트했다.

---

## 핵심 발견: V2는 된다, V3는 안 된다

| IcebergCompat 버전 | Incremental Refresh | 결과 |
|---|---|---|
| V2 (`enableIcebergCompatV2=true`) | 동작 | 변경된 파티션만 refresh |
| V3 (`enableIcebergCompatV3=true`) | 미동작 | SKIPPED -- 변경 감지 불가 |

공식 문서가 "V1 only"라고 명시하는 것과 달리, **V2에서 실제로 incremental refresh가 동작**한다. V3는 StarRocks 3.5.14가 메타데이터 변경을 감지하지 못해서 매번 SKIPPED된다.

주의할 점이 하나 있다. **한 번 V3로 올리면 V2로 다운그레이드가 불가능**하다. Databricks에서 `IcebergCompat cannot be disabled` 에러가 발생한다. 프로덕션에서는 V2에 머무는 것이 현재로서는 안전한 선택이다.

### 첫 번째 refresh는 반드시 FORCE

MV 생성 직후 일반 refresh를 실행하면 SKIPPED된다. baseline이 없는 상태이므로, 첫 번째는 반드시 `FORCE` 옵션을 사용해야 한다.

```sql
-- 최초 1회: baseline 구축을 위해 FORCE 필수
REFRESH MATERIALIZED VIEW mv_name FORCE;

-- 이후부터는 incremental refresh
REFRESH MATERIALIZED VIEW mv_name;
```

---

## 풀 refresh가 발생하는 진짜 원인

V2로 전환했는데도 특정 테이블에서 계속 풀 refresh가 발생했다. 원인을 추적하면서 의심했던 항목들을 하나씩 배제했다.

### 원인이 아닌 것들

아래 설정/작업은 incremental refresh 동작에 영향을 주지 않았다.

- CDF(Change Data Feed) 활성화 여부
- `autoCompact` / `optimizeWrite` 설정
- 수동 `OPTIMIZE`(compaction) 실행
- 파티션 수 (6,000+ 파티션에서도 정상 동작 확인)

### 진짜 원인: replaceWhere에 사용하는 컬럼

Databricks에서 데이터를 Overwrite할 때, `replaceWhere` 조건에 **어떤 컬럼을 사용하느냐**에 따라 Iceberg 메타데이터 기록 방식이 달라진다.

```python
# [OK] 파티션 컬럼 기준 Overwrite -- 해당 파티션만 변경으로 기록됨
df.write.mode("overwrite") \
    .option("replaceWhere", "_partition_date = '2026-04-04'") \
    .save(path)

# [NG] 비파티션 컬럼 기준 Overwrite -- 전체 테이블 Overwrite로 기록됨
df.write.mode("overwrite") \
    .option("replaceWhere", "datetime >= '2026-04-04 02:00:00'") \
    .save(path)
```

Delta Lake History에서 확인하면 차이가 명확하다.

```json
// OK: 파티션 컬럼 predicate -- Iceberg에서 해당 파티션만 변경으로 인식
{"mode": "Overwrite", "predicate": "(dt <=> DATE '2026-04-04')"}

// NG: 비파티션 컬럼 predicate -- Iceberg에서 전체 테이블 변경으로 인식
{"mode": "Overwrite", "partitionBy": "[]", "predicate": "datetime >= '2026-04-04 02:00:00+00:00'"}
```

NG 패턴은 Iceberg 입장에서 전체 테이블이 바뀐 것으로 기록된다. 소규모 테이블(파티션 수십 개)에서는 문제가 드러나지 않지만, **대규모 테이블(6,000+ 파티션)에서는 StarRocks가 모든 파티션을 "변경됨"으로 인식**해서 풀 refresh 또는 `NoSuchElementException` 에러가 발생한다.

---

## 복합 replaceWhere 패턴

단순히 파티션 컬럼만 `replaceWhere`에 사용하면 또 다른 문제가 생긴다. 예를 들어 월별 파티션(`_dt_month`)을 쓰면서 `replaceWhere = "_dt_month = '2026-04-01'"` 로만 지정하면, 해당 월의 **모든 데이터가 삭제되고** 새 데이터로 교체된다. 처리 구간이 1시간치인데 한 달치 데이터가 날아가는 상황이 발생한다.

이를 방지하기 위해 **파티션 컬럼 + 실제 처리 구간 컬럼을 결합하는 복합 replaceWhere 패턴**을 사용한다.

```python
# _dt_month: 파티션 컬럼 (Iceberg incremental refresh 지원용)
# datetime: 실제 처리 구간 (월 전체 삭제 방지용)
replace_predicate = (
    f"_dt_month = '{month_start}' "
    f"AND datetime >= '{window_start}' "
    f"AND datetime <= '{window_end}'"
)

df.write.mode("overwrite") \
    .option("replaceWhere", replace_predicate) \
    .save(path)
```

`_dt_month`가 파티션 컬럼이므로 Iceberg는 이 파티션만 변경된 것으로 기록하고, `datetime` 조건이 실제 교체 범위를 한정한다. **Iceberg incremental refresh 지원**과 **데이터 안전성**을 동시에 확보하는 패턴이다.

---

## 프로덕션 마이그레이션

4개 테이블을 프로덕션에 적용한 과정을 단계별로 정리한다.

### Step 1: UniForm V2 활성화

기존 Delta 테이블에 UniForm을 활성화하려면 다음 순서를 반드시 지켜야 한다. Deletion Vectors를 먼저 끄지 않으면 IcebergCompatV2 활성화가 실패한다.

```sql
-- 1. Deletion Vectors 비활성화 (선행 조건)
ALTER TABLE target_table SET TBLPROPERTIES (
    'delta.enableDeletionVectors' = 'false'
);

-- 2. 기존 데이터 파일 정리 (Deletion Vectors 제거)
REORG TABLE target_table APPLY (PURGE);

-- 3. UniForm V2 활성화
ALTER TABLE target_table SET TBLPROPERTIES (
    'delta.columnMapping.mode' = 'name',
    'delta.enableIcebergCompatV2' = 'true',
    'delta.universalFormat.enabledFormats' = 'iceberg'
);
```

### Step 2: MV 생성

```sql
CREATE MATERIALIZED VIEW mv_db.target_mv
PARTITION BY (_dt_month)
REFRESH ASYNC EVERY (INTERVAL 10 MINUTE)
AS
SELECT *
FROM iceberg_catalog.schema.source_table;
```

MV 파티션 키(`_dt_month`)는 반드시 base 테이블의 파티션 키에 포함되어야 한다. StarRocks 공식 문서에서도 "partitioning keys of the materialized view must be included in that of the base table"이라고 명시하고 있다.

### Step 3: 전환 중 발생한 에러들

마이그레이션은 순탄하지 않았다. 세 가지 에러를 겪었고 각각 다른 원인이었다.

#### 에러 1: 테이블과 코드를 분리 배포해서 발생한 에러

신규 테이블을 먼저 배포하고 코드는 나중에 배포하려 했다. 파이프라인이 돌면서 다음 에러가 발생했다.

```
[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column, variable, or function parameter
with name `_dt_month` cannot be resolved.
```

**원인**: 기존 파이프라인 코드는 `datetime` 기반 `replaceWhere`를 사용하고 있었다. 그런데 신규 테이블에는 `_dt_month`가 generated column으로 추가되어 있어서, Spark가 DataFrame에서 `_dt_month`를 찾으려다 실패한 것이다.

**대응**: 즉시 backup 테이블에서 원복했다. **파이프라인 중지 없이 테이블과 코드를 따로 전환하면 반드시 에러가 발생한다.** 코드와 테이블은 반드시 동시에 전환해야 한다.

올바른 전환 순서는 다음과 같다.

1. Databricks 파이프라인 중지
2. 신규 테이블 생성 (UniForm V2, `_dt_month` 파티션)
3. 기존 데이터 복사
4. 복합 `replaceWhere` 코드 배포
5. 파이프라인 체크포인트 리셋
6. StarRocks MV 생성 + `FORCE` refresh
7. 파이프라인 재시작

#### 에러 2: `_dt_month` 컬럼이 하위 인제스션으로 누출

파이프라인 재시작 후 PostgreSQL 인제스션 단계에서 에러가 발생했다.

```
UndefinedColumn: column "_dt_month" of relation "network_hour" does not exist
```

**원인**: CDF(Change Data Feed)로 변경분을 읽으면 `_dt_month`가 포함된 채로 DataFrame이 만들어진다. 이것이 그대로 PostgreSQL MERGE 쿼리로 흘러갔고, PostgreSQL 테이블에는 해당 컬럼이 없으므로 에러가 발생했다.

**해결**: CDF 처리 모듈에서 `_` prefix 컬럼을 자동으로 드롭하는 처리를 추가했다.

```python
# _ prefix 컬럼 제거 (하위 인제스션 호환)
drop_cols = [c for c in df.columns if c.startswith("_")]
df = df.drop(*drop_cols)
```

이후 에러 시점의 체크포인트를 복구해서 파이프라인을 재처리했다.

#### 에러 3: 파티션 컬럼만 replaceWhere에 사용해서 데이터 유실 위험

파티션 컬럼인 `_dt_month`만으로 `replaceWhere`를 구성하면 치명적인 문제가 생긴다.

```python
# [위험] 4월 전체가 삭제된 후 현재 처리 구간(3시간)만 재삽입됨
df.write.mode("overwrite") \
    .option("replaceWhere", "_dt_month = '2026-04-01'") \
    .save(path)
```

파이프라인이 매 3시간마다 실행되면서 4월 데이터 중 최근 3시간치만 남기고 나머지를 전부 삭제한다. 이미 적재된 4월 1일부터 현재까지의 데이터가 모두 유실된다.

**해결**: 앞서 설명한 [복합 replaceWhere 패턴](#복합-replacewhere-패턴)을 적용했다. `_dt_month`는 Iceberg incremental 지원을 위한 파티션 컬럼 조건이고, `datetime`은 실제 교체 구간을 한정하는 안전장치 역할을 한다.

### Iceberg 메타데이터 캐시 주의사항

`FORCE` refresh 직후 바로 일반 refresh를 실행하면 SKIPPED가 발생한다. StarRocks가 캐싱한 Iceberg 메타데이터가 아직 갱신되지 않았기 때문이다.

이때 `REFRESH EXTERNAL TABLE`로 캐시를 강제 갱신하면, 캐시 전체가 무효화되면서 오히려 풀 refresh가 발생할 수 있다. StarRocks 공식 문서에서도 캐시를 수동 refresh하는 것은 성능 최적화가 충분한 경우에 한해 권장하고 있다.

가장 안전한 방법은 **캐시 갱신 주기(약 10분)를 기다리는 것**이다. 이후 자연스럽게 변경분만 감지하여 incremental refresh가 정상 동작한다.

---

## 성과

| 구분 | 기존 (Delta Lake Catalog, 풀스캔) | 현재 (Iceberg V2, incremental) |
|---|---|---|
| FORCE refresh | 50~700초 | 53~58초 |
| 일반 refresh | 50~700초 (매번 풀스캔) | **1~2초** |
| 자동 갱신 | 수동 trigger | EVERY 10분 자동 |

incremental refresh는 FORCE 대비 약 **27배** 빠르다. 10분 주기 자동 갱신이 가능해지면서, 수동 운영 부담도 사라졌다.

---

## 프로덕션 운영 중 추가로 겪은 이슈

MV를 프로덕션에 배포한 뒤에도 두 가지 이슈가 더 발생했다. 둘 다 설정 레벨의 문제였지만, 증상만 보면 데이터 누락이나 스케줄러 장애처럼 보여서 원인을 찾기까지 시간이 걸렸다.

### 타임존 불일치로 최신 데이터가 MV에 안 보이는 문제

CelerData BYOC의 기본 타임존은 `America/New_York`(EDT, UTC-4)이다. 문제는 Databricks가 UTC 기준으로 데이터를 적재하는데, StarRocks가 이 타임스탬프를 EDT로 해석한다는 점이다.

**증상**: Databricks에 11:00 UTC까지 데이터가 있는데, StarRocks MV에서는 07:00(= `NOW()` EDT 기준)까지만 데이터가 보였다. `FORCE` refresh를 수동으로 실행해도 결과는 동일했다. StarRocks 입장에서 11:00 UTC 데이터는 EDT 기준 "미래"이므로, `NOW()` 시점까지만 처리하고 나머지를 스킵한 것이다.

**원인**: StarRocks의 `NOW()` 함수는 클러스터의 `time_zone` 설정을 따른다. EDT(UTC-4) 기준 `NOW()`가 07:00인 시점에, UTC 11:00 데이터는 4시간 뒤의 미래 데이터로 인식된다. MV refresh 로직이 `NOW()` 이후 데이터를 제외하면서 최신 데이터가 누락되었다.

**해결**: 클러스터 타임존을 UTC로 통일했다.

```sql
-- 타임존을 UTC로 변경 (GLOBAL -- 전체 클러스터 적용)
SET GLOBAL time_zone = 'UTC';

-- 변경 확인
SHOW VARIABLES LIKE '%time_zone%';
```

Databricks와 StarRocks의 타임존이 일치하면서 데이터 스킵 문제가 해결되었다. **외부 데이터 소스와 연동하는 환경에서는 타임존을 반드시 UTC로 통일하는 것이 안전하다.**

### MV 자동 refresh 스케줄이 ALTER로는 등록되지 않는 문제

초기에 MV를 `REFRESH MANUAL`로 생성한 뒤, 테스트가 끝나고 자동 스케줄로 전환하려고 `ALTER`를 실행했다.

```sql
-- MV를 MANUAL로 생성한 뒤
ALTER MATERIALIZED VIEW mv_db.target_mv
REFRESH ASYNC EVERY (INTERVAL 10 MINUTE);
```

`ALTER` 자체는 성공했지만, **자동 refresh가 실행되지 않았다.** `task_runs`를 조회해보면 `ALTER` 이후 실행된 모든 refresh의 `isManual`이 `true`였다. 자동 트리거(스케줄러)에 의한 실행이 단 한 건도 없었다.

```sql
-- task_runs에서 refresh 이력 확인
SELECT CREATE_TIME, FINISH_TIME, STATE, EXTRA_MESSAGE
FROM information_schema.task_runs
WHERE task_name LIKE '%target_mv%'
ORDER BY CREATE_TIME DESC
LIMIT 20;
```

결국 MV를 DROP하고, `REFRESH ASYNC EVERY`를 포함한 `CREATE`로 재생성한 뒤에야 `isManual=false`인 자동 트리거가 동작하기 시작했다.

```sql
-- DROP 후 ASYNC EVERY 포함하여 재생성
DROP MATERIALIZED VIEW mv_db.target_mv;

CREATE MATERIALIZED VIEW mv_db.target_mv
PARTITION BY (_dt_month)
REFRESH ASYNC EVERY (INTERVAL 10 MINUTE)
AS
SELECT *
FROM iceberg_catalog.schema.source_table;
```

**결론: MV의 refresh 정책은 `CREATE` 시점에 확정해야 한다.** 공식 문서에는 `ALTER MATERIALIZED VIEW ... REFRESH ASYNC EVERY(...)` 구문이 존재하지만, 실제로는 `MANUAL`에서 `ASYNC EVERY`로 변경할 때 스케줄러가 등록되지 않는 동작을 확인했다. 운영 환경에서는 처음부터 원하는 refresh 정책으로 MV를 생성하는 것이 안전하다.

---

## 현재 제약과 향후 옵션

### 비파티션 컬럼 Overwrite는 여전히 풀 refresh

파티션 컬럼 기반 `replaceWhere`로 전환했지만, 아직 일부 파이프라인은 비파티션 컬럼 기반 Overwrite를 사용하고 있다. 이 경우 Iceberg incremental refresh를 활용할 수 없다.

### StarRocks 4.1 IVM (Incremental View Maintenance)

StarRocks 4.1에 IVM이 추가되었다. 파티션 단위가 아니라 변경된 row(delta)만 읽어서 MV를 갱신하는 방식이다. 비파티션 컬럼 Overwrite 케이스도 처리할 수 있고, Iceberg V2 네이티브 IncrementalScan API를 활용한다.

단, **append-only 테이블만 지원**한다. DELETE/UPDATE가 있는 테이블에는 적용할 수 없다. 현재 V2 파티션 기반 incremental refresh가 안정적으로 동작하고 있으므로, 4.1 업그레이드는 급하지 않다.

---

## 정리

| 조건 | 결과 |
|---|---|
| Delta Lake Catalog | incremental 미지원, 항상 풀스캔 |
| Iceberg Catalog + V2 + 파티션 컬럼 기준 Overwrite | **incremental 동작** |
| Iceberg Catalog + V2 + 비파티션 컬럼 기준 Overwrite | 대규모 테이블에서 풀 refresh 또는 에러 |
| Iceberg Catalog + V3 | SKIPPED (StarRocks 3.5.14 미지원) |
| V3에서 V2로 다운그레이드 | 불가 |

공식 문서가 "V1 only"라고 말해도, 실제로 해보기 전까지는 모른다. V2에서 동작한다는 것을 테스트로 확인했고, 파티션 컬럼 기준 Overwrite 조건을 지키면 **27배의 성능 개선**을 얻을 수 있다.

---

## Reference

- [StarRocks -- Data Lake Query Acceleration with MVs](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_lake_query_acceleration_with_materialized_views/)
- [StarRocks -- Feature Support: Data Lake Analytics](https://docs.starrocks.io/docs/data_source/feature-support-data-lake-analytics/)
- [Delta Lake -- UniForm (Iceberg Compatibility)](https://docs.delta.io/latest/delta-uniform.html)
- [Databricks -- Read Delta tables with Iceberg clients (UniForm)](https://docs.databricks.com/aws/en/delta/uniform)
- [StarRocks 4.1 Release Notes -- IVM](https://docs.starrocks.io/releasenotes/release-4.1/)
- [GitHub #61789 -- Incremental Materialized View Refresh (IVM)](https://github.com/StarRocks/starrocks/issues/61789)
