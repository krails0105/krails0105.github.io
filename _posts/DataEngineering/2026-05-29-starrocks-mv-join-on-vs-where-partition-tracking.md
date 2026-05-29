---
title: "StarRocks Async MV의 JOIN ON vs WHERE: Partition Tracking이 갈리는 이유"
categories:
  - DataEngineering
tags:
  - StarRocks
  - MaterializedView
  - SQL
  - QueryOptimization
  - PartitionTracking
date: 2026-05-29
---

## Overview

SQL 교과서는 INNER JOIN에서 `ON` 절과 `WHERE` 절이 **"semantically equivalent"** 라고 가르친다. 결과 row set이 같기 때문에 어디에 predicate를 놓아도 동일하다는 설명이다.

그런데 StarRocks의 Async Materialized View(MV)에서 multi-base JOIN을 구성하다 보면 이 직관이 깨지는 지점을 만나게 된다. partition column 비교를 `ON`에 두면 partition tracking이 동작하지만, 같은 조건을 `WHERE`로 옮기는 순간 tracking이 꺼진다. 결과 데이터는 동일한데, 한 번의 refresh가 건드리는 partition 수가 **1개와 161개로 갈리는** 현상이다.

이 글에서는 1,000-partition 환경에서 4가지 variant를 비교한 샌드박스 결과를 토대로, 왜 이런 차이가 발생하는지를 StarRocks query planner의 SPJG 매칭 관점에서 정리한다. 결론을 먼저 말하면, INNER JOIN의 "결과 동치"는 SQL 표준의 약속이지만 "plan 동치"는 optimizer 구현의 영역이라는 것이다.

## Prerequisites

- StarRocks v3.3 이상 (multi-reference base table partition tracking 지원)
- Async MV의 기본 개념 (`REFRESH ASYNC`, `PARTITION BY`)에 대한 사전 이해
- INNER JOIN과 OUTER JOIN의 NULL 처리 차이를 알고 있으면 도움이 됨

## 배경: Async MV의 Partition Tracking이란

StarRocks의 Async MV는 base table이 변경될 때 **변경된 partition만 골라서 refresh** 하는 incremental refresh를 지원한다. 이를 partition tracking이라 부른다.

MV가 단일 base table로 구성된 경우에는 별다른 설정 없이도 tracking이 동작한다. 문제는 **multi-base JOIN** 구성일 때다.

```sql
-- 예시: fact 테이블 + dim 테이블 JOIN 구조
CREATE MATERIALIZED VIEW mv_example
PARTITION BY (partition_dt)
REFRESH ASYNC
AS
SELECT m.partition_dt, m.value, d.label
FROM main_table m
JOIN dim_table d ON m.id = d.id;
```

이 구조에서 `dim_table`이 변경되었을 때 MV가 **어느 partition을 refresh해야 하는지** 알려면, main과 dim 사이의 partition 대응관계를 optimizer가 인식해야 한다. StarRocks CBO(Cost-Based Optimizer)가 이 관계를 어떻게 도출하느냐가 핵심이다.

공식 문서는 multi-reference base table 케이스를 다음과 같이 설명한다.

> "You can create a materialized view whose partitions are aligned with those of multiple base tables, as long as the partitions of the base tables can align with each other." — *StarRocks Docs, Async MV*

문서는 partition alignment의 **조건**은 명시하지만, "어떻게 alignment를 표현해야 하는가"에 대한 가이드가 약하다. 공식 예제 SQL을 보면 모두 `ON` 절에 partition column 비교를 두고 있는데, 그 이유가 본문에서 명시되지 않는다. 이 글이 메우려는 빈자리가 바로 그 지점이다.

## 샌드박스 검증: 5가지 Variant 비교

1,000 partition 환경에서 동일한 결과를 반환하는 5가지 쿼리 변형으로 MV를 만들고, partition 1개를 변경한 뒤 refresh가 건드린 partition 수를 측정했다.

