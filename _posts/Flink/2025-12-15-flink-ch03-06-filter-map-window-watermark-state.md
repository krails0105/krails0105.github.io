---
title: "Flink 스터디 Ch03-06 - Filter/Map부터 Watermark, State 중복 제거까지"
date: 2026-03-14
categories: [Flink]
tags: [Flink, Java, Window, Watermark, State, KeyedProcessFunction, Deduplication]
---

### 들어가며

Ch02에서 Kinesis 스트림에서 데이터를 읽는 데 성공했다면, Ch03-Ch06은 그 데이터를 실제로 가공하고 분석하는 과정이다. "필터링 -> 그룹핑 -> 윈도우 집계 -> 중복 제거"라는 흐름을 단계적으로 쌓아가며 Flink의 핵심 추상화를 모두 맛볼 수 있는 구간이다.

이 글을 마치면 다음을 할 수 있게 된다.

- `filter()`와 `map()`으로 스트림 데이터 필터링 및 변환
- `keyBy()` + `TumblingWindow` + `ProcessWindowFunction`으로 1분 단위 집계
- `WatermarkStrategy`로 Event Time 기준 윈도우 처리
- `MapState` + `KeyedProcessFunction`으로 중복 레코드 제거

### 사전 준비 (Prerequisites)

| 항목 | 버전/조건 |
|------|-----------|
| Java | 11+ |
| Apache Flink | 1.20.x |
| Ch02 완료 | Kinesis Source 연결 및 `TSAgg` 모델 구현 |

Ch02의 `Ch02_KinesisSource.createKinesisSource(env)`와 `TSAgg` 모델 클래스를 재사용한다. Ch02를 먼저 완료해야 한다.

---

### Ch03: Filter & Map

#### 배경

원본 스트림에는 BTC 외에도 ETH, SOL 등 수많은 코인이 섞여 있고, futures 마켓 데이터도 함께 들어온다. 또한 거래소마다 USDT, USDC, BUSD 등 다른 스테이블코인으로 가격을 표시한다. Ch03은 이 잡음들을 제거하고 정규화하는 챕터다.

#### 구현

##### filter(): 필요한 데이터만 통과

`filter()`는 람다가 `true`를 리턴한 데이터만 내려보내고, `false`면 버린다. 조건이 여러 개일 때 `&&`로 한 줄에 묶는 것보다 체이닝이 가독성이 좋다. 성능 차이는 없다.

```java
// src/main/java/com/study/Ch03_FilterMap.java

source
    // volume이 0 초과인 데이터만 통과
    // BigDecimal은 > 연산자를 쓸 수 없고 compareTo()를 써야 한다
    .filter(o -> o.getVolume() != null && o.getVolume().compareTo(BigDecimal.ZERO) > 0)
    // spot 거래만 ("spot".equals() 순서가 중요 -- null-safe)
    .filter(o -> "spot".equals(o.getMarketType()))
    // BTC만
    .filter(o -> "BTC".equals(o.getBase()))
```

**BigDecimal 비교에 `compareTo`가 필요한 이유:** `BigDecimal`은 객체다. Java에서 `>`, `<` 연산자는 `int`, `double` 같은 기본 타입에만 쓸 수 있다. 객체끼리는 `compareTo()`로 비교해야 한다. `compareTo()`는 왼쪽이 크면 양수, 같으면 0, 작으면 음수를 리턴한다. `volume.compareTo(BigDecimal.ZERO) > 0`은 "volume이 0보다 크다"는 뜻이다.

**`"spot".equals(o.getMarketType())` 순서의 이유:** `o.getMarketType()`이 `null`인 경우, `null.equals("spot")`을 호출하면 `NullPointerException`이 발생한다. 반대로 `"spot".equals(null)`은 `false`를 리턴하므로 안전하다. 문자열 리터럴을 왼쪽에 두는 것이 null-safe한 관용구다.

##### map(): Stablecoin 정규화

거래소 간 가격을 비교하려면 quote 통화가 통일되어야 한다. USDT, USDC, BUSD는 모두 1달러에 페깅된 스테이블코인이므로 "USD"로 합쳐도 무방하다.

