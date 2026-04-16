---
title: "Flink EventTime Timer를 활용한 다단계 알림 패턴 — onTimer 체이닝, severity 에스컬레이션, 체크포인트 원자성"
date: 2026-04-16
categories:
  - Flink
tags: [Flink, Java, KeyedProcessFunction, EventTime, Timer, State, Checkpoint]
---

## 들어가며

스트리밍 파이프라인 모니터링을 구현하다 보면 "장애가 지속되면 알림을 점점 강하게 보내야 한다"는 요구사항을 만나게 된다.

단순히 타이머 하나를 등록하고 WARNING을 한 번 보내는 건 쉽다. 그런데 "5분이 지나도 복구가 없으면 WARNING, 10분이 지나면 또 WARNING, 15분이 지나면 CRITICAL로 올리고..." 같은 다단계 에스컬레이션은 구현 방식 자체가 달라진다.

이 글에서는 Flink `KeyedProcessFunction`의 `onTimer`를 **체이닝** 방식으로 연결해서 주기적 반복 알림을 구현하는 패턴을 정리한다. 여기에 타이머 관리를 위한 `nextTimerState` 패턴, 체크포인트 원자성까지 함께 다룬다.

**이 글에서 다루는 내용:**
- `onTimer` 내부에서 다음 타이머를 재등록하는 체이닝 패턴
- 등록한 타이머를 정확히 삭제하기 위한 `nextTimerState` 설계
- State에 원본 값만 저장하는 설계 원칙
- 체크포인트가 state와 timer의 일관성을 보장하는 원리

---

## 배경: Freshness 체크 구조

파이프라인 각 스테이지는 완료 시점에 `COMPLETE` 이벤트를 Kafka에 발행한다. 모니터링 Flink 잡은 이 이벤트를 소비하면서 "마지막 COMPLETE 이후 일정 시간이 지나도 다음 COMPLETE가 오지 않으면 알림"을 발송한다.

기본 로직은 간단하다.

1. `COMPLETE` 수신 → `eventTime + threshold` 시점에 EventTime 타이머 등록
2. Watermark가 타이머 시각을 넘기면 `onTimer` 발화 → 그 사이 COMPLETE가 없었다는 뜻 → 알림 발송
3. COMPLETE가 오면 → 기존 타이머 삭제 + RESOLVED 발송 + 새 타이머 등록

> **EventTime 타이머란?** Flink의 `TimerService.registerEventTimeTimer(long time)`는 현재 Watermark가 지정 시각을 넘길 때 `onTimer`를 콜백한다. ProcessingTime 타이머와 달리 이벤트 시간 기준으로 동작하므로, 재처리(replay) 시에도 동일한 결과를 보장한다.

threshold는 `schedule_interval_ms × 2`로 계산한다. 파이프라인이 10분 주기라면 마지막 완료 이후 20분 내에 다음 완료가 와야 한다.

문제는 초기 구현에서 타이머가 한 번 발화되면 끝이었다는 것이다. 장기 장애 상황에서 첫 WARNING만 나가고 이후에는 조용해진다.

---

## 다단계 알림 설계

에스컬레이션 규칙을 먼저 정의했다.

| 발화 횟수 | severity | 의미 |
|-----------|----------|------|
| 1회차     | WARNING  | 최초 지연 감지 |
| 2회차     | WARNING  | 지연 지속 |
| 3회차 이상 | CRITICAL | 장기 장애로 판단 |

COMPLETE가 수신되면 `RESOLVED` 발송 후 `firingCount`를 0으로 초기화한다.

---

## onTimer 체이닝 패턴

핵심 아이디어는 `onTimer`에서 알림을 발송하고 나서 **다음 타이머를 즉시 재등록**하는 것이다.

```
[onTimer 발화] → 알림 발송 → registerEventTimeTimer(현재 + threshold)
                                    ↓
                              [다음 onTimer 발화] → 알림 발송 → 또 등록 → ...
                                                                    ↓
                                                          [COMPLETE 수신] → 타이머 삭제 → 사이클 종료
```

```java
// FreshnessChecker.java (패턴 설명용 코드)

@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    // firingCount 증가
    Integer count = firingCountState.value();
    count = (count == null) ? 1 : count + 1;

    // firingCount 기반으로 severity 에스컬레이션
    Severity severity = (count > 2) ? Severity.CRITICAL : Severity.WARNING;

    // 알림 발송
    out.collect(Alert.builder()
        .severity(severity.name())
        .status(Status.FIRING.name())
        // ...
        .build());

    // state 업데이트 후 다음 타이머 등록 (체이닝)
    long threshold = scheduleIntervalState.value() * DEFAULT_MULTIPLIER;
    firingCountState.update(count);
    long nextTimerTime = timestamp + threshold;
    nextTimerState.update(nextTimerTime);
    ctx.timerService().registerEventTimeTimer(nextTimerTime);
}
```

