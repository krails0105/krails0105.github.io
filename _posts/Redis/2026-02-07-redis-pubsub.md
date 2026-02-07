---
title: "[Redis] Pub/Sub과 Streams - 메시징 패턴과 실시간 처리"
categories:
  - Redis
tags:
  - [Redis, PubSub, Streams, Messaging, RealTime]
---

# Introduction

---

Redis는 캐시뿐 아니라 **메시지 브로커**로도 활용됩니다. **Pub/Sub**은 발행-구독 패턴으로 실시간 알림에 적합하고, **Streams**는 Kafka처럼 메시지를 영속적으로 저장하며 소비자 그룹을 지원합니다.

이 글은 Redis의 두 가지 메시징 기능과 Spring에서의 활용법을 정리합니다.

# 1. Pub/Sub 개념

---

## 구조

```text
Publisher → Channel → Subscriber 1
                   → Subscriber 2
                   → Subscriber 3

특징:
- Fire and Forget: 메시지는 저장되지 않음
- 구독 시점 이후 메시지만 수신
- 연결이 끊기면 메시지 유실
```

## Redis CLI 예시

```bash
# 터미널 1: 구독
SUBSCRIBE news

# 터미널 2: 발행
PUBLISH news "속보: Redis 7.0 릴리즈"

# 터미널 1 출력:
# 1) "message"
# 2) "news"
# 3) "속보: Redis 7.0 릴리즈"
```

## 패턴 구독

```bash
# notifications:* 패턴 구독
PSUBSCRIBE notifications:*

# 발행
PUBLISH notifications:user:123 "새 메시지가 도착했습니다"
PUBLISH notifications:order:456 "주문이 완료되었습니다"
```

# 2. Spring에서 Pub/Sub

---

## 설정

```java
@Configuration
public class RedisPubSubConfig {

    @Bean
    public RedisMessageListenerContainer redisMessageListenerContainer(
            RedisConnectionFactory factory,
            MessageListenerAdapter listenerAdapter) {

        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        container.addMessageListener(listenerAdapter, new PatternTopic("notifications:*"));
        return container;
    }

    @Bean
    public MessageListenerAdapter messageListenerAdapter(NotificationSubscriber subscriber) {
        return new MessageListenerAdapter(subscriber, "handleMessage");
    }
}
```

## 구독자 (Subscriber)

```java
@Component
@Slf4j
public class NotificationSubscriber {

    public void handleMessage(String message, String channel) {
        log.info("채널: {}, 메시지: {}", channel, message);
        // 알림 처리 로직
    }
}
```

## 발행자 (Publisher)

```java
@Service
@RequiredArgsConstructor
public class NotificationPublisher {

    private final RedisTemplate<String, Object> redisTemplate;

    public void sendNotification(Long userId, String message) {
        String channel = "notifications:user:" + userId;
        redisTemplate.convertAndSend(channel, message);
    }

    public void broadcast(String message) {
        redisTemplate.convertAndSend("notifications:all", message);
    }
}
```

## 사용 예시

```java
@RestController
@RequiredArgsConstructor
public class NotificationController {

    private final NotificationPublisher publisher;

    @PostMapping("/notify/{userId}")
    public void notify(@PathVariable Long userId, @RequestBody String message) {
        publisher.sendNotification(userId, message);
    }
}
```

# 3. Pub/Sub 활용 사례

---

## 실시간 알림

```java
@Service
@RequiredArgsConstructor
public class ChatService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 채팅방 메시지 발행
    public void sendMessage(Long roomId, ChatMessage message) {
        String channel = "chat:room:" + roomId;
        redisTemplate.convertAndSend(channel, message);
    }
}
```

## 캐시 무효화 전파

```java
@Service
@RequiredArgsConstructor
public class CacheInvalidationService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 모든 서버에 캐시 무효화 알림
    public void invalidateCache(String cacheKey) {
        redisTemplate.convertAndSend("cache:invalidate", cacheKey);
    }
}

@Component
@Slf4j
public class CacheInvalidationSubscriber {

    @Autowired
    private CacheManager cacheManager;

    public void handleMessage(String cacheKey, String channel) {
        log.info("캐시 무효화: {}", cacheKey);
        // 로컬 캐시 삭제
        cacheManager.getCache("localCache").evict(cacheKey);
    }
}
```

## 설정 갱신 전파

```java
// 설정 변경 시 모든 서버에 알림
public void updateConfig(String key, String value) {
    configRepository.save(key, value);
    redisTemplate.convertAndSend("config:reload", key);
}
```

# 4. Pub/Sub 한계

---

