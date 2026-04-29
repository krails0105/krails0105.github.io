---
title: "Flink 이벤트타임 타이머와 mailbox 모델 — 한 사고로 본 내부 메커니즘"
date: 2026-04-28
categories:
  - Flink
tags: [Flink, Streaming, Watermark, Timer, Checkpoint]
---

## 들어가며

스트리밍 파이프라인 모니터링 잡에서 흥미로운 사고가 있었다. 증상은 단순했다.

1. 잡을 재시작한다.
2. "Delayed 0 min" 알림이 수십 건 쏟아진다.
3. 몇 분 뒤 `CheckpointException: Checkpoint expired before completing.` 으로 잡이 다시 죽는다.
4. 다시 재시작 — 같은 패턴 반복.

처음에는 "재시작 직후 타이머가 즉시 발화하는 게 문제다"라고 진단했고, 이를 막는 catch-up 가드를 도입했다. 그런데 그 가드 자체에 두 가지 치명적인 결함이 있었다. **수학적으로 절대 발동하지 않는 dead code** 였고, **만약 발동하면 무한 루프** 를 만드는 코드였다.

이 글은 그 사고를 단순히 회고하는 글이 아니다. 사고를 분석하다 보면 Flink의 내부 메커니즘이 어떻게 맞물려 동작하는지가 한 화면에 펼쳐진다. 백엔드 엔지니어가 Flink 내부를 처음 깊게 들여다볼 때 참고할 수 있도록, 다음 다섯 가지 구성 요소를 사고 사례에 엮어 정리한다.

- 이벤트타임 타이머의 등록·발화 메커니즘 (`InternalTimerServiceImpl`)
- 워터마크와 wall-clock — 두 시계의 진행 모델
- 단일 스레드 mailbox 모델 (`MailboxProcessor`, `MailboxExecutor`)
- Checkpoint barrier (asynchronous barrier snapshotting)
- 그리고 안티패턴: 두 시계를 섞어버린 catch-up 가드

> 본문 코드는 Flink 1.20 기준이며, 클래스 경로와 설정 기본값은 공식 문서로 검증한 값을 사용했다.

---

## 1. 이벤트타임 타이머 — 등록은 메모지, 발화는 워터마크가 한다

`KeyedProcessFunction` 안에서 타이머를 등록하는 코드는 한 줄이다.

```java
// org.apache.flink.streaming.api.functions.KeyedProcessFunction
ctx.timerService().registerEventTimeTimer(eventTimeMillis + threshold);
```

이 한 줄이 하는 일은 사실상 **`(currentKey, namespace, timestamp)` 튜플을 우선순위 큐에 push** 하는 것이 전부다. 등록된 순간 타이머는 아무것도 하지 않는다. **수동적인 메모지** 일 뿐이다.

발화 조건은 단 하나, **워터마크 W가 해당 timestamp를 통과** 하는 시점이다. 이 처리는 사용자 코드가 아니라 Flink 런타임이 한다. 호출 경로를 단순화하면 다음과 같다.

```
StreamTask.processInput()
  └─ MailboxProcessor.runMailboxLoop()              ← 단일 스레드 메인 루프
      └─ AbstractStreamOperator.processWatermark(W)
          └─ InternalTimeServiceManagerImpl.advanceWatermark(W)
              └─ InternalTimerServiceImpl.advanceWatermark(W)
                  └─ while (eventTimeTimersQueue.peek().timestamp <= W) {
                        timer = eventTimeTimersQueue.poll();
                        triggerTarget.onEventTime(timer);   // → user.onTimer(...)
                    }
```

핵심 포인트는 두 가지다.

- **루프** — 워터마크 한 번에 큐 앞쪽의 모든 적격 타이머가 **연속으로** 발화한다. 워터마크 하나가 4,000개의 `onTimer()` 호출을 트리거하는 것은 흔한 일이다.
- **단일 스레드** — 이 루프는 task의 메인 스레드(mailbox 스레드)에서 돈다. 따라서 `onTimer()` 가 끝날 때까지 다음 mailbox 항목(다른 element, 다음 watermark, **checkpoint barrier**)은 처리되지 않는다.

