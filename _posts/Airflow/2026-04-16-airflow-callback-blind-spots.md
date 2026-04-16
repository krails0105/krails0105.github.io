---
title: "[Airflow] 콜백 사각지대 — retry/dagrun_timeout 조합에서 on_failure_callback이 호출되지 않는 문제"
categories:
  - Airflow
tags:
  - Airflow
  - Callback
  - Retry
  - dagrun_timeout
  - Monitoring
  - on_failure_callback
---

## Introduction

Airflow DAG에서 task가 분명히 실패했는데 모니터링 알림이 오지 않는 상황을 경험한 적이 있다면, `on_failure_callback`의 호출 조건을 다시 확인해볼 필요가 있습니다.

`on_failure_callback`은 "task가 실패하면 호출된다"고 막연하게 이해하기 쉽습니다. 하지만 실제로는 **최종 FAILED 상태에 도달했을 때만** 호출됩니다. retry 중간에는 호출되지 않으며, `dagrun_timeout`과의 조합에 따라서는 아예 호출되지 않는 사각지대가 생깁니다.

이 글에서는 해당 문제를 재현하고 원인을 분석한 과정을 정리합니다. 글을 다 읽고 나면, retry와 dagrun_timeout 설정 시 콜백 누락을 방지하는 방법을 이해할 수 있습니다.

## 문제 상황

데이터 파이프라인을 관리하는 Airflow DAG에서, task 실패 시 Kinesis로 ERROR 이벤트를 전송하는 모니터링 콜백을 구성했습니다.

```python
# dags/my_pipeline_dag.py
from datetime import timedelta
from airflow import DAG

def on_failure_handler(context):
    """task 최종 실패 시 Kinesis로 이벤트 전송"""
    send_kinesis_event(
        event_type="ERROR",
        task_id=context["task_instance"].task_id,
        dag_id=context["dag"].dag_id,
    )

default_args = {
    "retries": 18,
    "retry_delay": timedelta(minutes=10),
    "retry_exponential_backoff": True,
    "on_failure_callback": on_failure_handler,  # task 레벨 콜백
}

with DAG(
    dag_id="my_pipeline",
    default_args=default_args,
    dagrun_timeout=timedelta(minutes=30),
) as dag:
    ...
```

> **DAG 레벨 vs task 레벨 콜백**: `on_failure_callback`을 DAG 생성자에 직접 전달하면 **DAG Run이 실패했을 때** 호출되는 DAG 레벨 콜백입니다. 개별 task 실패 시 호출하려면 위 예시처럼 `default_args`에 넣거나 각 task에 직접 지정해야 합니다.

설정 의도는 명확했습니다. task가 실패하면 콜백이 호출되고, Kinesis를 통해 Slack으로 알림이 전달되는 구조입니다. 그런데 실제 장애 상황에서 알림이 오지 않았습니다.

## 원인 분석

### Airflow 콜백 타입과 호출 조건

Airflow는 task 실행 흐름에서 여러 콜백을 제공합니다.

| 콜백 | 호출 시점 | 적용 레벨 |
|------|----------|-----------|
| `on_execute_callback` | 매 실행 시작 시 (retry 포함) | task |
| `on_success_callback` | 성공 시 | DAG / task |
| `on_failure_callback` | **최종 FAILED 상태에서만** | DAG / task |
| `on_retry_callback` | retry 시마다 | task |
| `on_skipped_callback` | task 실행 중 `AirflowSkipException` 발생 시 | task |

핵심은 `on_failure_callback`이 retry 중간에는 호출되지 않는다는 점입니다. task 상태가 `UP_FOR_RETRY`인 동안은 아직 "최종 실패"가 아니기 때문입니다.

또한 `on_skipped_callback`은 task가 실행 도중 `AirflowSkipException`을 raise했을 때만 호출됩니다. 브랜칭이나 trigger rule, 또는 dagrun_timeout에 의한 skip에서는 호출되지 않습니다.

### dagrun_timeout과의 조합에서 생기는 사각지대

문제의 설정을 다시 보면:

```text
retries=18
retry_delay=10분 (exponential backoff 포함)
dagrun_timeout=30분
```

exponential backoff가 적용된 retry 간격은 시간이 지날수록 늘어납니다. `dagrun_timeout`인 30분 안에 18번의 retry를 다 소진하는 것은 불가능합니다.

결과적으로 다음 흐름이 발생합니다.

```text
task 실패
  → UP_FOR_RETRY (retry 대기)
  → dagrun_timeout 초과
  → DAG Run 종료, 대기 중 task 강제 종료
  → task 상태: FAILED가 아닌 다른 상태로 전환
  → on_failure_callback: 호출되지 않음 (최종 FAILED 아님)
  → on_skipped_callback: AirflowSkipException이 아니므로 호출 안 됨
  → 모니터링 알림: 오지 않음
```

`dagrun_timeout`이 초과되면 DAG Run이 종료되면서 아직 실행 중이거나 대기 중인 task들이 강제로 종료됩니다. 이때 task 프로세스는 SIGTERM으로 kill될 수 있으며, 상태 전환이 `on_failure_callback`의 호출 조건(모든 retry 소진 후 최종 FAILED)과 맞지 않습니다.

### 상태 전환 비교

```text
정상 케이스 (retry 소진 후 FAILED):
  실패 → UP_FOR_RETRY → 재시도 → 실패 → ... → FAILED
  → on_failure_callback 호출됨

문제 케이스 (dagrun_timeout 초과):
  실패 → UP_FOR_RETRY → dagrun_timeout 초과 → 강제 종료
  → on_failure_callback 호출되지 않음
```