```text
❌ 메시지 영속성 없음
   - 구독자가 없으면 메시지 소실
   - 연결 끊김 시 메시지 유실

❌ 재처리 불가
   - 과거 메시지 조회 불가
   - 실패한 메시지 재시도 어려움

❌ 소비자 그룹 없음
   - 모든 구독자가 모든 메시지 수신
   - 작업 분산 불가

→ 이런 요구사항이 있으면 Redis Streams 사용
```

# 5. Redis Streams 개념

---

Redis 5.0에서 추가된 **Streams**는 Kafka와 유사한 로그 기반 자료구조입니다.

```text
Stream:
┌────────────────────────────────────────────────────┐
│ 1705300000000-0 │ 1705300000001-0 │ 1705300000002-0 │ ...
│ {user: "A"}     │ {user: "B"}     │ {user: "C"}     │
└────────────────────────────────────────────────────┘
         ↑                 ↑
    Consumer 1         Consumer 2
   (Group: workers)   (Group: workers)

특징:
- 메시지 영속화 (디스크 저장)
- 자동 ID 부여 (타임스탬프-시퀀스)
- 소비자 그룹 지원 (작업 분산)
- ACK 기반 확인 처리
```

## 기본 명령어

```bash
# 메시지 추가
XADD mystream * user "alice" action "login"
# "1705300000000-0" (자동 ID)

# 범위 조회
XRANGE mystream - +  # 전체 조회
XRANGE mystream 1705300000000-0 + COUNT 10  # 특정 ID부터 10개

# 스트림 길이
XLEN mystream
```

## 소비자 그룹

```bash
# 그룹 생성 (처음부터 읽기)
XGROUP CREATE mystream mygroup 0 MKSTREAM

# 그룹에서 읽기 (다음 새 메시지)
XREADGROUP GROUP mygroup consumer1 COUNT 1 STREAMS mystream >

# 처리 완료 확인
XACK mystream mygroup 1705300000000-0

# 펜딩 메시지 조회 (ACK 안 된 것)
XPENDING mystream mygroup
```

# 6. Spring에서 Streams

---

## 설정

```java
@Configuration
public class RedisStreamConfig {

    @Bean
    public StreamMessageListenerContainer<String, ObjectRecord<String, OrderEvent>> streamListenerContainer(
            RedisConnectionFactory factory,
            OrderEventListener listener) {

        StreamMessageListenerContainerOptions<String, ObjectRecord<String, OrderEvent>> options =
            StreamMessageListenerContainerOptions.builder()
                .pollTimeout(Duration.ofSeconds(1))
                .targetType(OrderEvent.class)
                .build();

        StreamMessageListenerContainer<String, ObjectRecord<String, OrderEvent>> container =
            StreamMessageListenerContainer.create(factory, options);

        // 소비자 그룹 설정
        container.receive(
            Consumer.from("order-group", "consumer-1"),
            StreamOffset.create("orders", ReadOffset.lastConsumed()),
            listener
        );

        container.start();
        return container;
    }
}
```

## 이벤트 객체

```java
@Data
@AllArgsConstructor
@NoArgsConstructor
public class OrderEvent {
    private Long orderId;
    private String userId;
    private String action;  // CREATED, PAID, SHIPPED
    private LocalDateTime timestamp;
}
```

## 리스너 (소비자)

```java
@Component
@Slf4j
@RequiredArgsConstructor
public class OrderEventListener implements StreamListener<String, ObjectRecord<String, OrderEvent>> {

    private final StringRedisTemplate redisTemplate;

    @Override
    public void onMessage(ObjectRecord<String, OrderEvent> record) {
        OrderEvent event = record.getValue();
        log.info("주문 이벤트 수신: {}", event);

        try {
            processOrder(event);

            // 처리 완료 ACK
            redisTemplate.opsForStream().acknowledge("orders", "order-group", record.getId());
        } catch (Exception e) {
            log.error("주문 처리 실패: {}", e.getMessage());
            // ACK 안 하면 펜딩 목록에 남음 → 재처리 가능
        }
    }

    private void processOrder(OrderEvent event) {
        // 주문 처리 로직
    }
}
```

## 생산자 (Producer)

```java
@Service
@RequiredArgsConstructor
public class OrderEventPublisher {

    private final RedisTemplate<String, Object> redisTemplate;

    public String publishOrderEvent(OrderEvent event) {
        ObjectRecord<String, OrderEvent> record = StreamRecords.newRecord()
            .ofObject(event)
            .withStreamKey("orders");

        RecordId recordId = redisTemplate.opsForStream().add(record);
        return recordId.getValue();
    }
}
```

# 7. Streams 고급 기능

---

