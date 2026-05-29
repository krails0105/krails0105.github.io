---
title: "StarRocks Async MV Partition Tracking: JOIN ON 절 inequality 로 71분 → 12초"
categories:
  - DataEngineering
tags: [StarRocks, MaterializedView, PartitionTracking, Iceberg, QueryOptimization]
---

## 들어가며

StarRocks Async Materialized View(이하 MV)를 운영하다 보면 "왜 변경되지 않은 파티션까지 매번 refresh 되는가"라는 의문을 마주치게 된다. 이 글은 어떤 multi-base MV의 daily refresh가 71분씩 걸리던 문제를 분석하고, JOIN ON 절에 partition column 사이의 부등호(inequality) 한 줄을 추가해 약 12초로 줄인 과정을 기록한다.

핵심은 단순한 트릭이 아니라, StarRocks plan analyzer가 어떤 형태의 술어(predicate)를 partition correspondence 단서로 인식하는가에 대한 이해다. 글을 읽고 나면 자신의 MV에서도 비슷한 패턴을 발견하고 수정할 수 있도록, 가설부터 실험·해결·학습까지 순서대로 정리했다.

## 필요한 사전 지식

- StarRocks Async MV의 기본 개념 (`REFRESH ASYNC`, `PARTITION BY`, `REFRESH MANUAL`)
- 컬럼나 기반 파티셔닝 (특히 date/datetime 기반 partition column)
- `information_schema.task_runs` 등 메타 테이블로 MV refresh 결과를 확인해 본 경험

테스트 환경은 다음과 같다.

- StarRocks (CelerData BYOC 계열) v4.0.10-ee
- Base table: Delta Uniform Iceberg V2 포맷의 외부 카탈로그 테이블
- partition 단위: day 또는 month

## 배경: StarRocks MV Partition Tracking이란

StarRocks Async MV는 refresh 대상 파티션을 두 가지 방식으로 결정한다.

1. **Partition Tracking (Precise)**: MV 파티션과 base table 파티션의 대응 관계를 plan analyzer 단계에서 파악한다. base에서 실제로 변경된 파티션에 매핑되는 MV 파티션만 refresh한다.
2. **Broad-Stale (Fallback)**: 대응 관계를 파악하지 못하면 해당 base의 *어떤* 파티션이 바뀌어도 MV의 광범위한 range(또는 전체)를 stale로 처리해 refresh한다.

공식 문서 역시 multi-base JOIN MV에서는 **"base table 사이에 동일 type의 partition key를 갖고 JOIN으로 연결해야 한다"** 고 명시한다. 즉 partition column끼리 *대응 관계가 명확해야* 모든 base가 partition tracking 대상이 된다.

문제는, 동일 type의 partition column이 있어도 **그 관계가 쿼리 본문에 드러나 있어야** 한다는 것이다. 컬럼명이 같다고 자동으로 인식해 주지는 않는다. 이 글의 시작점이다.

## 문제 상황

3개 base table을 JOIN하는 multi-base MV가 있었다. 운영 지표는 다음과 같다.

- 총 파티션 수: **6,350개**
- 매 refresh 시 갱신 파티션: **1,024개 (16.1%)**
- 단 한 번도 refresh되지 않은 파티션: **5,326개**
- 소요 시간: **71분**
- 패턴: 매일 거의 동일한 파티션 셋이 반복 refresh (deterministic broad-stale)

upstream 데이터는 최근 며칠치에만 write가 발생한다. 그런데 왜 수천 개의 파티션이 항상 stale 판정을 받고 있는가. 그것도 매번 같은 1,024개가.

## 1차 가설들 — 모두 틀렸다

분석 초기에 다음 가설들을 세웠고, 하나씩 검증해 모두 제거했다.

| 가설 | 검증 결과 |
|---|---|
| 1,024 = SR 내부 hard cap | 틀림. 비율 기반(16.1%) 우연의 일치 |
| base table에 historical write가 빈번 | 틀림. 운영 확인 결과 거의 없음 |
| Databricks OPTIMIZE가 historical 파티션을 reset | 틀림. 1회성 이벤트일 뿐 반복되지 않음 |
| Iceberg V2가 incremental refresh 미지원 | 틀림. 동일 클러스터의 다른 MV에서 V2 incremental 작동 확인 |
| non-SPJG/CTE 사용이 결정적 원인 | 보조 요인일 뿐 충분조건 아님 |

가설을 모두 제거하자 남은 의심 지점은 **JOIN 조건 자체**였다. base들이 partition column에서 어떻게 연결되는지를 plan analyzer가 못 본다면, partition correspondence를 잃고 broad-stale로 떨어진다는 추론이다.

