---
title: "Flink Broadcast State 동작 원리 - 느린 참조 데이터를 빠른 스트림에 결합하는 방법"
date: 2026-03-17
categories: [Flink]
tags: [Flink, Java, BroadcastState, KeyedBroadcastProcessFunction, MapStateDescriptor, StreamProcessing, StatefulProcessing]
---

### 들어가며

실시간 스트림 처리를 하다 보면 자주 마주치는 요구사항이 있다. 초당 수천 건씩 들어오는 메인 스트림 데이터에, 가끔씩 바뀌는 참조 데이터를 결합해야 하는 상황이다.

예를 들면 이런 케이스다.

- 실시간 거래 데이터 + 환율 (하루에 몇 번 갱신)
- 실시간 로그 + 알림 규칙 (운영팀이 수시로 변경)
- 실시간 이벤트 + 설정값 (배포 없이 런타임 변경)

가장 직관적인 해결책은 DB에서 참조 데이터를 조회하는 것이다. 그런데 이 방법은 메인 스트림이 초당 수천 건일 때 DB에 그만큼 쿼리가 나간다는 문제가 있다. 응답 지연도 쌓이고, DB도 과부하가 걸린다.

Flink는 이 문제를 **Broadcast State** 패턴으로 해결한다. 이 글에서는 Broadcast State의 동작 원리, 코드 구조, 그리고 다른 시스템과의 비교를 통해 이 패턴이 왜 유용한지 살펴본다.

---

### Broadcast State란?

Broadcast State의 핵심 아이디어는 단순하다.

> 참조 데이터를 모든 병렬 인스턴스의 인메모리 State에 복제(Broadcast)해두고, 메인 스트림 데이터가 들어올 때마다 DB 대신 State에서 읽는다.

```
참조 데이터 스트림 (느림)    -->  [Broadcast]  -->  모든 인스턴스에 State 복제
메인 데이터 스트림 (빠름)    -->  processElement() 에서 State 읽기
```

DB 조회를 없애고 인메모리 State 조회로 대체하니 지연이 사라진다. 그리고 참조 데이터가 바뀌면 스트림으로 새 값을 흘려보내면 State가 자동으로 갱신된다. 재배포나 재시작이 필요 없다.

---

### 동작 원리: 시간순 흐름

두 스트림이 어떻게 상호작용하는지 시간 흐름으로 보면 이해가 빠르다.

```
10:00:00  참조 데이터 도착 {"USD": 1.0}
          --> processBroadcastElement() 호출
          --> State에 저장: {USD=1.0}

10:00:01  메인 데이터 도착 (레코드 A)
          --> processElement() 호출
          --> State에서 USD 환율 조회 --> 1.0 반환

10:00:02  메인 데이터 도착 (레코드 B)
          --> processElement() 호출
          --> State에서 USD 환율 조회 --> 1.0 반환  (State 그대로)

  ...  (참조 데이터 갱신 없으면 processBroadcastElement 호출 안 됨)

10:05:00  참조 데이터 도착 {"USD": 1.0, "KRW": 0.00073}
          --> processBroadcastElement() 호출
          --> State 갱신: {USD=1.0, KRW=0.00073}

10:05:01  메인 데이터 도착 (레코드 C)
          --> processElement() 호출
          --> State에서 KRW 환율 조회 --> 0.00073 반환  (새 값 즉시 반영)
```

핵심은 두 메서드의 호출 빈도 차이다.

- `processBroadcastElement()`: 참조 데이터가 올 때만 호출 (하루에 몇 번)
- `processElement()`: 메인 데이터가 올 때마다 호출 (초당 수천 번)

---

### 두 메서드의 권한 차이

Flink는 두 메서드의 State 접근 권한을 의도적으로 다르게 설계했다.

| 메서드 | 호출 시점 | Broadcast State 권한 | Context 타입 |
|--------|-----------|----------------------|-------------|
| `processBroadcastElement()` | 참조 데이터 도착 | **읽기 + 쓰기** | `Context` |
| `processElement()` | 메인 데이터 도착 | **읽기 전용** | `ReadOnlyContext` |

