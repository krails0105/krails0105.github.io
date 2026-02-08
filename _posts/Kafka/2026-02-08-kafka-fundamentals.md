---
title: "[Kafka] 핵심 개념 - Topic, Partition, Producer, Consumer 이해하기"
categories:
  - Kafka
tags:
  - [Kafka, MessageQueue, EventDriven, Producer, Consumer]
---

# Introduction

---

시스템 간 데이터를 주고받을 때 직접 API를 호출하면 강한 결합이 생깁니다. 한 시스템이 다운되면 다른 시스템도 영향을 받습니다. **Apache Kafka**는 **분산 이벤트 스트리밍 플랫폼**으로, 시스템 간 결합을 느슨하게 하고 대용량 데이터를 안정적으로 처리합니다.

이 글은 Kafka의 핵심 개념인 Topic, Partition, Producer, Consumer를 정리합니다.

# 1. Kafka 개요

---

## 메시지 큐 vs 이벤트 스트리밍

```text
전통적 메시지 큐 (RabbitMQ 등):
- 메시지 소비 후 삭제
- Point-to-Point 또는 Pub/Sub
- 일시적 저장

Kafka (이벤트 스트리밍):
- 메시지 소비 후에도 보관 (retention)
- 여러 Consumer가 같은 메시지 소비 가능
- 영속적 저장 (디스크)
- 재처리 가능
```

## 사용 사례

| 사용 사례 | 설명 |
|----------|------|
| **이벤트 기반 아키텍처** | 마이크로서비스 간 비동기 통신 |
| **로그 집계** | 여러 서버의 로그를 중앙 수집 |
| **스트림 처리** | 실시간 데이터 분석 |
| **데이터 파이프라인** | DB → 데이터 레이크 동기화 |
| **이벤트 소싱** | 상태 변화를 이벤트로 저장 |

## 아키텍처 개요

```text
┌─────────────────────────────────────────────────────────┐
│                     Kafka Cluster                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │ Broker 1│  │ Broker 2│  │ Broker 3│                 │
│  └─────────┘  └─────────┘  └─────────┘                 │
│        ↑           ↑           ↑                        │
│        └───────────┼───────────┘                        │
│                    │                                     │
│              ┌─────┴─────┐                              │
│              │ ZooKeeper │  (또는 KRaft)                 │
│              └───────────┘                              │
└─────────────────────────────────────────────────────────┘
         ↑                           ↓
    ┌─────────┐                 ┌─────────┐
    │ Producer│                 │ Consumer│
    └─────────┘                 └─────────┘
```

# 2. Topic과 Partition

---

## Topic

**Topic**은 메시지의 논리적 분류입니다. 파일 시스템의 폴더와 비슷합니다.

```text
Topic: orders          - 주문 이벤트
Topic: user-activities - 사용자 행동 로그
Topic: payments        - 결제 이벤트
```

## Partition

Topic은 여러 **Partition**으로 나뉩니다. 각 Partition은 순서가 보장되는 불변 로그입니다.

```text
Topic: orders (3 partitions)

Partition 0: [msg0, msg3, msg6, msg9 ...]
Partition 1: [msg1, msg4, msg7, msg10 ...]
Partition 2: [msg2, msg5, msg8, msg11 ...]

- 각 Partition 내에서는 순서 보장
- Partition 간에는 순서 보장 없음
```

## 왜 Partition이 필요한가?

```text
1. 병렬 처리
   - 여러 Consumer가 동시에 다른 Partition 소비
   - Partition 수 = 최대 병렬도

2. 수평 확장
   - Partition을 여러 Broker에 분산
   - 처리량 선형 증가

3. 내결함성
   - 복제(Replication)로 Partition 복사
   - Broker 장애 시 다른 복제본 사용
```

## Offset

각 Partition 내 메시지의 고유 위치입니다.

```text
Partition 0:
  Offset 0: {"orderId": 1, "amount": 10000}
  Offset 1: {"orderId": 2, "amount": 20000}
  Offset 2: {"orderId": 3, "amount": 15000}
  ...

Consumer는 현재 읽은 Offset을 기록 (commit)
→ 재시작 시 마지막 Offset부터 이어서 소비
```

## Partition 키

메시지의 키로 Partition을 결정합니다.

