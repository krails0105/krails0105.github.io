---
title: "[Airflow] 멱등성(Idempotency)과 Backfill - 재처리 가능한 파이프라인 설계"
categories:
  - Airflow
tags:
  - [Airflow, Idempotency, Backfill, DataPipeline, ExecutionDate]
---

# Introduction

---

Airflow 운영에서 진짜 중요한 건 **"실패를 허용하는 설계"**입니다. 지연, 실패, 재시도는 반드시 발생하고, Backfill(과거 재처리)도 결국 필요해집니다. 그래서 파이프라인을 **멱등하게** 만드는 것이 핵심입니다. 같은 작업을 두 번 돌려도 결과가 달라지지 않는 파이프라인, 즉 "안심하고 재실행할 수 있는 파이프라인"을 설계하는 방법을 정리합니다.

멱등성 구현에 사용하는 Delta Lake의 구체적인 패턴(replaceWhere, MERGE 등)은 [별도 포스트](/Delta/delta-lake-idempotent-patterns/)에서 다룹니다.

# 1. 멱등성이란?

---

**같은 입력으로 같은 작업을 여러 번 실행해도 결과가 동일한 성질**입니다. 전등 스위치를 "켜기" 상태로 여러 번 눌러도 결과는 항상 "켜진 상태"인 것과 같습니다.

```text
실행 1: 2024-01-15 데이터 처리 → 결과 A
실행 2: 2024-01-15 데이터 처리 → 결과 A (동일!)
실행 3: 2024-01-15 데이터 처리 → 결과 A (동일!)
```

## 멱등성이 필요한 상황

| 상황 | 설명 |
|------|------|
| Retry | Task 실패 후 자동 재시도 |
| Manual Rerun | 운영자가 수동으로 재실행 |
| Backfill | 과거 날짜 범위 재처리 |
| 중복 트리거 | 스케줄러 이상으로 중복 실행 |

## 멱등하지 않으면?

```text
실행 1: INSERT 1000 rows
실행 2: INSERT 1000 rows (중복!)
→ 총 2000 rows (데이터 오염)
```

# 2. Airflow의 Execution Date

---

멱등성의 핵심은 **"지금 시각"이 아니라 "처리 대상 시각"을 기준으로 동작**하는 것입니다. Airflow는 이를 위해 `execution_date`(logical date) 개념을 제공합니다.

```python
from airflow.decorators import dag, task
from datetime import datetime

@dag(
    schedule_interval="@daily",
    start_date=datetime(2024, 1, 1),
    catchup=True  # backfill 활성화
)
def my_pipeline():

    @task
    def process_data(**context):
        # execution_date (logical date) 기반으로 처리
        execution_date = context["ds"]  # "2024-01-15"

        # 해당 날짜 데이터만 처리
        df = spark.sql(f"""
            SELECT * FROM source
            WHERE date = '{execution_date}'
        """)

        # 멱등하게 저장 (덮어쓰기)
        df.write \
            .mode("overwrite") \
            .option("replaceWhere", f"date = '{execution_date}'") \
            .saveAsTable("target")

    process_data()

dag = my_pipeline()
```

## 주요 컨텍스트 변수

| 변수 | 예시 | 설명 |
|------|------|------|
| `ds` | `"2024-01-15"` | execution date (YYYY-MM-DD 문자열) |
| `ds_nodash` | `"20240115"` | 날짜 (구분자 없음) |
| `data_interval_start` | datetime 객체 | 데이터 구간 시작 |
| `data_interval_end` | datetime 객체 | 데이터 구간 끝 |
| `logical_date` | datetime 객체 | Airflow 2.2+ 권장 이름 |

> **`execution_date` vs `logical_date`**: Airflow 2.2부터 `execution_date`는 `logical_date`로 이름이 변경되었습니다. 기능은 동일하지만, `logical_date`가 의미를 더 명확히 전달합니다. `ds`는 여전히 사용 가능합니다.

# 3. Backfill 운영

---

## CLI로 Backfill

```bash
# 날짜 범위 backfill
airflow dags backfill \
    --start-date 2024-01-01 \
    --end-date 2024-01-31 \
    my_dag

# 특정 task만 실행
airflow tasks run my_dag my_task 2024-01-15
```

## catchup 설정

```python
@dag(
    catchup=True,   # True: DAG 시작일~현재까지 미실행 구간 자동 실행 (기본값)
                     # False: 현재 시점부터만 스케줄
    ...
)
```

`catchup=True`이면 `start_date`부터 현재까지 실행되지 않은 모든 구간이 자동으로 실행됩니다. 처음 배포 시 의도치 않은 대량 실행이 발생할 수 있으므로 주의가 필요합니다.

## 병렬 실행 제어

```python
@dag(
    max_active_runs=3,         # 동시에 실행 가능한 DAG Run 수
    max_active_tasks=5,        # 동시에 실행 가능한 Task 수
    ...
)
```

Backfill 시 많은 DAG Run이 동시에 생성되므로, 리소스를 고려하여 병렬 실행 수를 제한합니다.

## Backfill 팁