## Sandbox 실험: JOIN ON vs WHERE

가설을 확인하기 위해 격리된 sandbox에 1,000개 day-partition을 가진 2개 테이블(Delta Uniform Iceberg V2)을 만들고, JOIN 조건 변형으로 비교 실험을 진행했다.

```sql
-- v1: 기본형 (PK 컬럼만 equality)
JOIN ON i.parent_id = b.parent_id

-- v2: partition col equality 추가
JOIN ON i.parent_id = b.parent_id
   AND i.dt = b.dt

-- v3: 동일 조건을 WHERE 절로 분리
JOIN ON i.parent_id = b.parent_id
WHERE i.dt = b.dt

-- v4: partition col inequality 추가
JOIN ON i.parent_id = b.parent_id
   AND i.dt >= b.dt

-- v5: no-op true predicate (semantic 무관 조건)
JOIN ON i.parent_id = b.parent_id
   AND b.dt < '2099-01-01'
```

검증은 매번 base 한쪽에 1개 파티션만 write 한 뒤 `REFRESH MATERIALIZED VIEW ... WITH SYNC MODE`를 실행하고, `information_schema.task_runs.EXTRA_MESSAGE` 의 `mvParts`/`refBase` 값을 읽었다.

| Variant | mvParts refreshed | refBase |
|---|---|---|
| v1 default | 161 | 1001 |
| v2 equality | **1** | **1** |
| v3 WHERE filter | 161 | 1000 |
| v4 inequality | **1** | **1** |
| v5 no-op true | 161 | 1000 |

핵심 발견 두 가지.

1. **JOIN ON 절에 partition column 조건을 추가**하면 plan analyzer가 partition 대응 관계를 인식해 precise tracking이 활성화된다.
2. **WHERE 절은 효과가 없다.** SR optimizer가 이를 post-JOIN filter로 분류해 partition propagation 정보가 소실된다.

v5가 효과 없는 것도 중요하다. `b.dt < '2099-01-01'`처럼 partition column을 언급하더라도 semantic 무관한 상수 비교는 인식 단서로 사용되지 않는다. SR plan analyzer가 보는 것은 두 테이블의 **partition column 사이의 관계**다.

## Production Fix: 3-base JOIN에서 inequality 적용

Production MV는 base table이 3개였다. 익명화한 구조는 다음과 같다.

- `events_input` — 주 테이블, daily partition (`datetime_day`)
- `block_meta` — 블록 메타, daily partition (`datetime_day`)
- `price_hourly` — 시세, monthly partition (`datetime_month`)

원래 JOIN 구조는 모든 JOIN을 PK equality 하나로만 연결하고 있었다.

```sql
-- block_meta 과는 parent_id equality 만 (partition 관계 없음)
JOIN block_meta b
  ON i.parent_id = b.parent_id

-- price_hourly 와는 hour equality 만 (partition 관계 없음)
JOIN price_hourly p
  ON s.exit_hour = p.datetime
```

이 형태에서는 두 base 모두 partition tracking 대상에서 빠지고, 결과적으로 매 refresh마다 broad-stale 1,024개를 반복했다.

수정 핵심은 두 가지다.

1. **day-partition base** 와는 `>=` inequality 로 partition column 관계를 명시한다. 이벤트 도메인 규칙상 `spent_day >= created_day` 가 항상 참이므로 결과 데이터에 변화가 없다.
2. **month-partition base** 와는 CTE에서 `partition_dt_month` 컬럼을 직접 노출한 뒤 equality 로 연결한다.

```sql
-- block_meta: 이벤트는 생성 후에만 소비 가능 -> spent_day >= created_day 항상 참
JOIN block_meta b
  ON i.parent_id = b.parent_id
  AND i.datetime_day >= b.datetime_day              -- partition tracking 활성화

-- price_hourly: 월 단위 partition col을 CTE에서 명시 노출 후 사용
JOIN price_hourly p_x
  ON s.exit_hour = p_x.datetime
  AND p_x.datetime_month = s.partition_dt_month     -- partition tracking 활성화
```

전체 수정 MV는 다음과 같다.

