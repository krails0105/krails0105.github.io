---
title: "[DevOps] Databricks Job 모니터링 대시보드 구축 -- system table predicate pushdown 버그 우회"
categories:
  - DevOps
tags: [Databricks, Monitoring, SystemTable, SQL, Dashboard, PredicatePushdown]
date: 2026-02-26
---

## Introduction

---

Databricks에서 장시간 돌아가는 ETL Job을 운영하다 보면 "어제 배치가 실패했는지, 소요 시간이 갑자기 늘었는지"를 빠르게 파악할 수 있는 모니터링 대시보드가 필수다.

Databricks는 `system.lakeflow.job_run_timeline`이라는 시스템 테이블로 Job 실행 이력을 제공한다. 이 테이블로 대시보드를 구성하는 과정에서 **부등호 필터(`<>`, `IS NULL`, `IS DISTINCT FROM`)가 완전히 깨지는 버그**를 발견했고, 이를 체계적으로 디버깅해 안전한 우회 패턴을 정립했다.

이 글에서 다루는 내용:

- `system.lakeflow.job_run_timeline` 테이블의 period-level 구조와 run 단위 집계 방법
- system table predicate pushdown 버그 발견 과정과 원인 분석
- 실무에서 안전하게 쓸 수 있는 필터 패턴 3가지
- 실패 감지, 소요 시간 추이, 비용 추적 쿼리 4종

## 배경 (Problem & Context)

---

### system.lakeflow.job_run_timeline의 period-level 구조

이 테이블은 하나의 Job run을 **최대 1시간 단위의 period로 분할**해서 저장한다. 1시간 미만으로 끝나는 run은 단일 row이고, 실행이 길어질수록 여러 row가 생기는 구조다.

```
run_id=123 (총 15분 실행 → period 1개)
  period 1: 12:00~12:15  result_state = 'SUCCEEDED'

run_id=456 (총 2시간 30분 실행 → period 3개)
  period 1: 12:00~13:00  result_state = NULL         -- 실행 중
  period 2: 13:00~14:00  result_state = NULL         -- 실행 중
  period 3: 14:00~14:30  result_state = 'SUCCEEDED'  -- 최종 결과
```

핵심 특성:

- 각 row의 `period_start_time` ~ `period_end_time` 구간이 **최대 1시간**을 커버한다.
- `result_state`는 **마지막 period에만** 기록된다. 중간 period는 모두 NULL이다.
- run이 실행을 시작하지 못한 경우 `period_start_time = period_end_time`인 row가 생긴다. 이때는 `termination_code`로 원인을 확인할 수 있다.

이 때문에 run 단위로 분석하려면 반드시 `GROUP BY run_id` + `MAX(result_state)` 조합이 필요하다.

```sql
SELECT
  run_id,
  MAX(result_state) AS final_state,   -- NULL이 아닌 마지막 period 값
  MIN(period_start_time) AS started,
  MAX(period_end_time)   AS ended
FROM system.lakeflow.job_run_timeline
WHERE job_id = YOUR_JOB_ID
GROUP BY run_id
```

> **참고**: 2025년 12월부터 `run_duration_seconds`, `execution_duration_seconds`, `setup_duration_seconds` 등 새 컬럼이 추가되었다. 이 컬럼들은 period 레벨이 아닌 run 레벨 정보를 담고 있어, 소요 시간 계산을 `TIMESTAMPDIFF` 대신 이 컬럼으로 대체할 수 있다. 다만 2025년 12월 이전에 생성된 row에는 값이 채워져 있지 않다.

### 구축하려는 대시보드

4개 패널로 구성된 운영 대시보드를 목표로 했다.

| 패널 | 목적 | 시각화 |
|---|---|---|
| 실패 Run 목록 | 실패 발생 즉시 확인 + Alert 연동 | Table |
| 일별 실패 트렌드 | 주간/월간 안정성 추이 | Bar chart (stacked) |
| 소요 시간 추이 | P50/P95로 성능 이상 감지 | Line chart |
| 비용 추적 | DBU 사용량 모니터링 | Bar chart |

## 접근 방법 -- 버그 발견과 디버깅

---

### 처음 발견한 이상 징후

실패한 run을 조회하려고 아래 쿼리를 작성했다.

```sql
WHERE job_id = YOUR_JOB_ID
  AND result_state is null or result_state <> 'SUCCEEDED'
```

결과가 이상했다. 먼저 AND/OR 우선순위 문제임을 인식하고 괄호를 추가했다. (`AND`가 `OR`보다 우선순위가 높으므로, 괄호 없이 쓰면 `(job_id = ... AND result_state IS NULL) OR (result_state <> 'SUCCEEDED')`로 해석된다.)

