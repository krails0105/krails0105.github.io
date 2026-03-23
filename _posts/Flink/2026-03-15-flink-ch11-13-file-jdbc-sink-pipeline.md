---
title: "Flink 스터디 Ch11-13 - FileSink, JdbcSink, 통합 파이프라인"
date: 2026-03-15
categories: [Flink]
tags: [Flink, Java, FileSink, JdbcSink, PostgreSQL, Pipeline]
---

### 들어가며

Ch11-Ch13은 Flink 스터디의 마지막 구간이다. 이전 챕터들이 데이터를 처리하는 방법을 다뤘다면, 이 구간은 **처리된 데이터를 어디에 어떻게 저장할지**, 그리고 **지금까지 배운 것을 하나로 조합하면 어떻게 되는지**를 다룬다.

이 글을 마치면 다음을 할 수 있게 된다.

- `FileSink`로 스트림 데이터를 파일에 저장하고, 체크포인트와 Rolling Policy를 설정
- `JdbcSink`로 PostgreSQL에 배치 INSERT하고, 배치 옵션으로 DB 부하를 제어
- Kinesis Source부터 윈도우 집계, JDBC Sink까지 전체 파이프라인을 하나로 연결

챕터별 요약은 다음과 같다.

- Ch11: `print()` 대신 파일로 저장하는 FileSink
- Ch12: PostgreSQL에 저장하는 JdbcSink
- Ch13: Kinesis --> 집계 --> PostgreSQL 전체 파이프라인 통합

### 사전 준비 (Prerequisites)

| 항목 | 버전/조건 |
|------|-----------|
| Java | 17 |
| Apache Flink | 1.20.x (`1.20.3` 사용) |
| Ch02 완료 | Kinesis Source 연결 |
| Ch03 완료 | `Ch03_FilterMap.getSourceWithFilter()` 재사용 |
| Ch10 완료 | `AggregateFunction` 이해 |
| Docker | Ch12, Ch13용 PostgreSQL 실행 |

---

### Ch11: File Sink

#### 배경

Flink로 데이터를 처리하다 보면 `print()`로 콘솔에 찍는 것만으로는 부족하다. 실제로는 파일로 저장하거나, S3에 올리거나, DB에 넣어야 한다. `FileSink`는 `print()` 대신 파일로 저장하는 Sink다.

Flink의 FileSink는 두 가지 포맷을 지원한다.

| 포맷 | 용도 | 예시 |
|------|------|------|
| Row Format | 한 줄씩 텍스트로 쓰기 | CSV, JSON 문자열 |
| Bulk Format | 묶어서 컬럼 형식으로 쓰기 | Parquet, ORC |

이번 챕터는 Row Format을 사용한다. Bulk Format은 Parquet 같은 추가 의존성이 필요해서 다루지 않는다.

#### 핵심 개념: 체크포인트와 Rolling Policy

FileSink를 사용하려면 두 가지 설정이 필수다.

**체크포인트(Checkpointing):** FileSink는 파일을 바로 완료하지 않는다. 데이터를 `.inprogress` 파일에 먼저 쓰고, 체크포인트가 발생하는 시점에 완료 파일로 전환한다. 이 설계 덕분에 장애 발생 시 `.inprogress` 파일만 버리면 되므로 exactly-once 시맨틱을 보장할 수 있다. 반대로, 체크포인트를 설정하지 않으면 `.inprogress` 파일만 영원히 남는다.

**Rolling Policy:** 파일을 언제 닫고 새 파일을 열지 결정하는 정책이다. `DefaultRollingPolicy`는 세 가지 조건 중 하나라도 만족하면 새 파일을 만든다: 파일 크기, 경과 시간, 비활성 시간.

#### 구현

