---
title: "Flink 스터디 Ch07-10 - Timer, Broadcast State, Side Output, Aggregate & Reduce"
date: 2026-03-15
categories: [Flink]
tags: [Flink, Java, Timer, BroadcastState, SideOutput, AggregateFunction, KeyedProcessFunction]
---

### 들어가며

Ch03-Ch06에서 filter/map/window/state 기초를 다졌다면, Ch07-Ch10은 Flink의 고급 기능을 다루는 구간이다. "타이머로 비활성을 감지하고(Ch07), 규칙을 동적으로 공유하고(Ch08), 스트림을 여러 갈래로 분기하고(Ch09), 더 효율적으로 집계한다(Ch10)"는 흐름이다.

이 글을 마치면 다음을 할 수 있게 된다.

- `TimerService`로 일정 시간 후 콜백을 예약하여 비활성 이벤트 감지
- `BroadcastState`로 규칙 데이터를 모든 병렬 인스턴스에 공유
- `OutputTag` + `Side Output`으로 하나의 스트림을 조건에 따라 분기
- `ReduceFunction` / `AggregateFunction`으로 메모리 효율적인 윈도우 집계

### 사전 준비 (Prerequisites)

| 항목 | 버전/조건 |
|------|-----------|
| Java | 11+ |
| Apache Flink | 1.20.x |
| Ch02 완료 | Kinesis Source 연결 및 `TSAgg` 모델 구현 |
| Ch03 완료 | `Ch03_FilterMap.getSourceWithFilter()` 재사용 |
| Ch05 완료 | `WatermarkStrategy` 설정 이해 |

Ch06까지의 프로젝트 구조 위에 이어서 작업한다. 특히 Ch03의 `getSourceWithFilter()`와 Ch05의 Watermark 설정을 Ch07, Ch08, Ch10에서 그대로 재사용한다.

---

### Ch07: ProcessFunction & Timer

#### 배경

거래소에서 데이터가 갑자기 끊기면 어떻게 알 수 있을까? 폴링 방식으로 "30초마다 데이터가 왔는지 체크"하면 될 것 같지만, Flink는 그런 주기적 체크를 직접 제공하지 않는다. 대신 **TimerService**를 사용한다. "지금부터 30초 후에 나를 불러줘"라고 예약해두고, 그 시점에 데이터가 여전히 안 오고 있으면 알림을 보내는 패턴이다.

#### Timer vs State TTL 비교

둘 다 "시간이 지나면 무언가 한다"는 점에서 헷갈리기 쉽다.

| 구분 | Timer | State TTL |
|------|-------|-----------|
| 역할 | 특정 시각에 내 코드를 실행해 달라는 예약 | State를 언제 자동 삭제할지 설정 |
| 콜백 | `onTimer()` 호출됨 | 조용히 State 삭제 |
| 용도 | "30초 후에 비활성 체크" | "5분간 안 쓰인 State 삭제" |
| 제어 | 내가 로직 작성 | Flink 자동 처리 |

#### 구현: 비활성 감지 패턴

```java
// src/main/java/com/study/Ch07_ProcessTimer.java

// KeyedProcessFunction<키타입, 입력타입, 출력타입>
static class InactivityAlertFunction extends KeyedProcessFunction<String, TSAgg, String> {

    // 키(거래소)별로 마지막 데이터 도착 시각을 저장
    private ValueState<Long> lastTimestamp;

    @Override
    public void open(OpenContext openContext) throws Exception {
        ValueStateDescriptor<Long> descriptor =
            new ValueStateDescriptor<>("lastTimestamp", Long.class);

        // State TTL: 거래소가 사라져도 메모리가 무한히 늘지 않도록
        StateTtlConfig ttlConfig = StateTtlConfig
                .newBuilder(Duration.ofMinutes(5))
                .setUpdateType(UpdateType.OnCreateAndWrite)
                .build();
        descriptor.enableTimeToLive(ttlConfig);

        lastTimestamp = getRuntimeContext().getState(descriptor);
        super.open(openContext);
    }

    @Override
    public void processElement(TSAgg tsAgg, Context context, Collector<String> collector)
            throws Exception {
        // 현재 Processing Time으로 마지막 도착 시각 갱신
        long processingTime = context.timerService().currentProcessingTime();
        lastTimestamp.update(processingTime);

        // 30초 후 콜백 등록 -- 그때까지 새 데이터가 안 오면 알림
        context.timerService().registerProcessingTimeTimer(processingTime + 30000);
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext ctx, Collector<String> out)
            throws Exception {
        Long value = lastTimestamp.value();

        // timestamp가 마지막 데이터 시각 + 30초와 같으면 -> 30초간 데이터 없음
        // 다르면 -> 그 사이에 새 데이터가 와서 lastTimestamp가 이미 갱신됨
        if (timestamp == (value + 30000)) {
            out.collect(String.format("[%s] No data for 30s", ctx.getCurrentKey()));
        }
    }
}
```