```sql
-- multi-base MV: event_aggregated_metric
CREATE MATERIALIZED VIEW silver.event_aggregated_metric
PARTITION BY partition_dt
REFRESH MANUAL
AS
WITH
  price_hour AS (
    SELECT datetime, datetime_month, close AS price
    FROM lakehouse.dim.price_hourly
    WHERE symbol = 'X'
  ),
  spent AS (
    SELECT
      date_trunc('hour', i.datetime)          AS datetime,
      i.datetime_day                          AS partition_dt,
      date_trunc('month', i.datetime_day)     AS partition_dt_month,  -- 명시적 노출 (핵심)
      i.value                                 AS v,
      date_trunc('hour', b.datetime)          AS entry_hour,
      date_trunc('hour', i.datetime)          AS exit_hour,
      b.datetime                              AS created_time,
      i.datetime                              AS spent_time
    FROM lakehouse.fact.events_input i
    JOIN lakehouse.fact.block_meta b
      ON i.parent_id = b.parent_id
      AND i.datetime_day >= b.datetime_day    -- inequality: partition tracking 활성화
    WHERE NOT i.is_root_event
  ),
  priced AS (
    SELECT s.datetime, s.partition_dt, s.v, s.created_time, s.spent_time,
           p_e.price AS entry_price, p_x.price AS exit_price
    FROM spent s
    JOIN price_hour p_e
      ON s.entry_hour = p_e.datetime
      AND p_e.datetime_month <= s.partition_dt_month   -- entry price: inequality
    JOIN price_hour p_x
      ON s.exit_hour = p_x.datetime
      AND p_x.datetime_month = s.partition_dt_month    -- exit price: equality
  )
SELECT
  datetime,
  partition_dt,
  AVG(TIMESTAMPDIFF(SECOND, created_time, spent_time) / 86400.0) AS avg_holding_days,
  SUM(v)                                                           AS total_value,
  SUM(CASE WHEN exit_price >= entry_price THEN v * (exit_price - entry_price) ELSE 0 END) AS realized_profit,
  SUM(CASE WHEN exit_price <  entry_price THEN v * (exit_price - entry_price) ELSE 0 END) AS realized_loss
FROM priced
GROUP BY datetime, partition_dt;
```

수정 후 한 사이클의 refresh 결과는 다음과 같았다.

```text
batches=1, state=SUCCESS
mvParts=1
refBase={events_input: 1, block_meta: 1, price_hourly: 0}
```

모든 3개 base table이 `refBase` 메타에 등록되었고, refresh는 변경된 1개 파티션에만 수행되었다.

**71분 → 약 12초 (약 355배 단축)**

## 검증: refBase 를 어떻게 읽나

수정이 의도대로 적용됐는지 다음과 같이 확인할 수 있다.

```sql
-- 가장 최근 refresh 결과 한 건
SELECT
  task_name,
  state,
  create_time,
  finish_time,
  extra_message
FROM information_schema.task_runs
WHERE task_name LIKE 'mv-%event_aggregated_metric%'
ORDER BY create_time DESC
LIMIT 1;
```

`extra_message` 는 JSON-ish 문자열이고, 그 안에 다음과 같은 키들이 들어 있다.

- `mvParts` — 이번 refresh 가 건드린 MV 파티션 수
- `refBase` — base 별로 참조된 partition 수 (dict)
- `batches` — 분할된 refresh batch 수
- `state` — `SUCCESS` / `FAILED` / `RUNNING` 등

검증 체크리스트는 두 가지다.

1. **`mvParts` 가 base에서 실제 변경된 파티션 수와 비슷한지** — 비슷하면 precise, 훨씬 크면 broad-stale 의심.
2. **`refBase` 에 모든 base table 이 키로 들어 있는지** — 누락된 base 가 있으면 그 base 의 변경은 broad-stale 을 유발한다.

## 실패 사례: chained derivative는 인식하지 못한다

처음 `price_hourly` 의 partition 관계를 추가할 때 아래처럼 작성했다가 실패했다.

```sql
-- 실패: chained derivative
AND p_x.datetime_month = date_trunc('month', s.datetime)
```

`s.datetime` 은 CTE 안에서 `date_trunc('hour', i.datetime)` 로 만들어진 값이다. SR plan analyzer 입장에서 보면 이 값은 partition column(`i.datetime_day`)의 **간접** derivative라 partition correspondence로 인식하지 못한다.

해결책은 partition column 에서 직접 파생된 컬럼을 CTE에서 명시 노출하는 것이다.

```sql
-- spent CTE 에서 명시 노출 (i.datetime_day 의 직접 derivative)
date_trunc('month', i.datetime_day) AS partition_dt_month

-- priced CTE 에서 참조
AND p_x.datetime_month = s.partition_dt_month
```

`partition_dt_month` 는 `i.datetime_day`(partition column)의 **직접** derivative이므로 plan analyzer가 인식한다.

