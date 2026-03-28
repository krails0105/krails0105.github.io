---
layout: single
title: "RDS Aurora PostgreSQL Failover 장애 대응기: OOM 원인 분석부터 GitOps 핫픽스까지"
categories: [DevOps]
tags: [AWS, RDS, Aurora, PostgreSQL, Failover, ArgoCD, Airflow, Performance Insights, Kubernetes, ConfigMap, OOM, Incident Response]
toc: true
toc_sticky: true
date: 2026-03-28
---

## 개요

---

2026-03-28 17:20 KST (08:20 UTC), Aurora PostgreSQL 클러스터에서 예고 없이 failover가 발생했다. Writer와 Reader 역할이 swap되면서, 커스텀 엔드포인트를 참조하던 Airflow ETL 파이프라인이 DNS resolve 실패로 멈췄다.

단순한 인프라 이슈처럼 보였지만, 근본 원인은 소규모 인스턴스(vCPU 2개)에서 ETL 파이프라인 3개가 동시에 heavy write를 쏟아내면서 DB가 OOM(Out of Memory)으로 강제 종료된 것이었다.

이 포스트에서 다루는 내용은 다음과 같다.

- 장애 발생 순간부터 긴급 복구까지의 시간순 대응 과정
- PostgreSQL 로그와 Performance Insights를 통한 근본 원인 확정
- GitOps 환경(ArgoCD + Kustomize)에서 ConfigMap 핫픽스 시 겪은 함정과 해결법
- 재발 방지를 위한 단기/중기/장기 권장 조치

## 장애 타임라인

---

전체 흐름을 먼저 파악하기 위해 시간순으로 정리한다. 각 이벤트의 상세 분석은 이후 섹션에서 다룬다.

| 시각 (KST) | 시각 (UTC) | 이벤트 |
|---|---|---|
| 16:00~ | 07:00~ | PostgreSQL 로그에 `Connection reset by peer` 다수 발생 (194건) |
| 17:16 | 08:16 | `autovacuum worker took too long to start; canceled` — 리소스 고갈 징후 |
| 17:20 | 08:20 | Writer 프로세스 OOM 종료 → Aurora failover 발동 |
| 17:20 | 08:20 | 커스텀 엔드포인트 멤버 소실 → Airflow DNS resolve 실패 |
| 17:30~ | 08:30~ | Git 커밋으로 ConfigMap 엔드포인트 교체, ArgoCD sync |
| 17:40~ | 08:40~ | `kubectl rollout restart`로 Airflow 컴포넌트 재시작, 복구 완료 |

Ethereum ETL 파이프라인은 수 분 간격으로 반복 실행되는 마이크로 배치 크론잡이다. 평소에는 문제없이 소화되던 부하가 이 날은 특정 시점부터 누적되며 점진적으로 악화됐다.

## 장애 현상 및 긴급 대응

---

### Airflow에서 관측된 에러

Failover 직후, Airflow 태스크 전체에서 아래 에러가 쏟아졌다.

```
sqlalchemy.exc.OperationalError: (psycopg2.OperationalError) could not translate host name
"xxx-prod-metrics.cluster-custom-xxxxxxxxxx.us-west-1.rds.amazonaws.com"
to address: Name or service not known
```

여기서 핵심은 **커스텀 엔드포인트**(`cluster-custom-...`)라는 점이다. Aurora 엔드포인트 유형별 failover 동작을 정리하면 다음과 같다.

| 엔드포인트 유형 | 형식 | Failover 시 동작 |
|---|---|---|
| **클러스터 엔드포인트** | `cluster-...` | 자동으로 새 Writer를 추적. 정상 동작 |
| **클러스터 Reader 엔드포인트** | `cluster-ro-...` | 자동으로 현재 Reader 인스턴스를 추적. 정상 동작 |
| **커스텀 엔드포인트** | `cluster-custom-...` | 사용자가 직접 지정한 멤버 기반. Failover 시 멤버가 비어 DNS가 응답하지 않을 수 있음 |

이번 장애에서는 커스텀 엔드포인트에 등록된 인스턴스의 역할이 바뀌면서 멤버가 비어버렸고, DNS 자체가 응답하지 않는 상태가 됐다.

### ConfigMap 핫픽스: 엔드포인트 교체

