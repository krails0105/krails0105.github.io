---
layout: post
title: "dbt BigQuery Incremental Strategy 벤치마크 - merge, insert_overwrite, copy_partitions, microbatch 실측 비교"
date: 2026-03-24
categories: [dbt]
tags: [dbt, BigQuery, incremental, benchmark, data-engineering, microbatch, copy-partitions]
---

## 들어가며

dbt의 BigQuery incremental 전략은 `merge`, `insert_overwrite`, `insert_overwrite + copy_partitions`, `microbatch`(dbt 1.9+) 네 가지가 있다. 공식 문서에는 각 전략의 동작 방식이 설명되어 있지만, **"실제로 얼마나 차이나는가"**에 대한 실측 데이터는 찾기 어렵다.

이 글에서는 일별 집계 모델(약 813 rows, 2024-01-01 ~ 현재)을 대상으로 네 전략을 직접 실행하고, 실행 시간과 비용(`bytes_billed`)을 측정한 결과를 공유한다. 읽고 나면 다음을 판단할 수 있다.

- 소규모 모델에서 어떤 전략이 가장 빠르고 저렴한가
- `copy_partitions`의 실제 비용 절감 효과는 어느 정도인가
- `microbatch`는 어떤 상황에서 쓸 수 있고, 어떤 상황에서 피해야 하는가

> **TL;DR** -- 소규모 일별 집계 모델에서는 기본값인 `merge`가 가장 빠르고 비용도 최소였다. `copy_partitions`는 대규모 데이터에서 빛을 발하며, `microbatch`는 백필 전용으로 가치가 있다.

## 사전 준비

벤치마크를 재현하려면 다음 환경이 필요하다.

| 항목 | 버전/사양 |
|---|---|
| dbt-core | 1.10.5 |
| dbt-bigquery | 1.10.0 |
| Python | 3.12 |
| BigQuery | On-demand 과금 모델 |

파티셔닝은 `timestamp` 타입의 `day` 단위, 클러스터링 키는 `datetime` 컬럼을 사용했다.

## 배경: 왜 벤치마크가 필요했나

일별 집계 모델은 여러 대형 소스 테이블을 JOIN하여 일별 메트릭을 계산하고, 월별 누적합(`accumulated_monthly_total`)을 포함하는 구조다. 기존에는 `merge` 전략을 기본값으로 사용했는데, 세 가지 의문이 생겼다.

1. `insert_overwrite`가 merge보다 빠르다고 하는데, **실제로 얼마나** 차이나는가?
2. `copy_partitions` 옵션이 Copy API를 사용해 비용을 줄인다는데, **실제 절감액**은?
3. dbt 1.9에서 추가된 `microbatch`는 이 모델 구조에서 **사용 가능한가**?

## 테스트 설계

동일한 쿼리 로직을 가진 모델을 전략별로 4개 생성한 뒤, 세 단계로 테스트를 진행했다.

1. **Phase 1** -- Full Refresh (`dbt run --full-refresh`)
2. **Phase 2** -- Incremental Run (`dbt run`)
3. **Phase 3** -- `INFORMATION_SCHEMA.JOBS`로 실제 과금 바이트 측정

dbt가 보고하는 `bytes processed`는 일부 전략에서 실제 BigQuery 과금과 다를 수 있다. 특히 `copy_partitions`는 Copy Job 비용이 dbt 로그에 잡히지 않는다. 따라서 `INFORMATION_SCHEMA.JOBS`의 `total_bytes_billed`를 별도로 측정했다.

### 전략별 모델 config

각 전략의 핵심 설정 차이는 아래와 같다.

