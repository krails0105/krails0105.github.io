---
title: "[Airflow] 모니터링과 성능 튜닝 - Scheduler, Executor, Pool 최적화"
categories:
  - Airflow
tags:
  - [Airflow, Monitoring, Performance, Scheduler, Executor, Pool]
---

# Introduction

---

Airflow가 느려지면 보통 "DAG이 너무 많아서", "Task가 밀려서"라고 생각하기 쉽습니다. 하지만 실제 병목은 Scheduler 설정, Executor 구성, Worker 리소스, DB 연결 등 다양한 곳에서 발생합니다. 병원에서 진료가 지연되는 이유가 의사 수, 접수 시스템, 대기실 크기 등 여러 요인이 있는 것처럼, Airflow도 어디가 막혔는지 파악하는 것이 먼저입니다.

이 글은 Airflow 모니터링 방법과 주요 성능 튜닝 포인트를 정리합니다.

# 1. Airflow 구성 요소와 병목 지점

---

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Scheduler  │───▶│   Executor  │───▶│   Worker    │
└─────────────┘    └─────────────┘    └─────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
  DAG 파싱/스케줄링    Task 큐잉/분배      실제 Task 실행
```

| 구성 요소 | 병목 증상 | 원인 |
|----------|----------|------|
| **Scheduler** | DAG 반영 지연, Task 스케줄링 느림 | 파싱 시간, DB 연결, 루프 설정 |
| **Executor** | Task가 큐에 쌓임 | Worker 부족, 병렬 설정 |
| **Worker** | Task 실행 시간 증가 | 리소스 부족, 무거운 로직 |
| **Metadata DB** | 전반적인 지연 | 커넥션 풀, 쿼리 성능 |
| **Triggerer** | Deferrable Task 지연 | Triggerer 인스턴스 부족 |

# 2. 주요 모니터링 메트릭

---

## Scheduler 메트릭

```text
scheduler.scheduler_loop_duration
  → Scheduler 루프 1회 소요 시간
  → 높으면: 파싱 또는 DB 병목

scheduler.dag_processing.total_parse_time
  → DAG 파일 파싱 총 시간
  → 높으면: DAG 파일 최적화 필요

scheduler.tasks.running
scheduler.tasks.pending
  → 실행 중/대기 중 Task 수
  → pending이 계속 쌓이면: Executor/Worker 병목
```

## Executor 메트릭

```text
executor.open_slots
  → 사용 가능한 Worker 슬롯
  → 0이면: 병렬 처리 한계

executor.queued_tasks
  → 큐에 대기 중인 Task
  → 계속 증가하면: Worker 부족

executor.running_tasks
  → 현재 실행 중인 Task 수
```

## Pool 메트릭

```text
pool.open_slots.<pool_name>
  → 특정 Pool의 사용 가능 슬롯
  → 0이면: 해당 Pool 병목

pool.queued_slots.<pool_name>
  → Pool 대기 중인 Task
```

## StatsD/Prometheus 연동

```python
# airflow.cfg
[metrics]
statsd_on = True
statsd_host = localhost
statsd_port = 8125
statsd_prefix = airflow

# 또는 Prometheus
metrics_exporter_class = airflow.metrics.otel_exporter.SafeOTelMetricExporter
```

# 3. Scheduler 튜닝

---

## 핵심 설정

```python
# airflow.cfg

[scheduler]
# DAG 파싱 주기 (초)
min_file_process_interval = 30  # 기본 30초, 파일 변경 적으면 늘리기

# Scheduler 루프 속도
scheduler_idle_sleep_time = 1  # 루프 사이 대기 시간

# 병렬 파싱 프로세스 수
parsing_processes = 2  # CPU 코어 수에 맞게 조정

# 한 루프에서 스케줄링할 최대 DAG Run 수
max_dagruns_to_create_per_loop = 10

# 한 루프에서 스케줄링할 최대 Task 수
max_tis_per_query = 512
```

## DAG 파싱 최적화

```python
# ❌ 느린 패턴: 모듈 import가 무거움
from heavy_library import something  # 매 파싱마다 실행

# ✅ 빠른 패턴: 실행 시점에만 import
def my_task():
    from heavy_library import something
    something()
```

```python
# ❌ 느린 패턴: DAG 파일에서 외부 호출
config = requests.get("https://config-server/settings").json()  # 파싱마다 호출

# ✅ 빠른 패턴: Airflow Variable 또는 환경 변수 사용
from airflow.models import Variable
config = Variable.get("my_config", deserialize_json=True)
```

## .airflowignore

파싱 대상에서 제외할 파일을 지정합니다.

```text
# .airflowignore (DAGs 폴더에 생성)
__pycache__/
tests/
*.pyc
archive/
```

# 4. Executor 튜닝

---

## LocalExecutor

개발/소규모 환경에 적합합니다.

```python
# airflow.cfg
[core]
executor = LocalExecutor
parallelism = 32  # 전체 동시 실행 Task 수
dag_concurrency = 16  # DAG당 동시 실행 Task 수
```

## CeleryExecutor

프로덕션 환경의 분산 처리에 적합합니다.

```python
# airflow.cfg
[core]
executor = CeleryExecutor
parallelism = 128

[celery]
worker_concurrency = 16  # Worker당 동시 Task 수
broker_url = redis://redis:6379/0
result_backend = db+postgresql://...
```

```bash
# Worker 시작
airflow celery worker --concurrency 16
```

## KubernetesExecutor

Task별 독립 Pod로 최대 격리/스케일링을 제공합니다.

```python
# airflow.cfg
[core]
executor = KubernetesExecutor