Airflow의 DB 엔드포인트는 Kubernetes ConfigMap으로 관리된다. 이 프로젝트는 Kustomize의 `configMapGenerator`로 `.env` 파일에서 ConfigMap을 생성하는 구조다.

```yaml
# applications/airflow/overlays/prod/kustomization.yaml (발췌)
configMapGenerator:
  - name: airflow-cq-configmap
    envs:
      - cq_configmap.env
    options:
      disableNameSuffixHash: true
```

`cq_configmap.env` 파일에서 `T1_2_DB_ENDPOINT_RO` 값을 커스텀 엔드포인트에서 클러스터 Reader 엔드포인트로 변경했다.

```bash
# applications/airflow/overlays/prod/cq_configmap.env (변경 내용)

# Before (커스텀 엔드포인트 — failover 시 멤버 소실 가능)
T1_2_DB_ENDPOINT_RO=xxx-prod-metrics.cluster-custom-xxxxxxxxxx.us-west-1.rds.amazonaws.com

# After (클러스터 Reader 엔드포인트 — Aurora가 자동 추적)
T1_2_DB_ENDPOINT_RO=xxx-prod-rds-cluster.cluster-ro-xxxxxxxxxx.us-west-1.rds.amazonaws.com
```

### ArgoCD + GitOps 환경에서의 함정

긴급한 상황이라 처음에는 ArgoCD UI에서 ConfigMap을 직접 Edit해서 즉시 반영하려 했다. 하지만 **ArgoCD의 auto-sync가 Git 상태를 정답(desired state)으로 인식**하기 때문에, 수동 편집 직후 `OutOfSync`로 감지되어 Git의 원래 값으로 덮어씌워졌다.

> **교훈**: GitOps 환경에서는 긴급 상황이라도 Git 커밋이 올바른 경로다. 대안으로 ArgoCD Application의 auto-sync를 일시적으로 비활성화(`argocd app set <app> --sync-policy none`)한 뒤 수동 변경하는 방법도 있지만, Git history에 변경 기록이 남지 않아 사후 추적이 어려우므로 권장하지 않는다.

ArgoCD sync 과정에서 또 다른 주의점이 있었다. sync 완료까지 생각보다 시간이 걸렸는데, Airflow Helm chart에 `pre-install` hook으로 등록된 `airflow-create-user` Job이 완료될 때까지 ArgoCD가 대기하기 때문이었다. 긴급 대응 시에는 이런 hook의 존재를 인지하고 있어야 대기 시간에 당황하지 않는다.

### ConfigMap 변경 후 Pod에 미반영되는 문제

ArgoCD sync가 완료됐지만 Airflow 태스크 에러가 계속됐다. 원인은 Kubernetes의 기본 동작에 있다.

ConfigMap을 `envFrom`으로 환경변수에 주입하는 방식은, **Pod 기동 시점에 한 번만 읽힌다.** ConfigMap 값이 바뀌어도 이미 실행 중인 Pod의 환경변수에는 반영되지 않는다. 이는 Kubernetes 공식 문서에도 명시된 동작이다. ArgoCD 역시 ConfigMap 변경을 감지해서 Pod를 자동으로 restart하는 기능을 내장하고 있지 않다.

```bash
# Airflow 컴포넌트 전체 rollout restart
kubectl rollout restart deployment \
  airflow-dag-processor \
  airflow-flower \
  airflow-scheduler \
  airflow-triggerer \
  airflow-webserver \
  airflow-worker \
  -n airflow
```

이 명령으로 Pod들이 순차적으로 재생성되면서 새 ConfigMap 값을 읽어 복구가 완료됐다.

**향후 자동화 방안**: Helm의 checksum annotation 패턴을 Deployment template에 적용하면, ConfigMap 내용이 바뀔 때 annotation 값도 변경되어 자동으로 rollout이 트리거된다.

