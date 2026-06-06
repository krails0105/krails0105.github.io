---
title: "Flink 타이머 심화 — event-time vs processing-time, 워터마크 복원 storm과 liveness 모니터링 설계"
categories:
  - Flink
tags: [Flink, EventTime, ProcessingTime, Watermark, Timer, Checkpoint, HighAvailability]
---

## 들어가며

파이프라인이 정해진 주기에 완료 이벤트를 정상적으로 발행하는지 추적하는 freshness 모니터를 Flink event-time 타이머로 구현했다. 잘 동작하는 것처럼 보였는데, NPE 크래시 루프를 거쳐 stale state에서 재기동하자 `onTimer`가 폭풍처럼 연속 발화하며 체크포인트 타임아웃이 걸렸다.

원인을 파다 보니 "타이머를 어떤 시계로 등록하느냐"가 복원 동작을 완전히 바꾼다는 걸 알게 됐다. 이 글은 그 과정에서 정리한 Flink 타이머·워터마크·복원·HA 개념을 한 곳에 묶은 것이다.

---

## 1. 세 가지 시간과 워터마크

Flink는 시간 개념을 세 가지로 분리한다.

| 종류 | 기준 | 특징 |
|---|---|---|
| **event-time** | 이벤트 자체에 박힌 타임스탬프 | 재처리해도 결과 동일, 지연·순서 역전 처리 필요 |
| **ingestion-time** | 소스 오퍼레이터가 읽어들인 시각 | 소스 입력 시각 기반, 재처리 시 결과 달라짐 |
| **processing-time** | 오퍼레이터가 실제 실행된 wall-clock | 가장 단순, 비결정적 |

**liveness 모니터링은 근본적으로 wall-clock 질문이다.** "파이프라인이 지난 20분 안에 완료 이벤트를 보냈는가"는 현실 시계를 기준으로 판단해야 한다. 이 점을 놓치고 event-time 타이머로 구현한 것이 문제의 씨앗이었다.

### 워터마크란

워터마크는 **"이 시각 이전의 이벤트는 이미 다 도착했다"는 선언**이다. Flink는 이 선언을 기준으로 event-time 타이머를 발화시킨다.

```java
// 최대 1분 지연 허용 워터마크 전략
WatermarkStrategy<PipelineEvent> strategy = WatermarkStrategy
    .<PipelineEvent>forBoundedOutOfOrderness(Duration.ofMinutes(1))
    .withTimestampAssigner((event, ts) -> event.getEventTime());

DataStream<PipelineEvent> withWatermarks =
    stream.assignTimestampsAndWatermarks(strategy);
```

내부 계산식은 다음과 같다.

```
워터마크 = maxEventTime − outOfOrderness − 1 (밀리초)
```

`forBoundedOutOfOrderness`의 내부 구현(`BoundedOutOfOrdernessWatermarks`)이 그동안
관측한 최대 이벤트 타임스탬프에서 허용 지연만큼 뺀 값을 워터마크로 방출한다. 즉
워터마크는 데이터 흐름에 의존하는 **논리 시계**다. 이벤트가 들어와야 전진한다.

### 핵심: 워터마크는 체크포인트에 저장되지 않는다

여기서 복원 storm의 원인이 시작된다. 재시작하면 워터마크는 `Long.MIN_VALUE`로 리셋된다. 첫 이벤트가 들어오는 순간 현재 시각으로 점프한다.

```
재시작 직후: 워터마크 = MIN_VALUE
첫 이벤트 수신 후: 워터마크 ≈ 현재 시각 (예: 2026-06-05 14:00)
```

이 점프가 event-time 타이머에게 어떤 의미인지가 다음 섹션의 주제다.

---

## 2. event-time 타이머 복원 avalanche

체크포인트에는 타이머 자체는 저장된다. 그러나 워터마크는 저장되지 않는다. 재시작 시퀀스를 따라가 보자.

1. 잡이 8일간 크래시 루프 → 체크포인트가 8일 전 시점에 박제됨
2. 패치 배포 후 복원 → 워터마크는 `MIN_VALUE`로 초기화
3. 첫 이벤트 유입 → 워터마크가 "현재 시각(2026-06-05)"으로 점프
4. 복원된 event-time 타이머들은 8일 전 시각에 등록되어 있음
5. 워터마크가 그 시각을 이미 한참 지났으므로 **즉시 발화**

