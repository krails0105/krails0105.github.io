---
title: "[Kafka] Spring Kafka - Producer, Consumer, 에러 처리 완벽 가이드"
categories:
  - Kafka
tags:
  - [Kafka, Spring, SpringKafka, Producer, Consumer]
---

# Introduction

---

Spring Kafka는 Apache Kafka를 Spring 방식으로 쉽게 사용할 수 있게 해줍니다. **KafkaTemplate**으로 메시지를 발행하고, **@KafkaListener**로 메시지를 소비합니다. 이 글은 Spring Boot에서 Kafka를 설정하고 사용하는 방법을 정리합니다.

# 1. 기본 설정

---

## 의존성

```xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
</dependency>
```

## application.yml

```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092

    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.springframework.kafka.support.serializer.JsonSerializer
      acks: all
      retries: 3

    consumer:
      group-id: my-group
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.JsonDeserializer
      properties:
        spring.json.trusted.packages: "com.example.dto"
```

## 설정 클래스 (커스텀)

```java
@Configuration
public class KafkaConfig {

    @Value("${spring.kafka.bootstrap-servers}")
    private String bootstrapServers;

    // Producer 설정
    @Bean
    public ProducerFactory<String, Object> producerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        config.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        config.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class);
        config.put(ProducerConfig.ACKS_CONFIG, "all");
        return new DefaultKafkaProducerFactory<>(config);
    }

    @Bean
    public KafkaTemplate<String, Object> kafkaTemplate() {
        return new KafkaTemplate<>(producerFactory());
    }

    // Consumer 설정
    @Bean
    public ConsumerFactory<String, Object> consumerFactory() {
        Map<String, Object> config = new HashMap<>();
        config.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        config.put(ConsumerConfig.GROUP_ID_CONFIG, "my-group");
        config.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        config.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, JsonDeserializer.class);
        config.put(JsonDeserializer.TRUSTED_PACKAGES, "com.example.dto");
        return new DefaultKafkaConsumerFactory<>(config);
    }

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, Object> kafkaListenerContainerFactory() {
        ConcurrentKafkaListenerContainerFactory<String, Object> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory());
        return factory;
    }
}
```

# 2. Producer (KafkaTemplate)

---

## 기본 발행

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderEventProducer {

    private final KafkaTemplate<String, Object> kafkaTemplate;

    // 단순 발행
    public void sendOrder(OrderEvent event) {
        kafkaTemplate.send("orders", event);
    }

    // 키와 함께 발행 (같은 키는 같은 Partition)
    public void sendOrderWithKey(OrderEvent event) {
        kafkaTemplate.send("orders", event.getOrderId(), event);
    }

    // 콜백으로 결과 처리
    public void sendOrderWithCallback(OrderEvent event) {
        CompletableFuture<SendResult<String, Object>> future =
            kafkaTemplate.send("orders", event.getOrderId(), event);

        future.whenComplete((result, ex) -> {
            if (ex == null) {
                log.info("메시지 발행 성공: topic={}, partition={}, offset={}",
                    result.getRecordMetadata().topic(),
                    result.getRecordMetadata().partition(),
                    result.getRecordMetadata().offset());
            } else {
                log.error("메시지 발행 실패: {}", ex.getMessage());
            }
        });
    }

    // 동기 발행 (결과 대기)
    public void sendOrderSync(OrderEvent event) {
        try {
            SendResult<String, Object> result =
                kafkaTemplate.send("orders", event.getOrderId(), event).get(10, TimeUnit.SECONDS);
            log.info("동기 발행 완료: offset={}", result.getRecordMetadata().offset());
        } catch (Exception e) {
            log.error("동기 발행 실패", e);
            throw new RuntimeException("Kafka 발행 실패", e);
        }
    }
}
```

## DTO 예시

```java
@Data
@AllArgsConstructor
@NoArgsConstructor
public class OrderEvent {
    private String orderId;
    private Long userId;
    private String status;  // CREATED, PAID, SHIPPED
    private int amount;
    private LocalDateTime createdAt;
}
```

## 특정 Partition으로 발행

```java
// Partition 직접 지정
kafkaTemplate.send("orders", 0, event.getOrderId(), event);  // Partition 0