```yaml
# Deployment template annotation 예시
kind: Deployment
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

이 패턴은 Helm 공식 문서의 [Charts Tips and Tricks](https://helm.sh/docs/howto/charts_tips_and_tricks/#automatically-roll-deployments)에서 권장하는 방식이다.

## 근본 원인 분석

---

긴급 복구 이후, failover가 왜 발생했는지 근본 원인을 추적했다. 분석에 사용한 도구는 두 가지다.

1. **PostgreSQL 로그** (RDS 콘솔에서 다운로드) — 장애 전개 순서 파악
2. **RDS Performance Insights** — 쿼리 수준 부하 분석, 결정적 증거 확보

### PostgreSQL 로그: 장애 전개 순서

RDS의 PostgreSQL 로그를 UTC 기준으로 분석하면, 장애가 약 1시간 20분에 걸쳐 점진적으로 악화된 것을 확인할 수 있다.

#### 07:00 UTC — 커넥션 불안정 시작

```
postgresql.log.2026-03-28-0700

[07:xx] FATAL: connection to client lost (Connection reset by peer)  -- 194건 (t1: 69건, t2: 125건)
```

07시부터 이미 DB 연결이 불안정했다. 대량 write로 인해 커넥션이 산발적으로 끊기는 현상이 반복됐다. 이 시점에서 경보가 있었다면 조기 대응이 가능했을 것이다.

#### 08:00~08:20 UTC — autovacuum 실패, OOM, 크래시

```
postgresql.log.2026-03-28-0800

[08:16:23] WARNING: autovacuum worker took too long to start; canceled
[08:17:08] WARNING: Broken pipe
[08:17:08] LOG:    autovacuum worker started in database "..."
[08:20:26] LOG: server process (PID 17657) was terminated by signal 9: Killed
            DETAIL: Failed process was running:
              INSERT INTO metadata."blocktime_blockheight_mapper_bitcoin"
[08:20:26] LOG: terminating any other active server processes
[08:20:26] ERROR: Can't handle storage runtime process crash
[08:20:26] LOG: database system is shut down
```

각 로그 라인의 의미를 분석하면 다음과 같다.

- **`autovacuum worker took too long to start`** — 리소스가 고갈되어 autovacuum 데몬조차 시작하지 못함. PostgreSQL에서 autovacuum은 dead tuple 정리와 통계 갱신을 담당하는데, 이것이 시작조차 못 한다는 것은 심각한 리소스 부족 상태를 뜻한다.
- **`signal 9: Killed`** — OOM Killer에 의해 PostgreSQL 서버 프로세스가 강제 종료됨. Linux 커널이 메모리 부족 시 메모리를 가장 많이 사용하는 프로세스에 SIGKILL을 보내는 메커니즘이다.
- **`Can't handle storage runtime process crash`** — Aurora 스토리지 레이어까지 영향받아 크래시 발생.
- 이후 DB는 즉시 recovery mode로 진입하고, Aurora가 failover를 시작했다.

#### RDS 이벤트 로그 (17:20 KST)

```
17:20 - A new writer was promoted. Restarting database as a reader.
17:20 - rds.logical_replication changed from 1 to 0
17:20 - max_wal_senders changed from 10 to 20
17:21 - DB instance restarted
```

파라미터 값 변경(`rds.logical_replication`, `max_wal_senders`)은 failover의 **원인이 아니다.** 새 writer가 promote될 때 파라미터 그룹이 재적용되면서 발생하는 **부수 효과**다. 처음 보면 이 파라미터 변경이 장애 원인처럼 오해할 수 있으므로 주의가 필요하다.

### Performance Insights: 결정적 증거

PostgreSQL 로그만으로는 "무언가 과부하였다" 수준까지만 파악할 수 있다. 어떤 쿼리가 얼마나 부하를 일으켰는지를 정확히 파악하려면 **RDS Performance Insights(PI)**가 필요하다.

Failover 직전 08:18 UTC 시점의 PI 스냅샷을 확인했다.

**인스턴스 사양 및 부하 요약:**

- 인스턴스 타입: db.r6g.large (vCPU **2**)
- 총 DB 로드 (AAS): **5.42**
- vCPU 대비 부하: **2.7배 초과**

> **AAS(Average Active Sessions)란?** 특정 시점에 DB에서 활성 상태(CPU 사용, I/O 대기 등)인 세션의 평균 수다. AAS가 vCPU 수를 초과하면 DB가 처리 능력 이상의 부하를 받고 있다는 의미다.

**Top SQL by AAS:**

