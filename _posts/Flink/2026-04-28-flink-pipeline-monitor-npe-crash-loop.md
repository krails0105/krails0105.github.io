---
title: "Flink 파이프라인 모니터 NPE 크래시 루프 디버깅 — 발견부터 정상화까지"
categories:
  - Flink
tags: [Flink, Kubernetes, Kinesis, Debugging, Production]
---

## 개요

"알림이 안 온다"는 한 줄 제보에서 시작된 디버깅 기록이다. 실시간 파이프라인 모니터링용 Flink Job이 약 7,000회 재시작을 반복하고 있었고, 원인은 `FreshnessChecker.onTimer()` 안에서 발생한 `NullPointerException`이었다. 단순한 NPE 한 건이 다음과 같은 연쇄 장애로 번졌다.

1. NPE → Job 크래시 루프 (~7,000회)
2. 크래시 루프 → 체크포인트 손실 누적 → 8일치 stale state 박제
3. NPE 패치 배포 → stale state에서 타이머 폭풍 → 체크포인트 타임아웃 → 또 다른 크래시 루프

이 글은 증상 발견부터 운영 정상화까지의 전 과정과, 각 단계에서 무엇을 봤고 무엇을 결정했는지를 기록한다. 사고의 내부 메커니즘(워터마크 catch-up, mailbox 점유, checkpoint barrier가 왜 막혔는가) 분석은 [이어지는 포스트](/flink/flink-event-time-timer-mailbox-internals/)에서 다룬다.

---

## 1. 증상 — Job은 살아 있는데 알림은 망가졌다

상태 점검 스크립트를 돌리자마자 이상이 보였다.

```bash
kubectl get flinkdeployment pipeline-monitor -n <monitoring-ns>
# NAME               JOB STATUS   LIFECYCLE STATE
# pipeline-monitor   RESTARTING   CREATED
```

추가로 확인한 메트릭은 다음과 같다.

| 항목 | 값 | 해석 |
|---|---|---|
| JobManager pod 업타임 | 2일 21시간 | 표면적으로는 멀쩡 |
| TaskManager pod 업타임 | 15분 | 최근에 죽었다 살아남 |
| Kinesis 인입 | 분당 ~6건 정상 | 프로듀서 문제 아님 |
| Slack 알림 24h 누적 | 48,618건 (17개 키) | 명백한 폭주 |

Job이 살아 있는 듯 보였지만 알림 품질은 이미 망가진 상태였다. 핵심 신호는 **JobManager 업타임 vs TaskManager 업타임 격차**다. JM은 멀쩡한데 TM만 짧다는 건 잡 레벨 페일오버가 반복되고 있다는 뜻이다.

---

## 2. 근본 원인 추적 — JobManager 로그에서 NPE 발견

### FlinkDeployment 이벤트

```bash
kubectl describe flinkdeployment pipeline-monitor -n <monitoring-ns>
```

이벤트 타임라인에서 `RESTARTING ↔ CREATED`가 95분 안에 3회 반복되었고, 점검 시점 12분 전에도 다시 RESTARTING으로 전환된 흔적이 있었다.

### NPE 스택트레이스

```bash
kubectl logs -n <monitoring-ns> deployment/pipeline-monitor-jobmanager \
  | grep -A 10 "FAILED"
```

```
Freshness Checker (1/1) switched from RUNNING to FAILED
java.lang.NullPointerException: null
    at com.example.monitor.function.FreshnessChecker.onTimer(FreshnessChecker.java:98)
    at ...processWatermark(...)
    at ...tryAdvanceWatermark(...)
```

시도 횟수 `#7991` — 약 7천 번의 재시작이 누적된 상태였다.

부수 예외도 함께 잡혔다.

```
java.lang.UnsupportedOperationException: Partial recovery is not supported
```

Flink는 region failover 전략을 쓰지 않는 한 단일 TaskManager 실패도 **글로벌 페일오버**로 처리한다. 즉 TM 하나가 죽으면 전체 잡이 재시작된다. TM 업타임 15분의 정체가 여기서 드러났다.

---

## 3. 코드 분석 — 왜 NPE가 발생했나

