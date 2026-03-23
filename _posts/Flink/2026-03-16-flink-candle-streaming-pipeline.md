---
title: "Flink 시계열 집계 스트리밍 파이프라인 — 설계하면서 배운 것들"
date: 2026-03-19
categories: [Flink]
tags: [Flink, Java, GapFill, WatermarkStrategy, SideOutput, StateTTL, MapState]
---

### 들어가며

Flink API를 하나씩 배운 뒤(Ch01~Ch23), 시계열 데이터를 처리하는 파이프라인을 직접 설계하고 구현했다. 단순 집계가 아니라 GapFill, 다중 시간대 집계, Timer 기반 안전망까지 포함한 파이프라인이다.

이 글에서는 구현 과정에서 **기술적으로 의미 있었던 부분**만 정리한다.

---

### 1. MapState 수동 버킷 — Window API를 쓰지 않은 이유

1분 시계열 데이터에서 10분/1시간/1일 집계를 동시에 만들어야 했다. 처음에는 Window API를 3번 적용하는 방법을 생각했지만, 이 방식은 **같은 데이터가 3개의 Window operator에 각각 복제**된다.

대신 `MapState<Long, TSAggAccumulator>`로 수동 버킷을 관리하면 **데이터를 한 번만 처리**하면서 3개 시간대의 집계를 동시에 생성할 수 있다.

```java
private void processCandle(TSAggSilver candle, Context ctx, Collector<TSAggSilver> out)
        throws Exception {
    out.collect(candle);  // 1분 데이터는 메인 출력

    long datetime = candle.getDatetime();
    long tenMinBucket = (datetime / TEN_MINUTES_MS) * TEN_MINUTES_MS;
    long hourBucket   = (datetime / ONE_HOUR_MS) * ONE_HOUR_MS;
    long dayBucket    = (datetime / ONE_DAY_MS) * ONE_DAY_MS;

    // 하나의 시계열 집계을 3개의 Accumulator에 동시 누적
    addToAccumulator(tenMinAccState, tenMinBucket, candle);
    addToAccumulator(hourAccState, hourBucket, candle);
    addToAccumulator(dayAccState, dayBucket, candle);

    // 다음 분이 새 경계의 시작이면 Side Output으로 집계 출력
    long nextMinute = datetime + ONE_MINUTE_MS;
    if (nextMinute % TEN_MINUTES_MS == 0)
        emitAggregation(tenMinAccState, tenMinBucket, "10min", TEN_MIN_TAG, ctx, candle);
    if (nextMinute % ONE_HOUR_MS == 0)
        emitAggregation(hourAccState, hourBucket, "hour", HOUR_TAG, ctx, candle);
    if (nextMinute % ONE_DAY_MS == 0)
        emitAggregation(dayAccState, dayBucket, "day", DAY_TAG, ctx, candle);
}
```

`(datetime / TEN_MINUTES_MS) * TEN_MINUTES_MS`는 정수 나눗셈의 내림 트릭이다. 10:04:37 → 10:00:00으로 버킷 시작점을 계산한다.

시간 경계 판별은 "다음 분이 새 구간의 시작인지" 체크한다. 예를 들어 10:09 시계열 집계의 `nextMinute`는 10:10이고, `10:10 % TEN_MINUTES_MS == 0`이므로 10분 집계를 출력한다.

---

### 2. Event Time Timer — 미완료 윈도우 안전망

위의 수동 버킷 방식에는 잠재적 버그가 있다.

```
10:04  마지막 시계열 집계 도착
  → 다음 데이터까지 gap이 5분 초과
  → GapFill 스킵 (gap > max)
  → 10:09 시계열 집계이 생성되지 않음
  → nextMinute % TEN_MINUTES_MS == 0 조건을 아무도 밟지 않음
  → 10:00~10:04 구간의 10분 집계가 영영 출력되지 않음
  → State TTL 25시간 후 조용히 사라짐
```

"시간 경계를 밟는 시계열 집계이 존재해야 집계가 출력되는 구조"가 문제다. gap이 크면 경계를 밟을 시계열 집계이 없다.

**해결: 시계열 집계 처리 시 다음 시간 경계에 Event Time Timer를 등록한다.**

```java
// processCandle에서 Timer 등록
ctx.timerService().registerEventTimeTimer(
    ((datetime / TEN_MINUTES_MS) + 1) * TEN_MINUTES_MS);
ctx.timerService().registerEventTimeTimer(
    ((datetime / ONE_HOUR_MS) + 1) * ONE_HOUR_MS);
ctx.timerService().registerEventTimeTimer(
    ((datetime / ONE_DAY_MS) + 1) * ONE_DAY_MS);
```