비활성 감지 원리를 한 줄로 요약하면 이렇다. 데이터가 도착할 때마다 "30초 후에 나를 불러줘"라고 예약한다. 30초 후 `onTimer()`가 발동됐을 때, 마지막으로 기록된 시각이 여전히 "30초 전"이면 그동안 데이터가 안 온 것이다. 반대로 새 데이터가 들어왔다면 `lastTimestamp`가 이미 갱신됐으므로 조건이 맞지 않아 조용히 넘어간다.

**Timer는 키마다 독립적으로 등록된다.** `keyBy(TSAgg::getExchange)`로 거래소별로 분리했기 때문에 binance 타이머와 upbit 타이머는 완전히 별개다. binance 데이터가 끊겨도 upbit 타이머에는 영향이 없다.

**`ValueState<Long>`와 State TTL:** Ch06의 `MapState`는 여러 개의 키-값 쌍을 저장하지만, 여기서는 "마지막 타임스탬프 하나"만 필요하므로 `ValueState<Long>`이 적합하다. 거래소 수가 많지 않으면 TTL 없이도 괜찮지만, 거래소가 추가/삭제될 수 있으므로 습관적으로 TTL을 설정하는 것이 안전하다.

---

### Ch08: Broadcast State

#### 배경

"binance, upbit, okx 데이터만 통과시켜라"는 규칙이 있다고 하자. 이 규칙을 코드에 하드코딩하면 거래소를 추가할 때마다 잡을 재배포해야 한다. **Broadcast State**를 쓰면 규칙 스트림을 실시간으로 보내서 잡 재시작 없이 필터 조건을 바꿀 수 있다.

#### Broadcast State란?

일반 Keyed State는 키별로 분리된다. 반면 Broadcast State는 모든 병렬 인스턴스가 동일한 데이터를 가진다. "공지사항을 전 직원에게 뿌리는" 것과 비슷하다.

```text
규칙 스트림 --> broadcast() --> 모든 TaskManager에 복사
메인 스트림 --> keyBy()    --> 각 TaskManager로 라우팅
                           ↕ connect()
                    KeyedBroadcastProcessFunction
```

#### MapStateDescriptor: 설계도와 실제 저장소

`MapStateDescriptor`는 Broadcast State의 "설계도"다. 이름과 키/값 타입을 정의한다. 실제 State(데이터가 저장되는 공간)는 Flink가 이 설계도를 보고 내부에서 생성한다. `main()`과 함수 클래스 양쪽에서 **같은 descriptor 인스턴스**를 참조해야 같은 State에 접근할 수 있다.

```java
// src/main/java/com/study/Ch08_BroadcastState.java

// static 필드로 공유 -- main()과 ExchangeFilterFunction이 같은 descriptor를 가리킴
private static MapStateDescriptor<String, String> descriptor;

public static void main(String[] args) throws Exception {
    // ...
    descriptor = new MapStateDescriptor<>("rule", String.class, String.class);

    // 규칙 스트림을 broadcast
    BroadcastStream<String> broadcastStream = ruleStream.broadcast(descriptor);

    // 메인 스트림과 connect -> 처리 함수 적용
    withFilter.keyBy(TSAgg::getExchange)
            .connect(broadcastStream)
            .process(new ExchangeFilterFunction())
            .print();
}
```

