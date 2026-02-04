---
title: "[Flink] 상태(State)와 Checkpoint 이해하기"
categories:
  - Streaming
tags:
  - [Flink, State, Checkpoint, ExactlyOnce, RocksDB]
---

# Introduction

---

Flink를 이해하는 가장 빠른 길은 **"상태(state)가 어떻게 안전하게 저장되는가"**를 이해하는 것입니다.

- 상태가 없으면(Stateless): 장애 복구가 단순
- 상태가 있으면(Stateful): 정확도/복구/성능이 모두 상태 저장 방식에 달려 있음

# 1. State란?

---

상태는 처리 중 누적되는 데이터입니다:

| 예시 | 설명 |
|------|------|
| 윈도우 집계 | 5분간 이벤트 합계 |
| 세션 상태 | 사용자 세션 정보 |
| 키별 카운터 | 사용자별 클릭 수 |
| Join 버퍼 | 조인을 위한 대기 데이터 |

## Stateless vs Stateful

```
Stateless: event → filter → output
           (각 이벤트 독립 처리)

Stateful:  events → aggregate → output
           (이전 값을 기억해야 함)
```

# 2. Flink State 종류

---

## Keyed State

키별로 분리된 상태 (가장 흔함)

```java
// Java 예시
public class CountFunction extends KeyedProcessFunction<String, Event, Result> {
    private ValueState<Long> countState;

    @Override
    public void open(Configuration parameters) {
        ValueStateDescriptor<Long> descriptor =
            new ValueStateDescriptor<>("count", Long.class);
        countState = getRuntimeContext().getState(descriptor);
    }

    @Override
    public void processElement(Event event, Context ctx, Collector<Result> out) {
        Long current = countState.value();
        if (current == null) current = 0L;
        countState.update(current + 1);
        out.collect(new Result(event.key, current + 1));
    }
}
```

## State 타입

| 타입 | 설명 | 용도 |
|------|------|------|
| ValueState | 단일 값 | 카운터, 플래그 |
| ListState | 리스트 | 이벤트 버퍼 |
| MapState | 맵 | 키-값 저장 |
| ReducingState | 누적 집계 | 합계, 평균 |
| AggregatingState | 사용자 정의 집계 | 복잡한 집계 |

## Operator State

연산자 전체에서 공유하는 상태 (소스/싱크에서 주로 사용)

```java
// Kafka 소스의 오프셋 저장 등
public class MySource implements SourceFunction<String>,
                                  CheckpointedFunction {
    private ListState<Long> offsetState;
    private Long currentOffset;

    @Override
    public void snapshotState(FunctionSnapshotContext context) {
        offsetState.clear();
        offsetState.add(currentOffset);
    }
}
```

# 3. State Backend

---

상태를 어디에 저장할지 결정합니다.

## HashMapStateBackend (메모리)

```java
env.setStateBackend(new HashMapStateBackend());
```

- 빠름
- 상태 크기에 제한 (JVM 힙)
- 작은 상태에 적합

## EmbeddedRocksDBStateBackend

```java
env.setStateBackend(new EmbeddedRocksDBStateBackend());
```

- 대용량 상태 지원
- 디스크 기반 (SSD 권장)
- 운영 환경에서 가장 많이 사용

## 비교

| 항목 | HashMap | RocksDB |
|------|---------|---------|
| 속도 | 빠름 | 상대적으로 느림 |
| 용량 | JVM 힙 제한 | 디스크 크기까지 |
| 직렬화 | 불필요 | 필요 |
| 용도 | 개발/테스트, 작은 상태 | 운영, 대용량 상태 |

# 4. Checkpoint 동작 방식

---

Checkpoint는 분산 스냅샷으로 정확한 복구 지점을 만듭니다.

## Barrier 메커니즘

```
Source → [Barrier N] → Operator → [Barrier N] → Sink
                ↓           ↓           ↓
            [Checkpoint N: 모든 상태 스냅샷]
```

1. 소스에서 Barrier 주입
2. Barrier가 모든 연산자 통과
3. 각 연산자가 상태 스냅샷 저장
4. 모든 스냅샷 완료 → Checkpoint N 완료

## Checkpoint 설정

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

