---
title: "Flink 스터디 Part 2 (Ch14-19) - Parquet Sink, Table API, Gap Fill, VWAP, Broadcast Join"
date: 2026-03-16
categories: [Flink]
tags: [Flink, Java, Parquet, TableAPI, FlinkSQL, GapFill, VWAP]
---

### 들어가며

Part 1(Ch01-Ch13)에서 Flink의 기본기를 익혔다면, Part 2는 프로덕션 파이프라인에 가까운 패턴들을 다룬다. 실제 Kinesis 스트림에서 시계열 집계(Time-Series Aggregation) 암호화폐 데이터를 읽어서, Parquet로 저장하고, SQL로 집계하고, 빠진 데이터를 채우고, VWAP을 계산하고, 환율 데이터를 실시간으로 결합하는 과정을 챕터별로 정리한다.

이 글을 끝까지 따라가면 다음을 할 수 있게 된다.

- 스트리밍 데이터를 Parquet 포맷으로 날짜별 파티셔닝하여 저장
- 같은 스트림에 Parquet 파일과 PostgreSQL UPSERT를 동시 연결(Dual Sink)
- DataStream API 위에 SQL 집계를 얹어 쓰기
- 빠진 시간대를 Forward Fill로 보간
- VWAP 지표를 실시간 계산하고, Broadcast Join으로 환율 참조 데이터를 결합

#### 챕터 구성

| 챕터 | 주제 | 핵심 API |
|------|------|----------|
| Ch14 | S3 Parquet Sink | `FileSink.forBulkFormat`, `AvroParquetWriters` |
| Ch15 | UPSERT & Dual Sink | `JdbcSink`, `sinkTo` vs `addSink` |
| Ch16 | Table API & Flink SQL | `StreamTableEnvironment`, `toChangelogStream` |
| Ch17 | Gap Fill (데이터 보간) | `KeyedProcessFunction`, `ValueState`, Timer |
| Ch18 | 다중 시간 집계 | `TumblingEventTimeWindows`, `AggregateFunction` |
| Ch19 | VWAP & Broadcast Join | `KeyedBroadcastProcessFunction`, `MapStateDescriptor` |

#### 사전 준비

- **Flink 1.20.3** (이 글의 모든 코드는 1.20.3 기준)
- **JDK 17** (모듈 시스템 관련 VM 옵션 필요 -- Ch14에서 설명)
- Part 1 코드가 동작하는 상태 (`Ch02_KinesisSource`, `Ch03_FilterMap` 등 재사용)
- Kinesis 스트림에 시계열 집계 데이터가 흐르고 있는 환경

---

### Ch14: S3 Parquet Sink

#### 왜 Parquet인가

CSV나 JSON은 텍스트 포맷이라 용량이 크고, 전체 파일을 읽어야 특정 컬럼 값을 꺼낼 수 있다. Parquet은 컬럼 기반 바이너리 포맷이라 용량이 작고, Spark나 Athena에서 특정 컬럼만 읽을 때 나머지 컬럼을 아예 스킵할 수 있다. 대용량 시계열 데이터를 S3에 저장할 때 사실상 표준이다.

#### FileSink 구성

Flink에서 Parquet로 쓰려면 `FileSink.forBulkFormat()`에 `AvroParquetWriters.forReflectRecord()`를 결합한다. `forReflectRecord`는 Java POJO의 필드를 Avro Reflect 방식으로 스캔해서 Parquet 컬럼으로 자동 변환한다.

