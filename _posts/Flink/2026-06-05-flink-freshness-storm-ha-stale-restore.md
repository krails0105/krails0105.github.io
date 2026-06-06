---
title: "Flink Freshness 알림 storm — HA 없는 last-state가 만든 37일 state 퇴행"
categories:
  - Flink
tags: [Flink, Kubernetes, HighAvailability, Checkpoint, EventTime, Incident]
---

## 개요

분당 680건, 스파이크 시 1,700건. 단일 키가 1,294번 연속 발화. 그런데 실제 파이프라인은 멀쩡했다. 스트리밍 파이프라인 모니터링 시스템에서 발생한 freshness 알림 storm의 진단과 복구, 그리고 재발 방지까지의 기록이다.

이 글은 세 가지가 어떻게 맞물려 storm을 만들었는지를 다룬다. (1) HA 없이 쓰던 `last-state` 업그레이드 모드, (2) event-time과 wall-clock을 섞은 지연 계산 버그, (3) 워터마크 점프 시 타이머가 폭발하는 재등록 버그. 핵심 교훈은 하나다 — **`last-state`는 Kubernetes HA가 전제되어야 안전하다.**

---

## 배경

모니터링 시스템은 Flink 1.20 잡(Kubernetes 위 flink-kubernetes-operator)으로 구성된다. 메시지 스트림에서 `COMPLETE / ERROR / HEARTBEAT` 이벤트를 수신하고, `FreshnessChecker`(`KeyedProcessFunction`)가 각 파이프라인 키별로 event-time 타이머를 등록한다. 마지막 `COMPLETE` 수신 후 `schedule_interval × 2` 이내에 새 `COMPLETE`가 없으면 WARNING → CRITICAL 알림을 발화한다.

```
이벤트 스트림 → FreshnessChecker (KeyedProcessFunction)
                    ├─ processElement: COMPLETE 수신 시 타이머 등록 + state 갱신
                    └─ onTimer:        임계 초과 시 알림 발화 + 다음 타이머 재등록
```

핵심 state는 두 가지다.

- `lastEventTimeState` — 마지막 COMPLETE의 event-time
- `scheduleIntervalState` — 해당 파이프라인의 스케줄 간격(ms)

---

## 증상

Slack 알림 채널이 폭주했다.

| 항목 | 값 |
|---|---|
| 알림 건수(분당 평균) | ~680건 |
| 알림 건수(스파이크) | ~1,700건 |
| 단일 키 최대 `alert_count` | 1,294회 |
| 영향 키 수 | 17개 이상 |
| `delayed_minutes` 표시값 | ~53,266분 (≈ 37일) |
| 잡 상태 | RUNNING / STABLE |
| 이벤트 스트림 수신량 | 정상 (~30 rec / 5min) |
| 실제 파이프라인 COMPLETE | 정상 유입 |

가장 이상한 지점은 **"데이터는 fresh한데 37일 지연 알림이 쏟아진다"**는 모순이었다. 잡도 RUNNING이고 입력 스트림도 멀쩡하다.

---

## 진단

### 1단계 — 입력 스트림과 실제 파이프라인 확인

먼저 알림이 진짜인지 의심했다. 입력 스트림에서 최근 레코드를 직접 peek해 `COMPLETE`가 들어오고 있는지 확인했다.

```bash
# 입력 스트림에서 최근 레코드를 디코드 후 COMPLETE만 필터
<stream-consumer> --limit 100 \
  | jq 'select(.status=="COMPLETE")'
```

모든 키에서 `COMPLETE`가 정상 유입되고 있었다. 프로듀서 문제가 아님을 확정.

### 2단계 — JobManager 재시작 흔적 발견

데이터가 정상이라면 알림을 만드는 잡 쪽을 의심해야 한다. operator와 파드 상태를 확인했다.

```bash
kubectl describe flinkdeployment pipeline-monitor -n <namespace>
kubectl get pod -n <namespace> -l component=jobmanager
```

잡은 RUNNING/STABLE이었지만 **JobManager 파드 업타임이 수십 분**에 불과했다. 직전에 재시작이 있었다. 이벤트 로그에서 `Evicted: Underutilized`가 반복 — 노드 오토스케일러의 consolidation 정책이 JM 파드를 하드 evict하고 있었다.

### 3단계 — 체크포인트 카운터 역주행

JM이 재시작됐다면 어느 체크포인트에서 복원됐는지가 관건이다. 체크포인트 디렉토리(객체 스토리지)를 타임스탬프 순으로 확인했다.

```bash
# 체크포인트 디렉토리를 시간순 정렬 후 최근 항목 확인
<object-store-ls> <checkpoint-dir>/<job-id>/ --recursive \
  | sort -k1,2 | tail -20
```

