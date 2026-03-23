---
title: "Flink 스터디 Part 2 Ch14-19 - Parquet Sink, Table API, Gap Fill, VWAP"
date: 2026-03-16
categories: [Flink]
tags: [Flink, Java, Parquet, TableAPI, FlinkSQL, GapFill, VWAP]
---

### 들어가며

Part 1(Ch01-Ch13)에서 Flink의 기본기를 익혔다면, Part 2는 프로덕션 파이프라인에 가까운 패턴들을 다룬다. 실제 Kinesis 스트림에서 시계열 집계(Time-Series Aggregation) 암호화폐 데이터를 읽어서, Parquet로 저장하고, SQL로 집계하고, 빠진 데이터를 채우고, VWAP을 계산하고, 환율 데이터를 실시간으로 결합한다.

챕터별 요약은 다음과 같다.

- Ch14: Parquet 포맷으로 S3에 저장하는 FileSink
- Ch15: 중복 방지 UPSERT와 두 곳에 동시 출력하는 Dual Sink
- Ch16: DataStream 위에 SQL 쿼리를 얹는 Table API
- Ch17: 빠진 시간대를 마지막 값으로 채우는 Gap Fill
- Ch18: 같은 스트림에서 5분/10분/1시간 캔들을 동시 생성
- Ch19: VWAP 계산과 환율 참조 데이터를 결합하는 Broadcast Join

---

### Ch14: S3 Parquet Sink

#### 왜 Parquet인가

CSV나 JSON은 텍스트라 용량이 크고 쿼리도 느리다. Parquet은 컬럼 기반 바이너리 포맷이라 용량이 작고, Spark나 Athena로 특정 컬럼만 읽을 때 나머지 컬럼을 아예 읽지 않아도 된다. 대용량 시계열 데이터를 S3에 저장할 때 사실상 표준이다.

Flink에서 Parquet로 쓰려면 `FileSink.forBulkFormat()`에 `AvroParquetWriters.forReflectRecord()`를 결합한다. `forReflectRecord`는 Java POJO의 필드를 리플렉션으로 스캔해서 Parquet 컬럼으로 자동 변환한다.

```java
// src/main/java/com/study/Ch14_ParquetSink.java

// 체크포인트 활성화 -- BulkFormat은 체크포인트마다 .inprogress -> 완성 파일로 전환
env.enableCheckpointing(10000);

// Parquet Sink -- 날짜별 폴더 파티셔닝 (output/2026-03-15/)
Path path = new Path("./output");
FileSink<TSAgg> sink = FileSink
    .<TSAgg>forBulkFormat(path, AvroParquetWriters.forReflectRecord(TSAgg.class))
    .withBucketAssigner(new DateTimeBucketAssigner<TSAgg>("yyyy-MM-dd"))
    .build();

filtered.sinkTo(sink);  // 새 Sink API (FLIP-143)
```

Row Format(`forRowFormat`)은 Rolling Policy로 파일 크기나 시간을 기준으로 파일을 닫을 수 있다. 반면 Bulk Format(`forBulkFormat`)은 `OnCheckpointRollingPolicy`만 지원한다. 즉 **체크포인트가 발생하는 시점이 파일이 완성되는 시점**이다. 체크포인트 간격을 조절해서 파일 생성 주기를 제어한다.

#### 의존성 지옥

Parquet 의존성은 줄줄이 딸려온다. `flink-parquet`을 추가하면 `parquet-avro`가 필요하고, `parquet-avro`는 `avro`를 transitive dependency로 가져오지만, Parquet 내부에서 Hadoop Configuration 클래스를 참조하기 때문에 `hadoop-client`도 별도로 추가해야 한다.

문제는 `hadoop-client`가 `slf4j-reload4j`를 끌고 온다는 점이다. 프로젝트에 이미 `log4j2`를 쓰고 있다면 두 SLF4J 구현체가 충돌한다. `exclusion`으로 제거해야 한다.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.apache.hadoop</groupId>
    <artifactId>hadoop-client</artifactId>
    <version>3.3.6</version>
    <exclusions>
        <!-- log4j2와 충돌하는 reload4j 제거 -->
        <exclusion>
            <groupId>org.slf4j</groupId>
            <artifactId>slf4j-reload4j</artifactId>
        </exclusion>
    </exclusions>