```sql
WHERE job_id = YOUR_JOB_ID
  AND (result_state IS NULL OR result_state <> 'SUCCEEDED')
```

그런데 여전히 결과가 이상했다. 최신 데이터 몇 건만 나오고, 과거 실패 이력이 보이지 않았다.

### 데이터 실제 현황 확인

GROUP BY로 실제 데이터가 얼마나 있는지 확인했다.

```sql
SELECT result_state, COUNT(*) AS cnt
FROM system.lakeflow.job_run_timeline
WHERE job_id = YOUR_JOB_ID
GROUP BY result_state
```

```
result_state | cnt
null         | 335
CANCELLED    | 21
FAILED       | 6
SUCCEEDED    | 9940
ERROR        | 948
```

데이터는 분명히 있다. ERROR 948건, FAILED 6건, CANCELLED 21건. 그런데 부등호 필터로는 조회가 안 된다.

### 조건별 COUNT 분리 테스트

각 조건을 독립적으로 테스트해 어떤 연산이 동작하고 어떤 연산이 깨지는지 정확히 확인했다.

```sql
SELECT
  COUNT(CASE WHEN result_state = 'SUCCEEDED' THEN 1 END)               AS eq_succeeded,
  COUNT(CASE WHEN result_state IN ('ERROR','FAILED','CANCELLED') THEN 1 END) AS in_failed,
  COUNT(CASE WHEN result_state <> 'SUCCEEDED' THEN 1 END)             AS neq_succeeded,
  COUNT(CASE WHEN result_state IS NULL THEN 1 END)                      AS is_null,
  COUNT(CASE WHEN result_state IS DISTINCT FROM 'SUCCEEDED' THEN 1 END) AS is_distinct
FROM system.lakeflow.job_run_timeline
WHERE job_id = YOUR_JOB_ID
```

결과:

| 연산 | 예상 결과 | 실제 결과 | 상태 |
|---|---|---|---|
| `= 'SUCCEEDED'` | 9,940 | 9,940 | 정상 |
| `IN ('ERROR', 'FAILED', 'CANCELLED')` | 975 | 975 | 정상 |
| `<> 'SUCCEEDED'` | 1,310 | 1 | **깨짐** |
| `IS NULL` | 335 | 0 | **깨짐** |
| `IS DISTINCT FROM 'SUCCEEDED'` | 1,310 | 0 | **깨짐** |

**등호(`=`)와 `IN`만 정상이고, 부등호(`<>`)와 NULL 체크(`IS NULL`, `IS DISTINCT FROM`)가 모두 깨져 있다.**

이 결과를 통해 문제가 SQL 문법이나 데이터 자체가 아니라, **데이터를 읽는 레이어에서 특정 predicate 유형을 잘못 처리**하고 있다는 확신을 갖게 되었다.

### COALESCE 시도 -- 우연히 발견한 해결책

컬럼을 함수로 감싸보면 어떨까 싶어 COALESCE를 적용했다.

```sql
COUNT(CASE WHEN COALESCE(result_state, 'NONE') <> 'SUCCEEDED' THEN 1 END) AS coalesce_neq
```

결과: **1,310** (정상)

같은 부등호 연산인데 COALESCE로 감싸기만 해도 올바른 결과가 나온다. 이 시점에서 문제가 predicate pushdown에 있다는 것을 확정했다.

### 원인 분석

`system.lakeflow` 테이블은 일반 Delta 테이블이 아닌 **custom data source**다. Spark의 predicate pushdown 메커니즘은 data source 레이어에 필터를 전달하는데, 이 data source가 **등호 기반 predicate만 올바르게 처리**하고 부등호/NULL 체크는 잘못 처리한다.

Spark 내부적으로 data source V2 API의 `SupportsPushDownV2Filters` 인터페이스를 통해 동작한다. Data source는 `pushPredicates()` 메서드에서 자신이 처리할 수 있는 predicate를 받아들이고, 처리할 수 없는 predicate는 반환해서 Spark 엔진이 직접 처리하도록 한다. 문제는 이 system table의 data source가 `<>`, `IS NULL`, `IS DISTINCT FROM` 같은 predicate를 "처리할 수 있다"고 받아들여 놓고 실제로는 올바르게 처리하지 못한다는 점이다.

**COALESCE가 동작하는 이유**는 명확하다. Spark optimizer는 컬럼을 함수로 감싸면 해당 표현식을 data source에 pushdown할 수 없다고 판단해 **full scan 후 Spark 엔진이 직접 필터링**한다. COALESCE가 의도치 않게 "pushdown barrier" 역할을 하는 것이다.