```java
// src/main/java/com/study/Ch03_FilterMap.java

// 스테이블코인 목록 -- Set.of()로 O(1) 조회
private static final Set<String> STABLECOINS =
    Set.of("USDT", "USDC", "BUSD", "DAI", "TUSD", "FDUSD");

// map(): 데이터를 받아 변환 후 리턴
.map(o -> {
    if (STABLECOINS.contains(o.getQuote())) {
        o.setQuote("USD");   // USDT/USDC/BUSD -> USD로 통합
    }
    return o;
});
```

##### getSourceWithFilter() -- static 메서드로 분리

filter + map 로직을 `static` 메서드로 추출하면 이후 Ch04, Ch05, Ch06에서 그대로 재사용할 수 있다. 실제로 Ch04 이후 모든 챕터에서 `Ch03_FilterMap.getSourceWithFilter(source)`로 호출한다.

```java
// src/main/java/com/study/Ch03_FilterMap.java

// 다른 챕터에서 Ch03_FilterMap.getSourceWithFilter(source)로 호출
public static SingleOutputStreamOperator<TSAgg> getSourceWithFilter(
        DataStreamSource<TSAgg> source) {
    return source
        .filter(o -> o.getVolume() != null && o.getVolume().compareTo(BigDecimal.ZERO) > 0)
        .filter(o -> "spot".equals(o.getMarketType()))
        .filter(o -> "BTC".equals(o.getBase()))
        .map(o -> {
            if (STABLECOINS.contains(o.getQuote())) {
                o.setQuote("USD");
            }
            return o;
        });
}
```

---

### Ch04: KeyBy & Window

#### 배경

필터링된 BTC 데이터를 거래소별로 묶어 1분 단위로 집계한다. Flink에서 "그룹핑 + 시간 윈도우 + 집계"는 `keyBy -> window -> process` 세 단계로 구성된다.

#### 구현

##### keyBy() -> window() -> process()

```java
// src/main/java/com/study/Ch04_KeyByWindow.java

Ch03_FilterMap.getSourceWithFilter(source)
    .keyBy(o -> o.getExchange())                                    // 거래소별 그룹핑
    .window(TumblingProcessingTimeWindows.of(Duration.ofMinutes(1))) // 1분 고정 윈도우
    .process(new TSAggWindowFunction())                              // 윈도우 닫힐 때 집계
    .print();
```

`keyBy()`는 같은 키를 가진 데이터가 같은 서브태스크(파티션)로 모이도록 라우팅한다. Kafka의 파티션 키와 비슷한 개념이다.

`TumblingProcessingTimeWindows`는 시스템 시각 기준으로 1분마다 윈도우가 열리고 닫힌다. 예를 들어 12:00:00 ~ 12:00:59 사이에 들어온 데이터가 하나의 윈도우를 구성한다.

##### ProcessWindowFunction: 윈도우 집계

윈도우가 닫힐 때 한 번 호출되는 집계 함수다. 제네릭이 4개라 처음에는 당황스럽지만 의미를 알면 어렵지 않다.

```java
// src/main/java/com/study/Ch04_KeyByWindow.java

// ProcessWindowFunction<입력타입, 출력타입, 키타입, 윈도우타입>
static class TSAggWindowFunction
        extends ProcessWindowFunction<TSAgg, String, String, TimeWindow> {

    @Override
    public void process(
            String key,              // keyBy로 그룹핑된 키 (거래소명)
            Context context,         // 윈도우 메타정보 (시작/종료 시각 등)
            Iterable<TSAgg> elements, // 이 윈도우에 모인 데이터 목록
            Collector<String> out     // 결과를 내보내는 출구 (return이 아님!)
    ) throws Exception {
        int count = 0;
        BigDecimal closeSum = BigDecimal.ZERO;

        // Iterable은 size()가 없다 -- for문으로 직접 카운트
        for (TSAgg o : elements) {
            closeSum = closeSum.add(o.getClose());
            count++;
        }

        BigDecimal avgClose =
            closeSum.divide(BigDecimal.valueOf(count), 2, RoundingMode.HALF_UP);

        // out.collect()로 결과 출력 -- return이 아니다!
        out.collect(String.format("[%s] avgClose=%.2f count=%d", key, avgClose, count));
    }
}
```

**왜 `Iterable`에 `size()`가 없나?** Java에서 `Collection`이 `size()`를 제공하고, `Iterable`은 `Collection`의 상위 인터페이스다. Flink는 윈도우 데이터를 순회만 할 수 있는 `Iterable`로 노출하기 때문에 크기를 직접 알 수 없다. `for`문으로 돌면서 카운트를 직접 세야 한다.