> 메서드 이름은 Flink 내부 구현에 따라 미세하게 달라질 수 있지만(`tryAdvanceWatermark` 같은 헬퍼 등), 호출 위계와 시맨틱은 위와 동일하다.

### 타이머는 keyed state다

타이머는 단순한 콜백이 아니라 **keyed state의 일부** 다. checkpoint에 포함되어 디스크로 내려가고, 잡 재시작 시 state와 함께 복원된다. 이 점이 사고의 출발점이 된다 — 재시작 직후 워터마크가 한 번 전진하면 복원된 타이머들이 폭발적으로 발화한다.

---

## 2. 두 개의 시계 — 워터마크 vs wall-clock

Flink 잡에는 사실상 두 개의 시계가 공존한다.

| 시계 | 의미 | 코드 | 진행 동력 |
|------|------|------|----------|
| 워터마크 | "이 시점 이전의 이벤트는 모두 봤다고 가정"하는 이벤트 시간 | `ctx.timerService().currentWatermark()` | 입력 이벤트의 timestamp |
| wall-clock | OS 시스템 시계 | `System.currentTimeMillis()` | 실시간 |

워터마크는 이벤트가 흘러야 전진한다. wall-clock은 항상 흐른다. 이 둘의 진행 속도가 다르다는 점이 모든 사고의 근원이다.

### `forBoundedOutOfOrderness`의 정의

이 사고에서는 다음 watermark 전략을 사용했다.

```java
WatermarkStrategy
    .<PipelineEvent>forBoundedOutOfOrderness(Duration.ofMinutes(1))
    .withTimestampAssigner((event, ts) -> event.getEventTimeMillis());
```

`forBoundedOutOfOrderness(b)` 는 다음 공식으로 워터마크를 방출한다.

```
W = max(observed_event_time) - b - 1
```

(`-1` 은 워터마크가 "통과한" 타임스탬프를 명확히 하기 위한 strict-less-than 처리.)

### 운영 invariant: 워터마크는 wall-clock을 앞설 수 없다

이벤트타임은 **이벤트가 발생한 시점** 이고, 이벤트는 미래에서 올 수 없다. 따라서 정상 운영 환경에서는 다음 부등식이 성립한다.

```
event_time ≤ producer_wall_clock ≤ now()
```

여기에 `forBoundedOutOfOrderness(1min)` 를 적용하면:

```
W = max(event_time) - 1min - 1ms
  ≤ now() - 1min
```

즉 **운영 환경에서 워터마크는 항상 wall-clock보다 최소 1분 이상 과거** 다. 이 부등식을 머릿속에 고정해두자. 5절에서 dead code를 증명하는 결정적인 도구로 쓴다.

### Catch-up 시나리오 — 두 시계가 빠르게 벌어질 때

정상 운영 시에는 워터마크가 wall-clock을 약 1분 늦게 따라간다. 그러나 잡을 재시작하면 다르다.

- 체크포인트 시점 이후 누적된 이벤트(예: 8일치)가 한 번에 들어온다.
- wall-clock 수 초 동안 이벤트타임 수십 분~수일이 진행된다.
- 워터마크가 급속히 전진하며 그 사이 등록되어 있던 타이머가 일제히 발화한다.

이 단계에서도 invariant `W ≤ now() - 1min` 는 유지된다. 다만 `now() - W` 의 절대값은 작아질 수 있다 (예: 8일 → 1분 가까이로 좁혀짐).

---

## 3. 단일 스레드 Mailbox 모델

Flink task는 표면적으로는 다중 입력·다중 핸들러처럼 보이지만, 실제로는 **하나의 스레드가 하나의 큐(mailbox)를 처리** 하는 구조다. Flink 1.10 이후 `getCheckpointLock()` 이 deprecated 되고 `MailboxExecutor` 가 정식 동기화 메커니즘이 된 이유다.

