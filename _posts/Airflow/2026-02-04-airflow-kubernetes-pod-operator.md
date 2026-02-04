---
title: "[Airflow] KubernetesPodOperator - K8s에서 Task 실행하기"
categories:
  - Airflow
tags:
  - [Airflow, Kubernetes, KubernetesPodOperator, Container, DevOps]
---

# Introduction

---

Airflow를 KubernetesPodOperator(KPO)로 실행하면 **스케일/격리** 측면에서 장점이 있지만, 운영 포인트가 **"쿠버네티스 디버깅"**으로 이동합니다.

# 1. KubernetesPodOperator란?

---

각 Task를 **독립된 Kubernetes Pod**로 실행하는 Operator입니다.

```
Airflow Scheduler → KubernetesPodOperator → Pod 생성 → 실행 → Pod 삭제
```

## 장점

| 장점 | 설명 |
|------|------|
| 격리 | Task별 독립 환경 (의존성 충돌 없음) |
| 스케일 | K8s 오토스케일링 활용 |
| 리소스 제어 | Pod별 CPU/메모리 설정 |
| 다양한 런타임 | Task별 다른 이미지 사용 가능 |

## 단점

| 단점 | 설명 |
|------|------|
| 오버헤드 | Pod 생성/삭제 시간 |
| 복잡도 | K8s 디버깅 필요 |
| 로그 관리 | Pod 삭제 후 로그 유실 가능 |

# 2. 기본 사용법

---

```python
from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator
from datetime import datetime

with DAG(
    dag_id="kpo_example",
    start_date=datetime(2024, 1, 1),
    schedule_interval="@daily"
) as dag:

    task = KubernetesPodOperator(
        task_id="my_task",
        namespace="airflow",
        image="python:3.9",
        cmds=["python", "-c"],
        arguments=["print('Hello from K8s!')"],
        name="my-pod",
        is_delete_operator_pod=True,
        get_logs=True,
    )
```

# 3. 주요 파라미터

---

## 필수/기본

```python
KubernetesPodOperator(
    task_id="my_task",
    namespace="airflow",           # Pod가 생성될 네임스페이스
    image="myregistry/myimage:v1", # 컨테이너 이미지
    name="my-pod",                 # Pod 이름
)
```

## 리소스 설정

```python
from kubernetes.client import models as k8s

KubernetesPodOperator(
    ...,
    container_resources=k8s.V1ResourceRequirements(
        requests={
            "memory": "512Mi",
            "cpu": "500m"
        },
        limits={
            "memory": "1Gi",
            "cpu": "1000m"
        }
    ),
)
```

## 노드 선택

```python
KubernetesPodOperator(
    ...,
    node_selector={"node-type": "compute"},
    tolerations=[
        k8s.V1Toleration(
            key="dedicated",
            operator="Equal",
            value="airflow",
            effect="NoSchedule"
        )
    ],
    affinity={...},
)
```

## 환경변수/시크릿

```python
KubernetesPodOperator(
    ...,
    env_vars={
        "MY_VAR": "value",
        "EXECUTION_DATE": "{{ ds }}"
    },
    secrets=[
        k8s.V1EnvFromSource(
            secret_ref=k8s.V1SecretEnvSource(name="my-secret")
        )
    ],
)
```

## 볼륨 마운트

```python
volume = k8s.V1Volume(
    name="data-volume",
    persistent_volume_claim=k8s.V1PersistentVolumeClaimVolumeSource(
        claim_name="my-pvc"
    )
)

volume_mount = k8s.V1VolumeMount(
    name="data-volume",
    mount_path="/data"
)

KubernetesPodOperator(
    ...,
    volumes=[volume],
    volume_mounts=[volume_mount],
)
```

# 4. 가장 흔한 문제와 해결

---

## 문제 1: FailedScheduling

**원인:** 리소스 부족 또는 노드 선택 조건 불일치

```bash
kubectl get events -n airflow --sort-by=.lastTimestamp
kubectl describe pod <pod-name> -n airflow
```

**해결:**
- requests/limits 조정
- node_selector/tolerations 확인
- 클러스터 리소스 확인

## 문제 2: ImagePullBackOff

**원인:** 이미지를 가져올 수 없음

```python
KubernetesPodOperator(
    ...,
    image_pull_secrets=[k8s.V1LocalObjectReference(name="my-registry-secret")],
)
```

**해결:**
- 이미지명/태그 확인
- 레지스트리 인증 설정
- 네트워크 접근 확인