**왜 `return`이 아니라 `out.collect()`인가?** `ProcessWindowFunction`의 `process()` 메서드는 `void`를 반환한다. 결과를 여러 개 내보낼 수 있도록 설계되어 있기 때문에, 하나만 내보내더라도 `out.collect()`를 써야 한다. `return`은 메서드 종료 용도이고, 결과 출력은 `Collector`가 담당한다.

---

### Ch05: Watermark

#### 배경

Ch04는 **Processing Time** 기준이었다 -- 데이터가 Flink에 도착한 시각 기준으로 윈도우를 나눈다. 하지만 실제로는 데이터의 `timestamp` 필드(실제 발생 시각) 기준으로 집계해야 정확하다. 이것이 **Event Time**이다.

문제는 네트워크 지연이나 재처리 상황에서 데이터가 순서대로 도착하지 않을 수 있다는 점이다. Flink는 "어느 시점까지의 데이터가 다 도착했다"를 어떻게 알 수 있을까? 그 답이 **Watermark**다.

#### Watermark란?

Watermark는 스트림 중간에 흐르는 특별한 메시지다. "현재 시각 T의 Watermark가 발행되었다 = T 이전의 데이터는 이제 다 도착했다"는 신호다. Flink는 이 신호를 받고 해당 시간 범위의 윈도우를 닫아 집계를 시작한다.

```text
데이터 흐름:
  [ts=100] [ts=98] [ts=102] [ts=95] ... Watermark(ts=90) ... Watermark(ts=95) ...

Watermark(90)이 오면 -> ts <= 90인 윈도우를 닫아도 됨
```

#### 구현

##### WatermarkStrategy 설정

```java
// src/main/java/com/study/Ch05_Watermark.java

// forBoundedOutOfOrderness(10초): 데이터가 최대 10초 늦게 도착할 수 있음을 허용
// 즉, 현재 최대 timestamp - 10초 = Watermark
WatermarkStrategy<TSAgg> watermarkStrategy = WatermarkStrategy
        .<TSAgg>forBoundedOutOfOrderness(Duration.ofSeconds(10))
        .withTimestampAssigner(
            // tsAgg: 데이터, ts: 이전에 할당된 타임스탬프 (처음엔 -1)
            // TSAgg.timestamp는 초 단위 -- Flink는 밀리초 단위를 요구
            (tsAgg, ts) -> tsAgg.getTimestamp() * 1000
        );
```

**`* 1000`이 필요한 이유:** Flink의 Event Time은 내부적으로 밀리초(ms) 단위를 사용한다. 하지만 Kinesis 스트림에서 오는 `TSAgg.timestamp`는 초(epoch seconds) 단위다. 1초 = 1000밀리초이므로 `* 1000`으로 변환해야 한다. 이 변환을 빠뜨리면 Watermark가 1970년대 값으로 계산되어 윈도우가 영원히 닫히지 않는다.

**`(tsAgg, ts)` 람다의 두 번째 파라미터 `ts`:** 이 람다가 처음 호출될 때 `ts`는 이전에 이 레코드에 할당된 타임스탬프 값이다(첫 호출 시 의미 없는 값). 우리는 항상 `tsAgg.getTimestamp() * 1000`을 반환하므로 `ts`는 사용하지 않는다.

##### TumblingEventTimeWindows 적용

Ch04의 `TumblingProcessingTimeWindows`를 `TumblingEventTimeWindows`로 교체한 것이 핵심이다.

```java
// src/main/java/com/study/Ch05_Watermark.java

filtered
    .assignTimestampsAndWatermarks(watermarkStrategy)  // Watermark 적용
    .keyBy(TSAgg::getExchange)                         // 메서드 레퍼런스로 축약
    .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))  // Event Time 기준 윈도우
    .process(new TSAggWindowFunction())
    .print();
```

`TSAgg::getExchange`는 `o -> o.getExchange()`의 축약이다. 이를 **메서드 레퍼런스**라고 한다.

##### Ch04 vs Ch05 비교