```
┌─────────────────────────────── Task Thread ──────────────────────────────┐
│                                                                          │
│   while (running) {                                                      │
│       Mail mail = mailbox.take();   // blocking                          │
│       mail.run();                                                        │
│   }                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ poll
        ┌─────────────────────────┴─────────────────────────┐
        │                    Mailbox Queue                  │
        │  ┌──────────────────────────────────────────────┐ │
        │  │ processElement(e1)                           │ │
        │  ├──────────────────────────────────────────────┤ │
        │  │ processWatermark(W)                          │ │ ← 이 안에서
        │  │   ├─ onTimer(t1)  ─┐                         │ │   타이머 N개가
        │  │   ├─ onTimer(t2)   │ 한 mail 안에서          │ │   직렬 실행
        │  │   └─ onTimer(t3) ──┘ 모두 실행               │ │
        │  ├──────────────────────────────────────────────┤ │
        │  │ CheckpointBarrier(chk-N)                     │ │ ← 대기
        │  ├──────────────────────────────────────────────┤ │
        │  │ processElement(e2)                           │ │
        │  └──────────────────────────────────────────────┘ │
        └───────────────────────────────────────────────────┘
```

큐에 들어가는 것: input element, watermark, checkpoint barrier, async I/O 결과, 사용자가 등록한 mail 등. **모두 같은 스레드가 순차적으로 처리** 한다.

### 장점 — lock-free state 접근

사용자 `processElement`/`onTimer` 안에서는 keyed state를 자유롭게 읽고 쓴다. 동시성 걱정이 없다. 그래서 Flink 코드에 `synchronized` 가 거의 없다.

### 단점 — head-of-line blocking

한 mail이 오래 걸리면 그 뒤의 mail이 모두 막힌다. 워터마크 한 번에 4,000개의 `onTimer()` 가 직렬 실행되면, 그 4,000번이 끝날 때까지 다음 mail은 큐에서 대기한다.

운영 가시성 측면에서 다음 메트릭을 기억해두면 유용하다.

| 메트릭 | 의미 |
|--------|------|
| `mailboxMailsPerSecond` | mailbox에서 초당 처리되는 mail 수 (모든 종류 포함) |
| `mailboxLatencyMs` | mail이 큐에서 대기한 시간 (히스토그램) |
| `mailboxQueueSize` | 현재 큐에 대기 중인 mail 수 |

타이머 storm이 일어나면 `mailboxLatencyMs` 와 `mailboxQueueSize` 가 동시에 치솟는다.

---

## 4. Checkpoint Barrier — mailbox 안의 또 다른 mail

Flink의 체크포인트는 Chandy-Lamport 알고리즘의 변형인 **asynchronous barrier snapshotting** 으로 동작한다. 핵심 아이디어:

1. `CheckpointCoordinator`(JobManager)가 주기적으로 모든 source task에 trigger를 보낸다.
2. Source task는 자신의 출력 스트림에 `CheckpointBarrier(N)` 을 **inline** 으로 삽입한다.
3. 다운스트림 operator가 BARRIER(N)을 받으면 자기 state의 스냅샷을 찍고, BARRIER를 다음 operator로 forward한다.
4. 입력이 둘 이상인 operator는 모든 입력에서 BARRIER(N)이 도착할 때까지 정렬(barrier alignment) 후 스냅샷을 찍는다.
5. 모든 operator가 BARRIER(N)을 처리하면 checkpoint N이 완성된다.

여기서 결정적인 사실 하나.

> **CheckpointBarrier는 별도 채널의 control message가 아니라, 데이터 스트림 안에 in-band로 흐르는 mail이다.**

즉 BARRIER도 mailbox 큐에 들어가서, 자기 차례가 올 때까지 기다린다. 앞에 처리 중인 mail이 무거우면 BARRIER도 같이 늦어진다.