```java
// src/main/java/com/study/Ch11_FileSink.java

// 체크포인트 활성화 -- FileSink는 체크포인트가 있어야 .inprogress -> 완료 파일로 전환
env.enableCheckpointing(60000);  // 60초마다 체크포인트

// Rolling Policy -- 파일을 언제 닫고 새 파일을 열지
Path outputPath = new Path("output/tsAgg");
DefaultRollingPolicy<String, String> rollingPolicy = DefaultRollingPolicy.builder()
        .withMaxPartSize(MemorySize.ofMebiBytes(128))   // 128MB 넘으면 새 파일
        .withRolloverInterval(Duration.ofMinutes(5))     // 5분마다 새 파일
        .withInactivityInterval(Duration.ofMinutes(1))   // 1분간 데이터 없으면 닫기
        .build();

// FileSink 생성 -- forRowFormat: 한 줄씩 텍스트로 쓰기
FileSink<String> sink = FileSink
        .forRowFormat(outputPath, new SimpleStringEncoder<String>("UTF-8"))
        .withRollingPolicy(rollingPolicy)
        .build();

// TSAgg -> String 변환 후 파일로 출력
withFilter.map(TSAgg::toString).sinkTo(sink);
```

전체 흐름을 정리하면: `env.enableCheckpointing()` --> `DefaultRollingPolicy` 설정 --> `FileSink.forRowFormat()` 생성 --> `.sinkTo()` 연결이다.

#### FileSink에서 빠지기 쉬운 함정들

**체크포인트 없으면 `.inprogress` 파일만 남는다.**

`enableCheckpointing()`을 빠뜨리면 잡이 실행되는 내내 `.inprogress` 파일만 생성되고 아무것도 완료되지 않는다. 실제로 이 문제를 겪었는데, `output/` 폴더를 열어보면 `.inprogress` 파일만 가득 차 있었다. FileSink를 쓸 때는 체크포인트 설정이 필수다.

**`Path`는 Flink의 Path를 써야 한다.**

```java
// 틀림 -- java.nio.file.Path
import java.nio.file.Path;

// 맞음 -- Flink의 Path
import org.apache.flink.core.fs.Path;
```

IDE가 자동으로 `java.nio.file.Path`를 import하면 런타임 타입 불일치 에러가 난다. import 문을 반드시 확인해야 한다.

**`FileSink<String>`인데 스트림 타입이 `TSAgg`이면 안 된다.**

`FileSink<String>`은 `String` 타입 스트림만 받을 수 있다. `TSAgg` 스트림을 그대로 꽂으면 컴파일 에러가 난다. `.map(TSAgg::toString)`으로 문자열로 변환한 뒤 `sinkTo()`에 연결해야 한다.

**`flink-connector-files` 의존성 scope 문제.**

`pom.xml`에서 이 의존성이 `<scope>provided</scope>`로 되어 있으면 로컬 실행 시 `ClassNotFoundException`이 발생한다. 로컬 실행 중에는 `compile` 스코프로 변경해야 한다.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-connector-files</artifactId>
    <version>${flink.version}</version>
    <!-- provided -> compile 으로 변경 -->
    <scope>compile</scope>
</dependency>
```

---

### Ch12: JDBC Sink (PostgreSQL)

#### 배경

파일보다 SQL 쿼리로 조회할 수 있는 DB가 필요할 때 `JdbcSink`를 사용한다. Flink는 `JdbcSink.sink()` static 팩토리 메서드로 간단하게 DB 연결을 설정할 수 있다.

한 가지 주의할 점은, JdbcSink는 아직 Flink의 새로운 Sink API(`sinkTo()`)를 지원하지 않는다. Legacy API인 `addSink()`를 사용해야 한다. `sinkTo()`로 연결하면 컴파일 에러가 나므로 혼동하지 말자.

#### Docker로 PostgreSQL 실행

```bash
docker run -d --name pg-flink \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  postgres:16
```

컨테이너가 시작되면 테이블을 생성한다.

```sql
CREATE TABLE ts_agg (
    exchange    VARCHAR,
    symbol      VARCHAR,
    market_type VARCHAR,
    timestamp   BIGINT,
    open        NUMERIC,
    high        NUMERIC,
    low         NUMERIC,
    close       NUMERIC,
    volume      NUMERIC
);
```

#### 구현

`JdbcSink.sink()`는 파라미터 4개를 받는다. 각 파라미터가 어떤 역할인지 주석으로 정리했다.

```java
// src/main/java/com/study/Ch12_JdbcSink.java

