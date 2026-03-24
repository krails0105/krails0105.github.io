---
layout: post
title: "dbt Incremental 모델의 {{ this }} 풀스캔 문제 - 슬롯 사용량 1000배 차이를 만드는 3가지 해결법"
date: 2026-03-24
categories: [dbt]
tags: [dbt, BigQuery, incremental, optimization, data-engineering, merge, incremental_predicates]
---

## 들어가며

dbt incremental 모델을 운영하다 보면 의외로 흔하게 마주치는 문제가 있다. 분명 `WHERE datetime > (SELECT MAX(datetime) FROM {{ this }})` 같은 필터를 달아 최신 데이터만 처리하도록 구현했는데, BigQuery 슬롯 사용량이나 비용을 보면 전체 테이블을 스캔한 것처럼 나타나는 현상이다.

이 글에서는 대규모 파티셔닝된 테이블(수십억 rows, 수백 GB 규모)에서 incremental 업데이트 범위를 판단하는 방식에 따라 슬롯 사용량이 어떻게 달라지는지 실측 데이터와 함께 정리한다. 읽고 나면 다음을 판단할 수 있다.

- `{{ this }}` 풀스캔이 **왜** 발생하는지, 정확히 **어느 시점**에 발생하는지
- 3가지 해결 방법 중 어떤 상황에서 무엇을 선택해야 하는지
- MERGE `ON` 절 풀스캔까지 해결하려면 무엇이 필요한지

> **TL;DR** -- `SELECT MAX(datetime) FROM {{ this }}`에 WHERE 절을 추가하는 것만으로 슬롯 사용량이 408초에서 0.22초로 줄어든다. 하지만 이것은 소스 스캔만 줄인 것이고, dbt가 생성하는 MERGE INTO 문의 `ON` 절에서 발생하는 `{{ this }}` 풀스캔은 별도로 `incremental_predicates`(dbt v1.4+) 또는 `get_merge_sql` 오버라이드로 해결해야 한다.

### 사전 지식

- dbt incremental 모델의 기본 동작 원리 (`is_incremental()`, `{{ this }}`)
- BigQuery 파티셔닝 개념 (날짜/타임스탬프 기반 파티셔닝)
- dbt-core 1.4 이상, dbt-bigquery 1.4 이상 사용 환경

---

## 배경: 어떤 상황에서 발생하는가

파티셔닝된 대규모 이벤트 로그 테이블(약 26억 rows, 385GB)을 소스로 하는 incremental 모델이 있다고 하자. 매 실행마다 "지난번 이후 새로 들어온 데이터만" 처리하는 것이 목표다.

기존에 가장 널리 쓰는 패턴은 다음과 같다.

```sql
-- models/metric/event_daily_summary.sql

{{ config(
    materialized='incremental',
    partition_by={'field': 'datetime', 'data_type': 'timestamp', 'granularity': 'day'},
    unique_key=['datetime']
) }}

WITH source AS (
    SELECT *
    FROM {{ ref('raw_data__event_logs') }}

    {% if is_incremental() %}
    WHERE datetime > (SELECT MAX(datetime) FROM {{ this }})
    {% endif %}
)

SELECT
    DATE_TRUNC(datetime, DAY) AS datetime,
    COUNT(*) AS event_count,
    SUM(value) AS total_value
FROM source
GROUP BY 1
```

이 코드 자체는 논리적으로 맞다. 문제는 **dbt가 이 모델을 실행하기 위해 내부적으로 생성하는 MERGE INTO 문**에 있다.

---

## 핵심 문제: MERGE INTO에서의 풀스캔

dbt는 `merge` 전략(BigQuery에서 `unique_key`를 지정할 때의 기본 전략)을 사용할 때 대략 다음과 같은 SQL을 생성한다.

```sql
MERGE INTO `project.dataset.event_daily_summary` AS DBT_INTERNAL_DEST
USING (
  -- 모델 SQL 실행 결과 (새 데이터)
  SELECT * FROM (...)
) AS DBT_INTERNAL_SOURCE

ON DBT_INTERNAL_DEST.datetime = DBT_INTERNAL_SOURCE.datetime
-- !! 여기에 파티션 필터가 없다

WHEN MATCHED THEN UPDATE ...
WHEN NOT MATCHED THEN INSERT ...
```

핵심은 `ON` 절이다. `DBT_INTERNAL_DEST.datetime >= DATE_SUB(...)` 같은 파티션 범위 제한이 없기 때문에, BigQuery는 MERGE의 대상 테이블(`{{ this }}`)을 **전체 스캔**한다.