| 구분 | Ch04 | Ch05 |
|------|------|------|
| 윈도우 기준 | Processing Time (시스템 시각) | Event Time (데이터의 timestamp) |
| 윈도우 타입 | `TumblingProcessingTimeWindows` | `TumblingEventTimeWindows` |
| Watermark | 불필요 | 필요 (`WatermarkStrategy` 설정) |
| 재처리 정확도 | 낮음 (재처리 시 시각이 달라짐) | 높음 (같은 데이터 = 같은 윈도우) |

---

### Ch06: State & Deduplication

#### 배경

Kinesis 스트림 특성상 같은 데이터가 두 번 들어올 수 있다(at-least-once). 이를 처리하려면 "이 데이터를 이미 봤는지" 기억해야 한다. Flink에서 기억을 담당하는 것이 **State**다.

#### Keyed State란?

Flink의 State는 `keyBy()` 이후에만 사용할 수 있는 **Keyed State**가 기본이다. 같은 키(`symbol`)끼리는 같은 State 공간을 공유한다. 즉, `BTC/USD`의 State와 `ETH/USD`의 State는 완전히 분리된 저장소다.

#### 구현

##### MapState로 중복 제거

Flink에는 `SetState`가 없다. `MapState<K, Boolean>`을 Set처럼 사용하는 것이 관용구다.

```java
// src/main/java/com/study/Ch06_StateDedup.java

// keyBy(symbol) -> 중복 제거 -> 출력
filtered.keyBy(TSAgg::getSymbol)
        .process(new DedupFunction())
        .print();
```

```java
// src/main/java/com/study/Ch06_StateDedup.java

// KeyedProcessFunction<키타입, 입력타입, 출력타입>
static class DedupFunction extends KeyedProcessFunction<String, TSAgg, TSAgg> {

    // MapState<timestamp, Boolean> -- Set처럼 사용 (본 timestamp를 키로 저장)
    private MapState<Long, Boolean> seenTimestamps;

    // open(): 잡 시작 시 한 번만 실행 -- State 초기화
    @Override
    public void open(OpenContext openContext) throws Exception {
        MapStateDescriptor<Long, Boolean> descriptor =
            new MapStateDescriptor<>("seenTimestamps", Long.class, Boolean.class);

        // State TTL: 5분간 업데이트 없으면 자동 삭제 (메모리 무한 증가 방지)
        StateTtlConfig ttlConfig = StateTtlConfig
            .newBuilder(Duration.ofMinutes(5))
            .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
            .build();
        descriptor.enableTimeToLive(ttlConfig);

        seenTimestamps = getRuntimeContext().getMapState(descriptor);
        super.open(openContext);
    }

    // processElement(): 데이터가 들어올 때마다 실행
    @Override
    public void processElement(
            TSAgg tsAgg, Context context, Collector<TSAgg> collector) throws Exception {
        if (!seenTimestamps.contains(tsAgg.getTimestamp())) {
            seenTimestamps.put(tsAgg.getTimestamp(), true);  // 처음 본 timestamp 기록
            collector.collect(tsAgg);                         // 새 데이터만 통과
        }
        // 이미 본 timestamp -> 아무것도 안 함 -> 버려짐
    }
}
```

##### State TTL이 필요한 이유

State는 Flink이 관리하는 인메모리(또는 RocksDB) 저장소다. TTL 없이 계속 timestamp를 쌓으면 메모리가 무한히 늘어난다. `StateTtlConfig`으로 5분간 업데이트가 없으면 해당 항목을 자동으로 삭제한다.

`OnCreateAndWrite`: State에 데이터를 쓸 때마다 TTL 타이머를 리셋한다. 즉, 5분 동안 같은 timestamp가 한 번도 안 들어오면 삭제된다. Flink 공식 문서에서는 이 외에 `OnReadAndWrite`(읽을 때도 리셋)와 `NeverReturnExpired`(만료된 State는 읽어도 null 반환) 옵션도 제공한다.

---

### 삽질 기록 (Gotchas)

#### 1. ValueState로 중복 제거 시도 -> 실패

처음에 `ValueState<Boolean>`으로 중복 제거를 시도했다.

```java
// 잘못된 접근 -- 이렇게 하면 안 된다
ValueState<Boolean> seen;

// symbol별로 true/false 하나만 저장됨
// 처음 데이터: seen = true (기록)
// 두 번째 데이터 (다른 timestamp): seen이 이미 true -> 통과 안 됨!
if (seen.value() == null) {
    seen.update(true);
    collector.collect(tsAgg);
}
```