| Variant | predicate 위치 | mvParts refresh | refBase scan | 평가 |
|---|---|---|---|---|
| v1 default | predicate 없음 | 161 | 1001 | broad-stale |
| **v2 equality** | `JOIN ON ... AND a.dt = b.dt` | **1** | **1** | precise |
| v3 wherefilter | `WHERE a.dt = b.dt` | 161 | 1000 | broad-stale |
| **v4 inequality** | `JOIN ON ... AND a.dt >= b.dt` | **1** | **1** | precise |
| v5 noop | `JOIN ON ... AND b.dt < '2099-01-01'` | 161 | 1000 | broad-stale |

여기서 `mvParts refresh`는 한 번의 refresh가 갱신한 MV partition 수, `refBase scan`은 dim 쪽 base table에서 스캔한 partition 수다. v2/v4에서 둘 다 1로 떨어졌다는 것은 incremental refresh가 정확히 의도한 1개 partition만 손을 댔다는 의미다.

핵심 결론은 두 가지다.

1. `ON` 절에 partition column 간 **직접 비교**(`=` 또는 `>=`)를 추가하면 partition tracking이 활성화된다.
2. `WHERE` 절에 동일한 predicate를 넣으면 효과가 없다. 결과 row는 같지만 plan 구조가 달라지기 때문이다.

## 왜 다르게 동작하는가: Plan Tree 관점

StarRocks의 transparent query rewrite는 **SPJG**(Select-Project-Join-Group-by) 형식을 기준으로 plan을 매칭한다. 이는 공식 문서가 명시한 알고리즘이다.

> "StarRocks uses a widely adopted transparent query rewrite algorithm based on the SPJG (select-project-join-group-by) form." — *StarRocks Docs, Query Rewrite*

SPJG 매칭의 핵심 도구 중 하나가 **equivalence class** 도출이다. 두 컬럼이 join condition에서 `=`로 묶이면 optimizer는 둘을 같은 equivalence class로 묶고, 이 정보를 partition propagation에 활용한다.

### JOIN ON 절 predicate

`ON` 절의 predicate는 plan tree에서 join node의 condition으로 통합된다.

```
HashJoin
├── join condition: a.id = b.id AND a.dt = b.dt
├── equivalence classes derived: {a.id, b.id}, {a.dt, b.dt}
├── Scan(main_table)   partition column: a.dt
└── Scan(dim_table)    partition column: b.dt
```

CBO의 partition propagation 로직은 equivalence class `{a.dt, b.dt}`를 보고 "main의 dt partition이 변경되면 dim의 대응 dt partition도 함께 refresh해야 한다"는 1:1 대응관계를 도출한다. 결과적으로 **변경된 단 1개 partition만** refresh 대상이 된다.

### WHERE 절 predicate

`WHERE` 절은 plan tree에서 **post-join filter node**로 처리된다.

```
Filter (a.dt = b.dt)                            <-- post-join, partition relation 정보 없음
└── HashJoin
    ├── join condition: a.id = b.id             <-- partition col은 join에 안 들어옴
    ├── Scan(main_table)   partition column: a.dt
    └── Scan(dim_table)    partition column: b.dt
```

이 구조에서 join node에는 partition column에 대한 equivalence 정보가 존재하지 않는다. Filter node는 row-level 통과 여부만 결정하며 partition correspondence를 join 쪽으로 전달하지 않는다. CBO는 partition 관계를 추론할 근거를 잃고, 안전 측면(soundness)에서 **모든 stale partition을 broad refresh** 하도록 fallback한다. 이게 161개라는 숫자의 정체다.

### No-op predicate가 효과 없는 이유

`b.dt < '2099-01-01'`처럼 항상 참인 조건은 CBO가 plan 단순화 단계에서 제거(constant folding)한다. `ON` 절에 적었어도 join condition으로 남지 않으며, equivalence class에도 기여하지 못한다. 결과적으로 v1 default와 동일한 broad-stale 동작을 보인다.

### 한 줄 요약

INNER JOIN에서 ON과 WHERE는 **row set 관점에서는 같지만 plan 관점에서는 다르다**. 이 plan 차이가 MV partition tracking의 활성화 여부를 결정한다.

## INNER JOIN에서 ON vs WHERE: "결과 동치, plan 이질"

이론적으로 INNER JOIN에서는 다음 두 쿼리가 동일한 결과를 반환한다.