### Checkpoint timeout

`execution.checkpointing.timeout` 의 기본값은 **10분** 이다. JobManager는 trigger를 보낸 후 10분 안에 모든 task가 ack를 보내지 않으면 `CheckpointException: Checkpoint expired before completing` 으로 해당 checkpoint를 폐기한다.

연속 실패 허용량은 `execution.checkpointing.tolerable-failed-checkpoints` 로 조절하며 **기본값은 0** 이다 — 즉 한 번 timeout만 나도 잡이 fail 처리될 수 있다.

```
Mailbox 큐 (사고 상황):
┌─────────────────────────────────────────────────────────┐
│ processWatermark(W)                                     │
│   └─ onTimer × 수천 개 직렬 실행 (수십 분 점령)         │ ← 처리 중
├─────────────────────────────────────────────────────────┤
│ CheckpointBarrier(chk-N)                                │ ← 10분째 대기
└─────────────────────────────────────────────────────────┘

t = trigger + 10min  → JobManager: chk-N expired → 잡 fail → restart
                     → 동일 state로 다시 시작 → 같은 storm 반복
```

---

## 5. 안티패턴: catch-up 가드의 두 가지 실수

### 배경

재시작 직후 타이머 storm이 발생하면, 각 `onTimer()` 가 "Delayed 0 min" 알림을 만든다. wall-clock 기준으로는 방금 이벤트가 들어왔는데(`now - lastEventTime` 이 작음) 워터마크 기준으로는 임계치를 넘은 상황이다. 이 허위 알림을 막기 위해 다음 가드를 추가했다(이후 제거됨, commit `bd76947`).

```java
// FreshnessChecker.onTimer() — bd76947 시점 (현재는 제거됨)
long now = System.currentTimeMillis();
long delayedMs = now - lastEventTime;

if (interval != null && delayedMs < interval) {
    long threshold = interval * DEFAULT_MULTIPLIER;       // = 2 * interval
    long nextTimerTime = now + threshold - delayedMs;     // (★)
    ctx.timerService().registerEventTimeTimer(nextTimerTime);
    return;
}
```

의도는 "wall-clock 기준 충분히 최근에 이벤트가 들어왔다면 알림을 보류하고 잠시 후 다시 검사"였다. 이 가드에는 두 개의 독립적인 결함이 있었다.

### 실수 1 — Dead code: 운영 invariant 위반으로 발동 불가

가드가 발동하려면 다음 두 조건이 **동시에** 참이어야 한다.

**조건 A — 가드 진입 조건:**

```
delayedMs < interval
⟺ now - lastEventTime < interval
⟺ lastEventTime > now - interval                   ... (1)
```

**조건 B — 타이머 발화 전제:**

이 잡은 `processElement` 에서 다음과 같이 타이머를 등록한다.

```java
long nextTimerTime = eventTimeMillis + newThreshold;   // = lastEventTime + 2*interval
ctx.timerService().registerEventTimeTimer(nextTimerTime);
```

따라서 `onTimer` 가 호출되었다는 것은 워터마크 W가 이 timestamp를 통과했다는 뜻이다.

```
W ≥ lastEventTime + 2*interval                    ... (2)
```

**(1)을 (2)에 대입:**

```
W ≥ lastEventTime + 2*interval
   > (now - interval) + 2*interval
   = now + interval
```

즉 가드가 발동하려면:

```
W > now + interval                                ... (3)
```

그런데 2절에서 도출한 운영 invariant는:

```
W ≤ now - 1min                                    ... (4)
```

(3)과 (4)는 동시에 성립할 수 없다 (`interval` 이 양수이고 1분 이상이라면 `now + interval > now > now - 1min` 이므로 (3)을 만족하면 (4)를 위반).

**결론**: 이 가드는 어떤 운영 환경에서도 절대 진입할 수 없는 dead code였다.