`processElement()`에서 Broadcast State 쓰기를 막은 이유가 있다. Flink는 병렬로 여러 인스턴스가 실행된다. 메인 데이터 레코드는 키(Key)에 따라 특정 인스턴스 하나에만 라우팅된다. 만약 이 인스턴스가 Broadcast State를 수정할 수 있다면, 다른 인스턴스의 State와 내용이 달라진다. 즉 일관성이 깨진다.

반면 `processBroadcastElement()`는 참조 데이터가 **모든 인스턴스에 동일하게 전달**되므로, 각 인스턴스가 같은 데이터로 State를 수정하면 결과도 같다. 이 비대칭 설계가 분산 환경에서 State 일관성을 보장하는 핵심이다.

이 권한 차이는 Java 타입 시스템으로 강제된다. `processElement()`의 Context 파라미터 타입이 `ReadOnlyContext`이므로, `getBroadcastState()`가 `ReadOnlyBroadcastState`를 반환한다. 이 인터페이스에는 `get()`과 `immutableEntries()`만 있고 `put()`이 없기 때문에, 컴파일 타임에 쓰기가 차단된다.

---

### 코드 구조

코드는 4단계로 구성된다.

#### 1단계: MapStateDescriptor 정의

```java
// Descriptor는 static final로 선언 - main()과 ProcessFunction이 같은 State를 가리키도록
static final MapStateDescriptor<String, BigDecimal> RATE_DESCRIPTOR =
    new MapStateDescriptor<>(
        "currency-rates",
        BasicTypeInfo.STRING_TYPE_INFO,
        BasicTypeInfo.BIG_DEC_TYPE_INFO
    );
```

`static final`로 선언하는 이유가 있다. `main()`에서 `broadcast()` 호출 시 사용하는 Descriptor와, `ProcessFunction` 내부에서 State에 접근할 때 쓰는 Descriptor가 동일한 객체여야 같은 State를 바라보기 때문이다.

#### 2단계: 참조 데이터 스트림을 BroadcastStream으로 변환

```java
BroadcastStream<Tuple2<String, BigDecimal>> broadcastStream =
    rateSource.broadcast(RATE_DESCRIPTOR);
```

`broadcast()`를 호출하는 순간, 이 스트림의 레코드는 모든 병렬 인스턴스에 복제되어 전달된다.

#### 3단계: 메인 스트림과 연결

```java
mainStream
    .keyBy(record -> record.getKey())
    .connect(broadcastStream)
    .process(new RateJoinFunction());
```

`keyBy()`로 메인 스트림을 키 파티셔닝하고, `connect()`로 Broadcast 스트림을 연결한 뒤, `process()`에 두 스트림을 모두 다루는 함수를 넘긴다.

#### 4단계: KeyedBroadcastProcessFunction 구현

```java
class RateJoinFunction
    extends KeyedBroadcastProcessFunction<
        String,                         // Key 타입
        MainRecord,                     // 메인 스트림 요소 타입
        Tuple2<String, BigDecimal>,     // Broadcast 스트림 요소 타입
        OutputRecord> {                 // 출력 타입

    // 참조 데이터 도착 --> State에 저장
    @Override
    public void processBroadcastElement(
            Tuple2<String, BigDecimal> value,
            Context ctx,                    // 읽기+쓰기 가능한 Context
            Collector<OutputRecord> out) throws Exception {

        ctx.getBroadcastState(RATE_DESCRIPTOR).put(value.f0, value.f1);
    }

    // 메인 데이터 도착 --> State에서 읽어서 처리
    @Override
    public void processElement(
            MainRecord value,
            ReadOnlyContext ctx,            // 읽기 전용 Context
            Collector<OutputRecord> out) throws Exception {

        // ReadOnlyContext --> getBroadcastState()는 ReadOnlyBroadcastState를 반환
        BigDecimal rate = ctx.getBroadcastState(RATE_DESCRIPTOR).get(value.getCurrency());
        if (rate == null) return;  // 아직 참조 데이터가 도착하지 않았으면 스킵

        out.collect(new OutputRecord(value, rate));
    }
}
```

타입 파라미터 4개의 의미는 순서대로 Key 타입, 메인 스트림 요소 타입, Broadcast 스트림 요소 타입, 출력 타입이다.

---

### Flink Broadcast State가 특별한 이유

