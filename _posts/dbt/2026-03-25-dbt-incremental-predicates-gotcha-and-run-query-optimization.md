---
title: "dbt incremental_predicates의 함정 -- MERGE 중복 row 생성 원인과 run_query 최적화로 slot_ms 75% 절감"
categories:
  - dbt
tags: [dbt, BigQuery, incremental, MERGE, optimization, data-engineering, run_query]
---

## 들어가며

dbt BigQuery incremental 모델에서 `incremental_predicates`를 적용했더니 slot_ms가 50~70% 줄었다. 성공적으로 보였는데, 데이터를 검증해보니 **중복 row가 조용히 쌓이고** 있었다.

이 글에서는 그 원인을 분석하고, 대안으로 `run_query` compile-time 캐싱을 적용해 **slot_ms 75% 절감**에 성공한 과정을 정리한다. 구체적으로 다음 내용을 다룬다.

- `incremental_predicates`가 MERGE 문의 `ON` 절을 어떻게 변경하는지
- 그 변경이 왜 `WHEN NOT MATCHED` 분기에서 중복 INSERT를 일으키는지
- `run_query`로 컴파일 시점에 리터럴 값을 주입해 동일한 비용 절감 효과를 안전하게 얻는 방법

> **환경**: dbt-core 1.10.5, dbt-bigquery 1.10.0, Google BigQuery

---

## 배경: 전체 테이블 스캔 문제

시계열 일별 메트릭을 쌓는 incremental 모델이 있다. `merge` 전략으로 날짜를 unique key로 삼아 UPSERT한다. 문제는 대상 테이블 전체를 스캔하는 비용이다.

BigQuery에서 `merge` 전략을 쓰면 dbt가 다음과 같은 MERGE 문을 생성한다.

```sql
MERGE INTO target AS DBT_INTERNAL_DEST
USING (
  -- source query
) AS DBT_INTERNAL_SOURCE
ON DBT_INTERNAL_SOURCE.datetime = DBT_INTERNAL_DEST.datetime
WHEN MATCHED THEN UPDATE SET ...
WHEN NOT MATCHED THEN INSERT ...
```

`ON` 절의 `DBT_INTERNAL_DEST.datetime = ...` 비교 때문에 BigQuery는 대상 테이블 전체를 읽는다. 테이블이 커질수록 slot_ms가 계속 늘어난다.

이를 줄이기 위해 `incremental_predicates`를 적용했고, 실측으로 slot_ms가 54~72% 줄어드는 것을 확인했다. 성공처럼 보였다.

---

## 접근 1: incremental_predicates -- 그리고 함정

### incremental_predicates란