> 이런 종류의 dead code가 무서운 이유는 **운영 환경에서는 영원히 검증될 수 없다는 점** 이다. 정상 운영 시에는 if 블록이 한 번도 실행되지 않으므로, 그 안에 어떤 버그가 있어도 드러나지 않는다.

### 실수 2 — 발동되더라도 무한 루프: 항등식으로의 환원

설령 가드가 어떤 경로로든(예: 단위 테스트, 시계가 조작된 환경) 발동했다고 가정해보자. (★) 라인의 `nextTimerTime` 식을 풀어보면:

```
nextTimerTime = now + threshold - delayedMs
              = now + threshold - (now - lastEventTime)
              = lastEventTime + threshold              ← now가 완전히 상쇄
```

`now` 가 식에서 사라진다. 즉 wall-clock과 무관한 상수다. 이 값은 무엇인가?

```
threshold = 2 * interval
lastEventTime + threshold = lastEventTime + 2*interval
                          = 직전에 등록되었던 타이머의 timestamp
```

**직전에 발화한 타이머와 정확히 같은 timestamp를 다시 등록하는 것** 이다.

새로 등록되는 시점에 워터마크는 이미 그 timestamp를 통과한 상태이므로, 새 타이머는 **다음 워터마크 처리 사이클에서 즉시 다시 발화** 한다. 그리고 이 타이머도 같은 가드에 걸려서 또 같은 timestamp를 등록한다.

```
[onTimer 진입]
   ↓
[가드 진입 — delayedMs < interval]
   ↓
[registerEventTimeTimer(lastEventTime + 2*interval)]   ← 직전과 동일
   ↓
[return]
   ↓
[다음 mail = 같은 타이머 발화]
   ↓
[onTimer 진입]
   ↓ ...
```

타이머 등록과 발화는 같은 mailbox 스레드에서 일어나고, 이 사이클에는 양보(yield) 지점이 없다. 한 키가 무한 루프에 들어가는 순간, 그 task의 mailbox는 그 키 처리에 영구히 점령된다. 다른 element도, 워터마크도, 그리고 결정적으로 **CheckpointBarrier도 처리되지 않는다**.

10분이 지나면 `Checkpoint expired before completing` 으로 잡이 fail된다.

루프가 자연스럽게 끝나는 조건은 단 하나, **wall-clock이 충분히 흘러서 `now - lastEventTime ≥ interval` 이 되는 순간** 이다. 즉 `interval` 이 5분이면 5분 동안 그 키의 mailbox를 잡아먹는다. 10분 timeout 안에 끝날 수도 있고 아닐 수도 있는, 운에 맡긴 동작이다.

### 두 실수의 합작

| 관점 | 결함 | 드러나는 환경 |
|------|------|---------------|
| 이론 | Dead code — invariant 위반으로 발동 불가 | 운영 환경에서는 절대 안 보임 |
| 실전 | 발동 가능한 경로(테스트 환경)에서는 무한 루프 | 단위/통합 테스트 |

근본 원인은 한 줄로 요약된다 — **이벤트타임 세계에서 동작하는 `onTimer` 안에서 wall-clock 기반 변수(`now`, `delayedMs`)로 이벤트타임 타이머의 timestamp를 계산했다.** 두 시계의 진행 속도가 다르다는 사실을 코드가 무시했다.

---

## 6. 사고의 전체 흐름을 한 장으로

지금까지의 메커니즘을 합쳐 사고 시퀀스를 그려보자.

```
1. 잡 재시작 (예: NPE crash loop, 배포)
       │
       ▼
2. Checkpoint 복원 — keyed state + 등록된 타이머가 복원됨
       │
       ▼
3. Catch-up 단계:
   wall-clock 수 초 동안 이벤트타임 수일치 진행
       │
       ▼
4. 워터마크 W가 한 번에 크게 전진
   InternalTimerServiceImpl가 큐에서 timestamp ≤ W 인 타이머를 모두 poll
       │
       ▼
5. onTimer × N 직렬 실행 (mailbox 점령)
   ├─ (가드가 정상이면) N번의 알림 emit 후 종료
   └─ (가드가 무한 루프면) 한 키가 영구 점령
       │
       ▼
6. CheckpointBarrier(chk-K)가 mailbox에서 대기
       │
       ▼
7. 10분 경과 → CheckpointException 으로 잡 fail
       │
       ▼
8. Job restart → 2번으로 (state는 동일하므로 같은 storm 반복)
```