발화가 문제가 아니다. `onTimer` 내부에서 다음 타이머를 재등록하는 패턴이 문제였다.

```java
// event-time 타이머 — 복원 시 march가 발생하는 패턴
@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    Long lastSeen = lastSeenState.value();
    long elapsed = timestamp - lastSeen;

    if (elapsed > THRESHOLD) {
        out.collect(Alert.of(ctx.getCurrentKey(), timestamp));
    }

    // 다음 타이머를 threshold 후로 재등록
    long next = timestamp + THRESHOLD;
    ctx.timerService().registerEventTimeTimer(next);
    nextTimerState.update(next);
}
```

`next = timestamp + THRESHOLD`를 계산하면 여전히 워터마크보다 과거다. 그래서 즉시 발화한다. 그 발화에서 또 `timestamp + THRESHOLD`를 등록한다. 반복이다.

```
복원 체크포인트 시각: 2026-03-29 10:00
현재 워터마크:       2026-06-05 14:00
타이머 간격(THRESHOLD): 20분

발화 횟수 ≈ (37일 × 24h × 60min) / 20min ≈ 2,664회
```

워터마크는 "값을 거쳐 전진하는 논리 시계"이기 때문에, 복원 시 과거~현재 구간 전체를 스윕하며 그 경로의 타이머를 모두 밟는 게 구조적으로 피할 수 없다.

---

## 3. KeyedProcessFunction + state + 타이머 기초

avalanche 패턴을 이해하기 위해 기본 구조를 정리한다.

```java
public class FreshnessChecker
        extends KeyedProcessFunction<String, PipelineEvent, Alert> {

    // State 핸들 — 이름이 복원 매칭 키다. 바꾸면 고아 state 발생
    private ValueState<Long> lastSeenState;
    private ValueState<Long> nextTimerState;

    // Flink 1.19+ 권장 시그니처. open(Configuration)은 deprecated.
    @Override
    public void open(OpenContext openContext) {
        lastSeenState = getRuntimeContext().getState(
            new ValueStateDescriptor<>("lastSeen", Long.class));
        nextTimerState = getRuntimeContext().getState(
            new ValueStateDescriptor<>("nextTimer", Long.class));
    }

    @Override
    public void processElement(PipelineEvent event,
                               Context ctx,
                               Collector<Alert> out) throws Exception {
        lastSeenState.update(event.getEventTime());

        // 기존 타이머 취소(멱등)
        Long prev = nextTimerState.value();
        if (prev != null) ctx.timerService().deleteEventTimeTimer(prev);

        long next = event.getEventTime() + THRESHOLD;
        ctx.timerService().registerEventTimeTimer(next);
        nextTimerState.update(next);
    }
}
```

핵심 포인트:
- **State descriptor 이름 = 복원 매칭 신원**. 클래스명이나 변수명이 아니라 descriptor에 넘긴 문자열로 복원 시 바인딩된다. 이름을 바꾸면 기존 state를 찾지 못해 고아 state가 된다.
- `deleteEventTimeTimer`는 멱등이다. 없는 타이머를 삭제해도 예외가 나지 않는다.
- State는 key 단위로 격리된다. 파이프라인 A의 state는 파이프라인 B에 영향을 주지 않는다.

---

## 4. 체크포인트 vs 세이브포인트

복원 전략을 논하기 전에 두 개념의 차이를 명확히 해둔다.

|  | 체크포인트 | 세이브포인트 |
|---|---|---|
| 소유 | Flink 자동 관리 | 사용자 수동·영구 보존 |
| 목적 | 장애 복구 (빠른 복원) | 계획된 운영 (업그레이드, 마이그레이션) |
| 포맷 | 네이티브/증분 가능 | canonical 포맷 (안정적) |
| 취소 시 | 기본 삭제 (`RETAIN_ON_CANCELLATION`으로 보존 가능) | 영구 유지 |

비유하자면 체크포인트는 데이터베이스의 recovery log, 세이브포인트는 사용자가 직접 만드는 backup에 가깝다.

