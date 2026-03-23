---
title: "Flink 스터디 Part 2 완결 (Ch23) - 프로덕션 파이프라인 최종 통합"
date: 2026-03-17
categories: [Flink]
tags: [Flink, Java, RocksDB, Checkpoint, ExactlyOnce, Kinesis, Parquet]
---

### 들어가며

Part 2의 마지막 챕터다. Ch14부터 Ch22까지 9개 챕터에 걸쳐 배운 것들을 단 하나의 파이프라인 파일로 조립한다.

새로운 API는 없다. 전부 기존에 배운 것들의 조합이다. 그런데 막상 합치면 생각지 못한 에러가 4~5개씩 터진다. 이 글은 그 에러들을 어떻게 잡아냈는지에 집중한다.

---

### 왜 통합 챕터가 필요한가

Part 1(Ch01~Ch13)은 기본기였다.

- Source → Filter → Window → Sink 흐름
- Event Time과 Watermark
- State와 중복 제거
- JDBC Sink, File Sink

Part 2(Ch14~Ch22)는 프로덕션 역량이다.

| Phase | 챕터 | 핵심 내용 |
|-------|------|----------|
| Sink 확장 | Ch14 | Parquet Sink (columnar 포맷, BulkFormat) |
| Sink 확장 | Ch15 | UPSERT + Dual Sink (동일 스트림 → 두 곳 동시 출력) |
| Sink 확장 | Ch16 | Table API & Flink SQL |
| 처리 패턴 | Ch17 | Gap Fill (Forward Fill + Timer) |
| 처리 패턴 | Ch18 | 다중 시간 집계 (5분/10분/1시간 캔들) |
| 처리 패턴 | Ch19 | VWAP & Broadcast Join |
| 인프라 | Ch20 | 공통 패키지 구조화 + maven-shade fat jar |
| 인프라 | Ch21 | 환경 분리(dev/prod) + Secret 관리 |
| 인프라 | Ch22 | Checkpoint, RocksDB, RestartStrategy, Web UI |
| **통합** | **Ch23** | **위 모든 것을 하나의 파이프라인으로** |

Part 1이 "동작하는 코드"를 목표로 했다면, Part 2는 "클러스터에 배포해도 괜찮은 코드"를 목표로 한다.

---

### 파이프라인 전체 구조

Ch23의 파이프라인은 아래 순서로 조립된다.

```
ConfigLoader.init(args)                   ← Ch21: --env dev|prod 환경 선택
createLocalEnvironmentWithWebUI()         ← Ch22: localhost:8081 모니터링
Checkpoint(30초) + EXACTLY_ONCE           ← Ch22: 정확한 처리 보장
RocksDB State Backend                     ← Ch22: 대규모 State 처리
RestartStrategy(3회, 3초)                 ← Ch22: 장애 자동 복구

KinesisSourceFactory.create(env)          ← Ch20: common 패키지 팩토리
TSAggFilter.apply(source)                 ← Ch20: spot + volume > 0 + stablecoin 정규화
assignTimestampsAndWatermarks             ← Ch05/Ch18: Event Time 기준 처리

keyBy(exchange:symbol)
  .window(TumblingEventTimeWindows, 5분)
  .aggregate(CandleAgg)                   ← Ch18: 캔들 집계 (O/H/L/C/V)
  .print()

filtered.sinkTo(parquetSink)              ← Ch14: 날짜별 폴더 파티셔닝
filtered.addSink(jdbcUpsertSink)          ← Ch15: ON CONFLICT DO UPDATE
```

전체 코드의 핵심부를 발췌하면 다음과 같다.

```java
// src/main/java/com/study/Ch23_ProductionPipeline.java

public static void main(String[] args) throws Exception {
    // 1. 환경 설정
    ConfigLoader.init(args);
    Configuration config = new Configuration();
    config.setString("rest.port", "8081");
    StreamExecutionEnvironment env =
        StreamExecutionEnvironment.createLocalEnvironmentWithWebUI(config);
    env.setParallelism(1);

    // 2. Checkpoint + RocksDB + Restart
    env.enableCheckpointing(30000);
    CheckpointConfig cpConfig = env.getCheckpointConfig();
    cpConfig.setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
    cpConfig.setCheckpointTimeout(60000);
    cpConfig.setMinPauseBetweenCheckpoints(5000);
    cpConfig.setMaxConcurrentCheckpoints(1);

    config.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
    config.set(CheckpointingOptions.CHECKPOINTS_DIRECTORY,
        "file:///tmp/flink-checkpoints");
    env.configure(config);
    env.setRestartStrategy(
        RestartStrategies.fixedDelayRestart(3, Time.of(3, TimeUnit.SECONDS)));

    // 3. Source → Filter → Watermark
    DataStreamSource<TSAgg> source = KinesisSourceFactory.create(env);
    SingleOutputStreamOperator<TSAgg> filtered = TSAggFilter.apply(source)
        .assignTimestampsAndWatermarks(
            WatermarkStrategy.<TSAgg>forBoundedOutOfOrderness(Duration.ofSeconds(10))
                .withTimestampAssigner((o, ts) -> o.getTimestamp() * 1000)
        );

    // 4. 5분 캔들 집계
    filtered
        .keyBy(o -> o.getExchange() + ":" + o.getSymbol())
        .window(TumblingEventTimeWindows.of(Duration.ofMinutes(5)))
        .aggregate(new CandleAgg())
        .print();

    // 5. Dual Sink
    FileSink<TSAgg> parquetSink = FileSink
        .forBulkFormat(new Path("./output"),
            AvroParquetWriters.forReflectRecord(TSAgg.class))
        .withBucketAssigner(new DateTimeBucketAssigner<>("yyyy-MM-dd"))
        .build();
    filtered.sinkTo(parquetSink);

    filtered.addSink(JdbcSink.sink(
        "INSERT INTO ts_agg (...) VALUES (...) "
            + "ON CONFLICT (exchange, symbol, timestamp) DO UPDATE SET ...",
        (stmt, o) -> { /* 바인딩 */ },
        JdbcExecutionOptions.builder()
            .withBatchSize(1000).withBatchIntervalMs(200).withMaxRetries(5).build(),
        new JdbcConnectionOptionsBuilder()
            .withUrl("jdbc:postgresql://localhost:5432/postgres")
            .withUsername("postgres")
            .withPassword(ConfigLoader.getDbPassword())
            .build()
    ));

    env.execute("Ch23 - Production Pipeline");
}
```