#### processElement vs processBroadcastElement

`KeyedBroadcastProcessFunction`에는 두 개의 콜백 메서드가 있다. 메인 데이터가 도착하면 `processElement()`가, 규칙 데이터가 도착하면 `processBroadcastElement()`가 호출된다.

```java
// src/main/java/com/study/Ch08_BroadcastState.java

// KeyedBroadcastProcessFunction<키타입, 입력1(메인), 입력2(규칙), 출력>
static class ExchangeFilterFunction
        extends KeyedBroadcastProcessFunction<String, TSAgg, String, TSAgg> {

    // 메인 데이터(TSAgg)가 도착할 때 호출 -- ReadOnlyContext: 읽기만 가능
    @Override
    public void processElement(TSAgg tsAgg, ReadOnlyContext ctx, Collector<TSAgg> out)
            throws Exception {
        // Broadcast State에 해당 거래소가 등록되어 있으면 통과
        if (ctx.getBroadcastState(descriptor).contains(tsAgg.getExchange())) {
            out.collect(tsAgg);
        }
    }

    // 규칙 데이터(String)가 도착할 때 호출 -- Context: 쓰기 가능
    @Override
    public void processBroadcastElement(String exchange, Context ctx, Collector<TSAgg> out)
            throws Exception {
        // 규칙을 Broadcast State에 저장 -> 모든 병렬 인스턴스에 반영됨
        ctx.getBroadcastState(descriptor).put(exchange, exchange);
    }
}
```

왜 `processElement()`에서는 읽기만 되고 쓰기는 안 될까? 병렬 환경에서 여러 인스턴스가 동시에 Broadcast State를 수정하면 데이터 불일치가 생긴다. Flink는 이를 막기 위해 `processElement()`에 `ReadOnlyContext`를 준다. Broadcast State 수정은 규칙이 들어올 때(`processBroadcastElement()`)만 허용하고, 이 호출은 모든 인스턴스에서 동일한 순서로 처리되어 일관성이 보장된다.

---

### Ch09: Side Output

#### 배경

Ch03의 `filter()`는 조건에 안 맞는 데이터를 완전히 버린다. 하지만 실무에서는 "버리는" 대신 "다른 곳으로 보내고 싶을" 때가 많다. futures 데이터를 버리지 않고 별도 저장소로 보내거나, volume이 0인 이상 데이터를 별도로 모니터링하는 경우가 그렇다. **Side Output**은 하나의 스트림을 여러 갈래로 분기하는 기능이다.

#### OutputTag: 이름표에 `{}` 가 필요한 이유

```java
// src/main/java/com/study/Ch09_SideOutput.java

// 끝에 {} 필수 -- Java type erasure 때문
static final OutputTag<TSAgg> futuresTag = new OutputTag<TSAgg>("futures") {};
static final OutputTag<TSAgg> zeroVolumeTag = new OutputTag<TSAgg>("zero-volume") {};
```

Java의 제네릭은 컴파일 시점에 타입 정보가 지워진다(type erasure). `new OutputTag<TSAgg>("futures")`만 쓰면 런타임에 `OutputTag`가 자신이 `TSAgg` 타입임을 알 수 없다. `{}`로 익명 클래스를 만들면 해당 클래스가 컴파일 타임의 타입 정보를 내부에 보존한다. Flink가 내부적으로 이 정보를 꺼내 쓰기 때문에 `{}`를 빠뜨리면 런타임 에러가 발생한다.

#### SplitFunction: 데이터를 세 갈래로 분기

