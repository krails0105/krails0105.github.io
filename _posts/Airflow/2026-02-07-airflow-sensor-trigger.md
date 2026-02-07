---
title: "[Airflow] Sensor와 Trigger - 외부 이벤트 대기 패턴"
categories:
  - Airflow
tags:
  - [Airflow, Sensor, Trigger, Deferrable, ExternalTaskSensor]
---

# Introduction

---

데이터 파이프라인에서 "파일이 도착할 때까지 기다려라", "API가 응답할 때까지 대기해라" 같은 요구사항은 흔합니다. Airflow의 **Sensor**는 이런 외부 조건을 주기적으로 확인하며 기다리는 Operator입니다. 낚시꾼이 찌를 보며 물고기를 기다리는 것과 비슷합니다.

하지만 Sensor가 대기하는 동안 Worker 슬롯을 점유하면 리소스 낭비가 됩니다. Airflow 2.2+에서 도입된 **Deferrable Operator**와 **Trigger**는 대기 중 Worker를 해제하고, 조건이 충족되면 다시 실행하는 효율적인 패턴을 제공합니다.

# 1. Sensor 기본 개념

---

## Sensor란?

특정 조건이 충족될 때까지 **주기적으로 확인(poke)**하며 대기하는 Operator입니다.

```python
from airflow import DAG
from airflow.sensors.filesystem import FileSensor
from datetime import datetime

with DAG("file_sensor_example", start_date=datetime(2024, 1, 1), schedule_interval="@daily") as dag:

    wait_for_file = FileSensor(
        task_id="wait_for_file",
        filepath="/data/input/{{ ds }}.csv",
        poke_interval=60,    # 60초마다 확인
        timeout=3600,        # 최대 1시간 대기
        mode="poke",         # 대기 모드
    )
```

## 주요 Sensor 종류

| Sensor | 용도 |
|--------|------|
| `FileSensor` | 파일 존재 여부 확인 |
| `ExternalTaskSensor` | 다른 DAG의 Task 완료 대기 |
| `HttpSensor` | HTTP 엔드포인트 응답 확인 |
| `S3KeySensor` | S3 객체 존재 확인 |
| `SqlSensor` | SQL 쿼리 결과가 True인지 확인 |
| `DateTimeSensor` | 특정 시각까지 대기 |

# 2. Sensor Mode: poke vs reschedule

---

## poke 모드 (기본값)

```text
Worker 슬롯을 점유한 채로 sleep → 다시 poke → sleep → ...

문제점:
  - 대기 시간 동안 Worker 슬롯 낭비
  - 많은 Sensor가 동시에 대기하면 Worker 부족
```

```python
FileSensor(
    task_id="wait_poke",
    filepath="/data/file.csv",
    poke_interval=60,
    mode="poke",  # Worker 점유 유지
)
```

## reschedule 모드

```text
poke 실패 → Task 종료 → 스케줄러가 재실행 예약 → Worker 해제

장점:
  - 대기 중 Worker 슬롯 반환
  - 리소스 효율적

단점:
  - 재스케줄링 오버헤드
  - 스케줄러 부하 증가
```

```python
FileSensor(
    task_id="wait_reschedule",
    filepath="/data/file.csv",
    poke_interval=300,  # 5분마다 재스케줄
    mode="reschedule",  # Worker 해제
)
```

## 비교

| 항목 | poke | reschedule |
|------|------|------------|
| **Worker 점유** | 유지 | 해제 |
| **적합한 상황** | 짧은 대기 (수분 이내) | 긴 대기 (수십 분~수시간) |
| **오버헤드** | 낮음 | 재스케줄링 비용 |
| **poke_interval** | 짧게 (30초~1분) | 길게 (5분 이상) |

# 3. Deferrable Operator와 Trigger

---

## 개념

Airflow 2.2+에서 도입된 패턴으로, **대기 중 Worker를 완전히 해제**하고 별도의 **Triggerer** 프로세스가 이벤트를 감시합니다.

```text
기존 reschedule:
  Task 종료 → 스케줄러가 재실행 → 다시 poke

Deferrable:
  Task가 defer() 호출 → Worker 해제 → Triggerer가 이벤트 감시
  → 이벤트 발생 → 스케줄러에 통보 → Task 재실행
```

## Trigger란?

비동기적으로 이벤트를 감시하는 경량 프로세스입니다. asyncio 기반으로 동작하며, 수천 개의 Trigger를 적은 리소스로 처리할 수 있습니다.

```text
Triggerer 프로세스:
  - Worker와 별도의 프로세스
  - asyncio 이벤트 루프로 동작
  - 다수의 Trigger를 동시에 감시
```

## Deferrable Sensor 예시

```python
from datetime import timedelta
from typing import Any

from airflow.sdk import BaseSensorOperator, Context
from airflow.providers.standard.triggers.temporal import TimeDeltaTrigger


class WaitOneHourSensor(BaseSensorOperator):

    def __init__(self, deferrable: bool = True, **kwargs) -> None:
        super().__init__(**kwargs)
        self.deferrable = deferrable

    def execute(self, context: Context) -> None:
        if self.deferrable:
            # Triggerer에게 대기 위임
            self.defer(
                trigger=TimeDeltaTrigger(timedelta(hours=1)),
                method_name="execute_complete",
            )
        else:
            # 기존 방식 (Worker 점유)
            import time
            time.sleep(3600)

    def execute_complete(
        self,
        context: Context,
        event: dict[str, Any] | None = None,
    ) -> None:
        # Trigger 이벤트 후 실행
        return
```

## 기본 제공 Deferrable Sensor