withFilter.addSink(
    JdbcSink.sink(
        // 파라미터 1: SQL -- ? 플레이스홀더로 값 위치 지정
        "INSERT INTO ts_agg (exchange, symbol, market_type, timestamp, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",

        // 파라미터 2: StatementBuilder -- ?에 실제 값 바인딩 (인덱스 1부터)
        (statement, o) -> {
            statement.setString(1, o.getExchange());
            statement.setString(2, o.getSymbol());
            statement.setString(3, o.getMarketType());
            statement.setLong(4, o.getTimestamp());
            statement.setBigDecimal(5, o.getOpen());
            statement.setBigDecimal(6, o.getHigh());
            statement.setBigDecimal(7, o.getLow());
            statement.setBigDecimal(8, o.getClose());
            statement.setBigDecimal(9, o.getVolume());
        },

        // 파라미터 3: ExecutionOptions -- 묶어서 보내기 (배치)
        JdbcExecutionOptions.builder()
            .withBatchSize(1000)        // 1000개 모이면 한번에 INSERT
            .withBatchIntervalMs(200)   // 200ms마다 쌓인 것 전송
            .withMaxRetries(5)          // 실패 시 최대 5회 재시도
            .build(),

        // 파라미터 4: ConnectionOptions -- DB 연결 정보
        new JdbcConnectionOptionsBuilder()
            .withUrl("jdbc:postgresql://localhost:5432/postgres")
            .withDriverName("org.postgresql.Driver")
            .withUsername("postgres")
            .withPassword("postgres")
            .build()
    )
);
```

`JdbcSink.sink()`의 4개 파라미터를 표로 정리하면 다음과 같다.

| 순서 | 파라미터 | 역할 |
|------|----------|------|
| 1 | SQL 문자열 | `?` 플레이스홀더로 값 위치 지정 |
| 2 | `JdbcStatementBuilder` | `?`에 실제 값을 바인딩하는 람다 (인덱스 1부터 시작) |
| 3 | `JdbcExecutionOptions` | 배치 크기, 전송 간격, 재시도 횟수 설정 |
| 4 | `JdbcConnectionOptions` | JDBC URL, 드라이버, 사용자명, 비밀번호 |

#### JdbcSink 핵심 포인트

**레코드마다 INSERT하면 DB 부하가 폭발한다.**

스트리밍 데이터는 초당 수천 건이 들어올 수 있다. 레코드마다 INSERT를 날리면 DB가 버티지 못한다. `JdbcExecutionOptions`의 `batchSize`와 `batchIntervalMs`로 묶어서 보내면 DB 부하를 크게 줄일 수 있다. `batchSize`에 도달하거나 `batchIntervalMs` 시간이 지나면 -- 둘 중 먼저 발생하는 조건에서 -- 배치가 실행된다.

**at-least-once 주의.** 장애 후 재시작 시 중복 INSERT가 발생할 수 있다. 중복이 문제라면 `ON CONFLICT DO UPDATE` (UPSERT) 방식을 SQL에 적용하자.

**import 주의.** 같은 이름 `JdbcSink` 클래스가 여러 패키지에 존재한다. 반드시 `org.apache.flink.connector.jdbc.JdbcSink`를 사용해야 한다.

**pom.xml 의존성 추가.**

```xml
<!-- pom.xml -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-connector-jdbc</artifactId>
    <version>3.3.0-1.20</version>
</dependency>
<dependency>
    <groupId>org.postgresql</groupId>
    <artifactId>postgresql</artifactId>
    <version>42.7.8</version>