dbt의 `incremental_predicates`는 MERGE 문의 `ON` 절에 추가 조건을 주입하여, BigQuery가 대상 테이블에서 스캔할 범위를 제한하는 기능이다. [공식 문서](https://docs.getdbt.com/docs/build/incremental-strategy#about-incremental_predicates)에서는 이를 "데이터 볼륨이 충분히 커서 추가적인 성능 투자가 정당화될 때" 사용하는 고급 옵션으로 분류한다.

설정 방법은 두 가지다. SQL 모델의 `config` 블록에서 직접 지정하거나, YAML 파일에서 지정할 수 있다.

{% raw %}
```sql
-- SQL 모델 config 블록
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    unique_key='datetime',
    incremental_predicates=[
      "DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)"
    ]
) }}
```
{% endraw %}

```yaml
# YAML (dbt_project.yml 또는 schema.yml)
models:
  - name: my_incremental_model
    config:
      materialized: incremental
      incremental_strategy: merge
      unique_key: datetime
      incremental_predicates:
        - "DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)"
```

이 설정이 생성하는 MERGE 문은 다음과 같다.

```sql
MERGE INTO target AS DBT_INTERNAL_DEST
USING (source) AS DBT_INTERNAL_SOURCE
ON DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
   AND DBT_INTERNAL_SOURCE.datetime = DBT_INTERNAL_DEST.datetime
WHEN MATCHED THEN UPDATE SET ...
WHEN NOT MATCHED THEN INSERT ...
```

`DBT_INTERNAL_DEST.datetime >= ...` 조건이 `ON` 절에 **AND**로 추가되면서, BigQuery는 최근 3일 파티션만 스캔한다. slot_ms가 크게 줄어든다.

### 함정: NOT MATCHED 분기가 조용히 중복을 만든다

문제는 MERGE 문의 동작 원리에 있다. `ON` 절의 조건이 **전체적으로 FALSE**가 되는 소스 row는 대상 테이블에 이미 존재하더라도 `WHEN NOT MATCHED` 분기로 떨어진다.

predicate 조건(`datetime >= 3일 전`)에 해당하지 않는 소스 row는 unique key 비교(`datetime = datetime`) 자체가 평가되지 않는다. BigQuery 입장에서는 "매칭되지 않은 새 데이터"로 판단하고 INSERT를 수행한다.

구체적인 예시로 설명하면 다음과 같다.

- **소스 데이터**: 3월 1일부터 오늘(3월 25일)까지 존재
- **predicate**: `datetime >= 3월 23일` (최근 3일)

| 소스 날짜 | ON 절 결과 | MERGE 동작 | 결과 |
|---|---|---|---|
| 3/1 ~ 3/22 | FALSE (predicate 불만족) | NOT MATCHED | **INSERT -- 중복 발생** |
| 3/23 ~ 3/25 | TRUE (predicate + unique key 매칭) | MATCHED | UPDATE (정상) |

3월 1일부터 22일까지의 데이터가 "매칭 안 된 새 데이터"로 오인되어 INSERT된다. 이미 테이블에 존재하는 row가 다시 INSERT되는 것이다.

### 실측으로 확인한 중복

실제 테이블에서 확인한 결과는 다음과 같았다.

- **row count**: 814 --> 836 (22개 증가, predicate 범위 밖의 소스 row 수와 일치)
- **일별 수치**: 개별 row의 값은 정상
- **누적합 컬럼**: 약 26 차이 (이중 합산으로 누적값이 깨짐)

`total_daily_value`는 정확한데 `accumulated_monthly_value`가 틀린 이유가 바로 이것이었다. 일별 값은 동일한 row가 두 번 들어갔을 뿐이므로 개별적으로는 맞지만, 누적 계산 시 중복 row가 포함되어 결과가 어긋난다.

### 소스 범위와 predicate를 동적으로 일치시킬 수 없는가

직관적인 해결책은 "소스 데이터도 최근 3일만 가져오고, predicate도 3일로 설정"하는 것이다. 두 범위가 정확히 일치하면 중복은 발생하지 않는다.

하지만 운영 환경에서 이를 보장하기는 어렵다. 파이프라인이 며칠 밀렸을 때, 최신 N일만 처리하면 밀린 기간의 데이터가 누락된다. incremental 모델의 소스 범위는 `MAX(datetime)`을 기준으로 동적으로 결정되므로, 정적 predicate와 항상 일치한다고 보장할 수 없다.

> **핵심 교훈**: `incremental_predicates`는 "스캔 범위를 줄이는 무해한 최적화"가 아니라, **MERGE 매칭 로직 자체를 변경하는 것**이다. 소스 데이터 범위와 predicate 범위가 항상 정확히 일치하지 않는 한 중복 INSERT 위험이 존재한다.

---

## 접근 2: run_query compile-time 캐싱

`incremental_predicates`를 제거한 후, 원래 문제로 돌아왔다. 이 모델에는 `MAX(datetime)` 조회가 4곳에서 반복된다.

1. `date_array` 시작일 계산
2. 트랜잭션 테이블 A 필터
3. 트랜잭션 테이블 B 필터
4. 가격 테이블 필터

각각 `SELECT MAX(datetime) FROM target` 서브쿼리를 실행하므로, BigQuery 입장에서는 동일한 대상 테이블을 여러 번 스캔할 가능성이 있다.

### run_query로 컴파일 시점에 1번만 조회

dbt Jinja의 `run_query`는 **SQL 컴파일 시점**(parse/compile phase)에 BigQuery에 쿼리를 실행하고, 결과를 Jinja 변수로 가져오는 함수다. [공식 문서](https://docs.getdbt.com/reference/dbt-jinja-functions/run_query)에서 권장하는 패턴을 따르면 다음과 같다.

{% raw %}
```sql
{% if is_incremental() %}
  {% set max_dt_query %}
    SELECT MAX(datetime) FROM {{ this }}
  {% endset %}

  {% set results = run_query(max_dt_query) %}

  {% if execute %}
    {% set max_dt = results.columns[0].values()[0] %}
  {% else %}
    {% set max_dt = none %}
  {% endif %}
{% endif %}
```
{% endraw %}

여기서 `execute` 체크가 중요하다. dbt는 parse 단계와 execute 단계를 분리하는데, parse 단계에서는 `run_query`가 실제로 실행되지 않아 `results`가 빈 상태일 수 있다. `{% raw %}{% if execute %}{% endraw %}` 블록으로 감싸면 parse 단계에서의 에러를 방지할 수 있다.

이제 `max_dt` 변수를 SQL 여러 곳에 주입한다.

{% raw %}
```sql
-- date_array 시작일
WITH date_array AS (
  SELECT date
  FROM UNNEST(GENERATE_DATE_ARRAY(
    {% if is_incremental() %}
      DATE({{ max_dt }})
    {% else %}
      DATE('2020-01-01')
    {% endif %},
    CURRENT_DATE('UTC')
  )) AS date
),

-- 각 테이블 필터에도 동일하게 사용
source_a AS (
  SELECT *
  FROM {{ ref('transaction_table_a') }}
  {% if is_incremental() %}
  WHERE event_timestamp > {{ max_dt }}
  {% endif %}
),

source_b AS (
  SELECT *
  FROM {{ ref('transaction_table_b') }}
  {% if is_incremental() %}
  WHERE event_timestamp > {{ max_dt }}
  {% endif %}
)
```
{% endraw %}

dbt가 이 Jinja를 컴파일하면, BigQuery에 전달되는 SQL에는 서브쿼리가 없다. 대신 **리터럴 타임스탬프 값**이 들어간다.

```sql
-- 컴파일된 SQL (BigQuery가 실제로 실행하는 쿼리)
WHERE event_timestamp > TIMESTAMP('2026-03-24 00:00:00+00:00')
```

`SELECT MAX(datetime) FROM target` 서브쿼리가 완전히 사라지고, BigQuery는 파티션 프루닝으로 필요한 범위만 읽는다.

### 시도했지만 실패한 다른 방법들

`run_query`에 도달하기 전에 시도한 두 가지 방법과, 각각이 실패한 이유를 정리한다.

**방법 1: pre_hook에서 DECLARE 변수 선언**

{% raw %}
```sql
{{ config(
    pre_hook="DECLARE _max_dt TIMESTAMP DEFAULT (SELECT MAX(datetime) FROM {{ this }});"
) }}
```
{% endraw %}

dbt의 `pre_hook`은 모델의 메인 SQL과 **별도의 SQL statement**로 실행된다. BigQuery에서 `DECLARE`로 선언한 스크립트 변수는 해당 스크립트 블록 내에서만 유효하다. `pre_hook`과 이후의 MERGE 문은 서로 다른 statement 스코프에서 실행되므로, MERGE 문에서 `_max_dt`를 참조할 수 없다.

**방법 2: CTE로 MAX 값 정의 후 여러 곳에서 참조**

```sql
WITH max_dt_cte AS (
  SELECT MAX(datetime) AS max_dt FROM target
),
source_a AS (
  SELECT * FROM transaction_table_a
  WHERE event_timestamp > (SELECT max_dt FROM max_dt_cte)
),
source_b AS (
  SELECT * FROM transaction_table_b
  WHERE event_timestamp > (SELECT max_dt FROM max_dt_cte)
)
```

BigQuery는 CTE(Common Table Expression)의 결과 캐싱을 보장하지 않는다. CTE가 여러 곳에서 참조될 때, 옵티마이저가 각 참조마다 CTE를 재실행할 수 있다. 의도한 "1회 조회, N회 재사용" 최적화가 보장되지 않는다.

**run_query의 본질적 차이**: `run_query`는 dbt 컴파일 단계(Python/Jinja 레이어)에서 처리된다. BigQuery 실행 엔진에 도달하기 전에 값이 확정되므로, 위 두 방법과 달리 BigQuery의 실행 계획이나 CTE 최적화 전략에 영향을 받지 않는다.

### 실측 결과

`INFORMATION_SCHEMA.JOBS`에서 `job_id`를 기준으로 직접 측정했다.

| 구분 | slot_ms | 변화율 |
|---|---|---|
| 기존 (MAX 서브쿼리 4회 반복) | 530,501 ms | -- |
| run_query 리터럴 주입 적용 후 | 131,708 ms | **-75.2%** |

- **bytes_billed**: 동일 (2,329 MiB) -- 스캔 데이터량 자체는 같고 처리 효율만 개선됨
- **데이터 정합성**: `EXCEPT DISTINCT` 비교로 기존 결과와 0건 차이 확인

---

## 주의할 점

### run_query 컴파일 시점 실행 비용

`run_query`는 `dbt compile` 또는 `dbt run` 시점에 BigQuery로 `SELECT MAX(datetime)` 쿼리를 보낸다. 이 쿼리 자체에도 비용이 발생한다. 다만 파티션이 잘 설정된 테이블에서 `MAX()` 집계는 매우 저렴하므로(파티션 메타데이터만 읽음), 대부분의 경우 무시할 수 있는 수준이다.

### full-refresh 시 동작

`run_query` 블록이 `{% raw %}{% if is_incremental() %}{% endraw %}` 안에 있으므로, `dbt run --full-refresh` 실행 시에는 `is_incremental()`이 `FALSE`가 되어 `run_query`가 실행되지 않는다. 초기 로드 로직(`{% raw %}{% else %}{% endraw %}` 분기)이 올바르게 설정되어 있는지 반드시 확인해야 한다.

### incremental_predicates를 안전하게 쓸 수 있는 조건

`incremental_predicates`가 항상 위험한 것은 아니다. 다음 조건이 **모두** 충족되면 안전하게 사용할 수 있다.

1. 소스 데이터의 범위와 predicate 범위가 **코드 수준에서** 정확히 일치함을 보장할 수 있다.
2. 파이프라인 지연(backfill) 시에도 범위가 어긋나지 않는 구조다.
3. 이 두 조건을 지속적으로 유지할 수 있는 팀 컨벤션이 있다.

하나라도 보장할 수 없다면, `run_query` 같은 다른 최적화 방법을 검토하는 것이 더 안전하다.

---

## 요약

| 항목 | incremental_predicates | run_query 리터럴 주입 |
|---|---|---|
| 동작 시점 | BigQuery 실행 시점 (ON 절 변경) | dbt 컴파일 시점 (리터럴 값 확정) |
| 비용 절감 | 54~72% (실측) | 75% (실측) |
| 중복 위험 | **있음** (predicate 범위 밖 row) | 없음 |
| 데이터 정합성 | 소스-predicate 범위 불일치 시 깨짐 | 유지됨 |
| 추가 비용 | 없음 | 컴파일 시 MAX 쿼리 1회 |

---

## 다음 단계

- 동일 패턴을 가진 다른 incremental 모델에 `run_query` 캐싱 적용 확대
- `incremental_predicates`를 이미 적용한 모델들에서 중복 row 여부 일괄 검증
- `run_query` + 리터럴 주입 패턴을 매크로로 추상화하여 여러 모델에서 재사용

---

## 참고 자료

- [dbt incremental_predicates 공식 문서](https://docs.getdbt.com/docs/build/incremental-strategy#about-incremental_predicates)
- [dbt run_query 공식 문서](https://docs.getdbt.com/reference/dbt-jinja-functions/run_query)
- [dbt execute 변수 공식 문서](https://docs.getdbt.com/reference/dbt-jinja-functions/execute)
- [dbt incremental models 공식 문서](https://docs.getdbt.com/docs/build/incremental-models)
- [dbt pre-hook / post-hook 공식 문서](https://docs.getdbt.com/reference/resource-configs/pre-hook-post-hook)
- [BigQuery MERGE 문 공식 문서](https://cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax#merge_statement)