```text
키가 없으면: Round-Robin으로 분배
키가 있으면: hash(key) % partition_count

예: 주문 ID를 키로 사용
  → 같은 주문의 모든 이벤트가 같은 Partition
  → 해당 주문 내 순서 보장
```

# 3. Producer

---

## 역할

Producer는 Topic에 메시지를 발행합니다.

```text
Producer → 메시지 직렬화 → Partition 결정 → Broker 전송
```

## 핵심 설정

| 설정 | 설명 | 권장값 |
|------|------|--------|
| `acks` | 확인 응답 수준 | `all` (안전) / `1` (성능) |
| `retries` | 재시도 횟수 | 충분히 크게 (예: 3) |
| `linger.ms` | 배치 대기 시간 | 5~100ms |
| `batch.size` | 배치 크기 | 16KB~1MB |

## ACKs 옵션

```text
acks=0: Fire and forget (응답 안 기다림)
  - 가장 빠름
  - 메시지 유실 가능

acks=1: Leader만 확인
  - 적당한 성능/안전성
  - Leader 장애 시 유실 가능

acks=all (=-1): 모든 ISR 복제본 확인
  - 가장 안전
  - 약간의 지연
```

## Java 예시

```java
Properties props = new Properties();
props.put("bootstrap.servers", "localhost:9092");
props.put("key.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("value.serializer", "org.apache.kafka.common.serialization.StringSerializer");
props.put("acks", "all");

KafkaProducer<String, String> producer = new KafkaProducer<>(props);

// 동기 전송
ProducerRecord<String, String> record = new ProducerRecord<>(
    "orders",           // topic
    "order-123",        // key (Partition 결정)
    "{\"amount\": 10000}"  // value
);

try {
    RecordMetadata metadata = producer.send(record).get();
    System.out.println("Partition: " + metadata.partition() +
                       ", Offset: " + metadata.offset());
} catch (Exception e) {
    e.printStackTrace();
}

// 비동기 전송
producer.send(record, (metadata, exception) -> {
    if (exception != null) {
        exception.printStackTrace();
    } else {
        System.out.println("Sent to " + metadata.partition());
    }
});

producer.close();
```

# 4. Consumer

---

## 역할

Consumer는 Topic에서 메시지를 읽습니다.

```text
Consumer → Partition 할당 → 메시지 Poll → 처리 → Offset Commit
```

## Consumer Group

여러 Consumer가 **Consumer Group**을 구성하여 Partition을 나눠 소비합니다.

```text
Topic: orders (4 partitions)
Consumer Group: order-processor

Consumer 1: Partition 0, 1
Consumer 2: Partition 2, 3

→ 하나의 Partition은 Group 내 하나의 Consumer만 소비
→ Consumer 추가하면 자동 리밸런싱
```

## Consumer 수 vs Partition 수

```text
Consumer < Partition: 일부 Consumer가 여러 Partition 담당
Consumer = Partition: 이상적 (1:1 매핑)
Consumer > Partition: 초과 Consumer는 유휴 상태

권장: Partition 수 >= 예상 최대 Consumer 수
```

## Offset Commit

```text
Auto Commit (기본):
  enable.auto.commit=true
  auto.commit.interval.ms=5000
  → 5초마다 자동 커밋
  → 장애 시 중복 처리 가능

Manual Commit:
  enable.auto.commit=false
  → 처리 완료 후 명시적 커밋
  → At-least-once 보장
```

## Java 예시

```java
Properties props = new Properties();
props.put("bootstrap.servers", "localhost:9092");
props.put("group.id", "order-processor");
props.put("key.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
props.put("value.deserializer", "org.apache.kafka.common.serialization.StringDeserializer");
props.put("enable.auto.commit", "false");  // 수동 커밋

KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
consumer.subscribe(Arrays.asList("orders"));

try {
    while (true) {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));

        for (ConsumerRecord<String, String> record : records) {
            System.out.printf("Partition=%d, Offset=%d, Key=%s, Value=%s%n",
                record.partition(), record.offset(), record.key(), record.value());

            // 메시지 처리
            processOrder(record.value());
        }

        // 처리 완료 후 커밋
        consumer.commitSync();
    }
} finally {
    consumer.close();
}
```