```java
// src/main/java/com/study/Ch09_SideOutput.java

// ProcessFunction<입력, 메인출력> -- keyBy 없이 사용 가능
static class SplitFunction extends ProcessFunction<TSAgg, TSAgg> {

    @Override
    public void processElement(TSAgg tsAgg, Context context, Collector<TSAgg> collector)
            throws Exception {
        // compareTo로 비교 -- equals()는 scale까지 비교 (0.0 != 0 문제)
        if (tsAgg.getVolume().compareTo(BigDecimal.ZERO) == 0) {
            context.output(zeroVolumeTag, tsAgg);  // Side Output 1
            return;
        }

        if (!"spot".equals(tsAgg.getMarketType())) {
            context.output(futuresTag, tsAgg);  // Side Output 2
            return;
        }

        collector.collect(tsAgg);  // 메인 출력 (spot + volume > 0)
    }
}
```

메인 스트림에서 `getSideOutput()`으로 각 Side Output 스트림을 꺼낸다. 이후 각 스트림에 독립적인 연산(다른 Sink, 다른 변환 등)을 붙일 수 있다.

```java
// src/main/java/com/study/Ch09_SideOutput.java -- main()

SingleOutputStreamOperator<TSAgg> mainStream = source.process(new SplitFunction());

mainStream.print("MAIN");                                  // spot + volume > 0
mainStream.getSideOutput(futuresTag).print("FUTURES");     // futures 전용
mainStream.getSideOutput(zeroVolumeTag).print("ZERO-VOL"); // volume 0 전용
```

**`ProcessFunction` vs `KeyedProcessFunction`:** Ch06-Ch07에서 쓴 `KeyedProcessFunction`은 `keyBy()` 이후에만 사용할 수 있다. `ProcessFunction`은 keyBy 없이도 사용 가능하다. 대신 Keyed State와 Timer를 사용할 수 없다. Ch09에서는 상태를 저장할 필요 없이 단순 분기만 하면 되므로 `ProcessFunction`이 적합하다.

---

### Ch10: Aggregate & Reduce

#### 배경

Ch04의 `ProcessWindowFunction`은 윈도우가 닫힐 때까지 **모든 데이터를 메모리에 보관**했다가 한꺼번에 처리한다. 1분 윈도우에 데이터가 10만 건 들어오면 10만 건을 메모리에 들고 있어야 한다. `ReduceFunction`과 `AggregateFunction`은 데이터가 들어올 때마다 **즉시** 누적값을 갱신하기 때문에 최종 누적값만 메모리에 남는다. 대용량 스트림에서 훨씬 효율적이다.

#### ReduceFunction: 같은 타입끼리 합치기

`ReduceFunction`은 입력/출력 타입이 동일하다. 두 원소를 받아서 "더 가치 있는 하나"를 리턴하는 방식으로 동작한다.

```java
// src/main/java/com/study/Ch10_AggregateReduce.java

// ReduceFunction<TSAgg>: 두 TSAgg를 받아 high가 더 큰 쪽을 리턴
static class MaxHighReduce implements ReduceFunction<TSAgg> {

    @Override
    public TSAgg reduce(TSAgg o1, TSAgg o2) {
        // compareTo >= 0: o1이 크거나 같으면 o1 리턴, 아니면 o2 리턴
        if (o1.getHigh().compareTo(o2.getHigh()) >= 0) {
            return o1;
        } else {
            return o2;
        }
    }
}
```

윈도우 내에서 Flink는 첫 번째 데이터를 누적값으로 두고, 다음 데이터가 올 때마다 `reduce(누적값, 새데이터)`를 호출한다. 결과가 다시 누적값이 되고, 윈도우가 닫히면 최종 누적값이 출력된다.

#### AggregateFunction: 입/출력 타입이 달라도 되는 범용 집계

`ReduceFunction`은 "TSAgg -> TSAgg"처럼 입출력 타입이 같아야 한다. 평균값처럼 입력은 `TSAgg`인데 출력은 `String`이거나, 내부적으로 별도 계산 상태(count, sum)가 필요한 경우에는 `AggregateFunction`을 써야 한다.

제네릭이 세 개다: `AggregateFunction<입력, 누적기, 출력>`.

