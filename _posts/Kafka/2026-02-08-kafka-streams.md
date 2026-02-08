---
title: "[Kafka] Kafka Streams 기초 - 실시간 스트림 처리의 시작"
categories:
  - Kafka
tags:
  - [Kafka, KafkaStreams, StreamProcessing, RealTime]
---

# Introduction

---

Kafka에서 메시지를 소비하고 처리 결과를 다시 Kafka에 발행하는 패턴은 매우 흔합니다. **Kafka Streams**는 이런 스트림 처리를 위한 경량 라이브러리입니다. 별도의 클러스터(Spark, Flink) 없이 **일반 Java 애플리케이션**으로 실시간 처리가 가능합니다.

이 글은 Kafka Streams의 핵심 개념과 기본 사용법을 정리합니다.

# 1. Kafka Streams 개요

---

## 특징

```text
장점:
- 별도 클러스터 불필요 (일반 Java 앱)
- Kafka에만 의존 (다른 시스템 필요 없음)
- Exactly-once 지원
- 상태 저장 처리 (State Store)
- 장애 복구 자동화

단점:
- Kafka 입출력만 가능 (외부 소스 직접 연결 불가)
- 복잡한 처리는 Flink/Spark가 더 적합
```

## vs 다른 스트림 처리

| 특성 | Kafka Streams | Apache Flink | Spark Streaming |
|------|--------------|--------------|-----------------|
| **배포** | 일반 앱 | 클러스터 | 클러스터 |
| **소스** | Kafka만 | 다양함 | 다양함 |
| **지연** | 밀리초 | 밀리초 | 초~분 |
| **상태 관리** | RocksDB | Checkpoint | Checkpoint |
| **복잡도** | 낮음 | 높음 | 중간 |

## 아키텍처

```text
┌─────────────────────────────────────────────────────────┐
│              Kafka Streams Application                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Stream Topology                      │   │
│  │  Source → Filter → Map → GroupBy → Aggregate     │   │
│  │     ↓                                    ↓        │   │
│  │  [Input Topic]                    [Output Topic]  │   │
│  └─────────────────────────────────────────────────┘   │
│                         ↓                               │
│                  [State Store]                          │
│                   (RocksDB)                             │
└─────────────────────────────────────────────────────────┘
              ↑                         ↓
        Kafka Broker              Kafka Broker
```

# 2. 기본 설정

---

## 의존성

```xml
<dependency>
    <groupId>org.apache.kafka</groupId>
    <artifactId>kafka-streams</artifactId>
</dependency>

<!-- Spring Boot 사용 시 -->
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

## 기본 설정

```java
Properties props = new Properties();
props.put(StreamsConfig.APPLICATION_ID_CONFIG, "my-streams-app");
props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

// Exactly-once 처리
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);
```

# 3. 핵심 개념

---

## KStream vs KTable

```text
KStream (이벤트 스트림):
  - 각 레코드는 독립적인 이벤트
  - INSERT 시맨틱
  - 예: 클릭 로그, 주문 이벤트

  Key: user1, Value: click
  Key: user1, Value: click
  Key: user1, Value: click
  → 3개의 클릭 이벤트

KTable (변경 로그):
  - 키별 최신 값만 유지
  - UPSERT 시맨틱
  - 예: 사용자 프로필, 재고 수량

  Key: user1, Value: {name: "Alice"}
  Key: user1, Value: {name: "Alice Kim"}
  Key: user1, Value: {name: "Alice Lee"}
  → user1의 현재 이름은 "Alice Lee"
```

## Topology

처리 흐름을 정의하는 DAG(방향 비순환 그래프)입니다.

```java
StreamsBuilder builder = new StreamsBuilder();

// 토폴로지 정의
KStream<String, String> source = builder.stream("input-topic");
source
    .filter((key, value) -> value != null)
    .mapValues(value -> value.toUpperCase())
    .to("output-topic");

// 토폴로지 빌드
Topology topology = builder.build();
```

## State Store

상태를 저장하는 로컬 저장소입니다.

```text
- 집계, 조인 등에 필요한 상태 저장
- RocksDB로 디스크에 영속화
- Changelog Topic으로 백업 (장애 복구)
```

# 4. 기본 연산

---

## Stateless 연산

상태 없이 각 레코드를 독립적으로 처리합니다.

```java
StreamsBuilder builder = new StreamsBuilder();
KStream<String, String> source = builder.stream("orders");