`onTimer`가 끝날 때 `registerEventTimeTimer`를 다시 호출하면, 다음 threshold 주기가 지난 후 `onTimer`가 또 발화된다. 이 사이클이 COMPLETE가 올 때까지 반복된다.

> **참고**: Flink의 EventTime 타이머는 동일 key, 동일 timestamp에 대해 중복 등록되지 않는다. 같은 timestamp로 `registerEventTimeTimer`를 여러 번 호출해도 `onTimer`는 한 번만 발화된다. 여기서는 매번 다른 timestamp(`timestamp + threshold`)로 등록하므로 이 특성이 문제되지 않는다.

---

## nextTimerState 패턴: 타이머 삭제 문제

타이머 체이닝을 구현했다면 COMPLETE 수신 시 **pending 타이머를 정확히 삭제**해야 한다.

Flink의 `TimerService.deleteEventTimeTimer(long time)`는 **정확한 timestamp를 인자로 전달해야** 해당 타이머를 삭제할 수 있다. `onTimer`에서 등록한 타이머의 timestamp를 COMPLETE 처리 시점에 어떻게 알 수 있을까?

해결책은 타이머를 등록할 때마다 그 timestamp를 state에 저장하는 것이다.

```java
// onTimer 마지막, processElement 마지막 둘 다 동일 패턴

long nextTimerTime = timestamp + threshold;
nextTimerState.update(nextTimerTime);                          // state에 저장
ctx.timerService().registerEventTimeTimer(nextTimerTime);     // 타이머 등록
```

COMPLETE가 오면:

```java
// processElement 내 COMPLETE 처리 (패턴 설명용 코드)

Long prevTimerTime = nextTimerState.value();
if (prevTimerTime != null) {
    context.timerService().deleteEventTimeTimer(prevTimerTime); // 정확한 timestamp로 삭제
}
```

`nextTimerState`가 없으면 pending 타이머를 삭제할 방법이 없고, COMPLETE 이후에도 타이머가 발화되어 중복 알림이 발송된다.

> **주의할 점**: 존재하지 않는 timestamp로 `deleteEventTimeTimer`를 호출해도 에러가 발생하지는 않는다. 하지만 실제 pending 타이머를 삭제하지 못하므로 의도하지 않은 `onTimer` 발화가 일어난다. `nextTimerState`로 정확한 timestamp를 추적하는 것이 핵심이다.

---

## State 설계: 원본 저장 vs 파생값 저장

초기 설계에서는 `thresholdState`에 `schedule_interval_ms × 2` 결과를 저장했다. 이벤트마다 `schedule_interval_ms`를 받는데 threshold를 별도로 저장하면 중복이다.

개선 후에는 **원본 값만 state에 저장**하고, threshold는 사용 시점에 계산한다.

```java
// Before
thresholdState.update(interval * DEFAULT_MULTIPLIER); // 파생값 저장

// After
scheduleIntervalState.update(interval);               // 원본만 저장
long threshold = scheduleIntervalState.value() * DEFAULT_MULTIPLIER; // 필요할 때 계산
```

State 설계 원칙: state는 재현 불가능한 원본 정보만 저장한다. 계산으로 얻을 수 있는 파생값은 저장하지 않는다.

최종적으로 `FreshnessChecker`가 관리하는 state는 다음과 같다. 각 state는 `open()` 메서드에서 `ValueStateDescriptor`로 선언하고, `getRuntimeContext().getState()`로 초기화한다.

| State | 타입 | 역할 |
|-------|------|------|
| `domainState` | `ValueState<String>` | 마지막으로 본 도메인 정보 |
| `lastEventTimeState` | `ValueState<Long>` | 마지막 COMPLETE의 eventTime |
| `isFiringState` | `ValueState<Boolean>` | 현재 알림 발화 중인지 여부 |
| `scheduleIntervalState` | `ValueState<Long>` | 파이프라인 주기 (원본) |
| `firingCountState` | `ValueState<Integer>` | 발화 횟수 (에스컬레이션 기준) |
| `nextTimerState` | `ValueState<Long>` | 다음 타이머 timestamp (삭제용) |

모든 state가 `ValueState`인 이유는 key당 하나의 값만 저장하면 충분하기 때문이다. 리스트나 맵 형태의 복합 state가 필요 없는 설계가 가장 단순하고 관리하기 쉽다.

---

## 체크포인트와 원자성

타이머 체이닝 구현 중 자연스럽게 드는 의문이 있다.