## 문제 3: OOMKilled

**원인:** 메모리 초과

```bash
kubectl describe pod <pod-name> -n airflow | grep -i oom
```

**해결:**
```python
container_resources=k8s.V1ResourceRequirements(
    limits={"memory": "2Gi"}  # 증가
)
```

## 문제 4: 로그 유실

**원인:** Pod 삭제 후 로그 접근 불가

**해결:**
```python
KubernetesPodOperator(
    ...,
    get_logs=True,              # Airflow UI에서 로그 확인
    is_delete_operator_pod=False,  # 디버깅 시 Pod 유지
    log_events_on_failure=True,
)
```

**또는 중앙 로그 시스템:**
- Fluentd/Fluent Bit → ElasticSearch
- CloudWatch Container Insights
- Datadog

# 5. 재시도와 멱등성

---

## 재시도 설정

```python
from airflow.models import Variable
from datetime import timedelta

KubernetesPodOperator(
    ...,
    retries=3,
    retry_delay=timedelta(minutes=5),
    execution_timeout=timedelta(hours=1),
)
```

## 멱등성 보장

```python
# 실행 날짜를 환경변수로 전달
KubernetesPodOperator(
    ...,
    env_vars={
        "EXECUTION_DATE": "{{ ds }}",
        "OUTPUT_PATH": "/data/output/{{ ds }}"
    },
)
```

컨테이너 내부에서:
```python
import os

execution_date = os.environ["EXECUTION_DATE"]
output_path = os.environ["OUTPUT_PATH"]

# 파티션 기반 overwrite
df.write.mode("overwrite").save(output_path)
```

# 6. 성능 최적화

---

## Pod 생성 시간 단축

```python
KubernetesPodOperator(
    ...,
    startup_timeout_seconds=300,  # 시작 타임아웃
    get_logs=True,
    do_xcom_push=False,  # XCom 불필요 시 비활성화
)
```

## 이미지 최적화

```dockerfile
# 가벼운 베이스 이미지
FROM python:3.9-slim

# 필요한 것만 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ /app/
```

## 리소스 적정 사이징

```python
# 너무 크면: 스케줄링 지연
# 너무 작으면: OOM 위험

container_resources=k8s.V1ResourceRequirements(
    requests={"cpu": "500m", "memory": "512Mi"},
    limits={"cpu": "1000m", "memory": "1Gi"}
)
```

# 7. 운영 체크리스트

---

```
□ 파드 리소스 request/limit이 적절한가?
□ 로그를 재현 가능하게 저장하는가?
□ 재시도 시 중복이 발생하지 않게 멱등성을 확보했는가?
□ 이미지 레지스트리 인증이 설정되어 있는가?
□ Pod cleanup policy가 적절한가?
□ node selector/tolerations이 필요한가?
□ 타임아웃 설정이 적절한가?
```

# 8. 완전한 예시

---

```python
from airflow import DAG
from airflow.providers.cncf.kubernetes.operators.pod import KubernetesPodOperator
from kubernetes.client import models as k8s
from datetime import datetime, timedelta

default_args = {
    "retries": 3,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="production_kpo",
    default_args=default_args,
    start_date=datetime(2024, 1, 1),
    schedule_interval="@daily",
    catchup=True,
) as dag:

    process_data = KubernetesPodOperator(
        task_id="process_data",
        namespace="airflow",
        image="myregistry/data-processor:v1.2.3",
        image_pull_secrets=[k8s.V1LocalObjectReference(name="registry-secret")],
        name="process-data-{{ ds_nodash }}",
        cmds=["python", "/app/process.py"],
        arguments=["--date", "{{ ds }}"],
        env_vars={
            "EXECUTION_DATE": "{{ ds }}",
            "ENV": "production"
        },
        container_resources=k8s.V1ResourceRequirements(
            requests={"cpu": "500m", "memory": "1Gi"},
            limits={"cpu": "2000m", "memory": "4Gi"}
        ),
        node_selector={"workload": "batch"},
        is_delete_operator_pod=True,
        get_logs=True,
        log_events_on_failure=True,
        execution_timeout=timedelta(hours=2),
        startup_timeout_seconds=600,
    )
```

# Reference

---

- [KubernetesPodOperator](https://airflow.apache.org/docs/apache-airflow-providers-cncf-kubernetes/stable/operators.html)
- [Airflow on Kubernetes](https://airflow.apache.org/docs/helm-chart/stable/index.html)
- [Kubernetes Pod Reference](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