스택트레이스가 가리킨 라인 98은 직전 커밋(`fix: skip false freshness alert on job restart`)이 추가한 catch-up 가드 코드 안에 있었다.

```java
// flink-job/src/main/java/com/tech/monitor/function/FreshnessChecker.java (수정 전)

@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    Long lastEventTime = lastEventTimeState.value();
    Long interval      = scheduleIntervalState.value();

    long now       = System.currentTimeMillis();
    long delayedMs = now - lastEventTime;  // <- line 98: lastEventTime이 null이면 NPE
    // ...
}
```

`lastEventTime`은 `Long`(boxed type)이다. `ValueState<Long>.value()`는 state가 비어 있으면 **`null`을 반환**한다 — Flink 1.20의 공식 동작이다. `null - long` 연산에서 auto-unboxing이 발생하고, 그 순간 NPE가 터진다. `interval`도 동일한 조건에서 null이 될 수 있는데, 가드는 둘 다 없었다.

컨테이너 안 jar의 타임스탬프(`Apr 20 03:53 UTC`)가 문제 커밋 시각과 정확히 일치했다. 패치는 운영에 반영됐지만, **그 패치 자체가 NPE를 만들고 있었다**.

> 좀 더 일반화하면: Flink state에서 boxed 타입(`Long`, `Integer`, `Boolean`)을 읽을 때는 항상 `null` 체크가 필요하다. 체크포인트가 어떤 이유로든 불완전하게 복구되면 키별로 일부 state만 비어 있는 비대칭 상태가 만들어질 수 있다.

---

## 4. NPE 가드 패치

수정은 단순하다. `onTimer` 진입부에서 두 state가 모두 유효한지 확인하고, 하나라도 `null`이면 진단 로그를 남기고 조용히 종료한다.

```java
// flink-job/src/main/java/com/tech/monitor/function/FreshnessChecker.java

@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<Alert> out) throws Exception {
    Long lastEventTime = lastEventTimeState.value();
    Long interval      = scheduleIntervalState.value();

    // dangling timer 가드: state 비대칭이면 알림을 만들 수 없다 → 폐기 + 진단 로그
    if (lastEventTime == null || interval == null) {
        log.warn("dangling timer fired key={} timestamp={} lastEventTime={} interval={}",
                 ctx.getCurrentKey(), timestamp, lastEventTime, interval);
        return;
    }

    long now       = System.currentTimeMillis();
    long delayedMs = now - lastEventTime;
    // ... 기존 알림 생성 로직
}
```

"dangling timer"라는 이름을 붙인 이유는 의미를 명확히 하기 위해서다. 이벤트가 한 번도 들어오지 않았거나 체크포인트의 부분 복구로 **타이머만 살아남고 state는 비어 있는 상태** — 즉 부유하는 타이머다.

### 별개의 버그: catch-up 가드는 dead code였다

같은 직전 커밋이 추가한 catch-up 가드(잡 재시작 시 허위 알림 방지 로직)도 분석했다. 가드 발동 조건을 부등식으로 정리하면 다음과 같다.

```
gate triggers
  ⟺  wall_clock - lastEventTime < interval         (조건 A: 최근 이벤트가 있었다)
  AND watermark   ≥ lastEventTime + 2 * interval   (조건 B: 워터마크는 충분히 진행)
```

조건 A에서 `lastEventTime > wall_clock - interval`이고, 이를 조건 B에 대입하면:

```
watermark ≥ lastEventTime + 2*interval
        > (wall_clock - interval) + 2*interval
        = wall_clock + interval
```

즉 **워터마크가 wall-clock보다 `interval`만큼 미래에 있어야** 가드가 발동한다는 결론이 나온다. 그러나 이 잡의 운영 invariant는 `워터마크 ≤ wall_clock - 1분`이다 — 워터마크는 본질적으로 wall-clock을 앞설 수 없다. **수학적으로 영원히 발동할 수 없는 dead code**였다.

게다가 가드 안쪽의 타이머 재등록 코드는 항등식으로 환원되어 `lastEventTime + threshold`에 동일 타이머를 반복 등록하는 무한 루프 가능성을 만들고 있었다. 결론은 명확했다 — catch-up 가드는 통째로 제거했다.