```java
// src/main/java/com/study/Ch14_ParquetSink.java

import org.apache.flink.connector.file.sink.FileSink;
import org.apache.flink.core.fs.Path;
import org.apache.flink.formats.parquet.avro.AvroParquetWriters;
import org.apache.flink.streaming.api.functions.sink.filesystem.bucketassigners.DateTimeBucketAssigner;

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

여기서 짚어야 할 포인트가 두 가지 있다.

**Row Format vs Bulk Format.** `forRowFormat()`은 Rolling Policy로 파일 크기나 시간 기준으로 파일을 닫을 수 있다. 반면 `forBulkFormat()`은 `OnCheckpointRollingPolicy`만 지원한다. Parquet처럼 컬럼 기반 포맷은 파일을 닫을 때 메타데이터(컬럼 통계, 오프셋 등)를 footer에 써야 하기 때문에, 임의 시점에 잘라서 닫으면 파일이 깨진다. 그래서 **체크포인트가 발생하는 시점이 곧 파일이 완성되는 시점**이다. 체크포인트 간격(`enableCheckpointing(10000)`)으로 파일 생성 주기를 제어하게 된다.

**DateTimeBucketAssigner.** Processing Time 기준으로 날짜별 하위 디렉터리를 만든다. `"yyyy-MM-dd"` 포맷을 지정하면 `output/2026-03-15/`, `output/2026-03-16/` 식으로 파티셔닝된다. Athena나 Hive에서 파티션 프루닝으로 특정 날짜만 조회할 때 유용하다.

#### 의존성 설정

Parquet 의존성은 줄줄이 딸려온다. `flink-parquet`을 추가하면 `parquet-avro`가 필요하고, `parquet-avro`는 `avro`를 transitive dependency로 가져온다. 그런데 Parquet 내부에서 Hadoop `Configuration` 클래스를 참조하기 때문에 `hadoop-client`도 별도로 추가해야 한다.

문제는 `hadoop-client`가 `slf4j-reload4j`를 끌고 온다는 점이다. 프로젝트에 이미 `log4j2`를 쓰고 있다면 두 SLF4J 구현체가 충돌한다. `exclusion`으로 제거해야 한다.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-parquet</artifactId>
    <version>1.20.3</version>
</dependency>
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

#### JDK 17 모듈 시스템 이슈

JDK 17 + FileSink 조합에서 체크포인트 직렬화 시 `InaccessibleObjectException`이 발생할 수 있다. FileSink 내부의 체크포인트 직렬화가 Kryo를 사용하고, Kryo가 `java.util` 패키지에 리플렉션으로 접근하려다 JDK 17의 모듈 시스템(JPMS)에 막히는 것이다.

IntelliJ나 실행 스크립트에서 다음 VM 옵션을 추가해야 한다.

```
--add-opens java.base/java.util=ALL-UNNAMED
```

> 이 옵션은 `java.base` 모듈의 `java.util` 패키지를 이름 없는 모듈(classpath 상의 모든 코드)에 열어주는 것이다. JDK 9 이전에는 기본이었지만, JDK 9 이후 모듈 시스템 도입으로 명시적 허용이 필요해졌다.

---

### Ch15: UPSERT & Dual Sink

#### UPSERT -- at-least-once 환경에서 중복 방지

Flink의 기본 전달 시맨틱은 at-least-once다. 장애 후 체크포인트에서 재시작하면 같은 데이터가 두 번 들어올 수 있다. DB에 단순 INSERT를 쓰면 중복 레코드가 생긴다.

PostgreSQL의 `ON CONFLICT DO UPDATE`(UPSERT)로 이 문제를 해결한다. PK 충돌 시 INSERT 대신 UPDATE를 실행한다. `EXCLUDED`는 INSERT를 시도한 새 값을 참조하는 PostgreSQL 전용 키워드다.

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

이 방식은 idempotent(멱등)하다. 같은 데이터가 두 번, 세 번 와도 결과는 동일하다. 복합 PK(`exchange, symbol, timestamp`)로 레코드를 유일하게 식별할 수 있어야 한다는 전제가 있다.

#### Dual Sink -- 같은 스트림을 두 곳에 출력

같은 스트림을 Parquet 파일과 PostgreSQL 두 곳에 동시에 저장하고 싶을 때, 별도로 스트림을 복제할 필요가 없다. 같은 스트림 변수에 Sink를 두 번 연결하면 Flink가 내부적으로 분기를 처리한다.

```java
// src/main/java/com/study/Ch15_UpsertDualSink.java