모델 SQL 내부에서 `WHERE datetime > ...` 필터를 적용한 것은 `USING` 절(소스 데이터)에만 해당하는 이야기다. `MERGE INTO` 대상 테이블은 별개로 스캔된다.

### 실측: 방법별 슬롯 사용량

동일한 모델을 3가지 방식으로 실행한 결과다.

| 방법 | 슬롯 사용량 | 비고 |
|---|---|---|
| 기존 방식 (`MAX` 쿼리) | **408초** (6.8분) | `{{ this }}` 전체 스캔 |
| MAX 쿼리 + WHERE 절 추가 | **0.22초** | 최근 파티션만 스캔하도록 제한 |
| INFORMATION_SCHEMA.PARTITIONS | **0.07초** | 메타데이터만 조회 (데이터 스캔 없음) |

408초 대 0.22초 -- 약 **1,850배** 차이다. 모델 수가 수십 개라면 전체 파이프라인의 비용 차이는 더 벌어진다.

다만 이 실측값은 **소스 필터링(USING 절)** 단계의 슬롯 사용량이다. dbt가 생성하는 MERGE `ON` 절에서 발생하는 `{{ this }}` 풀스캔은 별도의 문제이며, 이 글 후반부에서 다루는 `incremental_predicates`로 해결할 수 있다.

---

## 3가지 해결 방법

### 방법 1: 기존 방식 (MAX 쿼리) -- 문제가 있는 패턴

```sql
-- 문제: {{ this }} 전체를 스캔해 MAX(datetime)를 구함
{% if is_incremental() %}
WHERE datetime > (SELECT MAX(datetime) FROM {{ this }})
{% endif %}
```

이 방식의 문제는 두 가지다.

1. **소스 필터링 단계**: `SELECT MAX(datetime) FROM {{ this }}` 서브쿼리 자체가 대상 테이블 전체를 스캔한다.
2. **MERGE 단계**: `USING` 절의 소스 범위는 제한하지만, MERGE `ON` 절에 파티션 필터가 추가되지 않으므로 `{{ this }}` 풀스캔이 한 번 더 발생한다.

385GB 테이블에서 이 패턴을 사용하면 슬롯 사용량이 408초에 달한다.

### 방법 2: MAX 쿼리에 WHERE 절 추가 -- 가장 간단한 개선

기존 방식의 `SELECT MAX(datetime) FROM {{ this }}`가 전체 테이블을 스캔하는 이유는 BigQuery가 WHERE 없이 모든 파티션을 읽기 때문이다. 여기에 WHERE 절을 추가해 최근 파티션만 스캔하도록 제한하면 된다.

```sql
{% if is_incremental() %}
WHERE datetime > (
    SELECT MAX(datetime) FROM {{ this }}
    WHERE datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)  -- 최근 1일 파티션만 스캔
)
{% endif %}
```

이것만으로 슬롯 사용량이 **408초 → 0.22초**로 줄어든다. MAX 서브쿼리가 전체 385GB 대신 최근 1일분 파티션만 스캔하기 때문이다.

다만 이 방법은 **소스 필터링(USING 절)** 단계의 최적화일 뿐이다. dbt가 생성하는 MERGE `ON` 절에서 `{{ this }}`를 다시 풀스캔하는 문제는 여전히 남아 있다. 이 문제는 뒤에서 다루는 `incremental_predicates`로 해결할 수 있다.

### 방법 3: INFORMATION_SCHEMA.PARTITIONS -- 메타데이터 활용 (권장)

BigQuery는 테이블 파티션 정보를 `INFORMATION_SCHEMA.PARTITIONS` 뷰에서 메타데이터로 제공한다. 실제 데이터를 스캔하지 않고 파티션 ID만 조회하므로 비용이 사실상 0에 가깝다.

| 쿼리 방식 | 슬롯 사용량 | 스캔 데이터 |
|---|---|---|
| `SELECT MAX(datetime) FROM {{ this }}` | 408초 | 385GB 전체 |
| `INFORMATION_SCHEMA.PARTITIONS` | 0.07초 | 메타데이터만 |

이 방식을 매크로로 만들면 모든 incremental 모델에서 재사용할 수 있다.

```sql
-- macros/get_max_partition_date.sql

{%- macro get_latest_partition(table_ref, lookback_days) -%}
    timestamp(date_sub((
        select max(parse_date('%Y%m%d', partition_id))
        from `{{ table_ref.database }}.{{ table_ref.schema }}.INFORMATION_SCHEMA.PARTITIONS`
        where table_name = '{{ table_ref.identifier }}' AND partition_id != '__NULL__'
    ), interval {{ lookback_days }} day))
{%- endmacro -%}
```