---

## 5. 단위 테스트로 좀비 타이머 재현

`KeyedOneInputStreamOperatorTestHarness`로 NPE 시나리오를 직접 재현했다. 핵심은 state backend에 직접 접근해서 `lastEventTimeState`만 강제로 비우는 것이다 — 일반 API로는 이런 비대칭 상태를 만들 수 없다.

```java
// flink-job/src/test/java/com/tech/monitor/function/FreshnessCheckerTest.java

@Test
void onTimer_skipsAlertWhenLastEventTimeStateIsNull_danglingTimer() throws Exception {
    try (var harness = newHarness()) {
        // 1) 정상 이벤트 1건 주입 → 타이머 + 두 state가 함께 등록됨
        PipelineEvent event = completeEvent("zombie_dag", "stage1", eventTime);
        harness.processElement(event, event.getEventTimeMillis());

        // 2) lastEventTimeState만 비움 (타이머와 scheduleIntervalState는 그대로)
        @SuppressWarnings({"unchecked", "rawtypes"})
        KeyedStateBackend<String> backend =
            (KeyedStateBackend<String>) (KeyedStateBackend) harness.getOperator().getKeyedStateBackend();
        backend.setCurrentKey("zombie_dag.stage1");
        ValueState<Long> lastEventTimeState = backend.getPartitionedState(
            VoidNamespace.INSTANCE, VoidNamespaceSerializer.INSTANCE,
            new ValueStateDescriptor<>("lastEventTimeState", Long.class)
        );
        lastEventTimeState.clear();

        // 3) 워터마크를 임계 이상으로 진행시켜 타이머 발화
        //    가드가 정상 동작하면 NPE 없이 alert 0건으로 끝나야 함
        assertDoesNotThrow(() ->
            harness.processWatermark(event.getEventTimeMillis() + THRESHOLD_MS + 1)
        );
        assertEquals(0, harness.extractOutputValues().size());
    }
}
```

`@SuppressWarnings({"unchecked", "rawtypes"})` 더블캐스트가 필요한 이유는 Java 제네릭 erasure 때문이다. `getKeyedStateBackend()`의 반환 타입을 raw type으로 한 번 거치지 않으면 컴파일러가 타입 매개변수를 맞추지 못한다.

테스트를 작성하는 과정에서 기존 테스트의 `checkType` 대소문자 불일치(`"freshness"` → `"Freshness"`)도 함께 발견해 수정했다.

---

## 6. 빌드/배포 자동화 스크립트

매 배포마다 `mvn package`, `docker buildx`, ECR push, 메타데이터 확인을 손으로 치는 건 비효율적이었다. `scripts/build-and-push.sh`로 한 커맨드 처리화했다.

```bash
# 기본 태그(v6)로 빌드 & 푸시
./scripts/build-and-push.sh

# 특정 태그 지정
./scripts/build-and-push.sh v7

# 테스트 스킵 (긴급 핫픽스용)
SKIP_TESTS=1 ./scripts/build-and-push.sh
```

스크립트 내부 흐름은 다음과 같다.

```
[Java 17 환경 설정]
        ↓
[mvn package]  → JAR 존재 여부 확인
        ↓
[ECR 로그인]
        ↓
[docker build --platform linux/arm64]
        ↓
[ECR push]  → 푸시된 이미지 메타데이터 확인
```

`--platform linux/arm64`인 이유는 클러스터 노드가 Graviton(arm64)이기 때문이다. 로컬이 x86이라면 buildx 없이 빌드한 이미지는 노드에서 `exec format error`로 실패한다.

---

## 7. v6 배포 후 새 사고 — stale state 알림 폭주

NPE 패치(v6)를 배포하자 Job은 RUNNING/STABLE이 됐다. 그런데 Slack에 곧바로 새 알림이 쏟아지기 시작했다.

```
Delayed 12054 min · 179x alerted
Delayed 11872 min · 142x alerted
...
```

12,054분 ≈ 약 8일 지연. 초당 수십 건 단위로 폭주했다.

