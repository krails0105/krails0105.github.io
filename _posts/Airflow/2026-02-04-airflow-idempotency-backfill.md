---
title: "[Airflow] 멱등성(Idempotency)과 Backfill - 재처리 가능한 파이프라인"
categories:
  - Airflow
tags:
  - [Airflow, Idempotency, Backfill, DataPipeline, ETL]
---

# Introduction

---

Airflow 운영에서 진짜 중요한 건 **"실패를 허용하는 설계"**입니다.

- 지연/실패/재시도는 반드시 발생
- Backfill(과거 재처리)도 결국 필요

그래서 파이프라인을 **멱등하게** 만드는 것이 핵심입니다.

# 1. 멱등성이란?

---

**같은 입력/같은 실행을 여러 번 해도 결과가 동일한 성질**입니다.

```
실행 1: 2024-01-15 데이터 → 결과 A
실행 2: 2024-01-15 데이터 → 결과 A (동일!)
실행 3: 2024-01-15 데이터 → 결과 A (동일!)
```

## 멱등성이 필요한 상황

| 상황 | 설명 |
|------|------|
| Retry | Task 실패 후 재시도 |
| Manual Rerun | 운영자가 수동으로 재실행 |
| Backfill | 과거 날짜 범위 재처리 |
| 중복 트리거 | 스케줄러 이상으로 중복 실행 |

## 멱등성이 없으면?

```
실행 1: INSERT 1000 rows
실행 2: INSERT 1000 rows (중복!)
→ 총 2000 rows (데이터 오염)
```

# 2. 멱등성을 만드는 패턴

---

## 패턴 1: 파티션 Overwrite

```python
# 날짜 파티션 덮어쓰기
df.write \
    .mode("overwrite") \
    .option("replaceWhere", f"date = '{execution_date}'") \
    .save("/warehouse/table")
```

- 같은 날짜를 다시 실행해도 덮어쓰기
- 가장 단순하고 안전한 방법

## 패턴 2: Key 기반 MERGE (Upsert)

```sql
MERGE INTO target t
USING source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *
```

- 존재하면 UPDATE, 없으면 INSERT
- 중복 실행해도 결과 동일

## 패턴 3: DELETE + INSERT

```python
# 먼저 해당 파티션 삭제
spark.sql(f"DELETE FROM table WHERE date = '{execution_date}'")

# 새로 INSERT
df.write.mode("append").save(...)
```

- Overwrite가 지원 안 될 때 대안
- 트랜잭션 보장 필요

## 패턴 4: Output Path에 Execution Date 포함

```python
output_path = f"/warehouse/events/dt={execution_date}/"
df.write.mode("overwrite").parquet(output_path)
```

- 날짜별로 완전히 분리
- 재실행 시 해당 경로만 덮어쓰기

# 3. Airflow에서 Execution Date 활용

---

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
        # execution_date (logical date)
        execution_date = context["ds"]  # "2024-01-15"

        # 해당 날짜 데이터만 처리
        df = spark.sql(f"""
            SELECT * FROM source
            WHERE date = '{execution_date}'
        """)

        # 멱등하게 저장
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
| `ds` | "2024-01-15" | execution date (YYYY-MM-DD) |
| `ds_nodash` | "20240115" | 날짜 (구분자 없음) |
| `execution_date` | datetime 객체 | 날짜 객체 |
| `data_interval_start` | datetime | 데이터 구간 시작 |
| `data_interval_end` | datetime | 데이터 구간 끝 |

# 4. Backfill 운영

---

## CLI로 Backfill

```bash
# 날짜 범위 backfill
airflow dags backfill \
    --start-date 2024-01-01 \
    --end-date 2024-01-31 \
    my_dag

# 특정 task만
airflow tasks run my_dag my_task 2024-01-15
```

## Backfill 팁

```
□ 범위를 명확히 (시작일~종료일)
□ 한 번에 너무 넓은 범위 X (작게 쪼개기)
□ 병렬 실행 수 제한 (리소스 고려)
□ downstream 영향 파악 (서빙 테이블 등)
□ 결과 검증 자동화
```

## 병렬 실행 제어

```python
@dag(
    schedule_interval="@daily",
    max_active_runs=3,  # 동시 실행 제한
    ...
)
```

# 5. 멱등성 테스트

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
-- 중복 확인
SELECT date, COUNT(*) as cnt
FROM target_table
WHERE date = '2024-01-15'
GROUP BY date
HAVING COUNT(*) > 1;

-- 기대값 비교
SELECT
    SUM(amount) as total,
    COUNT(*) as row_count
FROM target_table
WHERE date = '2024-01-15';
```

# 6. 실패 대응 설계

---

## Retry 설정

```python
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

## 알림 설정

```python
from airflow.decorators import dag

@dag(
    on_failure_callback=slack_alert,
    on_success_callback=log_success,
    ...
)
def my_pipeline():
    ...
```

## Runbook 문서화

```markdown
## 실패 시 재처리 절차

1. 에러 로그 확인 (Airflow UI → Logs)
2. 원인 파악 (네트워크? 리소스? 데이터?)
3. 원인 해결
4. 해당 Task Clear (Airflow UI)
5. 자동 재시도 확인
6. 결과 검증 쿼리 실행
```

# 7. 비멱등 패턴 피하기

---

## 피해야 할 패턴

```python
# 나쁜 예 1: Append without key
df.write.mode("append").save(...)
# → 재실행 시 중복!

# 나쁜 예 2: 현재 시간 기반 처리
df.filter(col("created_at") >= datetime.now() - timedelta(days=1))
# → execution_date와 무관

# 나쁜 예 3: 순서 의존 로직
process_yesterday() >> process_today()
# → backfill 시 순서 보장 어려움
```

## 수정 방법

```python
# 좋은 예: execution_date 기반 필터 + overwrite
execution_date = context["ds"]
df.filter(col("date") == execution_date) \
  .write.mode("overwrite") \
  .option("replaceWhere", f"date = '{execution_date}'") \
  .save(...)
```

# 8. 체크리스트

---

```
□ retry/rerun/backfill을 해도 결과가 같은가?
□ 파티션/키 설계가 멱등성을 보장하는가?
□ execution_date를 기준으로 데이터를 필터하는가?
□ 실패 시 재처리 절차(runbook)가 있는가?
□ 결과 검증 쿼리가 자동화되어 있는가?
□ downstream 영향을 파악하고 있는가?
```

# Reference

---

- [Airflow Best Practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html)
- [Backfill](https://airflow.apache.org/docs/apache-airflow/stable/dag-run.html#backfill)
- [Idempotency in Data Pipelines](https://www.startdataengineering.com/post/idempotent-data-pipelines/)