## 해결 방법

핵심은 `dagrun_timeout` 안에 retry를 모두 소진해서 task가 확실히 `FAILED` 상태에 도달할 수 있도록 설정을 조정하는 것입니다.

```python
default_args = {
    "retries": 1,                         # 18 → 1로 줄임
    "retry_delay": timedelta(minutes=1),   # 10분 → 1분으로 줄임
    # retry_exponential_backoff 제거: 간격이 예측 불가하게 늘어나는 것을 방지
    "on_failure_callback": on_failure_handler,
}

with DAG(
    dag_id="my_pipeline",
    default_args=default_args,
    dagrun_timeout=timedelta(minutes=30),
) as dag:
    ...
```

변경 포인트:

- **`retries=18` -> `retries=1`**: 빠르게 최종 FAILED에 도달
- **`retry_delay=10분` -> `1분`**: dagrun_timeout 안에 retry 소진 가능
- **`retry_exponential_backoff=True` 제거**: 간격이 예측 불가하게 늘어나는 것을 방지

30분 `dagrun_timeout` 안에 1번의 retry(대기 1분)는 충분히 완료됩니다. task는 최종 `FAILED` 상태에 도달하고, `on_failure_callback`이 정상 호출됩니다.

## 주의할 점

### 콜백에만 의존하면 안 되는 이유

이번 사례처럼 `on_failure_callback`은 항상 호출된다는 보장이 없습니다. timeout, 외부 프로세스 kill, zombie task 등 다양한 경우에 콜백이 누락될 수 있습니다. Airflow 공식 문서에서도 "callback functions are only invoked when the task state changes due to execution by a worker"라고 명시하고 있으며, CLI나 UI를 통한 상태 변경에서는 호출되지 않습니다.

중요한 파이프라인이라면 DAG Run 상태를 주기적으로 조회하는 별도 모니터링 DAG나 외부 감시 메커니즘을 함께 구성하는 것이 안전합니다.

### retry 설정은 dagrun_timeout과 함께 계산하기

retry 횟수와 delay를 설정할 때, 최악의 경우(exponential backoff 포함) 전체 소요 시간이 `dagrun_timeout`을 초과하지 않는지 반드시 계산해야 합니다.

```text
최대 retry 소요 시간 = sum(retry_delay * backoff_factor^n for n in range(retries))
이 값이 dagrun_timeout보다 작아야 on_failure_callback이 호출될 수 있음
```

### on_retry_callback으로 중간 상태 추적

retry 중에도 알림을 받고 싶다면 `on_retry_callback`을 별도로 등록합니다. 이 콜백은 retry가 발생할 때마다 호출되므로, 문제 상황을 조기에 감지할 수 있습니다.

```python
def on_retry_handler(context):
    """retry 발생 시 경고 이벤트 전송"""
    send_kinesis_event(
        event_type="RETRY",
        retry_count=context["task_instance"].try_number,
        task_id=context["task_instance"].task_id,
        dag_id=context["dag"].dag_id,
    )

default_args = {
    "on_failure_callback": on_failure_handler,
    "on_retry_callback": on_retry_handler,
}
```

### DAG 레벨 on_failure_callback 활용

개별 task 콜백과 별개로, DAG 생성자에 `on_failure_callback`을 지정하면 **DAG Run 자체가 실패 상태로 종료**될 때 호출됩니다. dagrun_timeout에 의해 DAG Run이 failed로 마킹되는 경우를 잡기 위한 보조 수단으로 활용할 수 있습니다.

```python
def on_dag_failure_handler(context):
    """DAG Run 실패 시 알림"""
    send_kinesis_event(
        event_type="DAG_FAILED",
        dag_id=context["dag"].dag_id,
        run_id=context["run_id"],
    )

with DAG(
    dag_id="my_pipeline",
    default_args=default_args,
    dagrun_timeout=timedelta(minutes=30),
    on_failure_callback=on_dag_failure_handler,  # DAG 레벨 콜백
) as dag:
    ...
```

## 검증

설정 변경 후 의도적으로 task를 실패시켜 다음을 확인했습니다.

1. task `FAILED` 상태 도달 확인 (Airflow UI)
2. `on_failure_callback` 호출 로그 확인
3. Kinesis ERROR 이벤트 전송 확인
4. 최종 Slack 알림 수신 확인 (E2E)

Airflow UI에서 task 상태가 `FAILED`로 표시되고, 콜백 로그에 실행 기록이 남으며, 최종적으로 Slack 채널에 알림이 도달하는 것을 확인했습니다.

> **Tip**: 콜백 함수 내부에서 발생하는 에러는 task 로그가 아닌 **dag processor 로그**에 기록됩니다. 콜백이 호출되지 않는 것처럼 보일 때 dag processor 로그도 함께 확인하면 좋습니다.

## 다음 단계

- DAG Run 상태를 주기적으로 조회하는 모니터링 DAG 추가 (콜백 누락 보완)
- 파이프라인 전체에 retry 설정 가이드라인 문서화
- `on_retry_callback` 등록으로 retry 중간 상태도 추적

## Reference

- [Airflow Callbacks](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/callbacks.html)
- [Airflow DAG Run](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dag-run.html)
- [Airflow Task Retries](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html#retries)
- [Airflow Troubleshooting - Process terminated by signal](https://airflow.apache.org/docs/apache-airflow/stable/troubleshooting.html)