| SQL | AAS | 비중 |
|---|---|---|
| COMMIT | 2.00 | 37% |
| INSERT INTO metadata."blocktime_blockheight_mapper_ethereum" | 1.18 | 22% |
| INSERT INTO "address_balance"."eth_ethereum_transfer_flow_master" | 0.88 | 16% |
| INSERT INTO network_data.eth_ethereum_network_v2_block | 0.76 | 14% |
| SELECT address_balance.contract_eth... | 0.18 | 3% |
| SELECT address_balance.eth_ethereum... | 0.18 | 3% |

가장 눈에 띄는 점은 **COMMIT만으로 AAS 2.0**, 즉 vCPU 2개를 전부 점유하고 있다는 것이다. COMMIT이 쌓인다는 것은 트랜잭션 커밋 처리 속도보다 새로운 트랜잭션 생성 속도가 훨씬 빠른 상태, 즉 **DB가 이미 포화 상태**임을 의미한다.

부하의 원인을 소스별로 묶어보면 다음과 같다.

```
Ethereum ETL 파이프라인별 부하:

blocktime_blockheight_mapper_ethereum  (1.18 AAS)
eth_ethereum_transfer_flow_master      (0.88 AAS)
eth_ethereum_network_v2_block          (0.76 AAS)
──────────────────────────────────────────────────
소계                                    2.82 AAS  →  vCPU 2개를 INSERT만으로 초과
+ COMMIT 대기                           2.00 AAS
──────────────────────────────────────────────────
합계                                    4.82 AAS  →  전체 부하의 89%
```

이 3개 파이프라인은 각각 수 분 간격으로 반복 실행되는 마이크로 배치 크론잡이다. 평소에는 개별적으로 무거운 INSERT이지만 인스턴스가 소화할 수 있는 수준이었다. 그러나 이 날은 배치 실행 타이밍이 겹치면서 3개가 동시에 heavy write를 쏟아냈고, **vCPU 포화 → autovacuum 실패 → OOM → 스토리지 크래시 → failover**로 이어진 것이다.

## 결론 및 권장 조치

---

### 근본 원인 요약

장애의 인과 관계를 정리하면 다음과 같다.

```
Ethereum ETL 마이크로 배치 3개의 실행 타이밍 겹침
    → 대량 INSERT + COMMIT 폭주
    → vCPU 2개 포화 (AAS 5.42 vs vCPU 2)
    → autovacuum 데몬 시작 실패 (리소스 고갈)
    → PostgreSQL 프로세스 OOM (signal 9: Killed)
    → Aurora 스토리지 크래시
    → Failover 발동
    → 커스텀 엔드포인트 멤버 소실 → DNS 오류 → Airflow 전체 다운
```

### 권장 조치

#### 단기: 즉시 적용 가능

**1. Airflow에서 동시 실행 수 제한**

Ethereum ETL 관련 DAG의 동시 실행 수를 제한한다. 두 가지 방법이 있다.

방법 A — DAG 단위 `max_active_tasks` 설정:

```python
# DAG 단위로 동시 실행 태스크 수 제한
dag = DAG(
    dag_id="eth_transfer_flow",
    max_active_tasks=2,  # 이 DAG에서 동시에 실행되는 태스크를 2개로 제한
    ...
)
```

방법 B — Pool을 사용한 크로스-DAG 동시 실행 제어 (권장):

```python
# 여러 DAG의 heavy write 태스크가 동일 Pool을 공유하도록 설정
heavy_insert_task = PythonOperator(
    task_id="insert_ethereum_data",
    python_callable=insert_data,
    pool="ethereum_heavy_write",  # 공유 Pool 지정
    pool_slots=1,                 # 이 태스크가 소비하는 슬롯 수
)
```

Pool은 Airflow UI > Admin > Pools에서 생성하거나 API로 생성할 수 있다. 예를 들어 `ethereum_heavy_write` Pool을 슬롯 2개로 생성하면, 3개 파이프라인이 동시에 실행되더라도 heavy write 태스크는 최대 2개만 동시에 실행된다.

**2. 커스텀 엔드포인트를 클러스터 Reader 엔드포인트로 교체**

가용성이 중요한 모든 연결에서 Aurora 커스텀 엔드포인트(`cluster-custom-`) 대신 클러스터 Reader 엔드포인트(`cluster-ro-`)를 사용하도록 전체 환경 설정을 검토한다.

#### 중기: 1~2주 내