// Sink 1: Parquet (새 Sink API -- FLIP-143)
filtered.sinkTo(parquetSink);

// Sink 2: JDBC UPSERT (구 SinkFunction API) -- 같은 filtered에 연결
filtered.addSink(JdbcSink.sink(upsertSql, ...));
```

여기서 `sinkTo()`와 `addSink()`가 혼재하는 이유를 짚어야 한다. `FileSink`는 FLIP-143으로 도입된 새 `Sink` 인터페이스를 구현하므로 `sinkTo()`를 쓴다. 반면 `JdbcSink`는 Flink 1.20 기준으로 아직 레거시 `SinkFunction` 인터페이스 기반이라 `addSink()`를 써야 한다. `JdbcSink`에 `sinkTo()`를 쓰면 타입 불일치로 컴파일 에러가 난다.

> Flink는 점진적으로 모든 커넥터를 새 Sink API로 마이그레이션하고 있다. JDBC 커넥터의 마이그레이션 시점은 [FLINK-25986](https://issues.apache.org/jira/browse/FLINK-25986)을 참고한다.

---

### Ch16: Table API & Flink SQL

#### DataStream과 SQL을 한 파이프라인에서 섞어 쓰기

복잡한 로직(State, Timer, Side Output)은 DataStream API가 적합하고, 집계나 필터링처럼 선언적으로 표현 가능한 로직은 SQL이 더 간결하다. Flink는 둘을 하나의 파이프라인에서 섞어 쓸 수 있도록 `StreamTableEnvironment`를 제공한다.

`StreamTableEnvironment.create(env)`로 기존 `StreamExecutionEnvironment` 위에 Table API 레이어를 추가한다. `fromDataStream()`으로 DataStream을 Table로 변환하면 POJO 필드가 자동으로 테이블 컬럼이 된다.

```java
// src/main/java/com/study/Ch16_TableApiSql.java

import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;

// Table API 레이어 추가
StreamTableEnvironment tableEnv = StreamTableEnvironment.create(env);

// DataStream -> Table (TSAgg POJO 필드가 자동으로 컬럼이 됨)
Table table = tableEnv.fromDataStream(filtered);
tableEnv.createTemporaryView("ts_agg", table);

// SQL 집계 -- Ch10에서 AggregateFunction으로 30줄 짠 걸 한 줄로
Table resultTable = tableEnv.sqlQuery(
    "SELECT exchange, COUNT(*) AS cnt, AVG(`close`) AS avg_close "
    + "FROM ts_agg GROUP BY exchange"
);

// Table -> DataStream (GROUP BY 결과는 업데이트 발생 -> toChangelogStream 필수)
tableEnv.toChangelogStream(resultTable).print();
```

Ch10에서 `AggregateFunction`과 누적기를 직접 구현해서 30줄 가까이 짰던 집계를 `SELECT ... GROUP BY` 한 줄로 대체할 수 있다. 물론 SQL로 표현 불가능한 복잡한 비즈니스 로직(예: Gap Fill의 State + Timer 조합)은 여전히 DataStream API를 써야 한다.

#### close는 SQL 예약어

`TSAgg` 모델의 `close` 필드를 SQL에서 그대로 쓰면 파싱 에러가 난다. `close`는 SQL 표준 예약어이기 때문이다. Flink SQL에서는 백틱(`` ` ``)으로 이스케이프해야 한다.

```sql
-- 에러: close가 예약어라 파싱 실패
SELECT AVG(close) FROM ts_agg

-- 정상: 백틱으로 이스케이프
SELECT AVG(`close`) FROM ts_agg
```

같은 이유로 `time`, `timestamp`, `value`, `key` 같은 흔한 필드명도 예약어에 해당할 수 있다. POJO 필드명을 정할 때 SQL 예약어를 피하거나, SQL에서 항상 백틱을 쓰는 습관을 들이는 것이 좋다.

#### toDataStream vs toChangelogStream