```java
// src/main/java/com/study/Ch10_AggregateReduce.java

// AggregateFunction<TSAgg, BigDecimal[], String>
//   - 입력: TSAgg
//   - 누적기: BigDecimal[2] -- [0]=합계(sum), [1]=개수(count)
//   - 출력: String (평균값 문자열)
static class AvgCloseAggregate implements AggregateFunction<TSAgg, BigDecimal[], String> {

    // 누적기 초기화 -- 윈도우 시작 시 한 번 호출
    @Override
    public BigDecimal[] createAccumulator() {
        return new BigDecimal[]{BigDecimal.ZERO, BigDecimal.ZERO};
    }

    // 데이터가 올 때마다 누적기 갱신
    @Override
    public BigDecimal[] add(TSAgg tsAgg, BigDecimal[] acc) {
        acc[0] = acc[0].add(tsAgg.getClose());  // sum 누적
        acc[1] = acc[1].add(BigDecimal.ONE);     // count 증가
        return acc;
    }

    // 윈도우 닫힐 때 누적기 -> 최종 출력으로 변환
    @Override
    public String getResult(BigDecimal[] acc) {
        BigDecimal avg = acc[0].divide(acc[1], 2, RoundingMode.HALF_UP);
        return String.format("avgClose=%.2f count=%s", avg, acc[1].intValue());
    }

    // 병렬 집계 결과 합치기 (세션 윈도우 등에서 사용)
    @Override
    public BigDecimal[] merge(BigDecimal[] a, BigDecimal[] b) {
        a[0] = a[0].add(b[0]);  // sum 합치기
        a[1] = a[1].add(b[1]);  // count 합치기
        return a;
    }
}
```

**왜 sum/count를 필드가 아닌 누적기에 담는가?** Flink에서 병렬 처리 시 함수 인스턴스가 여러 개 생성된다. 필드에 상태를 두면 각 인스턴스가 별도의 필드를 갖게 되어 집계값이 꼬인다. 누적기(`BigDecimal[]`)는 Flink가 각 키/윈도우마다 독립적으로 생성하고 관리하므로 안전하다.

#### ProcessWindowFunction vs Reduce/Aggregate 비교

| 구분 | ProcessWindowFunction | ReduceFunction | AggregateFunction |
|------|----------------------|----------------|-------------------|
| 처리 시점 | 윈도우 닫힐 때 일괄 처리 | 데이터마다 즉시 | 데이터마다 즉시 |
| 메모리 사용 | 윈도우 전체 보관 (높음) | 누적값 하나만 (낮음) | 누적기 하나만 (낮음) |
| 입/출력 타입 | 다를 수 있음 | 동일해야 함 | 다를 수 있음 |
| 윈도우 메타정보 | 접근 가능 (시작/종료 시각 등) | 접근 불가 | 접근 불가 |
| 적합한 경우 | 복잡한 집계 로직 | 단순 최대/최소 | count, sum, 평균 |

---

### 삽질 기록 (Gotchas)

#### 1. assignTimestampsAndWatermarks() 리턴값을 안 받음

```java
// 잘못된 코드 -- withFilter에는 watermark가 적용 안 됨
withFilter.assignTimestampsAndWatermarks(watermark); // 리턴값 무시!
withFilter.keyBy(TSAgg::getExchange)  // 원본 스트림으로 keyBy -> watermark 미적용
         .process(new InactivityAlertFunction())
         .print();
```

```java
// 올바른 코드 -- 리턴값을 받아서 체이닝
withFilter.assignTimestampsAndWatermarks(watermark) // 리턴값을 이어서 체이닝
         .keyBy(TSAgg::getExchange)
         .process(new InactivityAlertFunction())
         .print();
```

`assignTimestampsAndWatermarks()`는 새로운 스트림을 리턴한다. 이 리턴값을 쓰지 않고 원본 `withFilter`로 이어가면 watermark가 적용되지 않은 스트림을 처리하게 된다. Event Time 윈도우가 영원히 닫히지 않거나, Timer가 예상대로 발동하지 않는 증상으로 나타날 수 있다.