</dependency>
```

---

### Ch13: 통합 파이프라인

#### 배경

Ch01부터 Ch12까지 배운 것을 하나의 파이프라인으로 연결한다. 각 챕터에서 독립적으로 다뤘던 개념들이 하나의 흐름 안에서 어떻게 조합되는지 보는 것이 이 챕터의 핵심이다.

전체 파이프라인 흐름은 다음과 같다.

```
Kinesis(TSAgg)
  --> BTC/spot 필터                          (Ch03: FilterMap)
  --> Stablecoin 정규화 (USDT -> USD)        (Ch03: MapFunction)
  --> Watermark (10초 지연 허용)              (Ch05: WatermarkStrategy)
  --> 거래소별 1분 Tumbling Window            (Ch04: KeyBy + Window)
  --> 평균 종가 집계                          (Ch10: AggregateFunction)
      + 윈도우 메타정보 접근                  (Ch13: ProcessWindowFunction)
  --> PostgreSQL ts_agg_result 저장              (Ch12: JdbcSink)
```

#### PostgreSQL 테이블 준비

Ch12에서 사용한 `ts_agg` 테이블과 별도로, 집계 결과를 저장할 `ts_agg_result` 테이블이 필요하다.

```sql
CREATE TABLE ts_agg_result (
    exchange      VARCHAR,
    window_start  BIGINT,
    avg_close     NUMERIC,
    record_count  INT
);
```

#### AggregateFunction + ProcessWindowFunction 조합

Ch10에서 `AggregateFunction`은 메모리 효율적인 집계를 하지만 윈도우 메타정보(시작/종료 시각)에 접근할 수 없다는 한계가 있었다. Ch13에서는 이 둘을 **조합**해서 각각의 장점을 취한다.

| 함수 | 역할 | 호출 시점 |
|------|------|-----------|
| `AggregateFunction` | 데이터가 올 때마다 즉시 누적 (누적기 하나만 메모리 유지) | 레코드마다 |
| `ProcessWindowFunction` | 집계 결과 + 윈도우 시작 시각을 함께 받아서 최종 출력 | 윈도우가 닫힐 때 |

이 조합의 핵심은 `ProcessWindowFunction`이 전체 레코드가 아닌 `AggregateFunction`의 **최종 결과만** 받는다는 점이다. 단독으로 `ProcessWindowFunction`을 쓰면 윈도우의 모든 레코드를 메모리에 올려야 하지만, 이 조합에서는 누적기 하나만 유지하므로 메모리 효율이 좋다.

```java
// src/main/java/com/study/Ch13_Pipeline.java

// AggregateFunction: 누적기 BigDecimal[]{sum, count}로 평균 종가 계산
static class AvgCloseAggregateFunction implements AggregateFunction<TSAgg, BigDecimal[], BigDecimal[]> {

    @Override
    public BigDecimal[] createAccumulator() {
        return new BigDecimal[]{BigDecimal.ZERO, BigDecimal.ZERO};
    }

    @Override
    public BigDecimal[] add(TSAgg value, BigDecimal[] accumulator) {
        accumulator[0] = accumulator[0].add(value.getClose());  // sum
        accumulator[1] = accumulator[1].add(BigDecimal.ONE);    // count
        return accumulator;
    }

    @Override
    public BigDecimal[] getResult(BigDecimal[] accumulator) { return accumulator; }

    @Override
    public BigDecimal[] merge(BigDecimal[] a, BigDecimal[] b) {
        a[0] = a[0].add(b[0]);  // BigDecimal은 immutable -- 반드시 결과를 다시 대입
        a[1] = a[1].add(b[1]);
        return a;
    }
}

// ProcessWindowFunction: 집계 결과 + 윈도우 시작 시각을 TSAggResult로 변환
static class TSAggResultProcessWindow extends ProcessWindowFunction<BigDecimal[], TSAggResult, String, TimeWindow> {

