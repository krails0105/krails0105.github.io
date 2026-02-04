---
title: "[Kafka] Exactly-Once 이해하기 - 멱등 프로듀서, 트랜잭션, 컨슈머 오프셋"
categories:
  - Kafka
tags:
  - [Kafka, ExactlyOnce, Idempotent, Transaction, Streaming]
---

# Introduction

---

Kafka에서 "Exactly-once"는 단일 기능이 아니라 **여러 메커니즘을 조합한 보장 수준**입니다.

핵심 질문:
- Exactly-once는 정확히 무엇을 보장하나?
- 왜 네트워크/재시도가 있으면 기본은 at-least-once가 되나?
- Kafka는 어떤 장치로 중복/유실을 통제하나?

# 1. 배달 보장 수준

---

| 수준 | 설명 | 상황 |
|------|------|------|
| **At-most-once** | 최대 1번 (유실 가능) | ACK 없이 전송 |
| **At-least-once** | 최소 1번 (중복 가능) | 재시도 있음 |
| **Exactly-once** | 정확히 1번 | 중복도 유실도 없음 |

## 왜 At-Least-Once가 기본인가?

```
Producer → 브로커 → ACK
    ↓         ↓
  재시도   저장 성공?
```

네트워크 장애로 ACK가 유실되면:
- Producer는 실패로 판단 → 재전송
- 브로커는 이미 저장 → **중복 발생**

# 2. Exactly-Once의 의미

---

Kafka의 Exactly-once는:

1. **프로듀서 → Kafka 토픽**: 중복 제거
2. **Kafka Streams 등 처리 → 결과 저장**: 한 번만 반영
3. **컨슈머 오프셋 커밋**: 처리 결과와 함께 원자적 저장

**중요:** "물리적으로 네트워크 패킷이 한 번만 간다"가 아닙니다. 실패/재시도는 항상 있고, 그걸 **중복 없이 보이게** 하는 것이 목표입니다.

# 3. 멱등 프로듀서 (Idempotent Producer)

---

프로듀서 재시도에서 발생하는 중복을 제거합니다.

```java
Properties props = new Properties();
props.put("bootstrap.servers", "broker:9092");
props.put("enable.idempotence", "true");  // 멱등성 활성화
props.put("acks", "all");
props.put("retries", Integer.MAX_VALUE);

KafkaProducer<String, String> producer = new KafkaProducer<>(props);
```

## 동작 원리

```
Producer (PID=123, Seq=0) → 브로커
                           [저장: PID=123, Seq=0]

Producer 재시도 (PID=123, Seq=0) → 브로커
                                  [중복 감지! Seq=0 이미 있음]
                                  → 중복 무시
```

| 구성 요소 | 설명 |
|----------|------|
| Producer ID (PID) | 프로듀서 세션 식별 |
| Sequence Number | 파티션별 메시지 순서 |
| 브로커 | PID+Seq로 중복 감지 |

## 한계

- **단일 파티션 내에서만** 중복 제거
- **여러 토픽/파티션에 걸친 원자성** 보장 안 됨
- 프로듀서 재시작 시 PID 변경

# 4. 트랜잭션 프로듀서

---

여러 파티션/토픽에 대한 원자적 쓰기를 보장합니다.

```java
Properties props = new Properties();
props.put("bootstrap.servers", "broker:9092");
props.put("enable.idempotence", "true");
props.put("transactional.id", "my-transactional-id");  // 트랜잭션 ID

KafkaProducer<String, String> producer = new KafkaProducer<>(props);
producer.initTransactions();

try {
    producer.beginTransaction();

    // 여러 파티션에 쓰기
    producer.send(new ProducerRecord<>("topic1", "key", "value"));
    producer.send(new ProducerRecord<>("topic2", "key", "value"));

    // 오프셋 커밋도 트랜잭션에 포함
    producer.sendOffsetsToTransaction(offsets, groupId);

    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

## 트랜잭션 상태

```
beginTransaction
    ↓
send, send, send...
    ↓
commitTransaction → 모든 메시지가 한 번에 보임
    또는
abortTransaction → 모든 메시지 무효화
```

## 컨슈머 격리 수준

```java
// 커밋된 트랜잭션만 읽기
props.put("isolation.level", "read_committed");