`GROUP BY` 집계 결과는 새 데이터가 들어올 때마다 이전 결과를 철회하고 새 결과를 내보낸다. `toDataStream()`은 insert-only 스트림만 지원하므로, 업데이트가 발생하는 테이블에 쓰면 런타임 에러가 난다.

이때 `toChangelogStream()`을 써야 한다. Changelog 스트림은 세 가지 종류의 메시지로 변화를 표현한다.

| 타입 | 의미 | 예시 |
|------|------|------|
| `+I` | INSERT -- 새로 추가된 값 | `+I[binance, 1, 64500.00]` |
| `-U` | UPDATE_BEFORE -- 이전 값 철회 | `-U[binance, 1, 64500.00]` |
| `+U` | UPDATE_AFTER -- 갱신된 새 값 | `+U[binance, 2, 64750.00]` |

실시간 대시보드에서 Changelog를 받아서 `-U`가 오면 이전 값을 제거하고, `+U`가 오면 새 값으로 교체하는 식으로 활용한다. Flink 공식 문서에서도 `toChangelogStream()`은 "모든 종류의 업데이트 테이블을 지원하는 가장 범용적인 변환"으로 안내하고 있다.

---

### Ch17: Gap Fill (데이터 보간)

#### 왜 보간이 필요한가

거래소 장애나 네트워크 문제로 1분봉 데이터가 빠지는 일이 실전에서는 빈번하다. 이 상태로 차트를 그리면 시간 축이 끊기고, 이동평균 같은 집계도 틀어진다. 빠진 구간을 직전 값으로 채우는 **Forward Fill**이 가장 단순하고 실무에서 많이 쓰이는 방법이다.

#### KeyedProcessFunction + ValueState + Timer 조합

Gap Fill은 Part 1에서 배운 State(Ch06)와 Timer(Ch07)의 실전 응용이다. 각 거래소+종목(key) 별로 독립적으로 동작해야 하므로 `KeyedProcessFunction`을 사용한다.

동작 흐름은 두 단계로 나뉜다.

**1단계: 데이터 도착 시**

- State에 현재 값 저장
- 다음 예상 시각(현재 + 60초 + 10초 여유)에 타이머 등록
- 원본 데이터를 그대로 downstream으로 전달

**2단계: 타이머 발동 시 (= 데이터가 안 왔다는 뜻)**

- State에서 마지막 값을 꺼내 새 객체로 복제
- close 값으로 OHLC를 채우고, volume은 0으로 설정 (실제 거래가 없었으므로)
- 다음 타이머를 재등록하여 연속 gap에 대응

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

    // 반드시 새 객체를 만들어야 State 원본이 오염되지 않음
    TSAgg filled = new TSAgg();
    long now = ctx.timerService().currentProcessingTime();
    filled.setOpen(last.getClose());   // Forward Fill: 마지막 close로 OHLC 채움
    filled.setHigh(last.getClose());
    filled.setLow(last.getClose());
    filled.setClose(last.getClose());
    filled.setVolume(BigDecimal.ZERO); // 실제 거래가 없었으므로 0
    filled.setTimestamp(now);
    // ... (exchange, symbol 등 나머지 필드 복사)

    // 연속 gap 대응: 다음 타이머 재등록
    ctx.timerService().registerProcessingTimeTimer(now + INTERVAL_MS + TOLERANCE_MS);
    out.collect(filled);
}
```

#### State 원본 오염 주의

위 코드에서 가장 중요한 부분은 `new TSAgg()`로 새 객체를 만드는 것이다. `onTimer`에서 `lastState.value()`로 꺼낸 객체를 직접 수정하면 State에 저장된 원본이 바뀐다. 다음 타이머가 발동했을 때 오염된 값을 읽게 되어, 보간 데이터가 연쇄적으로 틀어진다.

Flink의 `ValueState.value()`는 힙 기반 State Backend에서 객체 참조를 직접 반환한다. (RocksDB State Backend에서는 역직렬화된 복사본을 반환하므로 이 문제가 발생하지 않지만, Backend에 의존하는 코드는 위험하다.)

**원칙: State에서 꺼낸 객체는 반드시 복사 후 수정한다.**

---

### Ch18: 다중 시간 집계

#### 같은 스트림에서 여러 캔들 동시 생성

트레이딩 대시보드는 5분봉, 10분봉, 1시간봉을 동시에 보여준다. 각 시간 프레임마다 별도 파이프라인을 만들면 Source를 중복 소비하게 되어 비효율적이다. Flink에서는 같은 keyed 스트림에 윈도우 크기만 다르게 적용하면 된다.

```java
// src/main/java/com/study/Ch18_MultiTimeAgg.java