</dependency>
```

프로덕션에서는 parent pom이나 BOM(Bill of Materials)으로 버전을 한 곳에서 관리하는 것이 낫다. 의존성이 많아질수록 버전 충돌 추적이 어려워진다.

#### JDK 17 VM 옵션

JDK 17 + FileSink 조합에서 체크포인트 직렬화 시 `InaccessibleObjectException`이 발생할 수 있다. FileSink 내부의 체크포인트 직렬화가 Kryo를 사용하고, Kryo가 `java.util` 패키지에 리플렉션으로 접근하려다 JDK 17 모듈 시스템에 막히는 것이다.

VM 옵션으로 해제해야 한다.

```
--add-opens java.base/java.util=ALL-UNNAMED
```

---

### Ch15: UPSERT & Dual Sink

#### UPSERT — at-least-once 대응

Flink의 기본 시맨틱은 at-least-once다. 장애 후 재시작하면 같은 데이터가 두 번 들어올 수 있다. DB에 단순 INSERT를 쓰면 중복 레코드가 생긴다.

PostgreSQL의 `ON CONFLICT DO UPDATE`(UPSERT)로 중복을 막는다. PK 충돌 시 INSERT 대신 UPDATE를 실행한다. `EXCLUDED`는 INSERT 하려던 새 값을 참조하는 PostgreSQL 키워드다.

```sql
INSERT INTO ts_agg (exchange, symbol, market_type, timestamp, open, high, low, close, volume)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (exchange, symbol, timestamp) DO UPDATE SET
    open = EXCLUDED.open,
    high = EXCLUDED.high,
    low  = EXCLUDED.low,
    close = EXCLUDED.close,
    volume = EXCLUDED.volume
```

#### Dual Sink — 스트림 분기

같은 스트림을 Parquet 파일과 PostgreSQL 두 곳에 동시에 저장하고 싶을 때, 별도로 스트림을 복제할 필요가 없다. 같은 스트림 변수에 Sink를 두 번 연결하면 Flink가 내부적으로 분기를 처리한다.

```java
// src/main/java/com/study/Ch15_UpsertDualSink.java

// Sink 1: Parquet (새 API)
filtered.sinkTo(parquetSink);

// Sink 2: JDBC UPSERT (구 API) — 같은 filtered에 연결, Flink이 내부적으로 분기
filtered.addSink(JdbcSink.sink(upsertSql, ...));
```

여기서 `sinkTo()`와 `addSink()`가 혼재하는 게 눈에 띈다. `FileSink`는 FLIP-143으로 도입된 새 Sink API라 `sinkTo()`를 쓴다. `JdbcSink`는 아직 새 API로 마이그레이션이 안 돼서 `addSink()`를 써야 한다. `JdbcSink`에 `sinkTo()`를 쓰면 컴파일 에러가 난다.

---

### Ch16: Table API & Flink SQL

#### DataStream과 SQL을 함께 쓰기

복잡한 로직(State, Timer)은 DataStream API가 적합하고, 집계나 필터링은 SQL이 더 간결하다. Flink는 둘을 한 파이프라인에서 섞어 쓸 수 있다.

`StreamTableEnvironment`를 생성하면 기존 `StreamExecutionEnvironment` 위에 Table API 레이어가 추가된다. DataStream을 `fromDataStream()`으로 테이블로 변환하면 POJO 필드가 자동으로 컬럼이 된다.

```java
// src/main/java/com/study/Ch16_TableApiSql.java

// Table API 레이어 추가
StreamTableEnvironment tableEnv = StreamTableEnvironment.create(env);

// DataStream -> Table (TSAgg POJO 필드가 자동으로 컬럼이 됨)
Table table = tableEnv.fromDataStream(filtered);
tableEnv.createTemporaryView("ts_agg", table);

// SQL 집계 — Ch10에서 AggregateFunction으로 30줄 짠 걸 한 줄로
Table resultTable = tableEnv.sqlQuery(
    "SELECT exchange, COUNT(*) AS cnt, AVG(`close`) AS avg_close FROM ts_agg GROUP BY exchange"
);

// Table -> DataStream
tableEnv.toChangelogStream(resultTable).print();
```

#### close는 SQL 예약어

`TSAgg` 모델의 `close` 필드를 SQL에서 그대로 쓰면 파싱 에러가 난다. `close`는 SQL 예약어이기 때문이다. 백틱(`)으로 이스케이프해야 한다.

```sql
-- 에러: close가 예약어라 파싱 실패
SELECT AVG(close) FROM ts_agg

-- 정상: 백틱으로 이스케이프
SELECT AVG(`close`) FROM ts_agg
```