// filter: 조건에 맞는 레코드만
KStream<String, String> filtered = source
    .filter((key, value) -> value.contains("PAID"));

// map: 키와 값 변환
KStream<String, Integer> mapped = source
    .map((key, value) -> KeyValue.pair(key, value.length()));

// mapValues: 값만 변환
KStream<String, String> upperCased = source
    .mapValues(value -> value.toUpperCase());

// flatMapValues: 값을 여러 개로 분리
KStream<String, String> words = source
    .flatMapValues(value -> Arrays.asList(value.split(" ")));

// selectKey: 키 변경
KStream<String, String> rekeyed = source
    .selectKey((key, value) -> extractUserId(value));

// branch: 조건별 분기
Map<String, KStream<String, String>> branches = source
    .split(Named.as("branch-"))
    .branch((key, value) -> value.contains("URGENT"), Branched.as("urgent"))
    .branch((key, value) -> true, Branched.as("normal"))
    .noDefaultBranch();

KStream<String, String> urgent = branches.get("branch-urgent");
KStream<String, String> normal = branches.get("branch-normal");
```

## Stateful 연산

상태를 유지하며 처리합니다.

```java
// groupByKey: 키로 그룹화
KGroupedStream<String, String> grouped = source.groupByKey();

// groupBy: 새 키로 그룹화
KGroupedStream<String, String> regrouped = source
    .groupBy((key, value) -> extractCategory(value));

// count: 개수 집계
KTable<String, Long> counts = grouped.count();

// reduce: 값 누적
KTable<String, String> reduced = grouped
    .reduce((value1, value2) -> value1 + "," + value2);

// aggregate: 커스텀 집계
KTable<String, OrderStats> stats = grouped.aggregate(
    () -> new OrderStats(),  // 초기값
    (key, value, aggregate) -> aggregate.add(value),  // 집계 함수
    Materialized.with(Serdes.String(), new OrderStatsSerde())
);
```

# 5. Windowing

---

시간 기반으로 데이터를 그룹화합니다.

## Tumbling Window

고정 크기, 겹치지 않는 윈도우입니다.

```java
// 5분 단위 윈도우
KTable<Windowed<String>, Long> windowedCounts = source
    .groupByKey()
    .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5)))
    .count();

// 결과 출력
windowedCounts.toStream()
    .foreach((windowedKey, count) -> {
        String key = windowedKey.key();
        Window window = windowedKey.window();
        System.out.printf("Key: %s, Window: [%s - %s], Count: %d%n",
            key,
            Instant.ofEpochMilli(window.start()),
            Instant.ofEpochMilli(window.end()),
            count);
    });
```

## Hopping Window

고정 크기, 겹치는 윈도우입니다.

```java
// 5분 윈도우, 1분 간격 (겹침)
KTable<Windowed<String>, Long> hoppingCounts = source
    .groupByKey()
    .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5))
                           .advanceBy(Duration.ofMinutes(1)))
    .count();
```

## Session Window

활동 기반 동적 윈도우입니다.

```java
// 5분 비활동 시 세션 종료
KTable<Windowed<String>, Long> sessionCounts = source
    .groupByKey()
    .windowedBy(SessionWindows.ofInactivityGapWithNoGrace(Duration.ofMinutes(5)))
    .count();
```

# 6. Join

---

## KStream-KStream Join

두 스트림의 이벤트를 시간 윈도우 내에서 조인합니다.

```java
KStream<String, Order> orders = builder.stream("orders");
KStream<String, Payment> payments = builder.stream("payments");

// 1시간 윈도우 내 조인
KStream<String, OrderWithPayment> joined = orders.join(
    payments,
    (order, payment) -> new OrderWithPayment(order, payment),
    JoinWindows.ofTimeDifferenceWithNoGrace(Duration.ofHours(1)),
    StreamJoined.with(Serdes.String(), orderSerde, paymentSerde)
);
```

## KStream-KTable Join

스트림 이벤트를 테이블의 현재 값과 조인합니다.

```java
KStream<String, Order> orders = builder.stream("orders");
KTable<String, User> users = builder.table("users");

// 주문에 사용자 정보 추가
KStream<String, EnrichedOrder> enriched = orders.join(
    users,
    (order, user) -> new EnrichedOrder(order, user)
);
```

## KTable-KTable Join

두 테이블을 조인합니다.

```java
KTable<String, User> users = builder.table("users");
KTable<String, Address> addresses = builder.table("addresses");