KeyedStream<TSAgg, String> keyed = withWatermark
    .keyBy(o -> o.getExchange() + ":" + o.getSymbol());

// 같은 keyed 스트림에 윈도우 크기만 다르게 -- 각각 독립된 파이프라인
keyed.window(TumblingEventTimeWindows.of(Duration.ofMinutes(5)))
    .aggregate(new TSAggCandleAgg()).print("5m");
keyed.window(TumblingEventTimeWindows.of(Duration.ofMinutes(10)))
    .aggregate(new TSAggCandleAgg()).print("10m");
keyed.window(TumblingEventTimeWindows.of(Duration.ofHours(1)))
    .aggregate(new TSAggCandleAgg()).print("1h");
```

이 세 줄은 각각 독립된 연산자 체인을 만든다. 누적기(`CandleAccumulator`)를 공유하지 않는다. 5분 윈도우가 닫혀도 10분 윈도우와 1시간 윈도우의 누적기는 계속 데이터를 모은다.

#### 캔들 집계의 함정: low 초기화

`AggregateFunction`의 누적기에서 low(최저가)를 초기화할 때 실수하기 쉽다.

```java
// src/main/java/com/study/Ch18_MultiTimeAgg.java -- TSAggCandleAgg.add()

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
    acc.count++;
    // ...
}
```

만약 `createAccumulator()`에서 `low = BigDecimal.ZERO`로 초기화하면 `min()` 비교에서 항상 0이 최솟값이 되어 모든 캔들의 low가 0으로 찍힌다. 반대로 `high = BigDecimal.ZERO`로 초기화하면 첫 데이터 이전까지는 문제가 안 되지만 가독성이 떨어진다. `count == 0` 분기에서 첫 데이터의 값으로 open/high/low를 한꺼번에 초기화하는 것이 가장 명확한 패턴이다.

#### merge()는 언제 호출되는가

`AggregateFunction`의 `merge()` 메서드는 **Session Window에서 두 세션이 합쳐질 때** 호출된다. Tumbling Window와 Sliding Window에서는 호출되지 않는다. 이번 챕터처럼 Tumbling Window만 쓴다면 `merge()`는 구현해도 실제로 호출되지 않으므로, `return null`이나 `throw new UnsupportedOperationException()`으로 두어도 런타임에 문제가 없다.

---

### Ch19: VWAP & Broadcast Join

#### VWAP 계산

VWAP(Volume Weighted Average Price)은 거래량으로 가중치를 준 평균 가격이다. 기관 트레이더들이 현재가 대비 비싸게 사고 있는지 싸게 사고 있는지 판단할 때 쓰는 핵심 지표다.

```
VWAP = SUM(close * volume) / SUM(volume)
```

`AggregateFunction`으로 구현할 때, 누적기에 두 합계를 모두 담아야 `getResult()`에서 나눗셈이 가능하다.

```java
// src/main/java/com/study/Ch19_VwapBroadcast.java

static class VwapAccumulator {
    BigDecimal sumPriceVolume;  // SUM(close * volume)
    BigDecimal sumVolume;       // SUM(volume)
    String exchange, symbol;
}