**원인은 `chk-216`이라는 체크포인트가 박제한 stale state**였다. 패치 배포 직전, 마지막 정상 체크포인트가 `Apr 20 02:50~52 UTC`(v5 배포 직전 시각)에 만들어진 후 NPE 크래시 루프 동안 새 체크포인트가 한 번도 성공하지 못했다. 모든 키의 `lastEventTime`이 그 시점에 얼어 있었다.

Job이 정상 RUNNING으로 진입하자 워터마크가 `chk-216` 시점부터 현재까지 단숨에 catch-up하면서 **수백 개의 타이머가 일제히 발화**했다 — 8일치 누락된 타이머가 한꺼번에 터진 것이다.

5분 후 두 번째 위기가 왔다.

```
CheckpointException: Checkpoint expired before completing.
```

타이머 폭풍이 TaskManager의 mailbox를 가득 채웠고, checkpoint barrier가 처리될 여유가 없어졌다. 10분 체크포인트 타임아웃 → 잡 fail → 재시작 → 같은 stale state로 또 타이머 폭풍 — 루프가 형성됐다.

> 이 단계에서 "워터마크가 한꺼번에 진행되면 왜 mailbox가 막히는가"는 별도 분석이 필요하다. [Event-time timer & mailbox internals 포스트](/flink/flink-event-time-timer-mailbox-internals/)에서 다룬다.

---

## 8. 최종 해결 — stateless 재시작

옵션을 정리해서 비교했다.

| 옵션 | 설명 | 판단 |
|---|---|---|
| A. **stateless 재시작** | 기존 state 버리고 fresh start | **채택** |
| B. checkpoint timeout 증가 | `execution.checkpointing.timeout` 늘림 | 타이머 폭풍 자체를 해결 못 함 |
| C. 리소스 증설 | TM 추가 / parallelism 증가 | stale state가 근본 원인이라 효과 없음 |
| D. 타이머 스로틀링 코드 추가 | `onTimer`에서 발화 빈도 제한 | 개발 비용 대비 효과 불확실, 본질적 해결 아님 |

A를 선택한 근거는 단순했다. **stale state는 8일 동안 갱신이 없었으므로 운영상 가치가 없다.** 잠시 state를 잃어도 새 COMPLETE 이벤트가 들어오는 순간 각 키의 state가 자동으로 재구성된다. 즉 "잃어서 손해 보는 정보"가 사실상 0이었다.

Flink Kubernetes Operator는 `upgradeMode` 필드로 잡 업그레이드 시 state 처리 방식을 제어한다. 세 가지 옵션이 있다.

- `savepoint` — 업그레이드 전 savepoint를 떠서 거기서 복구
- `last-state` — 가장 최근 체크포인트/세이브포인트로 복구 (운영 기본값)
- `stateless` — 빈 state로 시작

```yaml
# infra/flink/flink-deployment.yaml
spec:
  job:
    upgradeMode: stateless   # 임시 변경: last-state → stateless
```

```bash
kubectl apply -f infra/flink/flink-deployment.yaml -n <monitoring-ns>
```

`chk-216`이 폐기되고 fresh state로 시작됐다. 12:01 UTC 이후 알림 0건으로 정상화.

### 운영 모드로 복귀

`chk-1`이 정상 생성(metadata 29KB)된 것을 확인한 뒤 `upgradeMode`를 `last-state`로 되돌렸다.

```bash
kubectl apply -f infra/flink/flink-deployment.yaml -n <monitoring-ns>
# spec 변경량이 작아 pod 재시작 없이 mode만 전환됨
```

5분 후 `chk-2`도 정상(39KB) 생성 확인. 이후 알림 0건 유지.

> **stateless를 운영 기본값으로 두면 안 되는 이유**: 다음 정상 업그레이드 시에도 state를 버리게 된다. 이번처럼 "이번 한 번만 state를 버린다"는 의도라면 정상화 직후 반드시 `last-state`로 되돌려야 한다.

---

## 9. stale state의 원인 — 사후 분석

프로듀서 측 문제 가능성을 차단하기 위해 Kinesis 스트림을 직접 peek했다.

