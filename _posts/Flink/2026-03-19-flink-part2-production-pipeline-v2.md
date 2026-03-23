---
title: "Flink 스터디 Part 2 완결 - 프로덕션 파이프라인 최종 통합과 에러 해결기"
date: 2026-03-17
categories: [Flink]
tags: [Flink, Java, RocksDB, Checkpoint, ExactlyOnce, Kinesis, Parquet]
---

### 들어가며

Part 2의 마지막 챕터(Ch23)다. Ch14부터 Ch22까지 9개 챕터에 걸쳐 배운 것들을 단 하나의 파이프라인 파일로 조립한다.

새로운 API는 없다. 전부 기존에 배운 것들의 조합이다. 그런데 막상 합치면 생각지 못한 에러가 4~5개씩 터진다. 이 글은 **그 에러들을 어떻게 잡아냈는지**에 집중한다. 에러 하나하나의 원인을 추적하면서 Flink 내부 동작 원리를 더 깊이 이해하게 된 과정을 공유한다.

---

### 왜 통합 챕터가 필요한가

Part 1(Ch01~Ch13)은 기본기였다.

- Source -> Filter -> Window -> Sink 흐름
- Event Time과 Watermark
- State와 중복 제거
- JDBC Sink, File Sink

Part 2(Ch14~Ch22)는 프로덕션 역량이다.

| Phase | 챕터 | 핵심 내용 |
|-------|------|----------|
| Sink 확장 | Ch14 | Parquet Sink (columnar 포맷, BulkFormat) |
| Sink 확장 | Ch15 | UPSERT + Dual Sink (동일 스트림 -> 두 곳 동시 출력) |
| Sink 확장 | Ch16 | Table API & Flink SQL |
| 처리 패턴 | Ch17 | Gap Fill (Forward Fill + Timer) |
| 처리 패턴 | Ch18 | 다중 시간 집계 (5분/10분/1시간 캔들) |
| 처리 패턴 | Ch19 | VWAP & Broadcast Join |
| 인프라 | Ch20 | 공통 패키지 구조화 + maven-shade fat jar |
| 인프라 | Ch21 | 환경 분리(dev/prod) + Secret 관리 |
| 인프라 | Ch22 | Checkpoint, RocksDB, RestartStrategy, Web UI |
| **통합** | **Ch23** | **위 모든 것을 하나의 파이프라인으로** |

Part 1이 "동작하는 코드"를 목표로 했다면, Part 2는 "클러스터에 배포해도 괜찮은 코드"를 목표로 한다. Ch23은 그 증명이다.

---

### 파이프라인 전체 구조

Ch23의 파이프라인은 아래 순서로 조립된다. 각 단계 옆에 해당 개념을 다룬 챕터를 표기했다.

```
ConfigLoader.init(args)                   <- Ch21: --env dev|prod 환경 선택
createLocalEnvironmentWithWebUI()         <- Ch22: localhost:8081 모니터링
Checkpoint(30초) + EXACTLY_ONCE           <- Ch22: 정확한 처리 보장
RocksDB State Backend                     <- Ch22: 대규모 State 처리
RestartStrategy(3회, 3초)                 <- Ch22: 장애 자동 복구

KinesisSourceFactory.create(env)          <- Ch20: common 패키지 팩토리
TSAggFilter.apply(source)                 <- Ch20: spot + volume > 0 + stablecoin 정규화
assignTimestampsAndWatermarks             <- Ch05/Ch18: Event Time 기준 처리

keyBy(exchange:symbol)
  .window(TumblingEventTimeWindows, 5분)
  .aggregate(CandleAgg)                   <- Ch18: 캔들 집계 (O/H/L/C/V)
  .print()

filtered.sinkTo(parquetSink)              <- Ch14: 날짜별 폴더 파티셔닝
filtered.addSink(jdbcUpsertSink)          <- Ch15: ON CONFLICT DO UPDATE
```

#### 핵심 코드

전체 코드의 핵심부를 발췌하면 다음과 같다. 주석으로 각 블록의 역할을 표시했다.