같은 문제를 다른 방식으로 해결하는 시스템들과 비교해보면 Flink의 접근이 왜 좋은지 보인다.

| 시스템 | 방식 | 특징 |
|--------|------|------|
| **Flink** | Broadcast State | 자동 분산 + Checkpoint + 스트림 갱신 |
| **Spark Streaming** | Broadcast Variable | 드라이버에서 생성, 갱신 시 재배포 필요 |
| **Kafka Streams** | GlobalKTable | 전체 파티션 읽기, 자동 갱신 가능 |
| **일반 앱** | Redis / Memcached | 별도 인프라 필요, 장애 복구 별도 관리 |

Flink Broadcast State의 세 가지 장점이 두드러진다.

**자동 분산**: `broadcast()`를 호출하기만 하면 Flink가 참조 데이터를 모든 병렬 인스턴스에 자동으로 복제한다. 직접 분배 로직을 짤 필요가 없다.

**Checkpoint에 포함**: Broadcast State는 일반 State와 동일하게 Checkpoint에 저장된다. 잡이 실패해서 재시작하면 State가 복원되므로, 재시작 직후에도 참조 데이터가 유효하다.

**스트림으로 실시간 갱신**: Kafka나 Kinesis에서 참조 데이터가 흘러오면, 실행 중인 잡에 즉시 반영된다. 재배포가 필요 없다.

---

### 주의할 점

#### 참조 데이터가 늦게 도착하는 경우

메인 스트림이 시작된 직후에 참조 데이터가 아직 안 들어왔을 수 있다. 이 경우 `processElement()`에서 `ctx.getBroadcastState(RATE_DESCRIPTOR).get(key)`가 `null`을 반환한다. 위 코드 예시처럼 `null` 체크 후 스킵하거나, Side Output으로 보내서 나중에 재처리하는 전략이 필요하다.

프로덕션에서는 잡 시작 시 참조 데이터 소스를 먼저 초기 로딩하는 방식을 많이 쓴다.

#### MapStateDescriptor는 반드시 static final로 공유

`main()`의 `broadcast(RATE_DESCRIPTOR)` 호출과, `ProcessFunction` 내부의 `ctx.getBroadcastState(RATE_DESCRIPTOR)`는 같은 Descriptor 인스턴스를 참조해야 한다. 매번 `new MapStateDescriptor(...)`로 만들면 이름이 같더라도 다른 객체이므로, 직렬화/역직렬화 과정에서 예상치 못한 동작이 생길 수 있다.

#### Timer는 processElement()에서만 등록 가능

Flink 공식 문서에 명시되어 있는 제약사항이다. `processBroadcastElement()`에서는 타이머를 등록할 수 없다. 타이머 기반 로직(예: TTL 만료 처리)이 필요하면 `processElement()` 내부에서 `ctx.timerService()`를 사용해야 한다.

#### BroadcastProcessFunction 이후 Watermark 재할당

`connect().process()` 이후의 스트림은 Watermark가 두 입력 스트림 중 더 느린 쪽을 따른다. 참조 데이터 스트림에 Watermark가 없거나 매우 느리면, 이후 Window 연산이 제대로 동작하지 않을 수 있다. `connect().process()` 다음에 `assignTimestampsAndWatermarks()`를 다시 붙여주는 패턴이 프로덕션에서 권장된다.

---

### 정리

Broadcast State는 "가끔 바뀌는 참조 데이터"와 "자주 오는 메인 데이터"를 결합하는 문제에 대한 Flink의 해법이다.

- DB 조회 없이 인메모리 State에서 참조 -- 지연 없음
- `processBroadcastElement()`는 쓰기 가능, `processElement()`는 읽기 전용 -- 일관성 보장
- Checkpoint에 자동 포함 -- 장애 복구 안전
- `broadcast()`만 호출하면 자동 분산 -- 직접 분배 로직 불필요

실시간 파이프라인에서 참조 데이터 결합이 필요한 상황이라면, Broadcast State 패턴을 먼저 검토해볼 만하다.

---

### Reference

- [Apache Flink - The Broadcast State Pattern](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/broadcast_state/)
- `src/main/java/com/study/Ch08_BroadcastState.java`