많은 공식 Sensor가 `deferrable=True` 옵션을 지원합니다.

```python
from airflow.providers.amazon.aws.sensors.s3 import S3KeySensor

wait_for_s3 = S3KeySensor(
    task_id="wait_for_s3",
    bucket_key="s3://my-bucket/data/{{ ds }}.parquet",
    deferrable=True,  # Triggerer 사용
)
```

# 4. reschedule vs deferrable 비교

---

| 항목 | reschedule | deferrable |
|------|------------|------------|
| **대기 방식** | 주기적 재스케줄링 | Triggerer가 비동기 감시 |
| **Worker 점유** | 해제 (poke 시만 점유) | 완전 해제 |
| **리소스 효율** | 중간 | 최고 |
| **반응 속도** | poke_interval에 의존 | 즉시 (이벤트 기반) |
| **설정 복잡도** | 낮음 | Triggerer 프로세스 필요 |
| **Airflow 버전** | 1.10+ | 2.2+ |

```text
선택 기준:
  - 짧은 대기 + 간단한 환경 → poke
  - 긴 대기 + Worker 부족 → reschedule
  - 많은 Sensor + 최대 효율 → deferrable
```

# 5. ExternalTaskSensor - DAG 간 의존성

---

다른 DAG의 Task 완료를 기다리는 Sensor입니다.

```python
from airflow.sensors.external_task import ExternalTaskSensor
from datetime import timedelta

wait_for_upstream = ExternalTaskSensor(
    task_id="wait_for_upstream",
    external_dag_id="upstream_dag",
    external_task_id="final_task",
    execution_delta=timedelta(hours=0),  # 같은 execution_date
    mode="reschedule",
    poke_interval=300,
    timeout=7200,
)
```

## execution_delta vs execution_date_fn

```python
# 방법 1: 고정 시간차
ExternalTaskSensor(
    external_dag_id="daily_etl",
    execution_delta=timedelta(days=1),  # 어제 실행분 대기
)

# 방법 2: 동적 계산
def get_execution_date(execution_date, **kwargs):
    # 월요일이면 금요일 실행분 대기
    if execution_date.weekday() == 0:
        return execution_date - timedelta(days=3)
    return execution_date - timedelta(days=1)

ExternalTaskSensor(
    external_dag_id="daily_etl",
    execution_date_fn=get_execution_date,
)
```

## 주의사항

```text
⚠️ execution_date 일치가 핵심
   - 기본적으로 같은 execution_date의 Task를 기다림
   - schedule_interval이 다르면 execution_delta 또는 execution_date_fn 필수

⚠️ 순환 의존성 주의
   - DAG A → DAG B → DAG A 같은 순환은 데드락 발생

⚠️ allowed_states 설정
   - 기본값은 ["success"]
   - 필요시 ["success", "skipped"] 등으로 확장
```

# 6. TaskFlow API의 @task.sensor

---

TaskFlow API에서 데코레이터로 Sensor를 정의할 수 있습니다.

```python
import pendulum
from airflow.sdk import dag, task, PokeReturnValue

@dag(
    schedule=None,
    start_date=pendulum.datetime(2024, 1, 1, tz="UTC"),
    catchup=False,
)
def sensor_decorator_example():

    @task.sensor(poke_interval=60, timeout=3600, mode="reschedule")
    def wait_for_condition() -> PokeReturnValue:
        # 조건 확인 로직
        condition_met = check_external_condition()

        if condition_met:
            return PokeReturnValue(is_done=True, xcom_value="data_ready")
        else:
            return PokeReturnValue(is_done=False)

    @task
    def process_data(status: str):
        print(f"Received: {status}")

    result = wait_for_condition()
    process_data(result)

dag = sensor_decorator_example()
```

`PokeReturnValue`로 완료 여부와 XCom 값을 동시에 반환할 수 있습니다.

# 7. Sensor 설정 팁

---

## timeout과 soft_fail

```python
FileSensor(
    task_id="wait_file",
    filepath="/data/file.csv",
    timeout=3600,           # 1시간 후 실패
    soft_fail=True,         # timeout 시 skip (failed 대신)
    poke_interval=60,
)
```

`soft_fail=True`는 timeout 시 Task를 `skipped` 상태로 만들어 downstream이 실행되지 않되, DAG 전체가 `failed`되는 것을 방지합니다.

## exponential_backoff

```python
FileSensor(
    task_id="wait_file",
    filepath="/data/file.csv",
    poke_interval=60,
    exponential_backoff=True,  # 60초 → 120초 → 240초...
)
```

API 호출 Sensor에서 rate limit을 피하는 데 유용합니다.

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Sensor** | 조건 충족까지 주기적으로 poke하며 대기 |
| **poke 모드** | Worker 점유 유지, 짧은 대기에 적합 |
| **reschedule 모드** | poke 후 Worker 해제, 긴 대기에 적합 |
| **Deferrable** | Triggerer에게 감시 위임, 최고 효율 (2.2+) |
| **Trigger** | asyncio 기반 비동기 이벤트 감시 프로세스 |
| **ExternalTaskSensor** | 다른 DAG Task 완료 대기 |

```text
핵심:
  Sensor = "조건이 맞을 때까지 기다리는 Operator"
  대기 시간이 길면 reschedule 또는 deferrable로 Worker 절약.
  deferrable이 가장 효율적이지만 Triggerer 설정 필요.
```

# Reference

---

- [Airflow Sensors](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/sensors.html)
- [Deferrable Operators](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html)
- [ExternalTaskSensor](https://airflow.apache.org/docs/apache-airflow/stable/howto/operator/external_task_sensor.html)