// 모든 메시지 읽기 (기본값)
props.put("isolation.level", "read_uncommitted");
```

# 5. Exactly-Once의 어려운 부분: Read-Process-Write

---

```
[읽기] → [처리] → [쓰기] + [오프셋 커밋]
```

이 네 단계가 분리되면 문제 발생:

| 상황 | 결과 |
|------|------|
| 쓰기 성공 → 오프셋 커밋 전 장애 | 재처리 → **중복** |
| 오프셋 커밋 → 쓰기 전 장애 | 누락 → **유실** |

## 해결책: 원자적 처리

```java
// Kafka Streams에서 EOS
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
          StreamsConfig.EXACTLY_ONCE_V2);
```

Kafka Streams는 내부적으로:
1. 처리 결과 쓰기
2. 오프셋 커밋
3. 상태 저장소 업데이트

를 하나의 트랜잭션으로 묶습니다.

# 6. Kafka Streams의 Exactly-Once

---

```java
Properties props = new Properties();
props.put(StreamsConfig.APPLICATION_ID_CONFIG, "my-app");
props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "broker:9092");

// Exactly-once 보장 (Kafka 2.5+)
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
          StreamsConfig.EXACTLY_ONCE_V2);

StreamsBuilder builder = new StreamsBuilder();
builder.stream("input-topic")
    .mapValues(value -> process(value))
    .to("output-topic");

KafkaStreams streams = new KafkaStreams(builder.build(), props);
streams.start();
```

## EOS v2 (exactly_once_v2)

- Kafka 2.5+
- 더 효율적인 트랜잭션 관리
- 스레드당 하나의 Producer

# 7. 외부 시스템 연동

---

Kafka 내부에서는 EOS가 가능하지만, 외부 시스템(DB, API)은 다릅니다.

## 외부 DB 쓰기

```java
// 문제: Kafka 오프셋과 DB 쓰기가 분리됨
consumer.poll() → process() → db.insert() → consumer.commitSync()
                                   ↑
                              여기서 장애 시 중복!
```

## 해결책: 멱등 키

```java
// DB에서 멱등 처리
INSERT INTO table (kafka_partition, kafka_offset, data, ...)
ON CONFLICT (kafka_partition, kafka_offset) DO NOTHING;

// 또는 UPSERT
MERGE INTO table
USING (SELECT ...) ON key = key
WHEN MATCHED THEN UPDATE
WHEN NOT MATCHED THEN INSERT
```

# 8. 설정 요약

---

## Producer 설정

```java
// 멱등 프로듀서
props.put("enable.idempotence", "true");
props.put("acks", "all");
props.put("retries", Integer.MAX_VALUE);
props.put("max.in.flight.requests.per.connection", 5);  // 5 이하

// 트랜잭션 프로듀서
props.put("transactional.id", "unique-id");
```

## Consumer 설정

```java
// 트랜잭션 읽기
props.put("isolation.level", "read_committed");

// 수동 오프셋 관리
props.put("enable.auto.commit", "false");
```

## Streams 설정

```java
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG,
          StreamsConfig.EXACTLY_ONCE_V2);
```

# 9. 체크리스트

---

```
□ "Exactly-once"가 필요한 범위를 명확히 했는가?
   (토픽 기록만? 처리 파이프라인 전체?)
□ 멱등 프로듀서가 활성화되어 있는가?
□ 트랜잭션이 필요한 경우 transactional.id를 설정했는가?
□ 컨슈머가 read_committed로 설정되어 있는가?
□ 외부 시스템 연동 시 멱등 처리를 설계했는가?
□ Kafka Streams 사용 시 EXACTLY_ONCE_V2를 설정했는가?
□ 오프셋 커밋과 결과 쓰기를 원자적으로 묶는 전략이 있는가?
```

# Reference

---

- [Kafka Idempotent Producer](https://kafka.apache.org/documentation/#producerconfigs_enable.idempotence)
- [Kafka Transactions](https://kafka.apache.org/documentation/#semantics)
- [Kafka Streams Exactly-Once](https://kafka.apache.org/documentation/streams/core-concepts#streams_processing_guarantee)
- [KIP-447: Exactly-Once V2](https://cwiki.apache.org/confluence/display/KAFKA/KIP-447:+Producer+scalability+for+exactly+once+semantics)