체크포인트는 기본적으로 잡이 취소되면 정리된다. 취소 후에도 last-state 복원에 쓰려면
externalized retention을 명시해야 한다.

```java
// Flink 1.20 — CheckpointConfig.ExternalizedCheckpointRetention 사용
env.getCheckpointConfig().setExternalizedCheckpointRetention(
    ExternalizedCheckpointRetention.RETAIN_ON_CANCELLATION);
```

`RETAIN_ON_CANCELLATION`은 잡을 명시적으로 취소해도 마지막 체크포인트를 남긴다.
`flink-kubernetes-operator`의 `last-state` 업그레이드가 이 보존된 체크포인트에
의존한다.

### upgradeMode 세 가지

FlinkDeployment를 쿠버네티스에 올릴 때 업그레이드 전략을 지정한다.

```yaml
spec:
  job:
    upgradeMode: savepoint       # 내리기 전 새 세이브포인트 생성 후 복원
    # upgradeMode: last-state    # 최신 체크포인트로 복원 (HA 필수)
    # upgradeMode: stateless     # 빈 state로 재시작
```

- `savepoint`: 가장 안전하지만 잡이 살아있어야 세이브포인트를 만들 수 있다.
- `last-state`: 빠르지만 HA가 없으면 포인터를 잃는다(5절 참조).
- `stateless`: 과거 state가 필요 없을 때.

---

## 5. JobManager HA — 복구 포인터의 정체

JobManager(JM)는 Flink 클러스터의 단일 제어 플레인이다. 여기서 SPOF(Single Point of Failure)가 생긴다.

JM이 보관하는 중요한 정보:
- JobGraph
- 사용자 jar
- **completed checkpoints 포인터** ← 핵심

HA를 구성하지 않으면 `CompletedCheckpointStore`가 JM 메모리에만 존재한다. JM 파드가 죽으면 "가장 최신 체크포인트가 무엇인지" 정보가 사라진다. S3에 체크포인트 데이터 자체는 남아 있어도 어떤 것이 최신인지 알 수 없게 된다.

```
체크포인트 데이터 (S3, 유효·최신)  ←→  복구 포인터 (JM 메모리, 소실)
                                         ↑
                                    이것만 잃어도 stale 복원 발생
```

### K8s HA의 실제 의미

쿠버네티스 환경에서 Flink HA를 설정하면 standby JM이 생기는 게 아니다. 단일 JM이더라도 포인터를 ConfigMap에 외부화한다. JM 파드가 재기동해도 ConfigMap에서 최신 체크포인트 경로를 읽어 fresh 복원이 가능해진다.

```yaml
# Flink 1.20 기준 — high-availability.type 키를 쓴다.
# (구버전의 `high-availability: kubernetes` 단축 표기는 deprecated)
high-availability.type: kubernetes
high-availability.storageDir: s3://my-bucket/flink/ha
kubernetes.cluster-id: pipeline-monitor   # 클러스터 식별자(필수)
```

`high-availability.type: kubernetes`는 내부적으로 `KubernetesHaServicesFactory`를
선택하는 단축 별칭이다. FlinkDeployment의 `flinkConfiguration`에서는 별칭 대신
풀 클래스명을 직접 적기도 한다.

```yaml
# FlinkDeployment.spec.flinkConfiguration (동등한 표현)
high-availability: org.apache.flink.kubernetes.highavailability.KubernetesHaServicesFactory
high-availability.storageDir: s3://my-bucket/flink/ha
```

HA의 핵심은 failover 속도가 아니라 **포인터의 내구성**이다.

### last-state 체크포인트 age 가드

최신 체크포인트가 일정 시간 이상 오래된 경우를 대비한 두 번째 방어선이다. 정확한
설정 키는 다음과 같다(`last-state` 업그레이드 경로에만 적용된다).

```yaml
kubernetes.operator.job.upgrade.last-state.max.allowed.checkpoint.age: 1h
```