// 헤더 추가
ProducerRecord<String, Object> record = new ProducerRecord<>("orders", event);
record.headers().add("source", "order-service".getBytes());
kafkaTemplate.send(record);
```

# 3. Consumer (@KafkaListener)

---

## 기본 소비

```java
@Service
@Slf4j
public class OrderEventConsumer {

    // 기본 리스너
    @KafkaListener(topics = "orders", groupId = "order-processor")
    public void consume(OrderEvent event) {
        log.info("주문 이벤트 수신: {}", event);
        processOrder(event);
    }

    // 메타데이터 포함
    @KafkaListener(topics = "orders", groupId = "order-processor")
    public void consumeWithMetadata(
            @Payload OrderEvent event,
            @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
            @Header(KafkaHeaders.OFFSET) long offset,
            @Header(KafkaHeaders.RECEIVED_TIMESTAMP) long timestamp) {

        log.info("수신: partition={}, offset={}, event={}", partition, offset, event);
        processOrder(event);
    }

    // ConsumerRecord로 전체 정보 접근
    @KafkaListener(topics = "orders", groupId = "order-processor")
    public void consumeRecord(ConsumerRecord<String, OrderEvent> record) {
        log.info("Key: {}, Value: {}, Partition: {}, Offset: {}",
            record.key(), record.value(), record.partition(), record.offset());
    }

    private void processOrder(OrderEvent event) {
        // 비즈니스 로직
    }
}
```

## 배치 소비

```java
@Configuration
public class KafkaConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, OrderEvent> batchFactory(
            ConsumerFactory<String, OrderEvent> consumerFactory) {
        ConcurrentKafkaListenerContainerFactory<String, OrderEvent> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);
        factory.setBatchListener(true);  // 배치 모드 활성화
        return factory;
    }
}

@Service
public class OrderBatchConsumer {

    @KafkaListener(topics = "orders", groupId = "batch-processor",
                   containerFactory = "batchFactory")
    public void consumeBatch(List<OrderEvent> events) {
        log.info("배치 수신: {}건", events.size());
        events.forEach(this::processOrder);
    }
}
```

## 여러 Topic 구독

```java
@KafkaListener(topics = {"orders", "payments", "shipments"}, groupId = "event-processor")
public void consumeMultipleTopics(
        @Payload String message,
        @Header(KafkaHeaders.RECEIVED_TOPIC) String topic) {

    switch (topic) {
        case "orders" -> processOrder(message);
        case "payments" -> processPayment(message);
        case "shipments" -> processShipment(message);
    }
}
```

## 동시성 설정

```java
// 3개의 Consumer 스레드
@KafkaListener(topics = "orders", groupId = "order-processor", concurrency = "3")
public void consume(OrderEvent event) {
    // 최대 3개 Partition 병렬 처리
}
```

# 4. 수동 Offset 커밋

---

## 설정

```yaml
spring:
  kafka:
    consumer:
      enable-auto-commit: false
    listener:
      ack-mode: manual