```bash
# 최근 30분 COMPLETE 이벤트 peek (TRIM_HORIZON 부근)
aws kinesis describe-stream --stream-name <stream-name> \
  --query 'StreamDescription.Shards[].ShardId' --output text

aws kinesis get-shard-iterator \
  --stream-name <stream-name> \
  --shard-id <shard-id> \
  --shard-iterator-type LATEST \
  --query 'ShardIterator' --output text

aws kinesis get-records --shard-iterator <iterator> --limit 100 \
  | jq -r '.Records[].Data' | base64 -d | jq 'select(.status=="COMPLETE")'
```

모든 파이프라인 키에서 COMPLETE 이벤트가 정상 송출 중이었다 — 프로듀서는 무관했다.

**결론**: v5 시대(Apr 20 이후) NPE가 산발적으로 터지면서 체크포인트 성공이 누적되지 못했다. 모든 키의 `lastEventTime`이 `Apr 20 02:50~52 UTC`에 박제된 것이 결정적 단서다. 다만 Kinesis 24h 보존 기간과 로그 rotation으로 `Apr 20~26` 데이터는 이미 사라진 상태여서 100% 확정은 불가능하다 — "거의 확실하지만 증거는 부족" 수준.

---

## 10. 정리

이번 사고는 **단순한 NPE 하나가 연쇄 장애로 번진 사례**다. 단계별 교훈을 정리하면 다음과 같다.

**1) Flink state에서 boxed 타입을 읽을 때는 항상 null 체크**

`Long`, `Integer`, `Boolean` 등 boxed 타입의 `ValueState.value()`는 state가 비어 있을 때 `null`을 반환한다. 체크포인트가 부분적으로만 복구되거나 타이머/state 등록 시점이 어긋나면 키별 state 비대칭이 발생할 수 있다. 진입부에서 가드하지 않으면 unboxing NPE로 직행한다.

**2) 가드 로직은 발동 조건을 부등식으로 검증하라**

직관적으로 "이런 조건에서 동작해야 한다"고 작성한 가드가 실제로는 운영 invariant와 충돌해 영원히 발동하지 않는 dead code가 될 수 있다. 워터마크-월클락 같은 두 시간축이 얽힐 때 특히 그렇다. 부등식 한 줄이면 30초 만에 잡힌다.

**3) 오래된 stale state를 가진 잡을 살릴 때는 state 가치를 먼저 판단하라**

state가 운영상 가치를 잃었다면 `stateless` 재시작이 가장 빠른 복구 경로다. 체크포인트 타임아웃을 늘리거나 리소스를 증설하는 건 증상 완화일 뿐, stale state 자체가 원인일 때는 효과가 없다.

**4) 한 줄 제보를 무시하지 말 것**

"알림이 안 온다"는 모호한 한 줄에서 시작해서 들춰보니 7,000회 크래시 루프가 진행 중이었다. JM 업타임만 보고 안심하면 TM 레벨 페일오버는 놓친다. 두 업타임을 항상 비교하자.

---

## 연관 포스트

이번 사고의 표면적 흐름은 위에서 다뤘지만, "왜 워터마크가 한꺼번에 진행되면 mailbox가 막히는가", "타이머 발화와 checkpoint barrier는 같은 큐에서 어떻게 경쟁하는가" 같은 내부 메커니즘은 별도 정리했다.

- [Flink event-time 타이머와 mailbox 내부 동작 — 타이머 폭풍은 왜 체크포인트를 막는가](/flink/flink-event-time-timer-mailbox-internals/)

---

## Reference

- `flink-job/src/main/java/com/tech/monitor/function/FreshnessChecker.java`
- `flink-job/src/test/java/com/tech/monitor/function/FreshnessCheckerTest.java`
- `scripts/build-and-push.sh`
- [Flink 1.20 — KeyedProcessFunction & Timers](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Flink 1.20 — State Backend & Checkpointing](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/checkpoints/)
- [Flink Kubernetes Operator — Job Management & upgradeMode](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/docs/custom-resource/job-management/)
- [Flink 1.20 — Testing with KeyedOneInputStreamOperatorTestHarness](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/testing/)