```sql
-- 1. merge (BigQuery 기본값)
-- unique_key를 지정하면 MERGE DML로 upsert 수행
{{ config(
    materialized="incremental",
    unique_key=["datetime"],
    partition_by={"field": "datetime", "data_type": "timestamp", "granularity": "day"},
    cluster_by=["datetime"]
) }}

-- 2. insert_overwrite
-- 파티션 단위로 덮어쓰기. 내부적으로 CTAS + MERGE 3단계 실행
{{ config(
    materialized="incremental",
    incremental_strategy="insert_overwrite",
    partition_by={"field": "datetime", "data_type": "timestamp", "granularity": "day"},
    cluster_by=["datetime"]
) }}

-- 3. copy_partitions (insert_overwrite의 하위 옵션)
-- 마지막 MERGE 단계를 BigQuery Copy Table API로 대체
{{ config(
    materialized="incremental",
    incremental_strategy="insert_overwrite",
    partition_by={
        "field": "datetime",
        "data_type": "timestamp",
        "granularity": "day",
        "copy_partitions": true
    }
) }}

-- 4. microbatch (dbt 1.9+)
-- 시간 범위를 batch_size 단위로 분할하여 순차 실행
{{ config(
    materialized="incremental",
    incremental_strategy="microbatch",
    event_time="datetime",
    batch_size="day",
    lookback=3,
    begin="2024-01-01"
) }}
```

## 벤치마크 결과

### Phase 1: Full Refresh

| 전략 | 실행 시간 | 처리량 | slot_ms | rows |
|---|---|---|---|---|
| merge | 54.81s | 561.4 GiB | 22,009,706 (~6.1h) | 813 |
| insert_overwrite | 63.26s | 561.4 GiB | 25,614,038 (~7.1h) | 813 |
| copy_partitions | 47.53s | 561.4 GiB | 18,307,984 (~5.1h) | 813 |
| microbatch | ~9시간 예상 (중단) | 9.5 GiB x 814 배치 | - | - |

Full Refresh에서는 `copy_partitions`가 가장 빠르고 슬롯 사용량도 최소였다. `insert_overwrite`가 `merge`보다 오히려 느리고 슬롯도 더 많이 사용했다. `microbatch`는 814개 배치를 순차 실행하는 구조라 현실적으로 사용 불가 수준의 시간이 예상되어 중단했다.

### Phase 2: Incremental Run

| 전략 | 실행 시간 | dbt 보고 처리량 | slot_ms 합계 |
|---|---|---|---|
| merge | 13.17s | 424.3 MiB | 861,621 (~14.4min) |
| insert_overwrite | 25.84s | 424.3 MiB | 760,889 (~12.7min) |
| copy_partitions | 15.80s | **0 processed** | **177,005 (~2.9min)** |

`copy_partitions`의 dbt 보고 처리량이 0으로 나오는 이유는 마지막 단계가 쿼리(DML)가 아닌 Copy Job이기 때문이다. 실제 비용을 확인하려면 `INFORMATION_SCHEMA.JOBS`를 직접 조회해야 한다.

슬롯 사용량을 보면 `copy_partitions`가 merge 대비 **79% 절감**(861s → 177s)으로, bytes_billed보다 더 극적인 차이를 보인다. on-demand 과금에서는 bytes_billed가 비용 기준이지만, flat-rate(슬롯 예약) 환경에서는 slot_ms가 직접적인 리소스 소모 지표이므로 이 차이가 더 중요할 수 있다.

### Phase 3: INFORMATION_SCHEMA.JOBS 실측

실제 과금 비용을 확인하기 위해 아래 쿼리로 각 전략의 단계별 `bytes_billed`를 합산했다.

```sql
SELECT
  job_id,
  statement_type,
  ROUND(total_bytes_billed / POW(1024, 2), 1) AS billed_mib,
  TIMESTAMP_DIFF(end_time, creation_time, SECOND) AS duration_sec,
  SUBSTR(query, 1, 80) AS query_preview
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND job_type = 'QUERY'                  -- 쿼리 작업만 필터링
  AND query LIKE '%benchmark_model%'      -- 벤치마크 모델명으로 필터링
  AND statement_type != 'SCRIPT'          -- SCRIPT 래퍼 제외
ORDER BY creation_time DESC
```

> **Tip**: `job_type = 'QUERY'` 필터를 추가하면 LOAD, COPY 등 비쿼리 작업이 제외되어 결과가 깔끔해진다. Copy Job은 별도 `job_type = 'COPY'`로 조회할 수 있다.

결과는 다음과 같다.