핵심 포인트:
- `partition_id`는 `'20260210'` 형태의 문자열이므로 `PARSE_DATE`로 변환한다
- `partition_id = '__NULL__'` (NULL 파티션)을 반드시 제외한다
- `safe_lookback` 파라미터로 안전 마진을 두어 늦게 도착하는 데이터를 커버한다
- `{{ table_ref }}`에는 dbt의 `this`를 전달하면 database, schema, identifier를 자동으로 추출한다

모델에서의 사용은 다음과 같다.

```sql
{{ config(
    materialized='incremental',
    partition_by={'field': 'datetime', 'data_type': 'timestamp', 'granularity': 'day'},
    unique_key=['datetime']
) }}

WITH source AS (
    SELECT *
    FROM {{ ref('raw_data__event_logs') }}

    {% if is_incremental() %}
    WHERE datetime >= {{ get_latest_partition(this, 3) }}
    {% endif %}
)

SELECT
    DATE_TRUNC(datetime, DAY) AS datetime,
    COUNT(*) AS event_count,
    SUM(value) AS total_value
FROM source
GROUP BY 1
```

`SELECT MAX(datetime) FROM {{ this }}`를 `get_latest_partition(this, 3)`으로 교체하는 것만으로 슬롯 사용량이 **408초 → 0.07초**로 줄어든다.

다만 이 방식은 **소스 데이터의 범위를 제한하는 용도(USING 절)**이지, MERGE `ON` 절의 풀스캔 문제를 직접 해결하지는 않는다. MERGE `ON` 절 최적화가 필요하다면 `incremental_predicates`를 조합해야 한다.

---

## MERGE ON 절 최적화: incremental_predicates

위의 3가지 방법은 모두 **소스 필터링(USING 절)** 최적화다. 그러나 dbt가 생성하는 MERGE INTO 문의 `ON` 절에는 여전히 파티션 필터가 없어 `{{ this }}` 풀스캔이 발생할 수 있다.

dbt v1.4에서 도입된 `incremental_predicates` 설정을 사용하면 MERGE `ON` 절에 추가 필터를 주입할 수 있다.

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    partition_by={'field': 'datetime', 'data_type': 'timestamp', 'granularity': 'day'},
    unique_key=['datetime'],
    incremental_predicates=[
        "DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)"
    ]
) }}
```

이렇게 설정하면 dbt가 생성하는 MERGE 문이 다음과 같이 바뀐다.

```sql
MERGE INTO `project.dataset.event_daily_summary` AS DBT_INTERNAL_DEST
USING (...) AS DBT_INTERNAL_SOURCE

ON DBT_INTERNAL_DEST.datetime = DBT_INTERNAL_SOURCE.datetime
AND DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
--  ^^^ incremental_predicates가 ON 절에 추가됨

WHEN MATCHED THEN UPDATE ...
WHEN NOT MATCHED THEN INSERT ...
```

**주의할 점**:
- 컬럼 참조에 반드시 `DBT_INTERNAL_DEST.` 접두사를 붙여야 한다. 없으면 ambiguous column reference 에러가 발생할 수 있다.
- 이 기능의 실제 슬롯 절감 효과는 별도 실측이 필요하다. 위 실측 데이터(408초 → 0.22초)는 소스 필터링(USING 절) 최적화의 결과이며, `incremental_predicates`에 의한 ON 절 최적화와는 다른 계층이다.

### 가장 이상적인 조합

소스 스캔과 MERGE ON 절을 동시에 최적화하려면 `get_latest_partition` 매크로와 `incremental_predicates`를 함께 사용한다.

```sql
{{ config(
    materialized='incremental',
    incremental_strategy='merge',
    partition_by={'field': 'datetime', 'data_type': 'timestamp', 'granularity': 'day'},
    unique_key=['datetime'],
    incremental_predicates=[
        "DBT_INTERNAL_DEST.datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)"
    ]
) }}

WITH source AS (
    SELECT *
    FROM {{ ref('raw_data__event_logs') }}

    {% if is_incremental() %}
    WHERE datetime >= {{ get_latest_partition(this, 3) }}
    {% endif %}
)

SELECT ...
```

이렇게 하면 소스 스캔 범위(`USING` 절)는 `INFORMATION_SCHEMA`로, MERGE 대상 스캔 범위(`ON` 절)는 `incremental_predicates`로 각각 최적화된다.

---

## 고급 제어: get_merge_sql 매크로 오버라이드

`incremental_predicates`로 커버되지 않는 케이스(예: 모델마다 파티션 범위 계산 로직이 다른 경우)에는 dbt 내장 매크로를 직접 오버라이드할 수 있다.

dbt-bigquery는 MERGE 문 생성을 `bigquery__get_merge_sql` 매크로에서 담당한다. 이 매크로를 프로젝트 내 `macros/` 디렉토리에 동일한 이름으로 정의하면 dbt의 기본 구현을 덮어쓸 수 있다.

```sql
-- macros/bigquery_get_merge_sql.sql