@Override
public VwapAccumulator createAccumulator() {
    VwapAccumulator acc = new VwapAccumulator();
    acc.sumPriceVolume = BigDecimal.ZERO;  // null 방지 -- ZERO로 초기화
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

`BigDecimal.divide()`는 반드시 `scale`과 `RoundingMode`를 지정해야 한다. 지정하지 않으면 나누어 떨어지지 않는 경우(예: 1/3) `ArithmeticException: Non-terminating decimal expansion`이 발생한다. 금융 데이터를 다룰 때 `RoundingMode.HALF_UP`(반올림)이 가장 보편적인 선택이다.

#### Broadcast Join -- 환율 참조 데이터 결합

환율처럼 느리게 변하는 참조 데이터(reference data)를 실시간 스트림과 결합할 때 Broadcast Join을 쓴다. 참조 데이터를 브로드캐스트해서 모든 파티션이 공유하는 State에 저장하고, 메인 스트림 데이터가 올 때마다 State에서 읽어서 결합한다.

```java
// src/main/java/com/study/Ch19_VwapBroadcast.java

// MapStateDescriptor: main()과 ProcessFunction에서 같은 descriptor를 공유해야 함 (static final)
static final MapStateDescriptor<String, BigDecimal> RATE_DESCRIPTOR =
    new MapStateDescriptor<>("currency-rates",
        BasicTypeInfo.STRING_TYPE_INFO, BasicTypeInfo.BIG_DEC_TYPE_INFO);

// 환율 데이터를 브로드캐스트 스트림으로 변환
BroadcastStream<Tuple2<String, BigDecimal>> broadcast = env.fromElements(
    Tuple2.of("USD", BigDecimal.ONE),
    Tuple2.of("KRW", new BigDecimal("0.00075"))
).broadcast(RATE_DESCRIPTOR);

// keyed 메인 스트림과 브로드캐스트 스트림을 연결
keyed.connect(broadcast)
    .process(new RateJoinFunction())
    .print("joined");
```

`RateJoinFunction`은 `KeyedBroadcastProcessFunction`을 확장한다. 이 클래스 안의 두 메서드는 역할과 State 접근 권한이 명확히 구분된다.

| 메서드 | 호출 시점 | Broadcast State 접근 |
|--------|-----------|---------------------|
| `processBroadcastElement()` | 환율 데이터 도착 | **읽기 + 쓰기** (`ctx.getBroadcastState()`) |
| `processElement()` | TSAgg 데이터 도착 | **읽기 전용** (`ctx.getBroadcastState()` -- ReadOnly) |

이 비대칭 설계는 의도적이다. Broadcast State는 모든 병렬 인스턴스(파티션)가 동일한 복사본을 가져야 한다. 만약 `processElement()` (메인 스트림 처리)에서 State를 수정할 수 있다면, 파티션마다 서로 다른 메인 데이터를 처리하므로 State가 파티션 간에 불일치할 수 있다. 쓰기는 모든 파티션에 동일하게 전달되는 브로드캐스트 요소가 올 때만 허용함으로써 일관성을 보장한다.

#### 주의: Broadcast 데이터 도착 순서

환율 데이터가 TSAgg 데이터보다 늦게 도착하면 `processElement()`에서 State를 조회해도 `null`이 나온다. 이 코드에서는 `null` 체크 후 "No rate for ..." 메시지를 출력하는 것으로 처리했지만, 실환경에서는 다음 전략 중 하나를 적용해야 한다.

- 파이프라인 시작 시 참조 데이터를 먼저 로딩 (초기화 완료 후 메인 스트림 처리 시작)
- join 실패 데이터를 Side Output으로 분리해 재처리
- 메인 스트림 쪽에서 BufferingState를 두고, 참조 데이터가 올 때까지 대기 후 일괄 처리

---

### 트러블슈팅 모음

| 챕터 | 현상 | 원인 | 해결 |
|------|------|------|------|
| Ch14 | SLF4J 바인딩 충돌 경고 | `hadoop-client`가 `slf4j-reload4j`를 transitive로 가져옴 | pom.xml에서 `exclusion` 처리 |
| Ch14 | `InaccessibleObjectException` | JDK 17 모듈 시스템이 Kryo의 리플렉션 접근을 차단 | VM 옵션 `--add-opens java.base/java.util=ALL-UNNAMED` |
| Ch15 | `sinkTo()` 컴파일 에러 | `JdbcSink`가 레거시 `SinkFunction` 인터페이스 기반 | `addSink()` 사용 |
| Ch16 | SQL 파싱 에러 | `close`가 SQL 표준 예약어 | 백틱으로 이스케이프: `` `close` `` |
| Ch16 | `toDataStream()` 런타임 에러 | GROUP BY 결과는 update가 발생하는 테이블 | `toChangelogStream()` 사용 |
| Ch17 | 보간 값이 연쇄적으로 틀어짐 | State에서 꺼낸 객체를 직접 수정하여 원본 오염 | 새 객체 생성 후 필드 복사 |
| Ch18 | 모든 캔들의 low가 0 | `createAccumulator()`에서 `low = BigDecimal.ZERO`로 초기화 | `count == 0` 분기에서 첫 데이터의 low로 초기화 |
| Ch19 | `ArithmeticException` | `BigDecimal.divide()`에서 scale/RoundingMode 미지정 | `divide(divisor, 2, RoundingMode.HALF_UP)` |

---

### 핵심 정리

1. **BulkFormat FileSink는 체크포인트가 파일 분할 시점이다.** Parquet 같은 컬럼 기반 포맷은 footer 메타데이터 때문에 임의 시점에 파일을 자를 수 없다. 체크포인트 간격으로 파일 생성 주기를 제어한다.
2. **의존성은 줄줄이 딸려온다.** `flink-parquet` -> `parquet-avro` -> `avro` + `hadoop-client`. 로깅 충돌은 `exclusion`으로 끊어야 한다.
3. **Dual Sink는 같은 스트림에 두 번 연결하면 된다.** 스트림 복제 로직이 필요 없다. 다만 `sinkTo()`(새 API)와 `addSink()`(구 API)의 혼재에 주의한다.
4. **Table API와 DataStream API는 한 파이프라인에서 섞어 쓸 수 있다.** Source와 전처리는 DataStream, 집계는 SQL, Sink는 다시 DataStream으로 돌아오는 패턴이 실무에서 흔하다.
5. **State에서 꺼낸 객체는 복사 후 수정한다.** 힙 기반 State Backend에서는 참조를 직접 반환하므로, 수정하면 State 원본이 오염된다.
6. **Broadcast State는 쓰기 주체가 정해져 있다.** `processBroadcastElement()`에서만 쓰고, `processElement()`에서는 읽기만 한다. 이는 파티션 간 일관성을 보장하기 위한 설계다.

---

### 다음 단계

- **Ch20+:** 지금까지 만든 파이프라인들을 Flink SQL DDL과 Catalog로 관리
- **Exactly-once:** Parquet + PostgreSQL 조합에서 exactly-once 보장 방법 (2PC Sink)
- **Flink on Kubernetes:** 로컬 실행에서 실제 클러스터로 이동

---

### Reference

- [Ch14_ParquetSink.java](../../flink-study/src/main/java/com/study/Ch14_ParquetSink.java)
- [Ch15_UpsertDualSink.java](../../flink-study/src/main/java/com/study/Ch15_UpsertDualSink.java)
- [Ch16_TableApiSql.java](../../flink-study/src/main/java/com/study/Ch16_TableApiSql.java)
- [Ch17_GapFill.java](../../flink-study/src/main/java/com/study/Ch17_GapFill.java)
- [Ch18_MultiTimeAgg.java](../../flink-study/src/main/java/com/study/Ch18_MultiTimeAgg.java)
- [Ch19_VwapBroadcast.java](../../flink-study/src/main/java/com/study/Ch19_VwapBroadcast.java)
- [Apache Flink FileSink 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/filesystem/)
- [Apache Flink Table API & SQL 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/overview/)
- [Apache Flink Broadcast State Pattern](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/broadcast_state/)
- [Apache Flink DataStream / Table 변환 가이드](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/data_stream_api/)