> `nextTimerState.update(nextTimerTime)`와 `registerEventTimeTimer(nextTimerTime)` 사이에 프로세스가 죽으면 어떻게 되나? state에는 timestamp가 저장됐는데 타이머는 등록이 안 된 상태 아닌가?

Flink 체크포인트가 이 문제를 해결한다.

Flink 공식 문서에 따르면:

> "Timers are fault tolerant and checkpointed along with the state of the application. In case of a failure recovery or when starting an application from a savepoint, the timers are restored."
> -- [Flink Process Function 문서](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/operators/process_function/)

즉, Flink는 체크포인트 시점에 **모든 operator의 state와 timer를 하나의 스냅샷으로 함께 저장**한다. 단일 `processElement` 실행이 원자적인 게 아니라, **체크포인트 간격 단위로 원자적**이다.

- 프로세스가 죽으면 마지막 성공한 체크포인트로 복구된다.
- 복구 시 state와 timer가 해당 체크포인트 시점으로 **함께 롤백**된다.
- 따라서 "state는 업데이트됐는데 타이머는 없는" 불일치 상태가 생기지 않는다.

체크포인트 사이에 발생한 변경사항은 복구 후 Kafka offset 기반으로 재처리된다. 이것이 Flink의 exactly-once 보장이 작동하는 방식이다.

> **성능 참고**: 타이머도 체크포인트 state의 일부이므로, 대량의 타이머가 등록되어 있으면 체크포인트 시간이 늘어날 수 있다. 특히 RocksDB backend + incremental snapshot + heap timer 조합에서는 타이머가 비동기 스냅샷 대상에서 제외되므로 주의가 필요하다.

---

## Alert context 설계

알림에 context 필드를 추가해서 수신자가 상황을 바로 파악할 수 있게 했다.

**FIRING 알림:**
```json
{
  "last_updated_at": "2026-04-09T10:00:00Z",
  "delayed_minutes": "25",
  "alert_count": "3"
}
```

**RESOLVED 알림:**
```json
{
  "resolved_after_minutes": "37",
  "alert_count": "3"
}
```

`alert_count`가 3이면 CRITICAL이 1회 발송된 뒤 복구된 것이다. 운영자가 로그를 뒤지지 않아도 장애 규모를 파악할 수 있다.

---

## 정리

이번에 구현한 패턴의 핵심을 세 줄로 정리하면:

1. **onTimer 체이닝**: `onTimer` 마지막에 다음 타이머를 등록하면 주기적 반복 알림을 만들 수 있다.
2. **nextTimerState**: 등록한 타이머를 나중에 삭제하려면 그 timestamp를 state에 저장해야 한다.
3. **체크포인트 원자성**: state와 timer는 체크포인트 단위로 함께 스냅샷된다. 개별 라인 단위 원자성은 Flink가 보장하지 않는다.

타이머 하나를 제대로 관리하려면 생각보다 많은 설계 고려가 필요하다. 특히 "타이머를 어떻게 삭제할 것인가"는 설계 초반부터 고려해야 한다.

---

## 흔한 실수와 주의점

**1. `nextTimerState` 없이 타이머 체이닝**

타이머를 등록만 하고 timestamp를 state에 저장하지 않으면, COMPLETE 수신 시 pending 타이머를 삭제할 방법이 없다. COMPLETE 이후에도 이전 타이머가 발화되어 잘못된 알림이 발생한다.

**2. `onTimer`에서 state null 체크 누락**

`firingCountState.value()`는 초기값이 `null`이다. `ValueState`는 기본값을 자동으로 설정하지 않으므로 첫 번째 접근에서 반드시 null 체크를 해야 한다.

**3. ProcessingTime과 EventTime 타이머 혼동**

`registerProcessingTimeTimer`는 시스템 시계 기준, `registerEventTimeTimer`는 Watermark 기준이다. Freshness 체크처럼 이벤트 시간 기반 로직에는 EventTime 타이머가 적합하다. ProcessingTime을 사용하면 데이터 재처리(replay) 시 다른 결과가 나올 수 있다.

---

## Reference

- [Flink Process Function (Timer, State)](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/operators/process_function/) -- `KeyedProcessFunction`, `onTimer`, `TimerService` API 공식 문서
- [Flink Checkpointing Overview](https://nightlies.apache.org/flink/flink-docs-master/docs/dev/datastream/fault-tolerance/checkpointing/) -- 체크포인트 설정 및 동작 원리
- [Flink Event-Driven Applications](https://nightlies.apache.org/flink/flink-docs-master/docs/learn-flink/event_driven/) -- EventTime 타이머를 활용한 패턴 예제