```sql
-- Query A: ON 절에 조건
SELECT *
FROM a
JOIN b
  ON a.id = b.id
  AND a.dt = b.dt;

-- Query B: WHERE 절에 조건
SELECT *
FROM a
JOIN b
  ON a.id = b.id
WHERE a.dt = b.dt;
```

> 참고: OUTER JOIN에서는 ON과 WHERE가 semantic 자체가 다르다. unmatched row의 NULL 처리 시점이 다르기 때문이다. 이건 SQL 표준의 영역이고 잘 알려진 사실이다. INNER JOIN에서의 plan 차이는 그것과는 별개로 **StarRocks optimizer 구현이 ON 절 predicate에 부여하는 추가 의미** 때문에 발생한다.

결과 row set은 같다. 그러나 StarRocks optimizer는 두 쿼리를 **다른 plan tree**로 만든다. ON에 있던 predicate는 join node 안에 들어가서 equivalence class 도출에 기여하지만, WHERE에 있던 predicate는 post-join filter로 빠진다. 이 plan 차이가 MV partition tracking의 활성화 여부를 결정한다.

"같은 쿼리 아닌가?" 라는 직관은 결과 관점에서는 맞지만, plan 관점에서는 틀리다.

## AND 순서는 무관하다

ON 절 내부에서 predicate의 순서는 결과에도, plan에도 영향을 주지 않는다. SQL AND는 교환·결합 법칙이 성립하며, optimizer가 내부에서 재배열한다.

```sql
-- 두 쿼리 동일하게 동작
JOIN ON a.id = b.id AND a.dt >= b.dt
JOIN ON a.dt >= b.dt AND a.id = b.id
```

중요한 것은 순서가 아니라 **위치(ON vs WHERE)** 다.

## 올바른 패턴

### 패턴 1: Equality (1:1 partition 대응)

가장 단순한 케이스다. 두 base table의 partition column이 같은 granularity일 때 사용한다.

```sql
CREATE MATERIALIZED VIEW mv_example
PARTITION BY (partition_dt)
REFRESH ASYNC
AS
SELECT m.partition_dt, m.value, d.label
FROM main_table m
JOIN dim_table d
  ON m.id = d.id
  AND m.partition_dt = d.partition_dt;   -- partition col equality를 ON 절에
```

이 패턴이 v2 variant에 해당하며, refresh가 정확히 1 partition만 건드린다.

### 패턴 2: Inequality (ordering 관계)

partition column이 정렬 관계로 묶이는 경우다. snapshot dim을 fact에 join하는 temporal 패턴에서 자주 등장한다.

```sql
SELECT m.partition_dt, m.value, d.label
FROM main_table m
JOIN dim_snapshot d
  ON m.id = d.id
  AND m.partition_dt >= d.snapshot_dt;   -- 범위 비교도 tracking 활성화
```

샌드박스 v4 결과대로, `>=`도 equivalence는 아니지만 partition propagation에는 충분하다. CBO가 main의 partition을 기준으로 dim 쪽 prune 범위를 도출할 수 있기 때문이다.

### 패턴 3: Cross-granularity (예: day vs month)

base table 간 granularity가 다를 때는, **partition column에서 한 단계 파생한 컬럼**을 CTE나 subquery에서 미리 노출한 뒤 그것을 ON 절에서 비교한다.

```sql
WITH main_with_month AS (
  SELECT *,
    date_trunc('month', partition_dt) AS partition_month
  FROM main_table
)
SELECT m.partition_dt, m.value, d.label
FROM main_with_month m
JOIN dim_monthly d
  ON m.id = d.id
  AND d.partition_month = m.partition_month;   -- 1-step 파생 컬럼끼리 직접 비교
```

여기서 핵심은 `date_trunc('month', partition_dt)`라는 **1단계 파생**까지는 CBO가 추적할 수 있다는 점이다. 공식 문서가 supported partition expression으로 명시한 `date_trunc()`, `str2date()`, `time_slice()`가 정확히 이 범주에 해당한다.

## 잘못된 패턴

### Bad 1: predicate를 WHERE로 이동

```sql
-- 잘못된 예: partition tracking 미작동
SELECT m.partition_dt, m.value, d.label
FROM main_table m
JOIN dim_table d ON m.id = d.id
WHERE m.partition_dt = d.partition_dt;   -- 결과는 같지만 plan에서 post-join filter로 빠짐
```