```text
✅ 범위를 명확히 지정 (시작일~종료일)
✅ 한 번에 너무 넓은 범위는 X → 주 단위 등으로 분할
✅ max_active_runs로 병렬 실행 제한 (리소스 고려)
✅ downstream 영향 파악 (서빙 테이블, 대시보드 등)
✅ 결과 검증 쿼리로 backfill 결과 확인
```

# 4. 실패 대응 설계

---

## Retry 설정

```python
from datetime import timedelta
from airflow.decorators import task

@task(
    retries=3,
    retry_delay=timedelta(minutes=5),
    retry_exponential_backoff=True,
    max_retry_delay=timedelta(minutes=30)
)
def my_task():
    ...
```

| 파라미터 | 설명 |
|----------|------|
| `retries` | 최대 재시도 횟수 |
| `retry_delay` | 재시도 간 대기 시간 |
| `retry_exponential_backoff` | 지수적 대기 (5분 → 10분 → 20분) |
| `max_retry_delay` | 최대 대기 시간 상한 |

## 알림 설정

```python
@dag(
    on_failure_callback=slack_alert,
    on_success_callback=log_success,
    ...
)
def my_pipeline():
    ...
```

실패 시 Slack/이메일 알림, 성공 시 로그 기록 등을 콜백으로 설정합니다.

## Runbook 문서화

```text
실패 시 재처리 절차:
  1. 에러 로그 확인 (Airflow UI → Logs)
  2. 원인 파악 (네트워크? 리소스? 데이터?)
  3. 원인 해결
  4. 해당 Task Clear (Airflow UI)
  5. 자동 재시도 확인
  6. 결과 검증 쿼리 실행
```

# 5. 비멱등 패턴 피하기

---

## 피해야 할 패턴

```python
# ❌ 패턴 1: 키 없는 Append
df.write.mode("append").save(...)
# → 재실행 시 중복 삽입!

# ❌ 패턴 2: 현재 시간 기반 처리
df.filter(col("created_at") >= datetime.now() - timedelta(days=1))
# → execution_date와 무관하게 동작 → backfill 불가

# ❌ 패턴 3: 외부 상태 의존
current_price = call_external_api()
# → 실행 시점마다 결과 달라짐
```

## 올바른 패턴

```python
# ✅ execution_date 기반 필터 + 덮어쓰기
execution_date = context["ds"]
df.filter(col("date") == execution_date) \
  .write.mode("overwrite") \
  .option("replaceWhere", f"date = '{execution_date}'") \
  .save(...)
```

핵심: **모든 처리를 `execution_date` 기준으로**, **저장은 멱등하게 (덮어쓰기 또는 MERGE)**.

# 6. 멱등성 테스트

---

```python
def test_idempotency():
    """동일 날짜를 2번 실행해도 결과가 같아야 함"""
    execution_date = "2024-01-15"

    # 첫 번째 실행
    run_pipeline(execution_date)
    result1 = get_row_count(execution_date)

    # 두 번째 실행
    run_pipeline(execution_date)
    result2 = get_row_count(execution_date)

    # 결과 동일해야 함
    assert result1 == result2, f"Idempotency failed: {result1} != {result2}"
```

## 검증 쿼리

```sql
-- 중복 키 확인
SELECT id, COUNT(*) as cnt
FROM target_table
WHERE date = '2024-01-15'
GROUP BY id
HAVING COUNT(*) > 1;

-- 행 수/합계 비교
SELECT
    SUM(amount) as total,
    COUNT(*) as row_count
FROM target_table
WHERE date = '2024-01-15';
```

# 7. 체크리스트

---

```text
□ retry/rerun/backfill을 해도 결과가 같은가?
□ execution_date(logical_date) 기준으로 데이터를 필터하는가?
□ 저장 방식이 멱등한가? (overwrite, MERGE, DELETE+INSERT)
□ 현재 시각(datetime.now()) 대신 execution_date를 사용하는가?
□ catchup 설정과 max_active_runs가 적절한가?
□ 실패 시 재처리 절차(runbook)가 문서화되어 있는가?
□ 결과 검증 쿼리가 준비되어 있는가?
□ downstream 영향을 파악하고 있는가?
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **멱등성** | 같은 입력으로 여러 번 실행해도 결과 동일 |
| **execution_date** | 처리 대상 시각 (실행 시각이 아님) |
| **catchup** | True면 start_date~현재 미실행 구간 자동 실행 |
| **Backfill** | CLI 또는 UI로 과거 범위 재처리 |
| **비멱등 패턴** | append, datetime.now(), 외부 상태 의존 |
| **검증** | 같은 날짜 2회 실행 → 결과 비교 |

```text
핵심:
  "같은 날짜를 다시 돌려도 안전한가?"
  이 질문에 "예"라고 답할 수 있으면 멱등한 파이프라인입니다.
  Airflow의 execution_date + 멱등한 저장 패턴의 조합이 핵심.
```

# Reference

---

- [Airflow Best Practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html)
- [Airflow Backfill](https://airflow.apache.org/docs/apache-airflow/stable/dag-run.html#backfill)
- [Airflow Context Variables](https://airflow.apache.org/docs/apache-airflow/stable/templates-ref.html)
- [Idempotency in Data Pipelines](https://www.startdataengineering.com/post/idempotent-data-pipelines/)