    @Override
    public void process(String key, Context context, Iterable<BigDecimal[]> elements, Collector<TSAggResult> out) throws Exception {
        for (BigDecimal[] values : elements) {
            BigDecimal avgClose = values[0].divide(values[1], 2, RoundingMode.HALF_UP);
            TSAggResult tsAggResult = TSAggResult.of(key, context.window().getStart(), avgClose, values[1].intValue());
            out.collect(tsAggResult);
        }
    }
}
```

`.aggregate(new AvgCloseAggregateFunction(), new TSAggResultProcessWindow())`처럼 두 함수를 같이 넘기면 Flink가 자동으로 조합해서 처리한다. `AggregateFunction`의 `getResult()`가 반환하는 타입이 `ProcessWindowFunction`의 입력 타입과 일치해야 한다 -- 여기서는 둘 다 `BigDecimal[]`이다.

#### 파이프라인 연결부

위에서 정의한 집계 함수들을 파이프라인에 연결하는 코드다.

```java
// src/main/java/com/study/Ch13_Pipeline.java

filtered.assignTimestampsAndWatermarks(watermarkStrategy)
    .keyBy(TSAgg::getExchange)
    .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
    .aggregate(new AvgCloseAggregateFunction(), new TSAggResultProcessWindow())
    .returns(TypeInformation.of(TSAggResult.class))  // POJO 직렬화 명시 (Kryo 폴백 방지)
    .addSink(JdbcSink.sink(
        "INSERT INTO ts_agg_result (exchange, window_start, avg_close, record_count) VALUES (?, ?, ?, ?)",
        (statement, o) -> {
            statement.setString(1, o.getExchange());
            statement.setLong(2, o.getWindow_start());
            statement.setBigDecimal(3, o.getAvg_close());
            statement.setInt(4, o.getRecord_count());
        },
        JdbcExecutionOptions.builder()
            .withBatchSize(1000)
            .withBatchIntervalMs(200)
            .withMaxRetries(5)
            .build(),
        new JdbcConnectionOptionsBuilder()
            .withUrl("jdbc:postgresql://localhost:5432/postgres")
            .withDriverName("org.postgresql.Driver")
            .withUsername("postgres")
            .withPassword("postgres")
            .build()
    ));
```

#### TSAggResult 모델 설계

집계 결과를 담는 모델 클래스다. Lombok 어노테이션 4개를 모두 달았는데, `@NoArgsConstructor`가 없으면 큰 문제가 생긴다(아래 트러블슈팅 참고).

```java
// src/main/java/com/study/model/TSAggResult.java

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TSAggResult {
    private String exchange;
    private Long window_start;
    private BigDecimal avg_close;
    private int record_count;

    static public TSAggResult of(String exchange, Long window_start, BigDecimal avg_close, int record_count) {
        return TSAggResult.builder()
            .exchange(exchange)
            .window_start(window_start)
            .avg_close(avg_close)
            .record_count(record_count)
            .build();
    }
}
```

---

### 트러블슈팅 (Gotchas)

#### 1. @NoArgsConstructor 없으면 JDK 17에서 크래시

**증상:**

```
InaccessibleObjectException: Unable to make field private final ... accessible:
module java.base does not "opens java.util" to unnamed module ...
```

**원인과 해결 과정:**

`TSAggResult`에 `@NoArgsConstructor`가 없으면 Flink가 이 클래스를 POJO로 인식하지 못한다. Flink의 직렬화 우선순위는 다음과 같다.

```
내장 직렬화 (String, Integer 등 기본 타입)
  --> POJO 직렬화 (기본 생성자 + 모든 필드 public 또는 getter/setter)
  --> Kryo (위 두 가지 모두 안 될 때 폴백)