Java 체이닝에서 중요한 원칙이 있다. **각 메서드의 리턴 타입이 다음 호출을 결정한다.** `WatermarkStrategy` 빌더 구조도 마찬가지다. `forBoundedOutOfOrderness()`가 `WatermarkStrategy`를 리턴하기 때문에 이어서 `.withTimestampAssigner()`를 호출할 수 있다.

#### 2. env.execute() 누락 (Ch07에서 세 번째)

Ch02, Ch05에 이어 Ch07에서도 반복됐다. Flink의 Lazy Evaluation은 `env.execute()` 없이는 아무 일도 일어나지 않는다. 에러 없이 프로그램이 종료되므로 초보자에게 특히 헷갈린다. 파이프라인 작성 후 항상 마지막 줄부터 확인하는 습관을 들이자.

#### 3. ReduceFunction의 compareTo == 0 실수

```java
// 잘못된 코드 -- "같을 때만" o1 리턴 -> 최고가 찾기 로직이 틀림
if (o1.getHigh().compareTo(o2.getHigh()) == 0) {
    return o1;
} else {
    return o2;
}
```

```java
// 올바른 코드 -- "크거나 같을 때" o1 리턴
if (o1.getHigh().compareTo(o2.getHigh()) >= 0) {
    return o1;
} else {
    return o2;
}
```

`compareTo()`는 왼쪽이 크면 양수, 같으면 0, 작으면 음수를 리턴한다. `== 0`은 "같을 때"만 해당되므로, o1이 더 클 때(`> 0`)에도 else로 빠져서 o2를 리턴했다. 최고가를 찾는다면 `>= 0`(크거나 같을 때 o1을 유지)이어야 한다.

#### 4. AggregateFunction에서 count/sum을 필드로 선언

```java
// 잘못된 코드 -- 병렬 처리 시 꼬임
static class AvgCloseAggregate implements AggregateFunction<TSAgg, BigDecimal[], String> {
    private BigDecimal sum = BigDecimal.ZERO;  // 필드! 병렬 인스턴스 간 공유 안 됨
    private BigDecimal count = BigDecimal.ZERO; // 필드!

    @Override
    public BigDecimal[] add(TSAgg tsAgg, BigDecimal[] acc) {
        sum = sum.add(tsAgg.getClose());  // 인스턴스별로 따로 놀음
        count = count.add(BigDecimal.ONE);
        ...
    }
}
```

로컬에서 parallelism 1로 실행하면 우연히 맞을 수 있지만, 병렬도가 높아지면 각 인스턴스가 독립된 `sum`, `count` 필드를 갖게 되어 집계가 깨진다. 모든 상태는 누적기(`acc`) 안에 담아야 한다. Flink가 누적기를 키/윈도우마다 독립적으로 생성하고 관리한다.

#### 5. Side Output 분기 로직 반대로 작성

```java
// 잘못된 코드 -- spot을 futuresTag로 보내고, futures를 메인으로 보냄
if ("spot".equals(tsAgg.getMarketType())) {
    context.output(futuresTag, tsAgg);  // spot인데 futuresTag?!
    return;
}
collector.collect(tsAgg);  // futures가 메인으로
```

```java
// 올바른 코드 -- spot이 "아닌" 것을 futuresTag로
if (!"spot".equals(tsAgg.getMarketType())) {
    context.output(futuresTag, tsAgg);
    return;
}
collector.collect(tsAgg);  // spot이 메인으로
```

부정 조건(`!`)을 빠뜨리면 조건이 완전히 반전된다. 실행해 보면 MAIN 출력에는 futures 데이터가, FUTURES 출력에는 spot 데이터가 나온다. 분기 로직 작성 후 실제 출력 레이블과 내용이 일치하는지 확인하는 습관이 필요하다.

#### 6. BigDecimal.equals() vs compareTo()