`ValueState`는 키당 값 **하나**만 저장한다. symbol별로 "본 적 있다/없다" 단 하나의 Boolean만 저장되므로, 첫 번째 데이터를 보고 나면 그 symbol의 모든 후속 데이터가 중복으로 판정되어 버려진다. `MapState<timestamp, Boolean>`으로 교체해야 timestamp마다 독립적으로 중복 체크를 할 수 있다.

#### 2. String.format에서 BigDecimal 타입 불일치

```java
// 잘못된 코드 -- 컴파일은 되지만 런타임에 에러
out.collect(String.format("[%s] avgClose=%.2f", key, avgClose.toString()));

// 올바른 코드 -- BigDecimal 객체를 직접 전달
out.collect(String.format("[%s] avgClose=%.2f", key, avgClose));
```

`%.2f` 포맷 지시자는 `float`, `double`, `BigDecimal` 타입의 인자를 기대한다. `avgClose.toString()`으로 `String`을 넘기면 `IllegalFormatConversionException`이 발생한다. `BigDecimal` 객체를 그대로 넘기면 `String.format`이 내부적으로 처리한다.

#### 3. env.execute() 누락 (Ch05에서 또 반복)

Ch02 삽질 기록에도 적었는데 Ch05에서 또 실수했다. Flink는 Lazy Evaluation이라 `env.execute()`가 없으면 프로그램이 DAG를 구성하고 즉시 종료된다. 에러도 없고 출력도 없는 상태로 끝나기 때문에 원인을 찾기 어렵다. 파이프라인을 작성한 뒤에는 마지막 줄에 `env.execute("잡 이름")`이 있는지 항상 확인하자.

#### 4. Iterable에서 size() 호출 시도

```java
// 컴파일 에러 -- Iterable에는 size() 없음
int count = elements.size();  // 에러!

// 올바른 방법 -- for문으로 직접 카운트
int count = 0;
for (TSAgg o : elements) {
    count++;
}
```

`ProcessWindowFunction`의 `elements`는 `Iterable<T>` 타입이다. `Collection`과 달리 `Iterable`은 순회만 할 수 있어서 `size()`, `get(idx)` 등의 메서드가 없다. 이런 제약이 있는 이유는 Flink가 데이터를 메모리에 모두 올리지 않고 streaming 방식으로 노출할 수 있도록 설계했기 때문이다.

---

### 핵심 정리 (Key Takeaways)

1. **filter 체이닝:** 조건 하나당 `filter()` 하나를 쓰면 가독성이 좋다. 성능 차이는 없다.
2. **BigDecimal 비교는 `compareTo()`:** `>`, `<` 연산자는 기본 타입(int, double)에만 사용 가능하다.
3. **`"리터럴".equals(변수)` 순서:** 변수가 `null`일 때 NullPointerException을 막는 null-safe 관용구다.
4. **ProcessingTime vs EventTime:** 재처리 정확도가 중요하면 EventTime + Watermark를 써야 한다.
5. **Watermark의 타임스탬프 단위:** Flink는 밀리초 단위. 데이터가 초 단위라면 `* 1000` 변환 필수.
6. **SetState 없음 -> `MapState<K, Boolean>`:** Flink의 Keyed State에는 SetState가 없다. Map을 Set처럼 사용한다.
7. **State TTL 필수:** TTL 없이 State를 쌓으면 메모리가 무한 증가한다. 운영 환경에서는 반드시 설정해야 한다.
8. **`open()` vs `processElement()`:** `open()`은 State 초기화 등 잡 시작 시 한 번만 실행. `processElement()`는 데이터마다 실행된다.

---

### 다음 단계 (Next Steps)

- **Ch07: ProcessFunction & Timer** -- 윈도우 없이 타이머로 시간 기반 로직 구현
- **Ch08: Broadcast State** -- 설정/규칙 데이터를 모든 파티션에 공유하는 패턴
- **State Backend 변경** -- 기본 HashMap State Backend를 RocksDB로 교체해 대용량 State 처리
- **Checkpoint 설정** -- 잡 재시작 시 State와 offset을 복구하는 내결함성 설정

---

### Reference

- [Apache Flink DataStream API 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/overview/)
- [Apache Flink Watermarks 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/event-time/generating_watermarks/)
- [Apache Flink State & Fault Tolerance 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/state/)