**인스턴스 스케일업**: db.r6g.large(vCPU 2) → db.r6g.xlarge(vCPU 4) 이상으로 업그레이드한다. 이번 장애 시점의 AAS가 5.42였으므로 현재 워크로드를 안정적으로 소화하려면 최소 vCPU 4개가 필요하다. 일시적인 부하 스파이크를 고려하면 vCPU 8(db.r6g.2xlarge) 수준이 더 안전하다.

**AAS 기반 CloudWatch 알람 설정**: Performance Insights의 `DBLoadCPU` 메트릭을 CloudWatch에서 모니터링하고, AAS가 vCPU 수에 근접하면 경보를 발생시키도록 설정한다. 이번처럼 1시간 이상 부하가 누적되는 상황을 조기에 감지할 수 있다.

#### 장기: 파이프라인 개선

대량 INSERT를 chunk 단위로 나누고 batch 사이에 짧은 sleep을 두어 DB에 부하를 분산한다. Heavy write 작업은 피크 타임을 피해 스케줄링하고, 가능하다면 작업 간 시간 간격을 두어 동시 실행을 자연스럽게 분산한다.

### 추가 발견사항: pg_stat_statements 미설치

Performance Insights로 쿼리 수준 분석을 하면서, `pg_stat_statements` 확장이 설치되어 있지 않은 것을 확인했다. 이 확장이 없으면 PI의 Top SQL 기능이 제한적으로 동작한다(쿼리 텍스트가 잘리거나, digest별 통계가 제공되지 않음).

활성화 방법:

1. RDS 파라미터 그룹에서 `shared_preload_libraries`에 `pg_stat_statements`를 추가한다.
2. 인스턴스를 재시작한다 (이 파라미터는 재시작이 필요하다).
3. 대상 데이터베이스에서 확장을 생성한다.

```sql
-- 확장 생성
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 설치 확인
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';
```

파라미터 변경과 재시작은 유지보수 창을 잡고 진행하는 것이 안전하다.

## 핵심 교훈 정리

---

이번 장애에서 배운 핵심 교훈을 다섯 가지로 정리한다.

1. **Aurora 커스텀 엔드포인트는 failover에 취약하다.** Failover 이후 멤버 구성이 틀어지면 DNS 자체가 응답하지 않는다. 가용성이 중요한 연결에는 클러스터 엔드포인트(`cluster-`) 또는 Reader 엔드포인트(`cluster-ro-`)를 사용해야 한다.

2. **GitOps 환경에서는 UI 직접 편집이 auto-sync에 의해 즉시 되돌아간다.** 긴급 상황이라도 Git 커밋이 올바른 경로다. ArgoCD의 auto-sync를 일시 비활성화하는 방법도 있지만, Git history에 기록이 남지 않아 사후 추적이 어렵다.

3. **ConfigMap을 `envFrom`으로 주입하면 Pod 재시작 없이는 반영되지 않는다.** ArgoCD sync만으로는 충분하지 않으며, `kubectl rollout restart`가 필요하다. Helm의 checksum annotation 패턴으로 자동화할 수 있다.

4. **Performance Insights는 장애 원인 확정에 강력하다.** 로그만으로는 "무언가 과부하였다" 수준이지만, PI의 Top SQL과 AAS 데이터는 어떤 쿼리가 얼마나 부하를 일으켰는지 정확히 짚어준다. `pg_stat_statements` 확장을 미리 설치해두면 더욱 상세한 분석이 가능하다.

5. **AAS vs vCPU 비율이 핵심 모니터링 지표다.** AAS가 vCPU를 초과하면 DB는 이미 과부하 상태다. 이번 장애 시 AAS 5.42 vs vCPU 2로 비율이 2.7배였다. 이 지표를 CloudWatch 알람으로 설정해두면 장애 전에 경보를 받을 수 있다.

## Reference

---

- [Amazon Aurora — 커스텀 엔드포인트 관리](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.Endpoints.html)
- [Performance Insights for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.html)
- [Airflow — Pools (동시 실행 제어)](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html)
- [Kubernetes — ConfigMap 환경변수 주입 시 업데이트 동작](https://kubernetes.io/docs/tutorials/configuration/updating-configuration-via-a-configmap/)
- [Helm — ConfigMap checksum annotation 패턴](https://helm.sh/docs/howto/charts_tips_and_tricks/#automatically-roll-deployments)