```java
// 잘못된 코드 -- 0.0과 0은 scale이 달라서 equals()로는 같지 않음
if (tsAgg.getVolume().equals(BigDecimal.ZERO)) { ... }  // 0.0 != 0

// 올바른 코드 -- compareTo는 수학적 값만 비교
if (tsAgg.getVolume().compareTo(BigDecimal.ZERO) == 0) { ... }  // 0.0 == 0
```

`BigDecimal.equals()`는 값뿐만 아니라 **scale(소수점 자릿수)**까지 비교한다. `new BigDecimal("0.0")`과 `BigDecimal.ZERO`는 수학적으로 같지만, scale이 각각 1과 0으로 달라서 `equals()`는 `false`를 리턴한다. `BigDecimal` 비교는 항상 `compareTo()`를 쓰는 것이 안전하다.

---

### Java 기초: process()가 필요한 이유

Ch03-Ch10을 거치면서 `filter()`, `map()`, `reduce()`, `aggregate()`, `process()`를 모두 써봤다. 그렇다면 언제 `process()`를 써야 할까?

`filter()`와 `map()`은 데이터 하나를 받아 변환/필터링만 한다. **State에 접근하거나, Timer를 등록하거나, Side Output을 내보내야 하는 경우에는 `process()`가 필요하다.** `ProcessFunction`과 `KeyedProcessFunction`은 `Context`를 통해 이 세 가지 기능에 모두 접근할 수 있다.

| 연산 | State | Timer | Side Output | 타입 변환 |
|------|-------|-------|-------------|-----------|
| `filter()` | X | X | X | X (bool만) |
| `map()` | X | X | X | O |
| `reduce()` | X | X | X | X (동일 타입) |
| `aggregate()` | X | X | X | O |
| `process()` | O | O | O | O |

---

### 핵심 정리 (Key Takeaways)

1. **Timer는 예약, TTL은 자동 삭제:** Timer는 내가 원하는 시각에 코드를 실행하도록 예약하는 것이고, State TTL은 일정 기간 후 State를 자동으로 지우는 설정이다. 둘은 다른 목적으로 같이 쓸 수 있다.
2. **Broadcast State는 모든 인스턴스에 공유:** 일반 State는 키별로 분리되지만, Broadcast State는 모든 병렬 인스턴스가 동일한 데이터를 본다. 규칙/설정을 동적으로 배포할 때 유용하다.
3. **`processElement()` = ReadOnly, `processBroadcastElement()` = 쓰기 가능:** Broadcast State 일관성을 위해 메인 데이터 처리 시에는 읽기만 허용한다.
4. **`OutputTag`에 `{}` 필수:** Java type erasure 때문에 익명 클래스로 제네릭 타입 정보를 런타임에 보존해야 한다.
5. **Side Output은 분기, filter는 제거:** `filter()`는 데이터를 버리고, Side Output은 다른 출력으로 살려서 별도 처리할 수 있다.
6. **누적기(accumulator)에 상태 담기:** `AggregateFunction`에서 count, sum 등의 상태는 반드시 누적기 안에 담아야 병렬 환경에서 올바르게 동작한다.
7. **`ProcessWindowFunction` vs `Reduce/Aggregate`:** 단순 집계는 메모리 효율적인 Reduce/Aggregate를 쓰고, 복잡한 로직이나 윈도우 메타정보가 필요할 때만 `ProcessWindowFunction`을 쓴다.

---

### 다음 단계 (Next Steps)

- **Ch11: File Sink (S3 Parquet)** -- 처리된 데이터를 S3에 Parquet 형식으로 저장
- **Ch12: JDBC Sink (PostgreSQL)** -- 집계 결과를 PostgreSQL에 저장
- **Ch13: 통합 파이프라인** -- Ch01-Ch12에서 배운 모든 것을 하나의 잡으로 연결

---

### Reference

- [Apache Flink ProcessFunction 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/process_function/)
- [Apache Flink Broadcast State Pattern 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/broadcast_state/)
- [Apache Flink Side Outputs 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/side_output/)
- [Apache Flink Windows 공식 문서 (Reduce/Aggregate)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/windows/)