---

### 에러 해결 과정

통합 챕터에서 가장 기술적으로 의미있었던 에러를 정리한다.

#### RocksDB + 내부 클래스 접근 불가

**증상**: `CandleAccumulator`를 `static class`(package-private)로 선언했더니 RocksDB를 State Backend로 쓸 때 직렬화 실패.

```
java.lang.IllegalAccessError: failed to access class
  Ch23_ProductionPipeline$CandleAccumulator from class
  Ch23_ProductionPipeline$CandleAccumulatorConstructorAccess
  (... is in unnamed module of loader com.esotericsoftware.reflectasm.AccessClassLoader)
```

**원인**: Flink가 RocksDB에 State를 저장할 때 Kryo 직렬화를 쓴다. Kryo는 내부적으로 `reflectasm.AccessClassLoader`라는 별도 ClassLoader로 객체를 생성한다. 이 ClassLoader는 원래 클래스의 패키지 외부에 있기 때문에, package-private인 내부 클래스에 접근할 수 없다.

Ch18에서 같은 `CandleAccumulator`를 `static class`로 선언해도 문제없었던 이유는 **기본 HashMap State Backend**를 썼기 때문이다. HashMap Backend는 JVM 힙에서 직접 참조하므로 ClassLoader가 다를 일이 없다. RocksDB로 바꾸는 순간 Kryo의 별도 ClassLoader가 개입하면서 터진 것이다.

**해결**: `public static class`로 변경한다.

```java
// 변경 전 — package-private (기본 접근제어자)
static class CandleAccumulator { ... }

// 변경 후 — Kryo의 AccessClassLoader에서 접근 가능
public static class CandleAccumulator {
    String exchange, symbol;
    BigDecimal open, high, low, close, volume;
    int count;
}
```

기억할 점: **RocksDB State Backend를 쓸 때는 State에 저장되는 객체(누적기 포함)를 반드시 `public`으로 선언**해야 한다.

---

### 자주 묻는 질문

**Q. `CandleAccumulator`는 keyBy 키마다 공유되나?**

아니다. Flink는 `(exchange:symbol, 윈도우)` 조합마다 독립적인 누적기를 생성한다. `okx:BTC/USD`의 5분 윈도우와 `binance:ETH/USD`의 5분 윈도우는 완전히 별개의 `CandleAccumulator` 인스턴스를 갖는다.

**Q. `setCheckpointTimeout(60000)`의 의미는?**

체크포인트가 60초(1분) 안에 완료되지 않으면 실패로 처리한다. State가 매우 크거나 체크포인트 저장소(S3 등)가 느리면 이 시간을 넘길 수 있다. 실패한 체크포인트는 재시작 시 복구에 사용할 수 없으므로, 운영 환경에서는 State 크기와 저장소 성능을 고려해 적절히 늘려야 한다.

**Q. `maven-shade-plugin`이 왜 필요한가?**

로컬 IntelliJ 실행 시에는 classpath에 모든 의존성이 이미 있다. 하지만 실제 Flink 클러스터에 `flink run app.jar`로 배포할 때는 jar 하나에 모든 의존성이 포함되어 있어야 한다. shade 플러그인은 이 fat jar를 만든다. `ServicesResourceTransformer`는 여러 커넥터의 SPI 파일(`META-INF/services`)을 합쳐서 Flink가 커넥터를 인식할 수 있게 한다.

---

### Part 2 마무리 회고

Part 1은 "Flink가 뭔지 이해하는" 과정이었다. Part 2는 "실제 쓸 수 있는 파이프라인을 만드는" 과정이었다.

가장 인상 깊었던 것은, 같은 코드도 State Backend를 바꾸면 터진다는 점이다. `CandleAccumulator`를 `public`으로 만들어야 하는 이유는 Kryo의 ClassLoader 동작 때문이고, 이건 RocksDB를 쓰기 전까지는 절대 알 수 없다. 에러를 추적하고 원인을 찾는 과정이 단순히 코드를 실행하는 것보다 훨씬 많이 배웠다.

---

### Reference

  - `src/main/java/com/study/Ch23_ProductionPipeline.java`
  - `src/main/java/com/study/common/ConfigLoader.java`
  - `src/main/java/com/study/common/KinesisSourceFactory.java`
  - `src/main/java/com/study/common/TSAggFilter.java`
  - `docs/progress.md`
- 이전 포스트:
  - [Part 2 (Ch14-19) — Sink 확장 & 처리 패턴](/Flink/2026/03/16/flink-part2-sink-patterns-v2)
  - [Part 2 (Ch20-22) — 인프라: 프로젝트 구조화, 환경 분리, Checkpoint](/Flink/2026/03/16/flink-part2-infra-checkpoint-v2)