이 사이클은 외부 개입 없이는 자연스럽게 빠져나오지 않는다. 운영 측 해결은 별도 글의 주제다 (말미 링크 참고).

---

## 7. 교훈 — 다음에 비슷한 가드를 짤 때

### 1) 두 시계를 절대 섞지 마라

`onTimer` 는 event-time 세계의 콜백이다. 이 안에서 `System.currentTimeMillis()` 를 참조하는 것 자체는 가능하지만, 그 결과를 가지고 **이벤트타임 타이머의 timestamp를 계산** 하면 거의 항상 사고가 난다. catch-up이나 replay 상황에서 두 시계의 격차가 크게 벌어지면서 의도와 반대로 동작한다.

처리시간 기반 동작이 필요하면 `registerProcessingTimeTimer` 를 명시적으로 써라. 이벤트타임 타이머와 처리시간 타이머는 **서로 다른 큐, 서로 다른 발화 트리거** 를 가진다.

### 2) 가드 조건을 부등식으로 풀어보라

새 if 분기를 추가할 때 다음을 확인하는 습관:

- 그 분기 안의 코드가 실제로 발동될 수 있는 조건을 부등식으로 쓴다.
- 알려진 운영 invariant(`W ≤ now - boundedOutOfOrderness` 등)와 함께 풀어본다.
- 두 부등식이 모순되면 dead code다.

이 사고의 catch-up 가드는 종이에 5줄만 적어봤어도 운영에 들어가지 않았을 코드였다.

### 3) 타이머 storm의 최악 케이스를 미리 산정하라

워터마크 한 번에 발화 가능한 타이머 수의 상한을 계산해두자.

- 키 수 K
- 키당 동시에 살아 있는 타이머 수 (대개 1개)
- 한 번의 catch-up에서 통과하는 워터마크 폭

대략 K개의 `onTimer()` 가 직렬로 실행된다. 각 호출이 평균 X ms라면 전체 mailbox 점령 시간은 K·X ms. 이 값이 `execution.checkpointing.timeout` 의 절반을 넘는다면 설계 단계에서 대안을 마련해야 한다 — 알림 배치, 타이머 coalescing(`watermark + 1` 트릭), 비동기 발신 등.

### 4) 단일 스레드 모델을 잊지 마라

Flink가 lock-free 코딩을 가능하게 해주는 대신, 그 비용으로 **mailbox는 직렬** 이라는 제약을 둔다. 사용자 코드 한 줄이 길어지면 그만큼 BARRIER가 밀린다. `onTimer` 를 짧게 유지하는 것은 단순한 성능 이슈가 아니라 **체크포인트 안정성의 문제** 다.

---

## 연관 포스트

- [Flink 파이프라인 모니터링 — NPE crash loop 디버깅 흐름]({% post_url Flink/2026-04-28-flink-pipeline-monitor-npe-crash-loop %})
  같은 사고의 발견 → 원인 추적 → 운영 정상화 과정을 시간 순으로 다룬 글. 이 포스트가 "왜 그렇게 동작하는가"라면, 저 포스트는 "어떻게 살려냈는가"에 가깝다.

## Reference

- [Flink 1.20 — Process Function](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Flink 1.20 — Generating Watermarks](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/event-time/generating_watermarks/)
- [Flink 1.20 — Fault Tolerance via State Snapshots](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/learn-flink/fault_tolerance/)
- [Flink 1.20 — Checkpointing Configuration](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/config/#execution-checkpointing-timeout)
- [Flink 1.20 — Task Mailbox Metrics](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/metrics/)