```java
// src/main/java/com/study/Ch23_ProductionPipeline.java

public static void main(String[] args) throws Exception {
    // ── 1. 환경 설정 ──────────────────────────────────────
    ConfigLoader.init(args);
    Configuration config = new Configuration();
    config.setString("rest.port", "8081");
    StreamExecutionEnvironment env =
        StreamExecutionEnvironment.createLocalEnvironmentWithWebUI(config);
    env.setParallelism(1);

    // ── 2. Checkpoint + RocksDB + Restart Strategy ───────
    env.enableCheckpointing(30_000); // 30초 간격
    CheckpointConfig cpConfig = env.getCheckpointConfig();
    cpConfig.setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
    cpConfig.setCheckpointTimeout(60_000);        // 1분 내 미완료 시 실패 처리
    cpConfig.setMinPauseBetweenCheckpoints(5_000); // 체크포인트 간 최소 5초 간격
    cpConfig.setMaxConcurrentCheckpoints(1);       // 동시 실행 1개로 제한

    config.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
    config.set(CheckpointingOptions.CHECKPOINTS_DIRECTORY,
        "file:///tmp/flink-checkpoints");
    env.configure(config);
    env.setRestartStrategy(
        RestartStrategies.fixedDelayRestart(3, Time.of(3, TimeUnit.SECONDS)));

    // ── 3. Source -> Filter -> Watermark ──────────────────
    DataStreamSource<TSAgg> source = KinesisSourceFactory.create(env);
    SingleOutputStreamOperator<TSAgg> filtered = TSAggFilter.apply(source)
        .assignTimestampsAndWatermarks(
            WatermarkStrategy.<TSAgg>forBoundedOutOfOrderness(Duration.ofSeconds(10))
                .withTimestampAssigner((o, ts) -> o.getTimestamp() * 1000)
        );

    // ── 4. 5분 캔들 집계 ─────────────────────────────────
    filtered
        .keyBy(o -> o.getExchange() + ":" + o.getSymbol())
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(5)))
        .aggregate(new CandleAgg())
        .print();

    // ── 5. Dual Sink: Parquet + JDBC ─────────────────────
    FileSink<TSAgg> parquetSink = FileSink
        .forBulkFormat(new Path("./output"),
            AvroParquetWriters.forReflectRecord(TSAgg.class))
        .withBucketAssigner(new DateTimeBucketAssigner<>("yyyy-MM-dd"))
        .build();
    filtered.sinkTo(parquetSink);

    filtered.addSink(JdbcSink.sink(
        "INSERT INTO ts_agg (...) VALUES (...) "
            + "ON CONFLICT (exchange, symbol, timestamp) DO UPDATE SET ...",
        (stmt, o) -> { /* PreparedStatement 바인딩 */ },
        JdbcExecutionOptions.builder()
            .withBatchSize(1000)
            .withBatchIntervalMs(200)
            .withMaxRetries(5)
            .build(),
        new JdbcConnectionOptionsBuilder()
            .withUrl("jdbc:postgresql://localhost:5432/postgres")
            .withUsername("postgres")
            .withPassword(ConfigLoader.getDbPassword())
            .build()
    ));

    env.execute("Ch23 - Production Pipeline");
}
```

> **참고**: `JdbcSink.sink()`는 at-least-once 시맨틱이다. exactly-once가 필요하면 `JdbcSink.exactlyOnceSink()`와 XA DataSource를 사용해야 한다. 이 파이프라인에서는 UPSERT(`ON CONFLICT DO UPDATE`)로 멱등성을 확보했기 때문에, at-least-once로도 결과 정합성이 보장된다.

---

### 에러 해결 과정

통합 챕터에서 만난 에러들이 이 글의 핵심이다. 각각 어디서 왜 터지는지, 그리고 그 원인이 Flink의 어떤 내부 동작과 연결되는지를 설명한다.

#### 에러 1 -- RocksDB + 내부 클래스 접근 불가

**증상**: `CandleAccumulator`를 `static class`(package-private)로 선언했더니 RocksDB State Backend 사용 시 직렬화 실패.

**원인**: Flink가 RocksDB에 State를 저장할 때 Kryo 직렬화를 사용한다. Kryo는 내부적으로 `reflectasm.AccessClassLoader`라는 별도 ClassLoader로 객체를 생성하는데, 이 ClassLoader는 원래 클래스의 패키지 외부에 위치한다. 따라서 package-private(기본 접근제어자)인 내부 클래스에 접근할 수 없어 직렬화가 실패한다.

> HashMap State Backend에서는 이 에러가 발생하지 않는다. HashMap은 Java 힙 메모리에 객체 참조를 직접 저장하므로 직렬화 과정을 거치지 않기 때문이다. RocksDB는 네이티브 메모리에 바이트 배열로 저장하므로 반드시 직렬화가 필요하다.

**해결**: `public static class`로 변경한다.

```java
// 변경 전 -- package-private (기본 접근제어자)
static class CandleAccumulator { ... }

// 변경 후 -- Kryo의 AccessClassLoader에서 접근 가능
public static class CandleAccumulator {
    public String exchange, symbol;
    public BigDecimal open, high, low, close, volume;
    public int count;
}
```