#### toDataStream vs toChangelogStream

`GROUP BY` 집계 결과는 새 데이터가 들어올 때마다 값이 바뀐다. `toDataStream()`은 insert-only 스트림만 지원하기 때문에, 집계 결과처럼 업데이트가 발생하는 데이터에 쓰면 에러가 난다.

`toChangelogStream()`을 써야 한다. Changelog 스트림은 세 가지 종류의 메시지로 변화를 표현한다.

| 타입 | 의미 |
|------|------|
| `+I` | INSERT: 새로 추가된 값 |
| `-U` | UPDATE_BEFORE: 이전 값 철회 |
| `+U` | UPDATE_AFTER: 갱신된 새 값 |

실시간 집계 대시보드에서 Changelog를 받아서 `-U`가 오면 이전 값을 지우고, `+U`가 오면 새 값으로 갱신하는 식으로 활용한다.

---

### Ch17: Gap Fill (데이터 보간)

#### 왜 보간이 필요한가

거래소 장애나 네트워크 문제로 1분봉 데이터가 빠지는 일이 생긴다. 이 상태로 차트를 그리면 끊기고, 이동평균 같은 집계도 틀어진다. 빠진 구간을 직전 값으로 채우는 Forward Fill이 가장 단순하고 많이 쓰이는 방법이다.

#### KeyedProcessFunction + ValueState + Timer 조합

Gap Fill은 Ch06(State)과 Ch07(Timer)의 실전 응용이다. 각 거래소+종목 키별로 독립적으로 동작해야 하므로 `KeyedProcessFunction`을 쓴다.

동작 흐름은 두 단계다.

1. **데이터가 오면:** State에 저장 + 다음 예상 시각(현재 + 60초 + 10초 여유)에 타이머 등록 + 그대로 통과
2. **타이머가 발동하면(= 데이터가 안 옴):** State에서 마지막 값을 꺼내 새 객체로 복제 + volume=0 + 다음 타이머 재등록

```java
// src/main/java/com/study/Ch17_GapFill.java

@Override
public void processElement(TSAgg value, Context ctx, Collector<TSAgg> out) throws Exception {
    lastState.update(value);
    ctx.timerService().registerProcessingTimeTimer(
        ctx.timerService().currentProcessingTime() + INTERVAL_MS + TOLERANCE_MS
    );
    out.collect(value);
}

@Override
public void onTimer(long timestamp, OnTimerContext ctx, Collector<TSAgg> out) throws Exception {
    TSAgg last = lastState.value();
    if (last == null) return;

    // 새 객체로 만들어야 State 원본이 오염되지 않음
    TSAgg filled = new TSAgg();
    long now = ctx.timerService().currentProcessingTime();
    filled.setOpen(last.getClose());   // Forward Fill: 마지막 close로 OHLC 채움
    filled.setHigh(last.getClose());
    filled.setLow(last.getClose());
    filled.setClose(last.getClose());
    filled.setVolume(BigDecimal.ZERO); // 실제 거래가 없었으므로 0
    filled.setTimestamp(now);
    // ... (나머지 필드 복사)

    // 연속 gap 대응: 다음 타이머 재등록
    ctx.timerService().registerProcessingTimeTimer(now + INTERVAL_MS + TOLERANCE_MS);
    out.collect(filled);
}
```

#### State 원본 오염 주의

`onTimer`에서 `lastState.value()`로 꺼낸 객체를 직접 수정하면 State에 저장된 원본이 바뀐다. 다음 타이머가 발동했을 때 잘못된 값을 읽게 된다. 반드시 새 객체를 만들어서 필드를 하나씩 복사해야 한다.

Flink의 ValueState는 참조를 반환하기 때문에 get한 객체를 수정하면 State도 바뀐다. "State에서 꺼낸 객체는 복사 후 수정"이 기본 원칙이다.

---

### Ch18: 다중 시간 집계

#### 같은 스트림에서 여러 시간 프레임 동시 생성

트레이딩 대시보드는 5분봉, 15분봉, 1시간봉을 동시에 보여준다. 각 시간 프레임마다 별도 파이프라인을 만들면 비효율적이다. Flink에서는 같은 keyed 스트림에 윈도우 크기만 다르게 적용하면 된다.