```java
@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<TSAggSilver> out)
        throws Exception {
    TSAggSilver template = lastCandleState.value();
    if (template == null) return;

    // if-else가 아님 — 10:00은 10분 경계이면서 동시에 1시간 경계일 수 있음
    if (timestamp % TEN_MINUTES_MS == 0)
        emitAggregation(tenMinAccState, timestamp - TEN_MINUTES_MS,
            "10min", TEN_MIN_TAG, ctx, template);
    if (timestamp % ONE_HOUR_MS == 0)
        emitAggregation(hourAccState, timestamp - ONE_HOUR_MS,
            "hour", HOUR_TAG, ctx, template);
    if (timestamp % ONE_DAY_MS == 0)
        emitAggregation(dayAccState, timestamp - ONE_DAY_MS,
            "day", DAY_TAG, ctx, template);
}
```

- **정상 케이스**: processCandle에서 이미 집계 출력 → State 비어있음 → onTimer가 발동해도 아무 일 없음
- **비정상 케이스 (gap > max)**: Watermark가 경계를 넘으면 onTimer 발동 → 미완료 Accumulator 강제 출력

Timer는 정상 경로를 방해하지 않는 안전망이다. `registerEventTimeTimer`는 같은 timestamp로 중복 등록해도 한 번만 발동하므로 성능 걱정도 없다.

---

### 3. withIdleness — 멀티 파티션 Watermark 멈춤 방지

```java
WatermarkStrategy.<TSAggSilver>forBoundedOutOfOrderness(Duration.ofMinutes(3))
    .withTimestampAssigner((element, ts) -> element.getDatetime())
    .withIdleness(Duration.ofMinutes(1));
```

Kinesis(또는 Kafka)는 여러 shard(파티션)로 나뉜다. Flink의 전체 Watermark는 **모든 shard 중 가장 느린 것**에 맞춰진다.

특정 shard에 데이터가 한동안 안 오면 그 shard의 Watermark가 멈추고, 다른 shard가 아무리 데이터를 보내도 **전체 Watermark가 진행 안 된다**. 윈도우가 안 닫히고, 집계가 안 나온다.

`withIdleness(1분)` = "1분간 데이터 없는 shard는 Watermark 투표에서 제외". 데이터를 버리는 게 아니라 **Watermark 계산에서만 빼는 것**이다. 나중에 데이터가 오면 즉시 active로 복귀한다.

다중 파티션 소스에서는 거의 필수 설정이다.

---

### 4. Best-Effort JDBC Sink — DB 장애 시 앱을 죽이지 않기

표준 `JdbcSink`는 flush 실패 시 예외를 throw한다. Job이 재시작되고, DB 장애가 지속되면 **무한 재시작 루프**에 빠진다.

커스텀 `RichSinkFunction`으로 Best-Effort 패턴을 구현했다:

```java
@Override
public void snapshotState(FunctionSnapshotContext context) throws Exception {
    if (!batch.isEmpty()) {
        try {
            flush();
        } catch (Exception e) {
            // flush 실패해도 예외 throw 안 함 — 앱 계속 동작
            LOG.error("JDBC flush 실패, 스킵: {}", e.getMessage());
        }
    }
    // flush 성공이든 실패든 State를 비움
    if (checkpointedState != null) {
        checkpointedState.clear();
    }
}
```

왜 데이터를 버려도 되나? **같은 데이터가 Parquet 파일로도 동시에 쓰이고 있기 때문**이다 (Dual Sink). Parquet이 Source of Truth이고, DB는 조회 성능을 위한 보조 저장소다. 나중에 Parquet → DB 백필로 복구할 수 있다.

배치 내에서 같은 PK가 2번 나오면 PostgreSQL의 `ON CONFLICT DO UPDATE`가 에러를 낸다. `LinkedHashMap`으로 flush 전에 중복을 제거하는 것도 필요하다.

---

### 5. State 관련 흔한 실수

구현 과정에서 반복적으로 만난 실수들이다.

| 실수 | 원인 | 올바른 방법 |
|------|------|-------------|
| `static ValueState` 선언 | static은 Task 간 공유됨, State 격리 깨짐 | `transient`로 선언, `open()`에서 초기화 |
| `processedState.update()` 누락 | 상태 기록 안 하면 dedup 무효화 | `processElement`에서 반드시 호출 |
| `processedState != null` 체크 | State 핸들과 State 값을 혼동 | `processedState.value() != null`로 체크 |
| `Duration.ofDays` vs `ofHours` | TTL 단위 실수로 25일 설정됨 | `ofHours(25)` — day 집계 24시간 + 여유 1시간 |
| State 객체 직접 수정 | State에 넣은 객체 mutate하면 체크포인트 일관성 깨짐 | 새 객체 생성 후 `state.update()` |

---

### Reference

- [Apache Flink — State TTL](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/state/#state-time-to-live-ttl)
- [Apache Flink — Process Function](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Apache Flink — Generating Watermarks](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/event-time/generating_watermarks/)
- [Apache Flink — Side Outputs](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/side_output/)