이 age를 초과하는 체크포인트밖에 없고 진행 중인 체크포인트도 없으면, 오퍼레이터는
last-state 복원 대신 **잡이 running(healthy) 상태인 동안 새 세이브포인트를 떠서** 그것으로
업그레이드한다. 세이브포인트라서 안전한 게 아니라, "방금 만들었으니 fresh"하기 때문에
안전하다. 단, 잡이 살아있어야만 세이브포인트를 뜰 수 있으므로 HA가 1차 방어선이고 이
설정은 2차 백스톱이다. 크래시 루프처럼 잡이 죽어 있으면 새 세이브포인트를 못 뜨므로 이
가드만으로는 stale 복원을 막지 못한다.

---

## 6. 복원 avalanche 대응 패턴

### 패턴 A: 타이머 coalescing (event-time 유지 시)

발화한 타이머를 현재 워터마크 기준으로 재등록해 "앞으로" 밀어낸다.

```java
// 복원 이후 즉시 재발화 방지 — 워터마크 기준으로 묶음 등록
@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    // ... 알림 로직 ...

    // timestamp + THRESHOLD 대신 현재 워터마크 + 1로 다음 타이머 등록.
    // event-time 타이머는 "현재 워터마크 < 타이머 시각"일 때만 미래에 발화하므로
    // currentWatermark()+1이 발화 가능한 가장 이른 미래 시각이다.
    long next = ctx.timerService().currentWatermark() + 1;
    ctx.timerService().registerEventTimeTimer(next);
    nextTimerState.update(next);
}
```

`currentWatermark() + 1`은 복원 후 과거 구간을 march하지 않고 한 번에 "현재"로 묶어
재등록한다. 이미 같은 시각에 등록된 타이머는 coalescing되어 한 번만 발화하므로 중복
발화도 정리된다.

단, 이 방법은 **복원 직후 첫 발화 자체는 막지 못한다.** 복원 시 이미 과거에 박힌
타이머는 워터마크가 현재로 점프하는 순간 즉시 한 번 발화한다(이후의 연쇄 march만
사라진다). 첫 발화까지 억제하려면 패턴 B 또는 별도 복원 가드가 필요하다.

### 패턴 B: processing-time 타이머로 교체 (liveness용 정석)

```java
// processing-time 타이머 — 복원 avalanche 구조적으로 없음
@Override
public void processElement(PipelineEvent event,
                           Context ctx,
                           Collector<Alert> out) throws Exception {
    lastSeenState.update(event.getEventTime());

    Long prev = nextTimerState.value();
    if (prev != null) ctx.timerService().deleteProcessingTimeTimer(prev);

    // now + threshold는 항상 미래 → 워터마크 점프에 무관
    long next = ctx.timerService().currentProcessingTime() + THRESHOLD;
    ctx.timerService().registerProcessingTimeTimer(next);
    nextTimerState.update(next);
}

@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    // wall-clock 기준 발화 — 데이터 흐름과 무관
    Long lastSeen = lastSeenState.value();
    if (lastSeen == null) return;

    long sinceLastSeen = ctx.timerService().currentProcessingTime() - lastSeen;
    if (sinceLastSeen > THRESHOLD) {
        out.collect(Alert.of(ctx.getCurrentKey(), timestamp));
    }

    // 재등록도 항상 미래 시각
    long next = ctx.timerService().currentProcessingTime() + THRESHOLD;
    ctx.timerService().registerProcessingTimeTimer(next);
    nextTimerState.update(next);
}
```

`now + threshold`는 항상 wall-clock 미래이므로 워터마크 점프와 무관하다. 복원 시 "과거~현재 구간을 스윕"하는 현상 자체가 없다. 키 수만큼 발화가 일어나지만 각 키에서 딱 한 번이다.

### event-time vs processing-time onTimer — 핵심 대비

```java
// event-time: 복원 시 march 발생
// timestamp는 "과거 시각"이 될 수 있음 → next도 여전히 과거 → 즉시 재발화
long next = timestamp + THRESHOLD;                        // [X] march
ctx.timerService().registerEventTimeTimer(next);

// processing-time: 복원 시 1발
// now는 항상 현재 wall-clock → next는 항상 미래 → 정상 발화
long next = ctx.timerService().currentProcessingTime() + THRESHOLD;  // [O] 1발
ctx.timerService().registerProcessingTimeTimer(next);
```

---

## 7. processing-time 타이머의 trade-off