{% macro bigquery__get_merge_sql(target, source, unique_key, dest_columns, incremental_predicates) %}
  {#
    기본 MERGE 문에 파티션 필터를 동적으로 주입하는 커스텀 로직.
    예: 모델의 meta 설정에서 파티션 범위를 읽어와 ON 절에 추가
  #}
  {{ return(dbt.get_merge_sql(target, source, unique_key, dest_columns, incremental_predicates)) }}
{% endmacro %}
```

이 방식은 모든 merge 전략 모델에 일괄 적용되므로 영향 범위가 넓다. 반드시 충분한 테스트 후 도입해야 한다.

참고 사례로 Dune Analytics의 오픈소스 프로젝트에서 `trino__get_merge_sql`을 오버라이드하여 incremental_predicates를 강화한 패턴을 볼 수 있다 ([Dune spellbook 소스 코드](https://github.com/duneanalytics/spellbook/blob/a32ee32bcece9b5ec24f42b59e1d937d3f14fc86/dbt_macros/dune/incremental.sql)).

### insert_overwrite와의 차이

`insert_overwrite` 전략은 표준 MERGE 대신 **파티션 단위 덮어쓰기 방식**을 사용한다. dbt-bigquery가 생성하는 SQL 구조가 근본적으로 다르다.

```sql
-- insert_overwrite 전략이 생성하는 SQL (간략화)

-- 1) 임시 테이블 생성
CREATE TEMPORARY TABLE model__dbt_tmp AS (
  {{ model_sql }}
);

-- 2) 교체 대상 파티션 목록을 동적으로 추출
DECLARE dbt_partitions_for_replacement ARRAY<DATE>;
SET (dbt_partitions_for_replacement) = (
    SELECT AS STRUCT ARRAY_AGG(DISTINCT DATE(partition_col))
    FROM model__dbt_tmp
);

-- 3) MERGE ON FALSE 패턴으로 파티션 단위 교체
MERGE INTO target_table DEST
USING model__dbt_tmp SRC
ON FALSE  -- 항상 not matched -> 기존 행과 매칭하지 않음

WHEN NOT MATCHED BY SOURCE
  AND partition_col IN UNNEST(dbt_partitions_for_replacement)
THEN DELETE

WHEN NOT MATCHED THEN INSERT ...
```

`ON FALSE`를 사용하므로 대상 테이블 전체를 키 매칭하지 않는다. 대신 `WHEN NOT MATCHED BY SOURCE` 절에서 특정 파티션만 삭제 후 새 데이터를 삽입한다. 따라서 `merge` 전략에서 발생하는 ON 절 풀스캔 문제가 구조적으로 발생하지 않는다.

다만 `insert_overwrite`에는 다음과 같은 제약이 있다.

- `unique_key` 기반의 행 단위 upsert가 불가능하다 (파티션 전체를 교체함)
- 소규모 업데이트에서는 오히려 더 많은 데이터를 처리할 수 있다
- `copy_partitions: true` 옵션을 추가하면 파티션 복사 방식으로 추가 최적화가 가능하다

---

## 주의할 점 (Gotchas)

### 1. incremental_predicates의 INTERVAL 기간 설정

`DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)`처럼 현재 시점 기준 상대 범위를 쓰면, 실행 시점에 따라 예상치 못한 파티션이 스캔 대상에서 제외될 수 있다. 운영 파이프라인의 지연 허용 시간(backfill 기간)보다 넉넉한 INTERVAL을 설정해야 한다.

예를 들어, 데이터가 최대 2일 늦게 도착할 수 있다면 `INTERVAL 3 DAY` 이상으로 여유를 두는 것이 안전하다.

### 2. is_incremental() 조건과 incremental_predicates의 역할 구분

| 설정 | 적용 대상 | 역할 |
|---|---|---|
| `is_incremental()` 블록 내 WHERE 절 | `USING` 절 (소스 데이터) | 소스 스캔 범위 제한 |
| `incremental_predicates` | `ON` 절 (대상 테이블) | `{{ this }}` 스캔 범위 제한 |

두 가지는 별개로 동작한다. 소스 스캔만 제한하고 `incremental_predicates`를 설정하지 않으면, MERGE 실행 시 `{{ this }}` 풀스캔이 여전히 발생한다. 반드시 양쪽 모두 설정해야 한다.

### 3. 가독성 개선: 조건 분기를 명시적으로 표현

매크로 내부가 아닌 모델 파일에 조건을 명시하면 동작을 더 쉽게 파악할 수 있다.

```sql
{% if not is_incremental() %}
  -- Full refresh: 전체 기간 처리
  WHERE datetime >= '2020-01-01'