[kubernetes]
worker_pods_creation_batch_size = 16  # 한 번에 생성할 Pod 수
delete_worker_pods = True  # 완료 후 Pod 삭제
```

## Executor 선택 기준

| Executor | 적합한 환경 | 장점 | 단점 |
|----------|------------|------|------|
| **Local** | 개발, 소규모 | 간단한 설정 | 스케일 제한 |
| **Celery** | 프로덕션, 분산 | 안정적, 스케일 가능 | 인프라 복잡 |
| **Kubernetes** | K8s 환경 | 최대 격리, 동적 스케일 | Pod 오버헤드 |

# 5. Pool로 리소스 제어

---

## Pool이란?

특정 Task 그룹의 동시 실행 수를 제한하는 메커니즘입니다.

```text
예: DB 연결 Pool
  - DB 동시 연결 10개 제한
  - 50개 Task가 DB 작업 필요
  - Pool 없으면: 50개 동시 연결 시도 → DB 과부하
  - Pool 있으면: 10개씩 순차 실행 → 안정적
```

## Pool 생성

```python
# UI: Admin → Pools
# 또는 CLI
airflow pools set db_pool 10 "Database connection pool"
```

## Task에 Pool 지정

```python
from airflow.decorators import task

@task(pool="db_pool", pool_slots=2)  # 이 Task는 2슬롯 사용
def heavy_db_query():
    ...

@task(pool="db_pool", pool_slots=1)
def light_db_query():
    ...
```

## 실무 Pool 패턴

```text
db_pool (10 slots):
  - DB 작업 Task
  - 커넥션 수 제한

api_pool (5 slots):
  - 외부 API 호출 Task
  - Rate limit 대응

spark_pool (3 slots):
  - Spark Job Task
  - 클러스터 리소스 보호

default_pool (128 slots):
  - Pool 미지정 Task
  - 기본 제공
```

# 6. DAG/Task 레벨 동시성 설정

---

## DAG 레벨

```python
@dag(
    max_active_runs=3,      # 동시 DAG Run 수
    max_active_tasks=10,    # DAG 내 동시 Task 수
    ...
)
def my_dag():
    ...
```

## Task 레벨

```python
@task(
    max_active_tis_per_dag=5,     # 이 Task의 DAG당 동시 실행 수
    max_active_tis_per_dagrun=2,  # 이 Task의 DAG Run당 동시 실행 수
)
def my_task():
    ...
```

## 설정 우선순위

```text
적용 순서 (엄격한 것 우선):
  1. Task의 pool 슬롯 제한
  2. Task의 max_active_tis_per_dag
  3. DAG의 max_active_tasks
  4. DAG의 max_active_runs
  5. 전역 parallelism
```

# 7. Metadata DB 튜닝

---

## 커넥션 풀

```python
# airflow.cfg
[database]
sql_alchemy_pool_size = 5       # 기본 커넥션 수
sql_alchemy_max_overflow = 10   # 추가 허용 커넥션
sql_alchemy_pool_recycle = 1800 # 커넥션 재활용 주기 (초)
```

## 정리 작업

오래된 데이터를 주기적으로 정리합니다.

```bash
# 30일 이전 데이터 정리
airflow db clean --clean-before-timestamp "2024-01-01"

# 또는 자동화
airflow dags trigger airflow_db_cleanup  # 관리용 DAG
```

```python
# airflow.cfg
[scheduler]
max_dagruns_per_loop_to_schedule = 20  # 한 번에 처리할 DAG Run 수 제한
```

# 8. 모니터링 체크리스트

---

```text
□ Scheduler 루프 시간이 안정적인가? (< 5초 권장)
□ DAG 파싱 시간이 적절한가? (< 30초 권장)
□ executor.open_slots > 0 인가?
□ 특정 Pool이 병목인가?
□ DB 커넥션이 고갈되지 않는가?
□ Worker 메모리/CPU 사용률은 적절한가?
□ Task 대기 시간(queued→running)이 길지 않은가?
```

## 문제 상황별 대응

| 증상 | 가능한 원인 | 대응 |
|------|------------|------|
| DAG 반영 느림 | 파싱 시간 길다 | DAG 최적화, .airflowignore |
| Task 대기 시간 김 | Worker 부족 | Worker 증설, parallelism 증가 |
| 특정 Task만 느림 | 리소스 경쟁 | Pool 분리, 리소스 할당 |
| 전반적으로 느림 | DB 병목 | 커넥션 풀, 인덱스, 정리 |
| 간헐적 실패 | 메모리 부족 | Worker 메모리 증설 |

# 9. 정리

---

| 개념 | 설명 |
|------|------|
| **parallelism** | 전체 동시 실행 Task 수 (전역) |
| **dag_concurrency** | DAG당 동시 실행 Task 수 |
| **max_active_runs** | 동시 DAG Run 수 |
| **Pool** | 리소스 그룹별 동시 실행 제한 |
| **Executor** | Task 실행 방식 (Local/Celery/K8s) |

```text
핵심:
  성능 튜닝의 시작은 "어디가 병목인지 파악"하는 것.
  Scheduler → Executor → Worker → DB 순으로 확인.
  Pool로 리소스 경쟁을 제어하고, 메트릭으로 상태를 모니터링.
```

# Reference

---

- [Airflow Scheduler Fine-Tuning](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html)
- [Airflow Executor Configuration](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/executor/index.html)
- [Airflow Pools](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html)
- [Airflow Metrics](https://airflow.apache.org/docs/apache-airflow/stable/logging-monitoring/metrics.html)