```java
// src/main/java/com/study/Ch18_MultiTimeAgg.java

KeyedStream<TSAgg, String> keyed = withWatermark
    .keyBy(o -> o.getExchange() + ":" + o.getSymbol());

// 같은 keyed 스트림에 크기만 다르게 -- 각각 독립된 파이프라인
keyed.window(TumblingEventTimeWindows.of(Duration.ofMinutes(5))).aggregate(new TSAggCandleAgg()).print("5m");
keyed.window(TumblingEventTimeWindows.of(Duration.ofMinutes(10))).aggregate(new TSAggCandleAgg()).print("10m");
keyed.window(TumblingEventTimeWindows.of(Duration.ofHours(1))).aggregate(new TSAggCandleAgg()).print("1h");
```

세 줄이 각각 독립된 파이프라인을 만든다. 누적기를 공유하지 않는다. 5분봉이 닫혀도 10분봉과 1시간봉의 누적기는 계속 데이터를 모은다.

#### 캔들 집계의 함정: low 초기화

`AggregateFunction`의 누적기에서 low(최저가)를 초기화할 때 실수하기 쉽다.

```java
// src/main/java/com/study/Ch18_MultiTimeAgg.java

@Override
public CandleAccumulator add(TSAgg value, CandleAccumulator acc) {
    if (acc.count == 0) {
        acc.open = value.getOpen();
        acc.high = value.getHigh();
        acc.low  = value.getLow();   // 첫 데이터로 초기화해야 함
    }
    acc.high = acc.high.max(value.getHigh());
    acc.low  = acc.low.min(value.getLow());   // BigDecimal 인스턴스 메서드
    acc.close = value.getClose();             // 마지막 값이 계속 덮어씀
    // ...
}
```

`CandleAccumulator`를 생성했을 때 `low`는 `null`이다. `createAccumulator()`에서 `low = BigDecimal.ZERO`로 초기화하면 `min()` 비교에서 항상 0이 최솟값이 되어 모든 캔들의 low가 0으로 찍힌다. `count == 0` 분기에서 첫 데이터의 low로 초기화해야 한다.

#### merge()는 언제 불리나

`AggregateFunction`의 `merge()` 메서드는 Session Window에서 두 세션이 합쳐질 때 호출된다. Tumbling Window와 Sliding Window에서는 불리지 않는다. 이번 챕터처럼 Tumbling Window만 쓴다면 `merge()`는 구현해도 실제로 호출되지 않는다.

---

### Ch19: VWAP & Broadcast Join

#### VWAP 계산

VWAP(Volume Weighted Average Price)은 거래량으로 가중치를 준 평균 가격이다. 기관 트레이더들이 현재가 대비 비싸게 사고 있는지 싸게 사고 있는지 판단할 때 쓰는 지표다.

공식: `VWAP = Σ(close × volume) / Σ(volume)`

`AggregateFunction`으로 구현할 때 누적기에 두 합계를 모두 담아야 한다.

```java
// src/main/java/com/study/Ch19_VwapBroadcast.java

static class VwapAccumulator {
    BigDecimal sumPriceVolume;  // close × volume 합
    BigDecimal sumVolume;       // volume 합
    String exchange, symbol;
}

@Override
public VwapAccumulator createAccumulator() {
    VwapAccumulator acc = new VwapAccumulator();
    acc.sumPriceVolume = BigDecimal.ZERO;  // null 방지 — ZERO로 초기화
    acc.sumVolume = BigDecimal.ZERO;
    return acc;
}

@Override
public String getResult(VwapAccumulator acc) {
    BigDecimal vwap = acc.sumVolume.compareTo(BigDecimal.ZERO) == 0
        ? BigDecimal.ZERO
        : acc.sumPriceVolume.divide(acc.sumVolume, 2, RoundingMode.HALF_UP);
    return String.format("[%s:%s] VWAP=%.2f", acc.exchange, acc.symbol, vwap);
}
```

`BigDecimal` 나눗셈은 반드시 `scale`과 `RoundingMode`를 지정해야 한다. 지정하지 않으면 나누어 떨어지지 않는 경우 `ArithmeticException`이 발생한다.

#### Broadcast Join — 환율 참조 데이터 결합

환율처럼 느리게 변하는 참조 데이터를 실시간 스트림과 결합할 때 Broadcast Join을 쓴다. 참조 데이터를 브로드캐스트해서 모든 파티션이 공유하는 State에 저장하고, 메인 스트림이 올 때마다 읽어서 결합한다.