{% elif is_incremental() %}
  -- Incremental: 최근 파티션만 처리
  WHERE datetime >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)

{% endif %}
```

`is_incremental()` 판단 로직을 매크로 내부에 숨기지 않고 SQL 파일에 직접 작성하면, 파이프라인을 처음 보는 사람도 실행 흐름을 바로 이해할 수 있다.

### 4. INFORMATION_SCHEMA.PARTITIONS 사용 시 권한 확인

`INFORMATION_SCHEMA.PARTITIONS` 조회에는 다음 IAM 권한이 필요하다.

- `bigquery.tables.get`
- `bigquery.tables.list`

이 권한은 `roles/bigquery.dataViewer`, `roles/bigquery.dataEditor`, `roles/bigquery.admin` 역할에 포함되어 있다. 서비스 계정에 권한이 없으면 런타임에 에러가 발생하므로, 파이프라인 배포 전에 확인해야 한다.

또한 `INFORMATION_SCHEMA.PARTITIONS` 조회는 **한 번에 최대 1,000개 테이블**까지만 지원한다. 데이터셋에 테이블이 매우 많은 경우 `table_name` 필터를 반드시 포함해야 한다.

---

## 전략 선택 가이드

| 상황 | 권장 방법 | 이유 |
|---|---|---|
| `merge` 전략 + 대규모 테이블 | `incremental_predicates` 필수 적용 | ON 절 파티션 필터로 풀스캔 방지 |
| `insert_overwrite` 전략 | 기본 설정으로 허용 가능, 필요시 `copy_partitions` 추가 | ON FALSE 패턴으로 풀스캔 문제 없음 |
| 모델마다 파티션 범위가 다른 경우 | `get_merge_sql` 매크로 오버라이드 | 동적 파티션 범위 계산이 필요할 때 |
| 파티션 최솟값/최댓값만 필요한 경우 | `INFORMATION_SCHEMA.PARTITIONS` | 메타데이터 조회로 비용 0 |
| 최적의 조합 | `incremental_predicates` + `INFORMATION_SCHEMA` | ON 절과 USING 절 양쪽 모두 최적화 |

---

## 정리

- **`SELECT MAX(datetime) FROM {{ this }}`를 그대로 쓰지 마라.** 이 서브쿼리는 전체 테이블을 풀스캔한다. `INFORMATION_SCHEMA.PARTITIONS`를 활용한 `get_latest_partition` 매크로로 대체하면 슬롯 사용량이 408초에서 0.07초로 줄어든다.
- **소스 필터링과 MERGE ON 절은 별개의 문제다.** 모델 SQL에서 WHERE 절을 아무리 잘 걸어도, dbt가 생성하는 MERGE INTO 문의 `ON` 절에 파티션 필터가 없으면 `{{ this }}` 풀스캔이 발생한다. `incremental_predicates`(dbt v1.4+)로 ON 절에 필터를 주입할 수 있다.
- **`INFORMATION_SCHEMA.PARTITIONS` + `incremental_predicates` 조합이 가장 이상적이다.** 전자는 소스 스캔(USING 절)을, 후자는 대상 테이블 스캔(ON 절)을 각각 최적화한다.
- **`insert_overwrite`는 이 문제에서 구조적으로 자유롭다.** `ON FALSE` 패턴을 사용하기 때문이다. 단, 행 단위 upsert가 불가능하고 소규모 모델에서는 오히려 비효율적일 수 있다.

---

## 참고 자료

- [dbt incremental_predicates 공식 문서](https://docs.getdbt.com/reference/resource-configs/bigquery-configs#incremental_predicates)
- [dbt BigQuery configurations](https://docs.getdbt.com/reference/resource-configs/bigquery-configs)
- [dbt Incremental models overview](https://docs.getdbt.com/docs/build/incremental-models)
- [BigQuery INFORMATION_SCHEMA.PARTITIONS](https://cloud.google.com/bigquery/docs/information-schema-partitions)
- [Dune Analytics spellbook - get_merge_sql 오버라이드 예시](https://github.com/duneanalytics/spellbook/blob/a32ee32bcece9b5ec24f42b59e1d937d3f14fc86/dbt_macros/dune/incremental.sql)
