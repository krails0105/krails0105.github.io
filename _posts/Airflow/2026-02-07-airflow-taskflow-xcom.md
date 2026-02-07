---
title: "[Airflow] TaskFlow API와 XCom - Task 간 데이터 전달"
categories:
  - Airflow
tags:
  - [Airflow, TaskFlow, XCom, Task, DataPassing]
---

# Introduction

---

Airflow에서 Task 간 데이터를 전달하는 방법은 **XCom(Cross-Communication)**입니다. 전통적인 방식은 `xcom_push`/`xcom_pull`을 명시적으로 호출해야 했지만, Airflow 2.0+의 **TaskFlow API**는 Python 함수의 return 값을 자동으로 XCom에 저장하고, 함수 파라미터로 자동 주입합니다.

TaskFlow API는 DAG 작성을 훨씬 Pythonic하게 만들어주지만, 내부 동작 원리를 이해해야 효과적으로 사용할 수 있습니다.

# 1. XCom 기본 개념

---

## XCom이란?

**Cross-Communication**의 약자로, Task 간에 소량의 데이터를 주고받는 메커니즘입니다.

```text
Task A (Producer) → XCom 저장소 (메타데이터 DB) → Task B (Consumer)
```

## 전통적인 XCom 사용법

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from datetime import datetime

def push_data(**context):
    # XCom에 데이터 저장
    context['ti'].xcom_push(key='my_data', value={'count': 100})

def pull_data(**context):
    # XCom에서 데이터 가져오기
    data = context['ti'].xcom_pull(task_ids='push_task', key='my_data')
    print(f"Received: {data}")  # {'count': 100}

with DAG("xcom_example", start_date=datetime(2024, 1, 1)) as dag:
    push_task = PythonOperator(task_id="push_task", python_callable=push_data)
    pull_task = PythonOperator(task_id="pull_task", python_callable=pull_data)
    push_task >> pull_task
```

번거롭습니다. key 이름 관리, task_ids 지정 등 boilerplate가 많습니다.

# 2. TaskFlow API - @task 데코레이터

---

## 기본 사용법

```python
import json
import pendulum
from airflow.sdk import dag, task

@dag(
    schedule=None,
    start_date=pendulum.datetime(2024, 1, 1, tz="UTC"),
    catchup=False,
)
def taskflow_example():

    @task()
    def extract():
        """데이터 추출"""
        data = '{"1001": 301.27, "1002": 433.21}'
        return json.loads(data)  # 자동으로 XCom에 저장

    @task()
    def transform(order_data: dict):
        """데이터 변환 - 파라미터로 XCom 값 자동 주입"""
        total = sum(order_data.values())
        return {"total": total}

    @task()
    def load(result: dict):
        """결과 출력"""
        print(f"Total: {result['total']}")

    # 함수 호출처럼 연결 → 자동으로 의존성 + XCom 설정
    order_data = extract()
    result = transform(order_data)
    load(result)

dag = taskflow_example()
```

핵심:
- **return 값 → 자동 XCom push**
- **함수 파라미터 → 자동 XCom pull**
- **함수 호출 순서 → 자동 의존성 설정**

## 비교: 전통 방식 vs TaskFlow

```text
전통 방식:
  - PythonOperator 정의
  - xcom_push() 명시적 호출
  - xcom_pull(task_ids='...', key='...') 호출
  - >> 연산자로 의존성 설정

TaskFlow:
  - @task 데코레이터
  - return으로 데이터 반환
  - 함수 파라미터로 데이터 수신
  - 함수 호출로 의존성 자동 설정
```

# 3. multiple_outputs - 딕셔너리 분해

---

## 기본 동작

return이 딕셔너리일 때, 기본적으로 전체 딕셔너리가 하나의 XCom 값으로 저장됩니다.

```python
@task()
def calculate():
    return {"count": 100, "total": 5000}

@task()
def use_result(result: dict):
    # 전체 딕셔너리를 받음
    print(result["count"])  # 100
```

## multiple_outputs=True

딕셔너리의 각 key를 별도 XCom으로 저장합니다.

```python
@task(multiple_outputs=True)
def calculate():
    return {"count": 100, "total": 5000}
    # XCom: key="count", value=100
    # XCom: key="total", value=5000

@task()
def use_count(count: int):
    print(f"Count: {count}")  # 100

@task()
def use_total(total: float):
    print(f"Total: {total}")  # 5000

# 개별 값 접근
result = calculate()
use_count(result["count"])  # count만 사용
use_total(result["total"])  # total만 사용
```

## 언제 쓰나?

```text
multiple_outputs=False (기본):
  - downstream이 전체 결과를 필요로 할 때
  - 딕셔너리 구조가 변할 수 있을 때

multiple_outputs=True:
  - downstream이 일부 값만 필요할 때
  - 여러 Task가 각각 다른 값을 사용할 때
  - 불필요한 데이터 전달을 줄이고 싶을 때
```

# 4. XCom 직접 접근

---

TaskFlow에서도 필요시 XCom을 직접 다룰 수 있습니다.

```python
@task()
def push_multiple(**context):
    ti = context['ti']
    ti.xcom_push(key='custom_key', value='custom_value')
    return {"main_result": 123}  # return도 여전히 XCom에 저장