# 5. 복제와 내결함성

---

## Replication

각 Partition은 여러 Broker에 복제됩니다.

```text
Topic: orders, Partition 0, Replication Factor: 3

Broker 1: Partition 0 (Leader)     ← Producer/Consumer 연결
Broker 2: Partition 0 (Follower)   ← Leader 복제
Broker 3: Partition 0 (Follower)   ← Leader 복제

Leader 장애 시 → Follower가 새 Leader 승격
```

## ISR (In-Sync Replicas)

```text
ISR: Leader와 동기화된 복제본 집합

- 모든 Follower가 ISR에 있으면 안전
- Follower가 뒤처지면 ISR에서 제외
- acks=all은 ISR 모두에 쓰기 확인
```

## min.insync.replicas

```text
min.insync.replicas=2, replication.factor=3

- 최소 2개 복제본이 ISR에 있어야 쓰기 허용
- 1개만 남으면 쓰기 거부 (안전성 확보)
```

# 6. 주요 명령어 (CLI)

---

```bash
# Topic 생성
kafka-topics.sh --create \
  --topic orders \
  --partitions 3 \
  --replication-factor 2 \
  --bootstrap-server localhost:9092

# Topic 목록
kafka-topics.sh --list --bootstrap-server localhost:9092

# Topic 상세 정보
kafka-topics.sh --describe --topic orders --bootstrap-server localhost:9092

# 메시지 발행 (테스트)
kafka-console-producer.sh --topic orders --bootstrap-server localhost:9092

# 메시지 소비 (테스트)
kafka-console-consumer.sh --topic orders \
  --from-beginning \
  --bootstrap-server localhost:9092

# Consumer Group 목록
kafka-consumer-groups.sh --list --bootstrap-server localhost:9092

# Consumer Group 상태 (Lag 확인)
kafka-consumer-groups.sh --describe \
  --group order-processor \
  --bootstrap-server localhost:9092
```

# 7. 설계 시 고려사항

---

## Partition 수 결정

```text
고려 요소:
1. 예상 처리량: 초당 메시지 수
2. 단일 Partition 처리량: ~10MB/s (환경에 따라 다름)
3. Consumer 병렬도: Partition 수 = 최대 Consumer 수

예시:
  - 예상 처리량: 100MB/s
  - 단일 Partition: 10MB/s
  - 필요 Partition: 100 / 10 = 10개 (여유분 포함 12~15개)

주의:
  - Partition 수는 늘리기만 가능 (줄이기 불가)
  - 너무 많으면 리더 선출, 리밸런싱 비용 증가
```

## 메시지 키 선택

```text
목표: 관련 메시지가 같은 Partition으로 (순서 보장)

예시:
  - 주문 이벤트 → 주문 ID
  - 사용자 활동 → 사용자 ID
  - IoT 센서 → 디바이스 ID

주의:
  - 키 분포가 불균형하면 특정 Partition에 쏠림
  - Hot Key 문제 발생 가능
```

## Retention 설정

```text
retention.ms: 메시지 보관 시간
  - 기본: 7일 (168시간)
  - 로그: 1~3일
  - 이벤트 소싱: 길게 또는 무제한

retention.bytes: Partition당 최대 크기
  - 용량 제한 필요 시 설정

cleanup.policy:
  - delete: 오래된 메시지 삭제
  - compact: 키별 최신 값만 유지
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Topic** | 메시지의 논리적 분류 |
| **Partition** | Topic의 물리적 분할, 순서 보장 단위 |
| **Offset** | Partition 내 메시지 위치 |
| **Producer** | 메시지 발행자 |
| **Consumer** | 메시지 소비자 |
| **Consumer Group** | Consumer 집합, Partition 분배 |
| **Replication** | Partition 복제, 내결함성 |

```text
핵심:
  Kafka = 분산, 내결함성, 고처리량 이벤트 스트리밍.
  Partition으로 병렬 처리, 복제로 안전성.
  Consumer Group으로 수평 확장.
  같은 키 = 같은 Partition = 순서 보장.
```

# Reference

---

- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
- [Kafka: The Definitive Guide](https://www.confluent.io/resources/kafka-the-definitive-guide/)
- [Confluent Developer](https://developer.confluent.io/)