**학습 포인트**: SR plan analyzer는 partition column의 *직접* derivative만 partition 관계로 추적한다. CTE 체인을 거쳐 두 단계 이상 변환된 컬럼은 추적하지 못한다.

## `>=` 를 쓴 이유 — semantic vs. no-op

실험 v5에서 `b.dt < '2099-01-01'` 같은 no-op true predicate는 효과가 없었다. 그렇다면 `i.datetime_day >= b.datetime_day` 는 왜 효과가 있는가?

두 가지 이유가 맞물린다.

- **Semantic 측면**: 이벤트는 생성된 블록보다 이전에 소비될 수 없다. `spent_day >= created_day` 는 도메인 규칙상 항상 참이지만, "두 테이블의 partition column 사이에 방향 관계가 있다"는 정보를 plan analyzer에 전달한다.
- **SR 인식 측면**: no-op true predicate(상수 비교)와 달리, 두 테이블의 partition column을 직접 비교하는 inequality는 대응 관계 단서로 사용된다.

정리하면 의미 있는 inequality는 **결과 데이터에 영향을 주지 않으면서 partition correspondence를 SR에 알려주는 힌트** 다.

참고로 `=` 를 쓰면 "같은 날 생성되고 같은 날 소비된 이벤트" 만 남아 대부분의 long-term holder 데이터가 소실된다. `>=` 가 semantically 도 올바른 선택이다.

## 패턴 정리: 어떤 경우에 무엇을 쓰나

| 상황 | JOIN ON 에 추가할 조건 |
|---|---|
| 두 base 의 partition col 이 1:1 대응 | `AND a.dt = b.dt` |
| b 의 partition 이 항상 a 보다 같거나 작음 (e.g. 이벤트) | `AND a.dt >= b.dt` |
| partition 단위 다름 (dim=month, main=day) | CTE 에서 `date_trunc('month', main.dt) AS dt_month` 명시 노출 후 `AND dim.month_col = main.dt_month` |
| WHERE 절로 partition 필터를 이미 걸고 있음 | **효과 없음** — JOIN ON 으로 옮길 것 |

## 주의할 점

1. **WHERE 절은 partition tracking 단서로 쓰이지 않는다.** 같은 조건이라도 WHERE 에 두면 SR optimizer 가 post-JOIN filter 로 처리해 partition propagation 이 끊긴다. partition column 관계는 반드시 JOIN ON 안에 둔다.
2. **CTE 체인을 거친 derivative 는 추적이 깨질 수 있다.** 의심스러우면 partition column 기반 컬럼을 CTE 에서 한 번 더 명시적으로 SELECT 해 노출하라.
3. **`refBase` 로 검증하라.** MV refresh 후 `information_schema.task_runs.extra_message` 의 `refBase` 값을 확인해, 모든 base 가 키로 등록돼 있고 mvParts 가 합리적인 수치인지 본다. 한 table 이라도 누락이면 해당 base 의 변경이 broad-stale 을 유발한다.
4. **inequality 의 semantic 을 먼저 확인하라.** partition tracking 활성화 목적이라도 이는 결과에 영향을 주는 조건이다. 잘못된 inequality 는 데이터 누락을 일으킨다. 도메인 규칙으로 항상 참임이 보장될 때만 사용한다.
5. **`PARTITION BY` 와의 정렬을 잊지 말 것.** 공식 문서가 강조하듯 multi-base partitioned MV 는 base 간 partition key type 이 같아야 하고, MV `PARTITION BY` 컬럼은 그 공통 컬럼으로 잡아야 한다. JOIN ON 의 partition correspondence 와 `PARTITION BY` 가 함께 맞물려야 incremental refresh 가 성립한다.

## 다음 단계

- 같은 구조(multi-base JOIN, 파티션 단위 불일치)를 가진 다른 MV 에 동일 패턴 적용
- 자유쿼리 → MV 자동 생성 파이프라인에서 JOIN 그래프 분석 + partition correspondence 자동 주입 기능 검토
- `EXPLAIN ANALYZE` 와 `task_runs.extra_message` 출력에서 partition tracking 활성화 여부를 자동 감지하는 검증 스크립트 도입

## Reference

- [StarRocks Async MV — Data modeling with materialized views](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_modeling_with_materialized_views/)
- [StarRocks — Create partitioned materialized view](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/create_partitioned_materialized_view/)
- [StarRocks SQL Reference — CREATE MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW/)
- [StarRocks SQL Reference — REFRESH MATERIALIZED VIEW](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/REFRESH_MATERIALIZED_VIEW/)