```

## 수동 커밋

```java
@KafkaListener(topics = "orders", groupId = "order-processor")
public void consumeManualAck(
        OrderEvent event,
        Acknowledgment acknowledgment) {

    try {
        processOrder(event);
        acknowledgment.acknowledge();  // 처리 성공 시 커밋
    } catch (Exception e) {
        // 커밋 안 함 → 재처리됨
        throw e;
    }
}
```

## ACK 모드

| 모드 | 설명 |
|------|------|
| `RECORD` | 각 레코드 처리 후 커밋 |
| `BATCH` | poll() 반환된 모든 레코드 처리 후 커밋 |
| `MANUAL` | Acknowledgment.acknowledge() 호출 시 커밋 |
| `MANUAL_IMMEDIATE` | acknowledge() 즉시 커밋 |

# 5. 에러 처리

---

## 기본 에러 핸들러

```java
@Configuration
public class KafkaConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, Object> kafkaListenerContainerFactory(
            ConsumerFactory<String, Object> consumerFactory) {

        ConcurrentKafkaListenerContainerFactory<String, Object> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(consumerFactory);

        // 에러 핸들러
        factory.setCommonErrorHandler(new DefaultErrorHandler(
            new FixedBackOff(1000L, 3L)  // 1초 간격, 3회 재시도
        ));

        return factory;
    }
}
```

## Dead Letter Topic (DLT)

처리 실패한 메시지를 별도 Topic으로 보냅니다.

```java
@Bean
public ConcurrentKafkaListenerContainerFactory<String, Object> kafkaListenerContainerFactory(
        ConsumerFactory<String, Object> consumerFactory,
        KafkaTemplate<String, Object> kafkaTemplate) {

    ConcurrentKafkaListenerContainerFactory<String, Object> factory =
        new ConcurrentKafkaListenerContainerFactory<>();
    factory.setConsumerFactory(consumerFactory);

    // DLT로 전송하는 에러 핸들러
    DeadLetterPublishingRecoverer recoverer =
        new DeadLetterPublishingRecoverer(kafkaTemplate,
            (record, ex) -> new TopicPartition(record.topic() + ".DLT", record.partition()));

    factory.setCommonErrorHandler(new DefaultErrorHandler(
        recoverer,
        new FixedBackOff(1000L, 3L)  // 3회 재시도 후 DLT로
    ));

    return factory;
}
```

## 특정 예외만 재시도

```java
@Bean
public DefaultErrorHandler errorHandler(KafkaTemplate<String, Object> kafkaTemplate) {
    DeadLetterPublishingRecoverer recoverer =
        new DeadLetterPublishingRecoverer(kafkaTemplate);

    DefaultErrorHandler handler = new DefaultErrorHandler(
        recoverer,
        new FixedBackOff(1000L, 3L)
    );

    // 재시도하지 않을 예외
    handler.addNotRetryableExceptions(
        ValidationException.class,
        IllegalArgumentException.class
    );

    return handler;
}
```

## @RetryableTopic (Spring Kafka 2.7+)

```java
@RetryableTopic(
    attempts = "3",
    backoff = @Backoff(delay = 1000, multiplier = 2),
    dltTopicSuffix = ".DLT",
    autoCreateTopics = "true"
)
@KafkaListener(topics = "orders", groupId = "order-processor")
public void consume(OrderEvent event) {
    processOrder(event);
}

// DLT 처리
@DltHandler
public void handleDlt(OrderEvent event, @Header(KafkaHeaders.ORIGINAL_TOPIC) String topic) {
    log.error("DLT 수신: topic={}, event={}", topic, event);
    // 알림, 로깅, 수동 처리 등
}
```

# 6. 트랜잭션

---

## 설정

```yaml
spring:
  kafka:
    producer:
      transaction-id-prefix: tx-
```

## 트랜잭션 사용

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final KafkaTemplate<String, Object> kafkaTemplate;

    public void processOrderWithTransaction(Order order) {
        kafkaTemplate.executeInTransaction(operations -> {
            operations.send("orders", order.getId(), new OrderCreatedEvent(order));
            operations.send("inventory", order.getId(), new InventoryReserveEvent(order));
            operations.send("notifications", order.getId(), new NotificationEvent(order));
            return null;
        });
    }
}
```

## @Transactional과 함께

```java
@Transactional
public void createOrder(OrderRequest request) {
    // DB 저장
    Order order = orderRepository.save(new Order(request));

    // Kafka 발행 (같은 트랜잭션)
    kafkaTemplate.send("orders", order.getId(), new OrderCreatedEvent(order));
}
```

# 7. 테스트

---

## Embedded Kafka

```xml
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka-test</artifactId>
    <scope>test</scope>
</dependency>
```