| 전략 | 단계 | bytes_billed | slot_ms |
|---|---|---|---|
| **merge** | MERGE | 425 MiB | 861,621 |
| **merge 합계** | | **425 MiB** | **861,621** |
| **insert_overwrite** | CTAS (임시 테이블 생성) | 425 MiB | 753,323 |
| | SELECT (파티션 감지) | 10 MiB | 206 |
| | MERGE (임시 테이블 -> 타깃) | 20 MiB | 7,360 |
| **insert_overwrite 합계** | | **455 MiB** | **760,889** |
| **copy_partitions** | CTAS (임시 테이블 생성) | 425 MiB | 176,833 |
| | SELECT (파티션 감지) | 10 MiB | 172 |
| | Copy API | **0** (무료) | **0** |
| **copy_partitions 합계** | | **435 MiB** | **177,005** |

**분석**:
- `bytes_billed` 기준으로는 `merge`가 가장 적은 비용(425 MiB)으로 가장 빠르게(13.17s) 실행됐다.
- 그러나 `slot_ms` 기준으로 보면 `copy_partitions`(177,005)가 merge(861,621) 대비 **79% 절감**으로 압도적이다.
- `insert_overwrite`의 slot_ms(760,889)는 merge와 비슷한데, CTAS 단계가 대부분의 슬롯을 소비하기 때문이다. 다만 MERGE 단계(7,360)는 merge 전략의 MERGE(861,621)보다 현저히 낮다 — 이는 insert_overwrite의 MERGE가 `ON FALSE` 패턴으로 키 매칭 없이 파티션만 교체하기 때문이다.
- `copy_partitions`의 CTAS 슬롯(176,833)이 insert_overwrite의 CTAS(753,323)보다 낮은 이유는 BigQuery의 쿼리 실행 시점 리소스 할당 차이로, 동일 쿼리라도 실행 시점에 따라 달라질 수 있다.

## 주의할 점 (Gotchas)

### 1. microbatch -- source()에 event_time 미설정 시 풀스캔

`microbatch`는 소스 테이블에 `event_time`이 설정되지 않으면 **매 배치마다 소스를 전체 스캔**한다. 이 모델에서는 설정 전 배치당 561 GiB가 설정 후 9.5 GiB로 감소했다(약 59배 차이).

dbt가 `event_time`을 기반으로 소스에 자동 필터를 추가하려면, `schema.yml`에서 소스 테이블에 반드시 `event_time`을 설정해야 한다.

```yaml
# schema.yml
sources:
  - name: raw_data
    tables:
      - name: sensor_events
        config:
          event_time: event_timestamp  # 이 설정이 없으면 매 배치마다 풀스캔
```

### 2. microbatch -- Full Refresh 시 `{{ this }}` 참조 에러

Full Refresh 시에는 타깃 테이블이 아직 존재하지 않기 때문에 `{{ this }}`를 참조하면 에러가 발생한다. 이는 microbatch에 한정된 문제는 아니지만, microbatch의 배치 실행 구조에서 특히 자주 마주친다. `is_incremental()` 가드로 감싸야 한다.

```sql
-- 잘못된 방식: full refresh 시 테이블이 없어 에러 발생
prev_accumulated AS (
  SELECT last_value
  FROM {{ this }}
  ORDER BY datetime DESC LIMIT 1
)

-- 올바른 방식: is_incremental()로 분기
{% raw %}{% if is_incremental() %}{% endraw %}
prev_accumulated AS (
  SELECT last_value
  FROM {{ this }}
  ORDER BY datetime DESC LIMIT 1
),
{% raw %}{% endif %}{% endraw %}
```

### 3. microbatch -- 누적합(running total) 로직과 비호환

`microbatch`는 각 배치를 독립적으로 실행한다. 이전 배치의 결과를 참조하는 월별 누적합 같은 **cross-batch 의존성** 로직은 정합성을 보장할 수 없다. 배치 A가 실행될 때 배치 B의 결과가 아직 존재하지 않을 수 있기 때문이다.

이런 모델에는 `merge` 또는 `insert_overwrite`를 사용해야 한다.

### 4. microbatch 내부 변수에 var()로 접근 불가

`__dbt_microbatch_event_time_start` 같은 microbatch 내부 변수를 `var()`로 접근하려 하면 동작하지 않는다. microbatch에서 시간 범위 필터링은 반드시 source/ref의 `event_time` 설정을 통해 **dbt가 자동으로 처리**하도록 해야 한다. 수동으로 시간 범위를 제어하려고 하면 의도대로 동작하지 않는다.