샌드박스 v3 그대로, refresh가 161 partition을 다 건드린다.

### Bad 2: No-op predicate

```sql
-- 잘못된 예: CBO가 simplify로 제거
JOIN dim_table d
  ON m.id = d.id
  AND d.partition_dt < '2099-01-01';   -- 항상 참 → equivalence class에 기여 못 함
```

샌드박스 v5에 해당하며, 사실상 v1과 동일하게 동작한다.

### Bad 3: 간접 expression (2단계 이상 파생)

```sql
-- 잘못된 예: partition col에서 2단계 이상 파생된 expression
JOIN dim_monthly d
  ON m.id = d.id
  AND d.partition_month = date_trunc('month', m.derived_ts);
  -- m.derived_ts 자체가 m.partition_dt에서 파생된 컬럼이라면
  -- 여기서 다시 date_trunc를 씌우는 건 2단계 파생이 됨
```

공식 문서는 multi-column partition mapping에 대해 다음과 같이 못박는다.

> "Multi-column partitions in materialized views can only be directly mapped to the base table's partition columns. Mapping using functions or expressions on the base table's partition columns is not supported." — *StarRocks Docs, CREATE MATERIALIZED VIEW*

CBO가 추적 가능한 범위는 **partition column 자체** 또는 **공식 지원 partition expression 한 번**까지다. 그 너머로 가는 표현은 tracking에서 누락된다.

## Troubleshooting: tracking이 안 되는지 확인하는 법

partition tracking이 의도대로 동작하는지 확인하려면 refresh 직후 metadata view를 들여다보면 된다.

```sql
-- 최근 refresh job이 건드린 MV partition 수와 base scan partition 수 확인
SELECT
  mv_name,
  refresh_start_time,
  mv_refresh_partitions,    -- mvParts
  ref_base_partitions       -- refBase scan
FROM information_schema.task_runs
WHERE task_name LIKE 'mv-%mv_example%'
ORDER BY create_time DESC
LIMIT 5;
```

mv_refresh_partitions가 base 변경분 대비 과도하게 크다면 tracking이 broad-stale fallback에 들어간 신호다. 이때 의심해야 할 것은 다음 셋이다.

1. partition col equality가 ON이 아니라 WHERE에 있는가
2. predicate가 constant folding으로 제거될 항상-참 조건인가
3. partition col에 2단계 이상의 파생 expression이 걸려 있는가

## 요약

| 구분 | ON 절 | WHERE 절 |
|---|---|---|
| INNER JOIN 결과 row set | 동일 | 동일 |
| Plan 처리 위치 | join node에 통합 | post-join filter |
| Equivalence class 기여 | 기여함 | 기여 못 함 |
| Partition tracking | 활성화 | 미작동 |
| 적용 가능 predicate 유형 | equality, inequality | (해당 없음) |
| No-op predicate | 효과 없음 | 효과 없음 |

StarRocks Async MV를 multi-base JOIN으로 구성할 때, base table 간 partition 관계는 **반드시 JOIN ON 절에 직접 명시** 해야 한다. SQL standard의 "INNER JOIN에서 ON과 WHERE는 equivalent"라는 문장은 row set 관점에서만 참이다. plan tree와 partition tracking 관점에서는 두 위치가 결정적으로 다르다.

공식 문서가 multi-base JOIN 예제에서 일관되게 `ON` 절에 partition col equality를 두는 데에는 분명한 이유가 있다. 다만 그 이유를 명시하지 않을 뿐이다. 이 글이 그 빈 자리에 대한 작은 메모이기를 바란다.

## Reference

- [StarRocks Docs: Async MV - Partitioned Materialized View](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/create_partitioned_materialized_view/)
- [StarRocks Docs: Async MV - Query Rewrite (SPJG)](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/query_rewrite_with_materialized_views/)
- [StarRocks Docs: CREATE MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW/)
- 관련 포스트: [StarRocks + Databricks UniForm Iceberg V2에서 MV Incremental Refresh 적용기](/dataengineering/starrocks-iceberg-incremental-mv/)
- 관련 포스트: [StarRocks Delta Lake MV Limitations](/dataengineering/starrocks-delta-lake-mv-limitations/)
