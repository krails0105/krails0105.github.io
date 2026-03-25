---
layout: single
title: "Airflow Scheduler 소스코드 분석 -- Task 중복 실행 버그를 추적한 과정"
date: 2026-03-20
categories:
  - Airflow
tags: [Airflow, Scheduler, Race Condition, 소스코드분석, 장애분석]
---

## Introduction

---

DAG 코드에는 아무 문제가 없었다. 그런데 데이터가 중복으로 적재됐다. 범인은 Airflow Scheduler 내부의 타이밍 갭이었다.

이 글은 데이터 파이프라인 프로젝트에서 발생한 Task 중복 실행 장애를 분석하면서, Airflow Scheduler의 소스코드를 직접 따라가 원인을 특정한 과정을 기록한다. PR 번호, 함수명, 상태 전이 흐름 등 소스코드 수준의 추적 내용을 포함하며, 최종적으로 어떤 버전에서 수정됐는지까지 정리한다.

이 글을 통해 다음을 이해할 수 있다.

- Airflow Scheduler의 메인 루프와 Task 상태 전이 흐름
- `clear_not_launched_queued_tasks()` 함수가 중복 실행을 일으키는 메커니즘
- 단일 스케줄러 환경에서도 발생하는 Race Condition의 구조
- 원인 PR(#18152)과 수정 PR(#19904)의 핵심 변경 내용

**사전 지식**: Airflow DAG, Task, Executor의 기본 개념을 알고 있다고 가정한다. KubernetesExecutor 환경에서 발생한 사례이지만, Executor와 DB 상태 업데이트 사이의 타이밍 갭은 다른 Executor에서도 동일하게 존재할 수 있다.

## 1. 장애 상황

---

S3에서 BigQuery로 데이터를 수집하는 Ingestion DAG에서 DW 테이블에 동일 데이터가 중복 적재되는 현상이 발생했다.

BigQuery는 PK(Primary Key) 개념이 없는 컬럼 지향 스토리지다. 일반 RDBMS와 달리 같은 행이 두 번 들어와도 자동으로 감지하거나 차단하지 않는다. 그 결과 중복은 즉시 발견되지 않고, 하류(downstream) 집계 테이블까지 오염된 이후에야 이상이 감지됐다.

```text
[장애 확산 경로]

Ingestion DAG → DW 테이블 (중복 적재)
                    |
                    v
             집계/변환 DAG
                    |
                    v
             하류 DW 테이블 (오염)
```

**첫 번째 가설: DAG 코드의 멱등성 문제**

DAG 코드를 꼼꼼히 검토했지만 문제가 없었다. `WRITE_TRUNCATE` 방식으로 적재하는 구조였고, Task 재시도 시에도 중복이 발생하지 않아야 했다. `WRITE_TRUNCATE`는 기존 테이블 데이터를 덮어쓰기 때문에 같은 Task가 두 번 실행돼도 결과는 동일해야 한다. 그런데 **같은 시간에 두 개의 Task가 동시에 실행되면** 이야기가 달라진다. 두 Pod가 거의 같은 시점에 TRUNCATE + WRITE를 수행하면, 한쪽의 결과가 다른 쪽에 의해 덮어씌워지거나, 타이밍에 따라 두 번 적재될 수 있다.

코드 레벨에서 원인을 찾을 수 없자 시선을 Airflow 내부로 돌렸다.

## 2. Scheduler 내부 흐름 추적

---

Airflow Scheduler의 메인 루프를 소스코드로 따라가며 Task가 어떻게 실행되는지 전체 흐름을 먼저 파악했다.

참고로 Airflow 공식 문서에 따르면, TaskInstance는 다음과 같은 상태를 가진다.

| 상태 | 의미 |
|------|------|
| `none` | 의존성이 충족되지 않아 아직 큐에 들어가지 않은 상태 |
| `scheduled` | 스케줄러가 의존성 충족을 확인하고 실행 대상으로 지정한 상태 |
| `queued` | Executor에 할당되어 워커를 기다리는 상태 |
| `running` | 워커에서 실행 중인 상태 |
| `success` | 에러 없이 실행 완료된 상태 |
| `up_for_retry` | 실행 실패했지만 재시도 횟수가 남아 재스케줄링 대상인 상태 |
| `up_for_reschedule` | Sensor가 reschedule 모드에서 대기 중인 상태 |

### 2.1 Scheduler 메인 루프 (스케줄링 흐름)

Scheduler는 주기적으로 heartbeat를 실행하며, 각 heartbeat에서 다음 흐름을 수행한다.

```text
[Scheduler 메인 루프]

create_dag_runs
  -> _get_dagrun_queued_task_instances
      (대상 상태: none / up_for_retry / up_for_reschedule)
  -> dependency check
  -> _schedule_task_instances -> DB 상태 'scheduled'로 업데이트
  -> slot + task + pool limit check
  -> ti(TaskInstance) 상태 'queued'로 업데이트
  -> Executor.queue_workload()에 전달
  -> Executor.heartbeat() -> sync() -> 실제 워커/Pod 실행
```

### 2.2 Task 실행 흐름 (task_run)

Executor가 Pod(또는 워커)를 실행하면, 해당 프로세스 내부에서 `task_run` 흐름이 시작된다.

```text
[task_run 내부]

task_run
  -> DB에서 ti(TaskInstance) 재조회 (refresh_from_db)
  -> dependency check (non-runnable & non-reschedule)
      -> 조건 불충족: Skip & return
  -> dependency check 통과:
      -> 현재 상태가 'up_for_reschedule'?
          -> Yes: start_date 초기화
          -> No: 계속 진행
  -> dependency check (non-runnable & reschedule)
      -> 충족 시: 상태 None으로 업데이트 + skip
  -> 충족 안 됨: 'running' 이벤트 로깅 -> run_task 실행
  -> 실행 완료: success / failed / up_for_retry 상태로 업데이트
```

정상 흐름을 머릿속에 완전히 그린 뒤에야, 어느 지점이 비정상인지 보이기 시작했다.

## 3. 발견한 문제 -- 상태 전이 타이밍 갭

---

Executor가 Task를 큐에서 꺼내 Pod를 실행하는 시점과, DB에 `running` 상태를 기록하는 시점이 일치하지 않는다. Pod가 이미 떠서 실행 중인데, DB 상태는 아직 `queued`로 남아 있는 순간이 존재한다.

이 타이밍 갭에 `clear_not_launched_queued_tasks()` 함수가 개입한다.

```text
[타이밍 갭 시각화]

시간 흐름 ─────────────────────────────────────────────────────>

Executor 관점:  task 수신 -> Pod 실행 시작 ---------> (나중에) DB 상태 'running' 기록
DB 상태 관점:   queued ──────────────────────────────────────> running
                               ^
                   이 구간에서 clear_not_launched_queued_tasks() 개입
                   "queued 상태인데 Executor가 안 가져갔네?" -> 'scheduled'로 되돌림
                               |
                               v
                   Scheduler 메인 루프 재실행
                   -> 다시 queued -> Executor에 재전달 -> Pod 2개 동시 실행
```

핵심 함수는 `clear_not_launched_queued_tasks()`다.

이 함수의 원래 의도는 명확하다. Executor에 전달됐지만 어떤 이유로 실제 실행되지 않고 큐에서 사라진(launched 되지 않은) Task를 감지해서 다시 스케줄링 대상으로 되돌리는 것이다. 일종의 안전장치다.

문제는 **"아직 DB 업데이트가 안 됐을 뿐, 이미 실행 중인 Task"도 이 함수가 동일하게 처리한다는 점**이다. DB에서 `queued` 상태를 읽고, Executor의 내부 큐에 해당 Task가 없으면, "실행되지 않은 것"으로 판단해 `scheduled`로 되돌린다. 실제로는 Pod가 이미 떠서 데이터를 적재하고 있는 중이더라도.

결과적으로 동일한 TaskInstance에 대해 두 개의 Pod가 동시에 실행되며, 데이터가 중복 적재된다.

## 4. 원인 PR 분석

---

### 4.1 PR #18152 -- 주기적 실행으로 변경

이 PR이 문제의 시작이었다.

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| `clear_not_launched_queued_tasks()` 실행 시점 | 스케줄러 부팅 시 **1회** 실행 | **주기적으로 반복** 실행 |
| 타이밍 갭에 걸릴 확률 | 낮음 (부팅 시점에만) | 높음 (매 주기마다 스캔) |

부팅 시 1회 실행할 때는 "실행 중 Task를 잘못 되돌리는" 타이밍 갭이 열릴 확률이 극히 낮았다. 스케줄러가 부팅되는 시점에는 보통 Executor도 초기화 중이거나 이전 실행의 잔여 Task를 정리하는 단계이기 때문이다.

주기적으로 반복 실행되면서, Pod가 실행 중이지만 DB가 아직 `running`을 기록하지 못한 순간을 **정기적으로 스캔**하게 됐다. 부하가 높은 환경에서 DB 업데이트 지연이 길어질수록 이 타이밍 갭에 걸릴 확률이 올라간다.

### 4.2 GitHub Issue #19038 -- 다중 스케줄러 환경에서의 보고

이 이슈는 다중 스케줄러(HA) 환경에서 동일한 원인으로 Task 중복 실행이 발생한다는 내용으로 보고됐다. 여러 스케줄러 인스턴스 간 상태 동기화 문제로 분석됐다.

직접 분석한 결과, **단일 스케줄러 환경에서도 같은 함수(`clear_not_launched_queued_tasks()`)가 동일한 메커니즘으로 Task를 중복 큐잉할 수 있음**을 확인했다. 다중 스케줄러 없이도 재현 가능한 버그였다.

다중 스케줄러 환경에서 더 빈번하게 발생한 이유는, 스케줄러 A가 큐잉한 Task를 스케줄러 B가 `clear_not_launched_queued_tasks()`로 스캔할 때, B의 Executor에는 해당 Task가 없으므로 "미실행"으로 판단할 확률이 높기 때문이다. 그러나 근본 원인은 동일하다. DB 상태와 실제 실행 상태 사이의 갭이다.

### 4.3 Fix PR #19904 -- Airflow 2.2.3에서 수정

Airflow 2.2.3에서 이 타이밍 갭을 인식하고 함수 동작 방식을 수정했다. `queued` 상태의 Task를 되돌리기 전에 **Executor가 실제로 해당 Task를 처리 중인지 확인하는 로직**이 추가됐다.

수정 전후의 동작 차이를 정리하면 다음과 같다.

```text
[수정 전 - Airflow < 2.2.3]
clear_not_launched_queued_tasks():
  1. DB에서 queued 상태인 TaskInstance 목록 조회
  2. Executor의 내부 큐에 없으면 -> 'scheduled'로 되돌림
  (문제: 이미 실행 중이지만 DB 업데이트가 지연된 Task도 되돌림)

[수정 후 - Airflow >= 2.2.3]
clear_not_launched_queued_tasks():
  1. DB에서 queued 상태인 TaskInstance 목록 조회
  2. Executor.has_task()로 해당 Task가 Executor에서 관리 중인지 확인
  3. Executor가 관리 중이면 -> 건너뜀 (되돌리지 않음)
  4. Executor가 관리하지 않는 경우에만 -> 'scheduled'로 되돌림
```

## 5. 해결

---

근본 원인이 Airflow 버전의 버그임을 확인한 뒤, 아래 두 가지 조치를 병행했다.

**버전 업그레이드**: Airflow 2.2 에서 2.10으로 업그레이드했다. 2.2.3에서 해당 버그가 수정됐으며, 이후 버전에서 Scheduler 안정성과 HA 관련 개선이 추가로 이루어졌다. 특히 2.3 이후에는 Scheduler HA 모드의 안정성이 크게 향상됐다.

**Job Concurrency 조정**: 업그레이드와 함께 동시 실행 Task 수 설정(`max_active_tasks_per_dag`, `max_active_runs_per_dag`)을 검토하고 조정했다. 타이밍 갭이 발생할 수 있는 구간을 최소화하기 위한 보조 조치였다.

이후 동일 유형의 중복 실행 장애는 재발하지 않았다.

## 6. 교훈

---

이 장애에서 배운 것은 세 가지다.

**프레임워크 버그는 DAG 코드만 봐서는 찾을 수 없다.** DAG 코드가 완벽해도 프레임워크 내부에서 잘못된 동작이 발생할 수 있다. 코드 레벨에서 원인이 없다고 결론 내리기 전에, 실행 환경 자체를 의심해야 한다. Airflow 로그에서 동일 TaskInstance에 대해 두 번의 `queued -> running` 전이가 기록되는지, 동일 `run_id`에 대해 두 개의 Pod가 뜬 이력이 있는지 확인하는 것이 첫 단서가 된다.

**정상 흐름을 완전히 이해해야 비정상 지점이 보인다.** Scheduler 메인 루프와 `task_run` 내부 흐름을 소스코드 수준으로 따라가지 않았다면, `clear_not_launched_queued_tasks()`가 개입하는 타이밍을 발견할 수 없었을 것이다. 문제를 찾기 위해 정상 흐름을 먼저 그려야 했다.

**Race Condition은 "동시 접근"만이 아니라 "상태 전이 타이밍 갭"에서도 발생한다.** 일반적으로 Race Condition은 두 프로세스가 동시에 같은 자원에 접근할 때 발생한다고 생각하기 쉽다. 이 케이스는 단일 스케줄러였지만, 상태(state)를 기록하는 시점과 실제 동작 시점 사이의 간격이 문제가 됐다. 상태 기반 시스템에서는 "누가 동시에 접근하는가"보다 **"상태가 언제 전이되는가"**가 더 중요한 관점일 수 있다.

## Reference

---

- [Airflow PR #18152](https://github.com/apache/airflow/pull/18152): `clear_not_launched_queued_tasks()` 주기적 실행으로 변경
- [Airflow GitHub Issue #19038](https://github.com/apache/airflow/issues/19038): 다중 스케줄러 환경에서의 Task 중복 실행 보고
- [Airflow PR #19904](https://github.com/apache/airflow/pull/19904): Task 중복 실행 버그 수정 (Airflow 2.2.3 포함)
- [Airflow 공식 문서 - Task States](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html#task-instances)
- [Airflow 공식 문서 - Scheduler](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html)