@task()
def pull_mixed(**context):
    ti = context['ti']

    # 직접 pull
    custom = ti.xcom_pull(task_ids='push_multiple', key='custom_key')

    # return 값은 'return_value' 키로 저장됨
    main = ti.xcom_pull(task_ids='push_multiple', key='return_value')

    print(f"custom: {custom}, main: {main}")
```

# 5. 동적 Task 매핑과 XCom

---

Airflow 2.3+에서 도입된 Dynamic Task Mapping과 XCom을 결합할 수 있습니다.

```python
@dag(schedule=None, start_date=pendulum.datetime(2024, 1, 1), catchup=False)
def dynamic_mapping_example():

    @task()
    def get_files():
        # 처리할 파일 목록 반환
        return ["file1.csv", "file2.csv", "file3.csv"]

    @task()
    def process_file(filename: str):
        # 각 파일 처리
        return {"file": filename, "rows": 100}

    @task()
    def summarize(results: list):
        # 모든 결과 집계
        total = sum(r["rows"] for r in results)
        print(f"Total rows: {total}")

    files = get_files()
    # expand: 리스트의 각 요소에 대해 Task 인스턴스 생성
    results = process_file.expand(filename=files)
    summarize(results)

dag = dynamic_mapping_example()
```

```text
실행 흐름:
  get_files() → ["file1.csv", "file2.csv", "file3.csv"]
  process_file(filename="file1.csv")  ─┐
  process_file(filename="file2.csv")  ─┼→ [result1, result2, result3]
  process_file(filename="file3.csv")  ─┘
  summarize([result1, result2, result3])
```

# 6. XCom 제약사항과 주의점

---

## 크기 제한

```text
⚠️ XCom은 메타데이터 DB에 저장됨
   - PostgreSQL: 기본 1GB (실질적으로 수 MB 권장)
   - MySQL: 64KB (BLOB 타입)
   - SQLite: 제한 없음 (테스트용)

권장:
  - XCom은 "메타데이터" 용도 (파일 경로, 레코드 수, 상태 등)
  - 대용량 데이터는 외부 저장소 (S3, GCS) + 경로만 XCom으로 전달
```

## Custom XCom Backend

대용량 데이터를 위해 XCom 저장소를 S3 등으로 변경할 수 있습니다.

```python
# airflow.cfg
[core]
xcom_backend = airflow.providers.amazon.aws.xcom.s3_xcom_backend.S3XComBackend

[aws]
xcom_s3_bucket = my-airflow-xcom-bucket
```

## 직렬화 가능 객체만

```python
@task()
def bad_return():
    # ❌ 직렬화 불가능한 객체
    import pandas as pd
    return pd.DataFrame({"a": [1, 2, 3]})  # 에러!

@task()
def good_return():
    # ✅ 직렬화 가능한 객체
    return {"a": [1, 2, 3]}  # dict, list, str, int 등
```

Pandas DataFrame, Spark DataFrame 등은 직접 XCom에 저장할 수 없습니다. JSON 직렬화 가능한 형태로 변환하거나, 파일로 저장 후 경로만 전달해야 합니다.

# 7. 실무 패턴

---

## 패턴 1: 파일 경로 전달

```python
@task()
def save_to_s3(data: dict) -> str:
    path = f"s3://bucket/output/{uuid.uuid4()}.parquet"
    # 데이터 저장 로직...
    return path  # 경로만 XCom에 저장

@task()
def load_from_s3(path: str):
    # 경로로 데이터 로드
    df = pd.read_parquet(path)
    return df.shape[0]
```

## 패턴 2: 상태와 메타데이터 전달

```python
@task(multiple_outputs=True)
def process_data():
    # 처리 로직...
    return {
        "status": "success",
        "record_count": 1500,
        "output_path": "s3://bucket/result.parquet",
        "processing_time_sec": 45.2
    }

@task()
def notify(status: str, record_count: int):
    if status == "success":
        send_slack(f"처리 완료: {record_count}건")
```

## 패턴 3: 조건부 분기

```python
from airflow.sdk import dag, task
from airflow.operators.python import BranchPythonOperator

@task()
def check_data_size() -> str:
    size = get_data_size()
    if size > 1_000_000:
        return "process_large"
    return "process_small"

@task()
def process_large():
    # Spark 사용
    pass

@task()
def process_small():
    # Pandas 사용
    pass
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **XCom** | Task 간 데이터 전달 메커니즘 (메타데이터 DB 저장) |
| **@task** | TaskFlow 데코레이터, return → XCom 자동 저장 |
| **multiple_outputs** | 딕셔너리 key별로 개별 XCom 저장 |
| **expand()** | Dynamic Task Mapping, 리스트 요소별 Task 생성 |
| **크기 제한** | 수 MB 이하 권장, 대용량은 외부 저장소 활용 |

```text
핵심:
  TaskFlow API = "Python 함수처럼 DAG 작성"
  return → XCom push, 파라미터 → XCom pull 자동화.
  XCom은 메타데이터용, 대용량 데이터는 외부 저장소 + 경로 전달.
```

# Reference

---

- [TaskFlow API Tutorial](https://airflow.apache.org/docs/apache-airflow/stable/tutorial/taskflow.html)
- [XCom Concepts](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html)
- [Dynamic Task Mapping](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/dynamic-task-mapping.html)