**CTE(WITH 절)는 이 문제를 해결하지 못한다.** Spark optimizer가 CTE를 인라인으로 전개(inline expansion)하기 때문에 최종 실행 계획에서 pushdown이 그대로 발생한다.

정리하면:

| 패턴 | pushdown 여부 | 결과 |
|---|---|---|
| `result_state <> 'SUCCEEDED'` | pushdown 됨 | 깨짐 (data source 버그) |
| `COALESCE(result_state, 'NONE') <> 'SUCCEEDED'` | pushdown 불가 | 정상 (Spark 엔진 필터링) |
| CTE 안에서 `<>` 사용 | 인라인 전개 후 pushdown 됨 | 깨짐 |
| `result_state IN ('ERROR', 'FAILED', 'CANCELLED')` | pushdown 됨 | 정상 (등호 기반) |

## 구현 -- 실무 모니터링 쿼리 4종

---

### 안전한 필터 패턴 3가지

system table에서 `result_state` 필터를 쓸 때 안전한 패턴은 아래 3가지다.

```sql
-- 패턴 1: IN (내부적으로 등호 OR로 변환되어 pushdown 정상)
WHERE result_state IN ('ERROR', 'FAILED', 'CANCELLED')

-- 패턴 2: COALESCE (pushdown barrier 역할 -- Spark가 직접 필터링)
WHERE COALESCE(result_state, 'NONE') <> 'SUCCEEDED'

-- 패턴 3: GROUP BY 후 HAVING (집계 후 필터링이라 pushdown 대상이 아님)
GROUP BY run_id
HAVING MAX(result_state) <> 'SUCCEEDED'
```

실무에서는 **패턴 1(IN)** 을 기본으로 쓴다. 의도가 명확하고, pushdown이 정상 동작하므로 성능도 좋다. 패턴 2는 가능한 상태값을 열거하기 어려울 때, 패턴 3은 run 단위 집계가 필요할 때 사용한다.

### 쿼리 1: 최근 실패 Run 목록

```sql
-- system.lakeflow.job_run_timeline 기준 실패 Run 목록
WITH runs AS (
  SELECT
    run_id,
    MAX(result_state) AS final_state,
    MAX(error_message) AS error_message,
    MIN(period_start_time) AS started,
    MAX(period_end_time) AS ended,
    ROUND(
      TIMESTAMPDIFF(SECOND, MIN(period_start_time), MAX(period_end_time)) / 60.0,
      1
    ) AS duration_min
  FROM system.lakeflow.job_run_timeline
  WHERE job_id = YOUR_JOB_ID
    AND result_state IN ('ERROR', 'FAILED', 'CANCELLED')  -- IN으로 pushdown 안전
  GROUP BY run_id
)
SELECT * FROM runs
ORDER BY started DESC
```

`result_state IN (...)` 조건이 period 레벨에서 먼저 필터링한다. 정상 run은 마지막 period가 `SUCCEEDED`이고 나머지 period는 NULL이므로, `IN ('ERROR', 'FAILED', 'CANCELLED')` 조건을 통과하는 period가 하나도 없어 자연스럽게 배제된다. 결과적으로 실패한 run만 GROUP BY 대상에 남는다.

단, 이 패턴에는 주의할 점이 있다. 실패한 run의 중간 period(result_state = NULL)가 WHERE에서 제외되므로, `MIN(period_start_time)`이 실제 시작 시간이 아닌 마지막 period의 시작 시간이 될 수 있다. 1시간 미만 실행이 대부분인 Job에서는 period가 1개뿐이라 문제가 없지만, 장시간 실행 Job에서 정확한 시작 시간과 소요 시간이 필요하면 아래처럼 2단계로 풀어야 한다.

```sql
-- 장시간 실행 Job을 위한 정확한 시작 시간 집계
WITH failed_run_ids AS (
  -- 1단계: 실패한 run_id만 식별
  SELECT DISTINCT run_id
  FROM system.lakeflow.job_run_timeline
  WHERE job_id = YOUR_JOB_ID
    AND result_state IN ('ERROR', 'FAILED', 'CANCELLED')
),
runs AS (
  -- 2단계: 해당 run_id의 모든 period를 포함해 집계
  SELECT
    t.run_id,
    MAX(t.result_state) AS final_state,
    MAX(t.error_message) AS error_message,
    MIN(t.period_start_time) AS started,
    MAX(t.period_end_time) AS ended,
    ROUND(
      TIMESTAMPDIFF(SECOND, MIN(t.period_start_time), MAX(t.period_end_time)) / 60.0,
      1
    ) AS duration_min
  FROM system.lakeflow.job_run_timeline t
  INNER JOIN failed_run_ids f ON t.run_id = f.run_id
  WHERE t.job_id = YOUR_JOB_ID
  GROUP BY t.run_id
)
SELECT * FROM runs
ORDER BY started DESC
```