```java
@SpringBootTest
@EmbeddedKafka(partitions = 1, topics = {"orders"})
class OrderEventProducerTest {

    @Autowired
    private KafkaTemplate<String, Object> kafkaTemplate;

    @Autowired
    private EmbeddedKafkaBroker embeddedKafka;

    @Test
    void 메시지_발행_테스트() throws Exception {
        // Given
        OrderEvent event = new OrderEvent("order-1", 100L, "CREATED", 10000, LocalDateTime.now());

        // When
        kafkaTemplate.send("orders", event.getOrderId(), event).get();

        // Then
        Map<String, Object> consumerProps = KafkaTestUtils.consumerProps(
            "test-group", "true", embeddedKafka);
        consumerProps.put(JsonDeserializer.TRUSTED_PACKAGES, "*");

        ConsumerFactory<String, OrderEvent> cf = new DefaultKafkaConsumerFactory<>(
            consumerProps,
            new StringDeserializer(),
            new JsonDeserializer<>(OrderEvent.class)
        );

        Consumer<String, OrderEvent> consumer = cf.createConsumer();
        embeddedKafka.consumeFromAnEmbeddedTopic(consumer, "orders");

        ConsumerRecords<String, OrderEvent> records =
            KafkaTestUtils.getRecords(consumer, Duration.ofSeconds(5));

        assertThat(records.count()).isEqualTo(1);
        assertThat(records.iterator().next().value().getOrderId()).isEqualTo("order-1");
    }
}
```

## Consumer 테스트

```java
@SpringBootTest
@EmbeddedKafka(partitions = 1, topics = {"orders"})
class OrderEventConsumerTest {

    @Autowired
    private KafkaTemplate<String, Object> kafkaTemplate;

    @SpyBean
    private OrderEventConsumer consumer;

    @Test
    void 메시지_소비_테스트() throws Exception {
        // Given
        OrderEvent event = new OrderEvent("order-1", 100L, "CREATED", 10000, LocalDateTime.now());

        // When
        kafkaTemplate.send("orders", event.getOrderId(), event).get();

        // Then
        verify(consumer, timeout(5000).times(1)).consume(any(OrderEvent.class));
    }
}
```

# 8. 실무 패턴

---

## 멱등성 보장

```java
@Service
@RequiredArgsConstructor
public class OrderEventConsumer {

    private final ProcessedEventRepository processedEventRepository;

    @KafkaListener(topics = "orders", groupId = "order-processor")
    @Transactional
    public void consume(OrderEvent event, @Header(KafkaHeaders.OFFSET) long offset) {
        String eventId = event.getOrderId() + "-" + offset;

        // 이미 처리된 이벤트인지 확인
        if (processedEventRepository.existsById(eventId)) {
            log.info("이미 처리된 이벤트: {}", eventId);
            return;
        }

        // 처리
        processOrder(event);

        // 처리 완료 기록
        processedEventRepository.save(new ProcessedEvent(eventId));
    }
}
```

## 순서 보장이 필요한 경우

```java
// Producer: 같은 키로 발행
public void sendOrderEvent(OrderEvent event) {
    // orderId가 키 → 같은 주문의 이벤트는 같은 Partition
    kafkaTemplate.send("orders", event.getOrderId(), event);
}

// Consumer: Partition 단위로 순차 처리 (기본 동작)
@KafkaListener(topics = "orders", groupId = "order-processor")
public void consume(OrderEvent event) {
    // 같은 Partition의 메시지는 순서대로 처리됨
}
```

# 9. 정리

---

| 컴포넌트 | 역할 |
|----------|------|
| **KafkaTemplate** | 메시지 발행 |
| **@KafkaListener** | 메시지 소비 |
| **Acknowledgment** | 수동 Offset 커밋 |
| **DefaultErrorHandler** | 에러 처리, 재시도 |
| **@RetryableTopic** | 자동 재시도 + DLT |

```text
핵심:
  KafkaTemplate으로 발행, @KafkaListener로 소비.
  키를 지정하면 같은 Partition → 순서 보장.
  에러 처리: 재시도 + Dead Letter Topic.
  수동 ACK로 정확한 Offset 관리.
```

# Reference

---

- [Spring for Apache Kafka](https://docs.spring.io/spring-kafka/docs/current/reference/html/)
- [Spring Kafka Samples](https://github.com/spring-projects/spring-kafka/tree/main/samples)
- [Confluent Spring Kafka](https://docs.confluent.io/platform/current/clients/spring.html)