**기억할 점**: RocksDB State Backend를 쓸 때는 State에 저장되는 모든 객체(누적기 포함)와 그 필드를 `public`으로 선언해야 한다.

#### 에러 2 -- `CandleAgg.add()`에서 NPE (null 반환)

**증상**: `add()` 메서드가 `return null`을 반환하자 다음 호출에서 NPE 발생.

**원인**: DataStream API의 `AggregateFunction.add()`는 반드시 누적기(accumulator)를 반환해야 한다. Flink는 이 반환값을 다음 `add()` 호출의 누적기 인자로 전달한다. `null`을 반환하면 다음 호출에서 `null.count` 같은 접근이 발생한다.

```
add(value1, acc) -> null    // 잘못된 반환
add(value2, null) -> NPE!   // Flink가 null을 다음 호출에 전달
```

> **공식 문서 패턴과 비교**: Flink 공식 예제에서는 `add()` 내에서 새로운 Tuple을 생성하여 반환한다 (예: `return new Tuple2<>(acc.f0 + value.f1, acc.f1 + 1L)`). 커스텀 POJO를 사용할 때는 기존 accumulator를 변경 후 그대로 반환하는 패턴도 유효하지만, 어느 쪽이든 **절대 null을 반환하면 안 된다**.

**해결**: `return null` -> `return acc`로 수정.

#### 에러 3 -- `count++` 누락으로 초기화 분기가 매번 실행됨

**증상**: 모든 데이터에서 `open`, `high`, `low`가 매번 초기화되어 5분 캔들이 아니라 마지막 1분봉만 출력됨.

**원인**: `add()` 안에서 `count == 0` 분기로 첫 데이터를 초기화하는데, `count++`를 빠뜨리면 `count`가 계속 0이라 매번 초기화 분기가 실행된다. 결과적으로 매 레코드마다 open이 덮어씌워지고, 윈도우 내 최초 가격 정보가 유실된다.

**해결**: `count` 비교 이후 반드시 `acc.count++`를 추가한다.

#### 에러 4 -- `high`/`low` 초기화 누락으로 NPE

**증상**: `acc.high.max(value.getHigh())`에서 NPE 발생.

**원인**: `count == 0`인 첫 번째 데이터 처리 시 `high`, `low`를 초기화하지 않으면 `null` 상태에서 `BigDecimal.max()` 호출이 발생한다. `BigDecimal`은 primitive가 아니므로 기본값이 `null`이다.

**해결**: `count == 0` 분기 안에 `acc.high = value.getHigh()`, `acc.low = value.getLow()` 초기화를 반드시 포함한다.

#### 최종 `add()` 구현

에러 2~4를 모두 반영한 최종 코드다. 주석으로 각 에러와의 대응 관계를 표시했다.

```java
@Override
public CandleAccumulator add(TSAgg value, CandleAccumulator acc) {
    if (acc.count == 0) {
        // [에러 4 방지] 첫 데이터에서 모든 필드를 초기화
        acc.open = value.getOpen();
        acc.high = value.getHigh();
        acc.low  = value.getLow();
    }
    acc.exchange = value.getExchange();
    acc.symbol   = value.getSymbol();
    acc.high   = acc.high.max(value.getHigh());
    acc.low    = acc.low.min(value.getLow());
    acc.close  = value.getClose();
    acc.volume = acc.volume == null
        ? value.getVolume()
        : acc.volume.add(value.getVolume());
    acc.count++;    // [에러 3 방지] 누락하면 매번 초기화 분기 실행
    return acc;     // [에러 2 방지] null 반환 금지 -- Flink가 다음 호출에 이 값을 전달
}
```

#### 에러 5 -- keyBy 키 공백 불일치

**증상**: 다른 챕터에서는 `"okx:BTC/USD"` 형태였는데 Ch23에서는 `"okx: BTC/USD"` (콜론 뒤 공백 있음)로 출력됨.

**원인**: `keyBy(o -> o.getExchange() + ":" + o.getSymbol())`에서 공백 없이 조합했지만, 소스 데이터의 `exchange` 필드 값 자체에 trailing 공백이 포함된 경우 불일치가 생긴다. 서로 다른 챕터에서 데이터를 다르게 전처리했다면 키 형식이 달라질 수 있다.

**해결**: keyBy 키 생성 시 `trim()`을 적용한다.

```java
// 방어적 키 생성
.keyBy(o -> o.getExchange().trim() + ":" + o.getSymbol().trim())
```