## 펜딩 메시지 재처리

```java
@Scheduled(fixedRate = 60000)  // 1분마다
public void processPendingMessages() {
    PendingMessagesSummary summary = redisTemplate.opsForStream()
        .pending("orders", "order-group");

    if (summary.getTotalPendingMessages() > 0) {
        // 펜딩 메시지 조회
        PendingMessages pending = redisTemplate.opsForStream()
            .pending("orders", Consumer.from("order-group", "consumer-1"), Range.unbounded(), 10);

        for (PendingMessage pm : pending) {
            // 5분 이상 펜딩된 메시지 재처리
            if (pm.getElapsedTimeSinceLastDelivery().toMinutes() > 5) {
                // 메시지 클레임 (다른 소비자가 가져감)
                List<ObjectRecord<String, OrderEvent>> claimed = redisTemplate.opsForStream()
                    .claim("orders", "order-group", "consumer-1",
                        Duration.ofMinutes(5), pm.getId());

                claimed.forEach(this::reprocessMessage);
            }
        }
    }
}
```

## 스트림 트리밍

```java
// 최대 10000개 유지
redisTemplate.opsForStream().trim("orders", 10000);

// 또는 XADD 시 자동 트리밍
// XADD orders MAXLEN ~ 10000 * field value
```

## 스트림 정보 조회

```java
StreamInfo.XInfoStream info = redisTemplate.opsForStream().info("orders");

log.info("스트림 길이: {}", info.streamLength());
log.info("첫 엔트리: {}", info.firstEntry());
log.info("마지막 엔트리: {}", info.lastEntry());
```

# 8. Pub/Sub vs Streams 비교

---

| 특성 | Pub/Sub | Streams |
|------|---------|---------|
| **영속성** | 없음 | 있음 (디스크 저장) |
| **구독 이전 메시지** | 못 받음 | 받을 수 있음 |
| **소비자 그룹** | 없음 | 있음 (작업 분산) |
| **ACK** | 없음 | 있음 (처리 보장) |
| **재처리** | 불가 | 가능 |
| **적합한 용도** | 실시간 알림 | 이벤트 소싱, 작업 큐 |

## 선택 기준

```text
Pub/Sub 선택:
  - 실시간 알림 (채팅, 푸시)
  - 캐시 무효화 전파
  - 메시지 유실 허용

Streams 선택:
  - 주문 처리, 결제 등 신뢰성 필요
  - 여러 워커가 작업 분산
  - 장애 시 재처리 필요
  - 이벤트 이력 보관
```

# 9. 실무 고려사항

---

## Pub/Sub 연결 관리

```java
// 연결 끊김 시 재연결 처리
@Bean
public RedisMessageListenerContainer container(RedisConnectionFactory factory) {
    RedisMessageListenerContainer container = new RedisMessageListenerContainer();
    container.setConnectionFactory(factory);
    container.setRecoveryInterval(5000);  // 5초마다 재연결 시도
    container.setErrorHandler(e -> log.error("Pub/Sub 에러: {}", e.getMessage()));
    return container;
}
```

## Streams 소비자 그룹 초기화

```java
@PostConstruct
public void initConsumerGroup() {
    try {
        redisTemplate.opsForStream().createGroup("orders", "order-group");
    } catch (Exception e) {
        // 이미 존재하면 무시
        if (!e.getMessage().contains("BUSYGROUP")) {
            throw e;
        }
    }
}
```

## 메모리 관리

```text
Streams:
  - MAXLEN으로 오래된 메시지 자동 삭제
  - ~ (approximately) 옵션으로 효율적 트리밍

Pub/Sub:
  - 메시지 저장 안 함 → 메모리 부담 없음
  - 단, 느린 구독자가 있으면 output buffer 증가
```

# 10. 정리

---

| 기능 | Pub/Sub | Streams |
|------|---------|---------|
| **모델** | Fire & Forget | 영속적 로그 |
| **메시지 보관** | 안 함 | 함 |
| **소비자 그룹** | 없음 | 있음 |
| **Spring** | MessageListenerContainer | StreamMessageListenerContainer |

```text
핵심:
  Pub/Sub = 실시간 브로드캐스트, 메시지 유실 허용.
  Streams = Kafka 대안, 신뢰성 필요한 이벤트 처리.
  소비자 그룹으로 워커 분산, ACK로 처리 보장.
  Kafka가 과한 경우 Redis Streams 고려.
```

# Reference

---

- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/)
- [Redis Streams](https://redis.io/docs/data-types/streams/)
- [Spring Data Redis Messaging](https://docs.spring.io/spring-data/redis/docs/current/reference/html/#pubsub)