KTable<String, UserWithAddress> joined = users.join(
    addresses,
    (user, address) -> new UserWithAddress(user, address)
);
```

# 7. 전체 예시

---

## 실시간 단어 카운트

```java
public class WordCountApp {

    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "word-count-app");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

        StreamsBuilder builder = new StreamsBuilder();

        // 토폴로지 정의
        KStream<String, String> textLines = builder.stream("text-input");

        KTable<String, Long> wordCounts = textLines
            .flatMapValues(line -> Arrays.asList(line.toLowerCase().split("\\W+")))
            .groupBy((key, word) -> word)
            .count(Materialized.as("word-counts-store"));

        wordCounts.toStream().to("word-count-output",
            Produced.with(Serdes.String(), Serdes.Long()));

        // 실행
        KafkaStreams streams = new KafkaStreams(builder.build(), props);

        // Graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(streams::close));

        streams.start();
    }
}
```

## 주문 집계 (5분 윈도우)

```java
public class OrderAggregatorApp {

    public static void main(String[] args) {
        StreamsBuilder builder = new StreamsBuilder();

        KStream<String, Order> orders = builder.stream("orders",
            Consumed.with(Serdes.String(), new OrderSerde()));

        // 5분 윈도우별 매출 집계
        KTable<Windowed<String>, OrderStats> stats = orders
            .groupBy((key, order) -> order.getCategory())
            .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5)))
            .aggregate(
                OrderStats::new,
                (category, order, stats) -> {
                    stats.addOrder(order);
                    return stats;
                },
                Materialized.with(Serdes.String(), new OrderStatsSerde())
            );

        stats.toStream()
            .map((windowedKey, value) -> KeyValue.pair(
                windowedKey.key() + "@" + windowedKey.window().start(),
                value))
            .to("order-stats-output");

        // 실행...
    }
}

@Data
public class OrderStats {
    private long count = 0;
    private long totalAmount = 0;

    public void addOrder(Order order) {
        count++;
        totalAmount += order.getAmount();
    }
}
```

# 8. Spring Boot 연동

---

## 설정

```yaml
spring:
  kafka:
    streams:
      application-id: my-streams-app
      bootstrap-servers: localhost:9092
      properties:
        default.key.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
        default.value.serde: org.apache.kafka.common.serialization.Serdes$StringSerde
```

## 토폴로지 빈 등록

```java
@Configuration
@EnableKafkaStreams
public class KafkaStreamsConfig {

    @Bean
    public KStream<String, String> kStream(StreamsBuilder builder) {
        KStream<String, String> stream = builder.stream("input-topic");

        stream
            .filter((key, value) -> value != null && !value.isEmpty())
            .mapValues(String::toUpperCase)
            .to("output-topic");

        return stream;
    }
}
```

## 상태 저장소 접근

```java
@Service
@RequiredArgsConstructor
public class WordCountService {

    private final StreamsBuilderFactoryBean streamsBuilderFactoryBean;

    public Long getWordCount(String word) {
        KafkaStreams streams = streamsBuilderFactoryBean.getKafkaStreams();
        ReadOnlyKeyValueStore<String, Long> store = streams.store(
            StoreQueryParameters.fromNameAndType("word-counts-store",
                QueryableStoreTypes.keyValueStore())
        );
        return store.get(word);
    }
}
```

# 9. 정리

---

| 개념 | 설명 |
|------|------|
| **KStream** | 이벤트 스트림 (INSERT) |
| **KTable** | 변경 로그 (UPSERT) |
| **Topology** | 처리 흐름 정의 |
| **State Store** | 상태 저장 (RocksDB) |
| **Windowing** | 시간 기반 그룹화 |

| 윈도우 | 설명 |
|--------|------|
| **Tumbling** | 고정 크기, 겹치지 않음 |
| **Hopping** | 고정 크기, 겹침 |
| **Session** | 활동 기반 동적 크기 |

```text
핵심:
  Kafka Streams = Kafka 기반 경량 스트림 처리.
  KStream은 이벤트, KTable은 상태.
  Windowing으로 시간 기반 집계.
  별도 클러스터 없이 일반 Java 앱으로 실행.
```

# Reference

---

- [Kafka Streams Documentation](https://kafka.apache.org/documentation/streams/)
- [Kafka Streams Developer Guide](https://docs.confluent.io/platform/current/streams/developer-guide/index.html)
- [Kafka Streams Examples](https://github.com/confluentinc/kafka-streams-examples)