processing-time이 liveness 모니터링에 더 적합하지만 공짜는 아니다. 복원 avalanche를
없애는 대신 새로운 false positive/negative 표면이 생긴다. 시계를 바꾸면 문제가 사라지는
게 아니라 **문제의 모양이 바뀐다**는 점을 분명히 해두자.

### 장점

- **liveness 시맨틱 일치**: "지금 기준으로 얼마나 지났나"를 wall-clock으로 측정
- **복원 avalanche 구조적 부재**: `now + threshold`는 항상 미래
- **idle 소스 감지 가능**: 워터마크가 전진을 멈춰도 wall-clock 타이머는 계속 발화한다. event-time 타이머는 워터마크가 멈추면 발화도 멈추는 역설이 있다.

### 단점과 위험

- **재시작 시 false alert burst**: 복원 직후 모든 키의 타이머가 없어진 상태에서 재등록된다. `lastSeen` state에 오래된 시각이 있으면 즉시 알림이 터진다. 복원 억제 가드가 필요하다.
- **백프레셔 false positive**: 잡이 살아 있어도 처리가 밀리면 processing-time이 전진해 타이머가 발화할 수 있다.
- **백로그 마스킹 false negative**: 처리는 정상처럼 보여도 실제 데이터가 수십 분 지연된 상태일 수 있다.
- **dead-key 누적**: 한 번 등록된 키는 이벤트가 오지 않아도 state와 타이머가 남는다. State TTL이 필요하다.

### 가장 깔끔한 조합

복잡한 모니터링에서는 두 시계를 하이브리드로 쓰는 게 현실적으로 깔끔하다.

```
processing-time 타이머 발화 → "지금 확인 시점"
event-time(lastSeen) 비교   → "데이터가 얼마나 오래됐는가" 판정
```

발화 시각은 wall-clock, 지연 판정은 데이터 타임스탬프. 두 역할을 분리하면 각 시계의 단점을 서로 보완할 수 있다.

---

## 8. 무엇을 측정하는가가 시계를 정한다

이 인시던트가 남긴 가장 중요한 교훈은 기술이 아니라 질문의 정의였다.

**"파이프라인이 정상 주기로 완료 이벤트를 보내고 있는가 (cadence/liveness)"**와 **"파이프라인이 처리하는 데이터가 최신인가 (data freshness)"**는 다른 질문이다.

| 질문 | 시계 | 필요한 것 |
|---|---|---|
| Cadence/Liveness | processing-time | 완료 이벤트 도착 여부 |
| Data Freshness | event-time | 이벤트 내 데이터 타임스탬프 |

완료 이벤트에 `event_time = 완료 시각`만 담으면 cadence는 잴 수 있다. 진짜 data freshness, 즉 "파이프라인이 다루는 원본 데이터가 얼마나 최신인가"는 producer가 원본 데이터의 타임스탬프를 이벤트에 실어야 한다.

집계·재현에는 event-time이 적합하다. 결정론적 결과가 필요하기 때문이다. Timeout·liveness 감지에는 processing-time이 적합하다. 현실 시간에 묶여 있어야 하기 때문이다.

어떤 시계를 쓸지는 구현 전에 "나는 지금 무엇을 측정하고 있는가"를 먼저 답해야 결정할 수 있다.

---

## Reference

- [Flink EventTime Timer 에스컬레이션 패턴](../2026-04-16-flink-eventtime-timer-escalation-pattern/)
- [Flink 파이프라인 모니터 NPE 크래시 루프 디버깅](../2026-04-28-flink-pipeline-monitor-npe-crash-loop/)
- [Flink mailbox internals — 타이머 폭풍과 체크포인트 barrier](../2026-04-28-flink-event-time-timer-mailbox-internals/)
- [Apache Flink — Event Time and Watermarks](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/concepts/time/)
- [Apache Flink — Generating Watermarks](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/event-time/generating_watermarks/)
- [Apache Flink — Timers and State in KeyedProcessFunction](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Apache Flink — Checkpoints (retention, RETAIN_ON_CANCELLATION)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/checkpoints/)
- [Apache Flink — Kubernetes High Availability](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/kubernetes_ha/)
- [Flink Kubernetes Operator — Job Management (upgrade modes, last-state)](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/docs/custom-resource/job-management/)