이런 종류의 버그는 통합 테스트에서만 드러난다. 개별 챕터에서는 데이터가 깨끗해서 문제가 없었기 때문이다.

---

### 자주 묻는 질문

**Q. `CandleAccumulator`는 keyBy 키마다 공유되나?**

아니다. Flink는 `(exchange:symbol, 윈도우)` 조합마다 독립적인 누적기를 생성한다. `okx:BTC/USD`의 5분 윈도우와 `binance:ETH/USD`의 5분 윈도우는 완전히 별개의 `CandleAccumulator` 인스턴스를 갖는다. 이것은 `AggregateFunction.createAccumulator()`가 각 키+윈도우 조합마다 호출되기 때문이다.

**Q. `setCheckpointTimeout(60000)`의 의미는?**

체크포인트가 60초(1분) 안에 완료되지 않으면 실패로 처리한다. State가 매우 크거나 체크포인트 저장소(S3 등)가 느리면 이 시간을 넘길 수 있다. 실패한 체크포인트는 재시작 시 복구에 사용할 수 없으므로, 운영 환경에서는 State 크기와 저장소 성능을 고려해 적절히 늘려야 한다.

**Q. `maven-shade-plugin`이 왜 필요한가?**

로컬 IntelliJ 실행 시에는 classpath에 모든 의존성이 이미 있다. 하지만 실제 Flink 클러스터에 `flink run app.jar`로 배포할 때는 jar 하나에 모든 의존성이 포함되어 있어야 한다. shade 플러그인은 이 fat jar를 만든다. `ServicesResourceTransformer`는 여러 커넥터의 SPI 파일(`META-INF/services`)을 합쳐서 Flink가 커넥터를 인식할 수 있게 한다.

**Q. `JdbcSink.sink()`와 `JdbcSink.exactlyOnceSink()`의 차이는?**

`JdbcSink.sink()`는 at-least-once 시맨틱이다. 장애 복구 시 동일 레코드가 중복 삽입될 수 있다. `JdbcSink.exactlyOnceSink()`는 XA 트랜잭션을 사용하여 exactly-once를 보장하지만, XA를 지원하는 DataSource가 필요하고 설정이 복잡하다. 이 파이프라인처럼 UPSERT(`ON CONFLICT DO UPDATE`)를 사용하면 중복 삽입이 업데이트로 처리되므로, at-least-once로도 결과적으로 정확한 데이터를 유지할 수 있다.

---

### Part 2 마무리 회고

Part 1은 "Flink가 뭔지 이해하는" 과정이었다. Part 2는 "실제 쓸 수 있는 파이프라인을 만드는" 과정이었다.

가장 인상 깊었던 것은 에러들이 대부분 단순한 실수처럼 보이지만, 그 배경에는 Flink의 동작 원리가 있다는 점이다.

- `CandleAccumulator`를 `public`으로 만들어야 하는 이유 -- Kryo의 ClassLoader 동작 원리
- `return null`이 NPE를 일으키는 이유 -- `AggregateFunction.add()`의 누적기 전달 방식
- `count++` 누락이 왜 단순 버그가 아닌지 -- 상태 기반 초기화 패턴의 이해
- 공백 하나의 차이가 키 불일치를 만드는 이유 -- 분산 처리에서의 데이터 정규화 중요성

에러를 추적하고 원인을 찾는 과정이 단순히 코드를 실행하는 것보다 훨씬 많이 배웠다. "왜 이렇게 동작하는가?"를 파고들 때 비로소 프레임워크가 도구에서 무기로 바뀐다.

---

### Reference

  - `src/main/java/com/study/Ch23_ProductionPipeline.java`
  - `src/main/java/com/study/common/ConfigLoader.java`
  - `src/main/java/com/study/common/KinesisSourceFactory.java`
  - `src/main/java/com/study/common/TSAggFilter.java`
  - `docs/progress.md`
- 이전 포스트:
  - [Part 2 (Ch14-19) -- Sink 확장 & 처리 패턴](/Flink/2026/03/16/flink-part2-sink-patterns-v2)
  - [Part 2 (Ch20-22) -- 인프라: 프로젝트 구조화, 환경 분리, Checkpoint](/Flink/2026/03/16/flink-part2-infra-checkpoint-v2)
- 공식 문서:
  - [Flink AggregateFunction (Window Operators)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/operators/windows/#aggregatefunction)
  - [Flink Checkpointing Configuration](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/checkpointing/)
  - [Flink JDBC Connector](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/jdbc/)
  - [Flink FileSink](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/filesystem/)
  - [Flink State Backend (RocksDB)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/state_backends/)