타임스탬프 순으로 정렬하면 체크포인트 번호가 **역주행**하고 있었다.

```
chk-8595  (정상 운영 최신)
chk-56    (재시작 후 — 퇴행)
chk-52
chk-50
```

`chk-8595`는 스토리지에 멀쩡히 존재했다. 그런데 재시작 후 잡은 `chk-8595`가 아니라 훨씬 오래된 체크포인트에서 시작됐다. **체크포인트 데이터가 아니라 복구에 쓰인 포인터가 잘못됐다**는 뜻이다.

---

## 근본 원인 — 3계층 구조

### 계층 1: 트리거 — 노드 consolidation

노드 오토스케일러의 consolidation(`Underutilized` 정책)이 JM 파드가 올라탄 노드를 "저사용"으로 판단하고 반복 evict했다. flink-kubernetes-operator의 기본 배포 모델은 JM이 단일 파드다. 따라서 JM 파드 evict = JM 유실이며, HA가 없으면 이는 곧 SPOF 이벤트다.

### 계층 2: stale 복원 — HA 없는 last-state (핵심)

```yaml
# flink-deployment.yaml (사고 당시 설정)
spec:
  job:
    upgradeMode: last-state   # ← HA 없이 이 모드를 쓰면 위험
```

공식 문서는 `last-state`를 *"the latest checkpoint or savepoint available"* 에서 복원하는 모드로 정의하고, 곧이어 단서를 붙인다: *"Manual recovery might be needed if HA metadata is lost."* 여기서 "latest checkpoint"를 누가 어떻게 찾느냐가 핵심이다.

HA가 설정되어 있으면 operator는 Kubernetes HA configmap에서 최신 체크포인트 경로를 읽어 복원한다. 이 configmap은 체크포인트가 완료될 때마다 갱신되므로 항상 최신을 가리킨다. 그런데 **HA를 설정하지 않으면** 갱신되는 메타데이터 소스가 없다.

이 경우 operator는 `FlinkDeployment` CR의 `status` 필드에 기록된 마지막 체크포인트 포인터로 폴백한다. 이 포인터는 **마지막으로 성공한 배포(`apply`) 시점**에 박제된 값이다. 본 케이스에서는 약 37일 전 옛 잡의 `chk-46`이었다.

```
스토리지 실제 최신: chk-8595  (멀쩡히 존재)
CR status 포인터:   <old-job-id>/chk-46  (37일 전, 박제값)
                           ↑
                 HA가 없으니 operator는 이 박제값으로 복원
```

### 계층 3: storm 메커니즘 — wall-clock 혼용 + 타이머 재등록 버그

37일 전 state로 복원되면 다음 체인이 발동한다.

**1. 워터마크 리셋 후 점프**

복원 직후 워터마크는 stale state 시점(37일 전)으로 리셋된다. 이후 현재 시각의 이벤트가 유입되면 워터마크가 현재로 단숨에 점프하면서, 그 사이 구간에 박제돼 있던 event-time 타이머가 일제히 발화한다. event-time 타이머는 워터마크가 타이머 시각을 넘어설 때 발화하므로, 37일치 타이머가 한 번의 점프로 모두 만료된다.

**2. wall-clock 혼용 버그**

발화한 타이머가 보고하는 지연값(`delayed_minutes`)이 53,266분(≈37일)으로 찍힌 이유는 지연 계산에 wall-clock을 섞었기 때문이다. 아래는 패턴을 보여주기 위한 발췌다(전체 코드 아님).

```java
// 수정 전 (버그) — onTimer 내부
long now = System.currentTimeMillis();   // wall-clock (물리 시계)
long delayedMs = now - lastEventTime;    // lastEventTime은 37일 전 stale 값
// → delayedMs ≈ 37일 → delayed_minutes ≈ 53,266
```

`onTimer`의 입력은 event-time(논리 시계)인데 지연 계산만 wall-clock으로 했다. 물리 시계는 현재인데 `lastEventTime`은 stale state의 37일 전 값이므로, 두 시계의 간격 전체가 허위 지연으로 보고됐다.

**3. 타이머 재등록 — gap/threshold 회 march**

더 심각한 문제는 다음 타이머 등록 방식이었다.

```java
// 수정 전 (버그) — onTimer 말미, 다음 타이머 재등록
long nextTimerTime = timestamp + threshold;
ctx.timerService().registerEventTimeTimer(nextTimerTime);
// timestamp(= 방금 발화한 타이머의 event-time)가 stale(과거)이고
// threshold가 수분~수십분이면 nextTimerTime이 여전히 현재 워터마크보다 과거.
// 등록되자마자 다시 만료 조건을 충족 → 즉시 재발화.
// 이 루프가 gap/threshold 회 반복되며 stale 구간을 한 칸씩 march한다.
```