```java
// src/main/java/com/study/Ch19_VwapBroadcast.java

// MapStateDescriptor: main()과 ProcessFunction에서 같은 descriptor 공유 (static final)
static final MapStateDescriptor<String, BigDecimal> RATE_DESCRIPTOR =
    new MapStateDescriptor<>("currency-rates",
        BasicTypeInfo.STRING_TYPE_INFO, BasicTypeInfo.BIG_DEC_TYPE_INFO);

// 환율 데이터를 브로드캐스트 스트림으로 변환
BroadcastStream<Tuple2<String, BigDecimal>> broadcast = env.fromElements(
    Tuple2.of("USD", BigDecimal.ONE),
    Tuple2.of("KRW", new BigDecimal("0.00075"))
).broadcast(RATE_DESCRIPTOR);

// 메인 스트림과 브로드캐스트 연결
keyed.connect(broadcast)
    .process(new RateJoinFunction())
    .print("joined");
```

`RateJoinFunction` 안에서 두 메서드의 역할이 다르다.

| 메서드 | 호출 시점 | State 접근 |
|--------|-----------|------------|
| `processBroadcastElement` | 환율 데이터 도착 | 쓰기 가능 |
| `processElement` | TSAgg 데이터 도착 | 읽기 전용(ReadOnly) |

이 비대칭 설계는 의도적이다. 브로드캐스트 State는 모든 파티션이 공유하기 때문에, 메인 스트림 처리 중에 State를 수정하면 파티션 간 불일치가 생길 수 있다. 쓰기는 브로드캐스트 요소가 올 때만 허용한다.

한 가지 주의할 점이 있다. 환율 데이터가 TSAgg 데이터보다 늦게 도착하면 join이 되지 않는다. 실환경에서는 파이프라인 시작 시 참조 데이터를 먼저 로딩하거나, null 체크 후 join 실패를 별도 처리해야 한다.

---

### 트러블슈팅 요약

| 챕터 | 현상 | 원인 | 해결 |
|------|------|------|------|
| Ch14 | `slf4j` 충돌 | `hadoop-client`가 `slf4j-reload4j`를 끌고 옴 | pom.xml에서 `exclusion` 처리 |
| Ch14 | `InaccessibleObjectException` | JDK 17 + Kryo 리플렉션 충돌 | VM 옵션 `--add-opens java.base/java.util=ALL-UNNAMED` 추가 |
| Ch15 | `sinkTo()` 컴파일 에러 | `JdbcSink`는 아직 새 API 미지원 | `addSink()` 사용 |
| Ch16 | SQL 파싱 에러 | `close`가 SQL 예약어 | 백틱(`)으로 이스케이프: `` `close` `` |
| Ch16 | `toDataStream()` 에러 | GROUP BY 결과는 update 발생 | `toChangelogStream()` 사용 |
| Ch17 | 보간 값 오염 | State 객체를 직접 수정 | 새 객체 생성 후 필드 복사 |
| Ch18 | low가 항상 0 | `CandleAccumulator.low`를 ZERO로 초기화 | `count == 0` 분기에서 첫 데이터의 low로 초기화 |
| Ch19 | `ArithmeticException` | `BigDecimal.divide()` 에서 scale 미지정 | `divide(divisor, 2, RoundingMode.HALF_UP)` |

---

### 핵심 정리

1. **BulkFormat FileSink는 체크포인트가 파일 분할 시점이다.** 체크포인트 간격으로 파일 생성 주기를 제어한다.
2. **의존성은 줄줄이 딸려온다.** Parquet → Avro → Hadoop. 로깅 충돌은 `exclusion`으로 해결한다.
3. **Dual Sink는 같은 스트림에 두 번 연결하면 된다.** Flink가 내부적으로 분기를 처리한다.
4. **Table API와 DataStream API는 섞어 쓸 수 있다.** Source/전처리는 DataStream, 집계는 SQL.
5. **State에서 꺼낸 객체는 복사 후 수정한다.** 직접 수정하면 State 원본이 오염된다.
6. **Broadcast State는 쓰기 주체가 정해져 있다.** `processBroadcastElement`에서만 쓰고, `processElement`에서는 읽기만 한다.

---

### 다음 단계

- **Ch20+:** 지금까지 만든 파이프라인들을 Flink SQL DDL과 Catalog로 관리
- **Exactly-once:** Parquet + PostgreSQL 조합에서 exactly-once 보장 방법
- **Flink on Kubernetes:** 로컬 실행에서 실제 클러스터로 이동

---

### Reference

- [Apache Flink File Sink 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/filesystem/)
- [Apache Flink Table API & SQL 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/overview/)