```

POJO 조건을 정리하면:
- public 클래스일 것
- **파라미터 없는 기본 생성자(no-arg constructor)가 있을 것**
- 모든 필드가 public이거나, public getter/setter가 있을 것

`@NoArgsConstructor`가 없으면 `@Builder`와 `@AllArgsConstructor`만으로는 기본 생성자가 만들어지지 않는다. POJO 인식에 실패한 Flink는 Kryo로 폴백하고, Kryo는 초기화 시 리플렉션을 사용하는데, JDK 17의 모듈 시스템이 `java.util` 패키지에 대한 리플렉션 접근을 차단해서 `InaccessibleObjectException`이 발생한다.

**해결:** `@NoArgsConstructor`를 추가하면 Flink가 POJO로 인식하고 Kryo를 쓰지 않는다. 추가로 `.returns()`로 타입을 명시적으로 알려주면 더 안전하다.

```java
.aggregate(new AvgCloseAggregateFunction(), new TSAggResultProcessWindow())
.returns(TypeInformation.of(TSAggResult.class))  // POJO 직렬화 명시 (Kryo 폴백 방지)
.addSink(JdbcSink.sink(...));
```

#### 2. Properties 키 이름 불일치 NPE

**증상:** 코드 실행 시 `NullPointerException`.

**원인:** properties 파일의 키 이름과 코드에서 읽는 키 이름이 달랐다.

```properties
# kinesis-config.properties -- 점(.) 사용
aws.region=ap-northeast-2
```

```java
// 코드에서 하이픈(-) 으로 읽음 -> null 반환 -> NPE
props.getProperty("aws-region")

// 맞는 코드
props.getProperty("aws.region")
```

에러 메시지가 NPE라서 원인을 찾기 어렵다. properties 파일 키 이름과 코드의 키 이름을 항상 맞춰야 한다. IDE의 "Go to Definition"으로 실제 properties 파일의 키를 확인하는 습관을 들이면 이런 실수를 줄일 수 있다.

#### 3. FileSink 체크포인트 미설정

위 Ch11에서도 다뤘지만 다시 한번 강조한다. 체크포인트 없이 실행하면 `output/` 폴더 안에 `.inprogress` 파일만 가득 찬다. 파일이 하나도 완료되지 않는 현상이 발생하면 가장 먼저 `env.enableCheckpointing()`을 확인하자.

---

### 핵심 정리 (Key Takeaways)

1. **FileSink는 체크포인트 필수:** 체크포인트 없이는 `.inprogress` 파일만 생성된다. `env.enableCheckpointing()`을 반드시 호출해야 한다.
2. **FileSink의 Path는 Flink의 Path:** `java.nio.file.Path`가 아닌 `org.apache.flink.core.fs.Path`를 써야 한다. IDE 자동 import에 주의.
3. **JdbcSink는 배치로 보내기:** `JdbcExecutionOptions`의 `batchSize`/`batchIntervalMs`로 배치 INSERT를 설정하지 않으면 DB 부하가 폭발한다.
4. **JdbcSink는 `addSink()` 사용:** 아직 새 API `sinkTo()`를 지원하지 않는다 (Flink 1.20 기준).
5. **POJO에는 @NoArgsConstructor 필수:** 없으면 Flink가 Kryo로 폴백하고 JDK 17에서 크래시가 난다.
6. **AggregateFunction + ProcessWindowFunction 조합:** 메모리 효율적인 집계와 윈도우 메타정보 접근을 동시에 얻을 수 있다. `getResult()` 반환 타입과 `ProcessWindowFunction` 입력 타입이 일치해야 한다.

---

### 다음 단계 (Next Steps)

- **Exactly-once 보장:** JdbcSink의 at-least-once 한계를 극복하기 위해 UPSERT 또는 Two-phase commit Sink 도입
- **Bulk Format FileSink:** Parquet 포맷으로 S3에 저장하는 Bulk Format 실험
- **Flink on Kubernetes:** 로컬 실행에서 벗어나 실제 클러스터 환경 구성

---

### Reference

- [Apache Flink File Sink 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/filesystem/)
- [Apache Flink JDBC Connector 공식 문서](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/jdbc/)