`gap = 37일 = 53,280분`, `threshold = 10분`이면 이론상 키당 5,328번 발화가 가능하다. 실측 최대 1,294회는 이 범위 안이다.

---

## 즉시 진화

알림 storm을 가장 빠르게 멈추는 방법은 stale state 자체를 폐기하는 것이다. 37일 된 `lastEventTime`은 운영 가치가 없고, 새 `COMPLETE` 이벤트가 들어오면 state는 자동 재구성된다.

```yaml
# flink-deployment.yaml — 임시 변경
spec:
  job:
    upgradeMode: stateless   # stale state/타이머 전체 폐기
```

```bash
kubectl apply -f infra/flink/flink-deployment.yaml -n <namespace>
```

적용 후 알림이 즉시 0건으로 떨어졌다. 새 체크포인트(`chk-1`) 생성을 확인한 뒤 `last-state`로 복귀했다.

> `stateless`를 운영 기본값으로 두면 다음 정상 업그레이드 시에도 state를 버린다. "이번 한 번만"의 의도라면 정상화 직후 반드시 되돌려야 한다.

---

## 영구 수정

### 코드 — FreshnessChecker 3가지 변경

아래 예제는 모두 변경의 핵심만 보여주는 발췌이며, 실제 함수의 전체 코드가 아니다.

**변경 1: 지연 계산을 event-time으로 통일**

```java
// 수정 전 (버그): wall-clock 혼용
long now = System.currentTimeMillis();
long delayedMs = now - lastEventTime;   // stale 복원 시 53,266분 등 허위값

// 수정 후: event-time끼리만 계산
// timestamp = onTimer가 받는 발화 타이머의 event-time (= 현재 워터마크 수준)
long delayedMinutes = (timestamp - lastEventTime) / 60_000;
```

`onTimer(long timestamp, ...)`의 `timestamp`는 event-time(논리 시계)이다. 여기에 `System.currentTimeMillis()`를 섞지 않고 event-time끼리만 빼면, stale 복원이 일어나도 두 시계의 간격이 허위 지연으로 새지 않는다.

**변경 2: 다음 타이머를 워터마크 기준으로 clamp**

```java
// 수정 전 (버그): stale timestamp 기준으로 재등록 → 즉시 재발화 루프
long nextTimerTime = timestamp + threshold;

// 수정 후: 다음 타이머의 기준점을 현재 워터마크 이상으로 끌어올린다
long base = Math.max(timestamp, ctx.timerService().currentWatermark());
long nextTimerTime = base + threshold;
ctx.timerService().registerEventTimeTimer(nextTimerTime);
```

핵심은 `Math.max(timestamp, currentWatermark())`로 기준점을 워터마크 이상으로 끌어올리는 것이다. 이렇게 하면 워터마크가 점프한 뒤에도 다음 타이머가 반드시 미래(현재 워터마크보다 큰 시각)에 예약되어, 등록 즉시 재발화하는 루프가 끊긴다. 이는 Flink 공식 문서의 timer coalescing 패턴(`currentWatermark() + 1`로 타이머를 워터마크에 정렬해 발화 횟수를 줄이는 기법)과 동일한 원리에 기반한다. 결과적으로 "워터마크 점프 1회 = 키당 발화 1회"로 storm을 1차 차단한다.

**변경 3: MAX_FIRINGS cap (2차 안전망)**

```java
private static final int MAX_FIRINGS = 50;

// onTimer 진입부
if (count > MAX_FIRINGS) {
    log.warn("freshness re-fire cap hit key={} count={}", currentKey, count);
    firingCountState.update(count);
    return;   // 다음 타이머 등록하지 않음 → storm 종료
}
```

clamp가 뚫리는 미지의 엣지 케이스까지 방어하는 2차 안전망이다.

### 인프라 — Kubernetes HA 활성화