### 5. copy_partitions는 insert_overwrite 전용 옵션

`copy_partitions: true`는 `insert_overwrite` 전략의 하위 옵션이다. `merge` 전략과 함께 설정하면 무시되거나 에러가 발생한다. 공식 문서에서도 `insert_overwrite`와 함께 사용하도록 명시하고 있다.

### 6. insert_overwrite의 내부 실행 단계

`insert_overwrite`라는 이름과 달리 단순한 `INSERT` 구문이 아니다. dbt는 내부적으로 다음 3단계를 수행한다.

1. **CTAS** -- 모델 SQL로 임시 테이블 생성
2. **SELECT** -- 임시 테이블에서 대상 파티션 목록 감지
3. **MERGE** -- 감지된 파티션을 타깃 테이블에 덮어쓰기 (이때 `NOT MATCHED BY SOURCE ... DELETE`로 기존 데이터 삭제 후 `NOT MATCHED THEN INSERT`로 새 데이터 삽입)

`copy_partitions: true`를 설정하면 3번째 MERGE 단계가 BigQuery Copy Table API 호출로 대체된다.

## 전략 선택 가이드

벤치마크 결과를 바탕으로 모델 유형별 권장 전략을 정리하면 다음과 같다.

| 모델 유형 | 권장 전략 | 이유 |
|---|---|---|
| 소규모 일별 집계 (수백~수천 rows) | **merge** | 가장 빠르고 비용 최소. 단계가 1개라 오버헤드 없음 |
| 대규모 incremental (수십 GiB/배치) | **copy_partitions** | MERGE DML 비용 절약 효과가 데이터 크기에 비례하여 커짐 |
| 누적합 없는 단순 시계열 | **microbatch** | 특정 기간 재처리(백필)에 유용. `--event-time-start/end` 옵션 활용 가능 |
| 누적합 포함 모델 | **merge** 또는 **insert_overwrite** | microbatch는 cross-batch 의존성 미지원 |

### microbatch는 백필에서 가치가 있다

`microbatch`는 `--event-time-start`, `--event-time-end` 옵션으로 특정 기간만 재처리할 수 있다. 예를 들어 과거 데이터 소스가 변경되어 특정 월만 재처리해야 할 때, 전체 full-refresh 없이 해당 기간만 재실행할 수 있다.

```bash
# 2024년 3월 데이터만 재처리
dbt run --select my_model --event-time-start 2024-03-01 --event-time-end 2024-04-01
```

### copy_partitions는 규모가 클수록 효과적

이번 테스트에서 incremental 처리량은 424 MiB로, `copy_partitions`가 절약한 비용은 20 MiB에 그쳤다. 그러나 배치당 수십 GiB를 처리하는 모델에서는 MERGE 단계의 비용이 크기 때문에, Copy API로 대체하면 의미 있는 절감이 가능하다.

## 정리

- **소규모 모델에서는 `merge`가 최선이다.** 단일 MERGE 문으로 끝나기 때문에 오버헤드가 가장 적다.
- **`insert_overwrite`는 소규모에서 오히려 느리다.** 3단계 실행 구조(CTAS -> 파티션 감지 -> MERGE) 때문에 추가 비용이 발생한다.
- **`copy_partitions`의 진짜 가치는 대규모 데이터에 있다.** Copy Table API는 무료이므로, MERGE 단계의 bytes_billed가 큰 모델일수록 절감 효과가 커진다.
- **`microbatch`는 범용 전략이 아니다.** cross-batch 의존성이 있는 모델에는 사용할 수 없으며, Full Refresh 성능이 극히 나쁘다. 단, 백필 용도로는 유용하다.

## 참고 자료

- [dbt BigQuery configurations 공식 문서](https://docs.getdbt.com/reference/resource-configs/bigquery-configs)
- [dbt microbatch 공식 문서](https://docs.getdbt.com/docs/build/incremental-microbatch)
- [BigQuery INFORMATION_SCHEMA.JOBS](https://cloud.google.com/bigquery/docs/information-schema-jobs)
- [BigQuery Copy Jobs 가격 정책](https://cloud.google.com/bigquery/pricing#data_ingestion_pricing)