// Checkpoint 활성화 (5초 간격)
env.enableCheckpointing(5000);

// Exactly-once 보장
env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);

// Checkpoint 저장소
env.getCheckpointConfig().setCheckpointStorage("s3://bucket/checkpoints/");

// 동시 Checkpoint 수 제한
env.getCheckpointConfig().setMaxConcurrentCheckpoints(1);

// 최소 Checkpoint 간격
env.getCheckpointConfig().setMinPauseBetweenCheckpoints(1000);

// Checkpoint 타임아웃
env.getCheckpointConfig().setCheckpointTimeout(60000);
```

## Checkpoint 주기 트레이드오프

| 주기 | 장점 | 단점 |
|------|------|------|
| 짧음 (1-5초) | 빠른 복구, 작은 재처리 범위 | 오버헤드 증가 |
| 길음 (30초+) | 낮은 오버헤드 | 느린 복구, 큰 재처리 범위 |

# 5. 장애 복구

---

## 복구 과정

```
1. 장애 발생
2. 마지막 성공 Checkpoint 로드
3. 소스 오프셋 복원 (예: Kafka offset)
4. 상태 복원
5. Checkpoint 시점부터 재처리
```

## 복구 시 데이터 흐름

```
Checkpoint N 시점:
  Source offset: 1000
  State: count=50

장애 후 복구:
  Kafka offset 1000으로 되돌림
  State count=50 복원
  1000번부터 재처리 시작
```

# 6. Savepoint vs Checkpoint

---

| 항목 | Checkpoint | Savepoint |
|------|------------|-----------|
| 목적 | 자동 장애 복구 | 수동 백업/업그레이드 |
| 트리거 | 자동 (주기적) | 수동 |
| 저장 기간 | 임시 (덮어쓰기) | 영구 |
| 용도 | 운영 중 복구 | 버전 업그레이드, 마이그레이션 |

## Savepoint 생성/복원

```bash
# Savepoint 생성
flink savepoint <job_id> s3://bucket/savepoints/

# Savepoint에서 복원
flink run -s s3://bucket/savepoints/savepoint-xxx app.jar
```

# 7. Watermark와 이벤트 시간

---

## Watermark란?

"이 시점까지의 데이터는 도착했다"는 신호입니다.

```java
WatermarkStrategy<Event> strategy = WatermarkStrategy
    .<Event>forBoundedOutOfOrderness(Duration.ofSeconds(10))
    .withTimestampAssigner((event, timestamp) -> event.getTimestamp());

DataStream<Event> stream = env
    .addSource(source)
    .assignTimestampsAndWatermarks(strategy);
```

## Watermark의 역할

| 역할 | 설명 |
|------|------|
| 윈도우 트리거 | 언제 윈도우 결과를 출력할지 |
| Late data 결정 | 늦은 데이터를 버릴지 처리할지 |
| State 정리 | 오래된 상태를 언제 삭제할지 |

## Late Data 처리

```java
// Late data 허용 + Side output
OutputTag<Event> lateTag = new OutputTag<>("late") {};

SingleOutputStreamOperator<Result> result = stream
    .keyBy(e -> e.key)
    .window(TumblingEventTimeWindows.of(Time.minutes(5)))
    .allowedLateness(Time.minutes(1))
    .sideOutputLateData(lateTag)
    .aggregate(new MyAggregator());

// Late data 별도 처리
DataStream<Event> lateStream = result.getSideOutput(lateTag);
```

# 8. 체크리스트

---

```
□ State backend가 상태 크기에 적합한가? (대용량이면 RocksDB)
□ Checkpoint 주기/저장소가 안정적인가?
□ Checkpoint 저장소에 충분한 용량이 있는가?
□ State 크기 증가를 모니터링하고 있는가?
□ Late event 처리 규칙을 명확히 했는가?
□ 장애 복구 시 결과 중복/유실이 없는지 테스트했는가?
□ Savepoint를 통한 업그레이드 절차가 있는가?
```

# Reference

---

- [Flink State & Checkpointing](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/checkpointing/)
- [State Backends](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/state_backends/)
- [Event Time & Watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)
- [Savepoints](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/savepoints/)