```yaml
# infra/flink/flink-deployment.yaml

flinkConfiguration:
  # ── JobManager HA ──
  # last-state는 HA 메타데이터에 의존한다. HA 없이 JM이 evict되면
  # operator가 CR status의 stale 포인터로 폴백 → state 퇴행.
  high-availability.type: kubernetes
  high-availability.storageDir: <object-store>/ha

  # 복원 가드: 사용하려는 마지막 체크포인트가 이 나이를 넘으면
  # (healthy 잡 한정) last-state 대신 새 savepoint를 떠서 업그레이드한다.
  kubernetes.operator.job.upgrade.last-state.max.allowed.checkpoint.age: 10min

podTemplate:
  metadata:
    annotations:
      # 노드 오토스케일러 consolidation이 JM/TM 파드를 evict하지 못하도록 차단.
      # 사용하는 오토스케일러/버전에 맞는 disruption 차단 어노테이션을 적용한다.
      cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

`high-availability.type: kubernetes`를 활성화하면 JM이 재시작될 때 operator가 HA configmap에서 최신 체크포인트 경로를 읽는다. `chk-8595`처럼 스토리지에 멀쩡히 있는 최신 체크포인트를 올바르게 가리키므로, CR status의 박제 포인터로 폴백하지 않는다.

`max.allowed.checkpoint.age: 10min`은 이중 안전망이다. 공식 문서 기준 이 설정은 *복원에 쓰려는 체크포인트가 지정 나이보다 오래된 경우, healthy 잡이라면 last-state 복원 대신 새 savepoint를 떠서 업그레이드*하도록 만든다. 즉 어떤 이유로 stale한 체크포인트가 후보로 잡히더라도, 그것을 그대로 사용하지 않고 현재 상태에서 새 savepoint를 확보해 퇴행을 막는다.

> 주의: `max.allowed.checkpoint.age`는 "stale 복원을 무조건 거부(실패)"시키는 옵션이 아니다. healthy 잡에 한해 savepoint로 우회한다. 잡이 unhealthy하면 이 우회가 불가능할 수 있으므로, 1차 방어선은 어디까지나 HA 자체다.

---

## 배포 절차

HA와 코드 수정을 동시에 적용할 때 안전한 순서는 다음과 같다.

1. `upgradeMode: stateless`로 1회 재시작 → stale state/타이머 완전 폐기, storm 즉시 0건
2. HA configmap + `<object-store>/ha/` 디렉토리 생성 확인
3. `upgradeMode: last-state` 복귀 + HA 설정 + 코드 수정이 반영된 신규 이미지 적용
4. 새 잡이 `chk-1`부터 시작하는지 확인, 알림 0건 유지 확인

---

## 교훈

**1) `last-state`는 HA가 전제다**

operator 단일-JM 모델에서 JM 파드 재시작은 곧 JM 유실(SPOF)이다. HA 없이 `last-state`를 쓰면 JM evict 시마다 stale 포인터로 복원될 수 있다. 둘은 반드시 같이 설정해야 한다.

**2) "체크포인트 데이터(스토리지)"와 "복구 포인터(메타데이터)"는 다른 물건이다**

객체 스토리지에 최신 체크포인트가 멀쩡히 있어도, 복구에 사용하는 포인터가 stale하면 의미가 없다. HA가 있으면 이 포인터는 HA configmap에서 체크포인트마다 갱신되지만, HA가 없으면 CR status의 마지막 배포 시점 값으로 박제된다.

**3) wall-clock과 event-time을 한 함수 안에 섞지 말 것**

`onTimer`의 `timestamp` 파라미터는 event-time(논리 시계)이다. 여기에 `System.currentTimeMillis()`를 섞으면 stale 복원 시 두 시계의 간격 전체가 허위 지연으로 표시된다. 지연 계산은 event-time끼리만 해야 한다.

**4) 체크포인트는 state 값뿐 아니라 타이머 큐도 박제한다**

stale state로 복원 → 워터마크 리셋 → 현재 시각 이벤트 유입 → 워터마크 점프 → 과거에 박제된 타이머 일제 발화. 장기 다운이나 stale 복원이 발생하면 타이머 폭발이 따라온다.

**5) 다음 타이머는 항상 미래에 예약해야 한다 (coalescing 패턴)**

`max(timestamp, currentWatermark) + threshold` 패턴은 기준점을 워터마크 이상으로 끌어올린다는 점에서 Flink 공식 문서의 timer coalescing(`currentWatermark() + 1`)과 동일한 원리에 기반한다. 이 clamp가 없으면 워터마크 jump 한 번에 키당 `gap/threshold`회 march가 발생한다.

---

## Reference

- `FreshnessChecker`(`KeyedProcessFunction`) — 지연 계산/타이머 재등록 로직
- `flink-deployment.yaml` — HA 설정 및 `upgradeMode`
- `FreshnessCheckerTest` — 워터마크 점프/stale 복원 회귀 테스트
- [Flink Kubernetes Operator — Job Management & upgradeMode](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/docs/custom-resource/job-management/)
- [Flink 1.20 — KeyedProcessFunction & Timers](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Flink 1.20 — High Availability](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/overview/)
- [Flink 파이프라인 모니터 NPE 크래시 루프 디버깅 (이전 인시던트)](/flink/flink-pipeline-monitor-npe-crash-loop/)