### 쿼리 2: 일별 실패 카운트 트렌드

```sql
-- 일별 실패 run 수 (ERROR/FAILED vs CANCELLED 분리)
WITH failed_runs AS (
  SELECT
    run_id,
    DATE(MIN(period_start_time)) AS run_date,
    MAX(result_state) AS final_state
  FROM system.lakeflow.job_run_timeline
  WHERE job_id = YOUR_JOB_ID
    AND result_state IN ('ERROR', 'FAILED', 'CANCELLED')
  GROUP BY run_id
)
SELECT
  run_date,
  COUNT(*) AS failed_total,
  SUM(CASE WHEN final_state IN ('ERROR', 'FAILED') THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN final_state = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
FROM failed_runs
GROUP BY run_date
ORDER BY run_date DESC
```

Lakeview 대시보드에서 이 쿼리를 Stacked Bar Chart로 시각화하면 일별 실패 패턴을 한눈에 파악할 수 있다. 특정 날짜에 ERROR가 집중되면 인프라 이슈, CANCELLED가 집중되면 수동 중단이나 timeout 설정을 먼저 확인한다.

### 쿼리 3: 소요 시간 추이 (P50/P95/MAX)

```sql
-- 성공 Run 소요 시간 분포 (일별 P50/P95)
WITH runs AS (
  SELECT
    run_id,
    DATE(MIN(period_start_time)) AS run_date,
    ROUND(
      TIMESTAMPDIFF(SECOND, MIN(period_start_time), MAX(period_end_time)) / 60.0,
      1
    ) AS duration_min
  FROM system.lakeflow.job_run_timeline
  WHERE job_id = YOUR_JOB_ID
    AND result_state = 'SUCCEEDED'  -- 성공 run만, = 연산자는 pushdown 안전
  GROUP BY run_id
)
SELECT
  run_date,
  COUNT(*) AS runs,
  ROUND(PERCENTILE(duration_min, 0.5),  1) AS p50_min,
  ROUND(PERCENTILE(duration_min, 0.95), 1) AS p95_min,
  ROUND(MAX(duration_min), 1)              AS max_min
FROM runs
GROUP BY run_date
ORDER BY run_date DESC
```

P95가 갑자기 튀는 날이 있으면 인프라 문제(클러스터 시작 지연, 리소스 경합)나 데이터 볼륨 급증을 먼저 확인한다. P50 대비 MAX가 3배 이상 차이나면 간헐적 지연 원인을 추적해볼 필요가 있다.

> **참고**: `result_state = 'SUCCEEDED'` 조건에서도 쿼리 1과 마찬가지로 성공한 run의 중간 period가 제외되는 효과가 있다. 성공한 run은 마지막 period에만 `SUCCEEDED`가 기록되고 나머지는 NULL이므로, `= 'SUCCEEDED'` 필터는 마지막 period만 통과시킨다. 따라서 장시간 실행 Job에서는 `MIN(period_start_time)`이 마지막 period의 시작 시간이 되어 실제 소요 시간보다 짧게 측정된다. 이 경우 쿼리 1의 2단계 패턴을 참고하거나, 2025년 12월 이후 데이터라면 `run_duration_seconds` 컬럼을 직접 활용하는 것이 더 정확하다.

### 쿼리 4: 비용 추적 (DBU)

```sql
-- system.billing.usage 기준 30일 DBU 사용량
SELECT
  usage_date,                          -- 전용 date 컬럼 (DATE(usage_start_time) 대신 사용)
  sku_name,
  ROUND(SUM(usage_quantity), 2) AS total_dbu
FROM system.billing.usage
WHERE usage_metadata.job_id = 'YOUR_JOB_ID'  -- 문자열 타입 주의
  AND usage_start_time >= CURRENT_DATE - INTERVAL 30 DAYS
GROUP BY usage_date, sku_name
ORDER BY usage_date DESC, total_dbu DESC
```

`system.billing.usage`는 `system.lakeflow`와는 별도 data source이므로 위에서 설명한 predicate pushdown 문제가 발생하지 않는다. 몇 가지 주의할 점:

- `usage_metadata.job_id`는 **문자열 타입**이다. 숫자형 `job_id`와 달리 따옴표로 감싸야 한다.
- `usage_date`는 billing 테이블 전용 date 컬럼으로, `DATE(usage_start_time)`보다 집계 성능이 좋다.
- `sku_name`으로 컴퓨트 유형(All-Purpose, Jobs, Serverless 등)별 DBU를 분리해서 볼 수 있다.

## 주의할 점 (Gotchas)

---

### system table은 일반 Delta 테이블이 아니다

`system.lakeflow.*`, `system.billing.*`, `system.access.*` 등 system table은 custom data source로 구현되어 있다. 따라서 필터 동작이 일반 Delta 테이블과 다를 수 있다. **쿼리 결과가 의심스러우면 `GROUP BY`로 먼저 데이터 분포를 확인**하는 습관이 필요하다. 이번 사례처럼 WHERE 결과와 GROUP BY 결과가 다르면 pushdown 문제를 의심해야 한다.

### CTE는 pushdown barrier가 아니다

```sql
-- 이렇게 해도 pushdown 버그는 그대로 발생한다
WITH base AS (
  SELECT * FROM system.lakeflow.job_run_timeline
  WHERE job_id = YOUR_JOB_ID
)
SELECT * FROM base WHERE result_state <> 'SUCCEEDED'  -- 여전히 깨짐
```

Spark optimizer가 CTE를 인라인으로 전개하기 때문에 최종 실행 계획에서 `result_state <> 'SUCCEEDED'` predicate는 원본 data source에 직접 pushdown된다. CTE가 중간에 있어도 방어가 되지 않는다.

pushdown barrier로 동작하는 것은 **컬럼을 함수로 감싸는 것**(COALESCE, CAST 등)이다. Spark optimizer는 함수가 적용된 표현식을 data source에 pushdown할 수 없다고 판단하므로 full scan 후 Spark 엔진이 직접 필터링한다.

### period 구조를 이해하지 않으면 중복 집계가 발생한다

run 단위 분석 없이 period row를 그대로 COUNT하면 장시간 실행 run이 과대 집계된다 (예: 3시간 run은 3개 row). 항상 `GROUP BY run_id`로 run을 먼저 집계하고 그 위에서 분석해야 한다.

### result_state 필터를 period 레벨에서 걸면 일부 period가 누락된다

앞서 쿼리 1에서 설명한 것처럼, `result_state IN (...)` 또는 `result_state = 'SUCCEEDED'`를 WHERE에 걸면 중간 period(result_state = NULL)가 제외된다. 단시간 run에서는 문제가 없지만, 장시간 run에서 정확한 시작 시간이나 소요 시간을 구해야 하면 2단계 쿼리가 필요하다.

또한, `result_state IS NULL`이 pushdown 버그로 깨지는 문제가 있으므로 "현재 실행 중인 run" 목록을 뽑으려면 다른 접근이 필요하다. `COALESCE(result_state, 'RUNNING') = 'RUNNING'`처럼 pushdown barrier를 활용하거나, 아직 종료되지 않은 run을 `period_end_time` 기준으로 판별하는 방법을 검토해야 한다.

---

- Databricks Lakeview 대시보드에 4개 패널 등록 및 자동 갱신 설정
- 쿼리 1(실패 Run 목록)에 Alert 연동 -- Slack 채널 알림 자동화
- `system.lakeflow.job_task_run_timeline`으로 task 단위 소요 시간 분석 추가 (어느 task가 병목인지 파악)
- 2025년 12월에 추가된 `run_duration_seconds`, `execution_duration_seconds` 컬럼 활용 -- `TIMESTAMPDIFF` 수동 계산 대체 검토
- 30일 이상 장기 트렌드를 위해 별도 Delta 테이블에 주기적으로 스냅샷 저장 검토 (system table retention 제한 대응)

## Reference

---

- Databricks 공식: [Jobs system table reference (system.lakeflow)](https://docs.databricks.com/en/admin/system-tables/jobs.html)
- Databricks 공식: [Billing system table reference (system.billing.usage)](https://docs.databricks.com/en/admin/system-tables/billing.html)
- Databricks 공식: [Monitor job costs with system tables](https://docs.databricks.com/en/admin/usage/system-tables.html)
- Apache Spark: [SupportsPushDownV2Filters](https://spark.apache.org/docs/latest/api/scala/org/apache/spark/sql/connector/read/SupportsPushDownV2Filters) -- data source V2 predicate pushdown 메커니즘
- Databricks 공식: [December 2025 release notes -- new columns in Lakeflow system tables](https://docs.databricks.com/en/release-notes/product/2025/december.html)
