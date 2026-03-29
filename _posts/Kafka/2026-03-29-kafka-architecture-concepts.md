---
title: "[Kafka] 아키텍처 핵심 개념 정리 - 토픽 설계부터 KRaft, Kinesis 비교까지"
categories:
  - Kafka
tags:
  - Kafka
  - KRaft
  - ZooKeeper
  - Partitioner
  - Assignor
  - Controller
  - EKS
  - Kinesis
---

## 들어가며

EKS에 Kafka를 배포하면서 "파티션을 몇 개로 잡아야 하나?", "KRaft와 ZooKeeper는 뭐가 다른가?", "Partitioner와 Assignor의 차이는?" 같은 질문이 연속으로 나왔습니다.

이 글은 그 Q&A를 주제별로 정리한 아키텍처 개념 노트입니다. 코드보다 **왜 이런 설계가 되어 있는지**에 집중합니다. Kafka를 처음 운영 환경에 배포하거나, 기본 개념은 알지만 설계 판단 기준이 부족한 분에게 도움이 될 것입니다.

### 사전 지식

- Kafka의 Producer/Consumer/Broker 개념을 대략적으로 알고 있으면 됩니다.
- EKS(Kubernetes) 관련 섹션은 K8s 기본 용어(Pod, Helm, PVC)를 알면 이해하기 쉽습니다.

## 1. 토픽과 파티션 설계

### 토픽 수 결정: Consumer가 다르면 분리

토픽을 나누는 가장 간단한 기준은 **Consumer가 다른가**입니다.

```text
파이프라인 이벤트 Consumer: Flink 집계 잡
알림 이벤트 Consumer: 알림 서비스

→ 토픽 분리: pipeline-events / alert-events
```

같은 메시지라도 처리 주체가 다르면 토픽을 분리합니다. 하나의 토픽에 여러 Consumer Group이 붙는 패턴도 가능하고, 각 Group의 offset은 독립적으로 추적됩니다. 하지만 **스키마나 보존 기간(retention)이 달라질 경우** 토픽 분리가 훨씬 관리하기 편합니다.

### 파티션 수 결정: 배수로 잡아라

```text
권장: max(브로커 수, 목표 Consumer 병렬도)의 배수

예시: 브로커 3개, Consumer 최대 6개
  → 파티션 수 = 6 (브로커당 2개씩 균등 분배)
  → 또는 12 (여유분 확보)
```

파티션 수는 **최대 병렬도의 상한선**입니다. Consumer 6개를 띄워도 파티션이 4개면 2개의 Consumer는 할당받을 파티션이 없어 유휴 상태가 됩니다.

### 파티션은 늘릴 수 있지만 줄일 수 없다

파티션을 줄이려면 토픽을 삭제하고 재생성해야 합니다. 처음부터 넉넉하게 잡되, 너무 많으면 다음과 같은 간접 비용이 발생합니다.

```text
파티션 수가 많아지면:
- 메모리: 파티션마다 버퍼(batch, index 등)가 생김
- 파일 디스크립터: OS 제한(ulimit) 초과 가능성
- 리더 선출 시간: 브로커 장애 시 선출해야 할 파티션 수에 비례해 증가

→ "직접 과금"은 없지만 운영 비용 존재
```

### Replication Factor와의 관계

```text
파티션 4개, RF=3 → 실제 저장되는 복제본 수 = 4 × 3 = 12개

Partition 0: Leader(Broker1), Follower(Broker2), Follower(Broker3)
Partition 1: Leader(Broker2), Follower(Broker3), Follower(Broker1)
Partition 2: Leader(Broker3), Follower(Broker1), Follower(Broker2)
Partition 3: Leader(Broker1), Follower(Broker2), Follower(Broker3)

→ 리더와 팔로워가 서로 다른 브로커에 분산
→ 브로커 1개가 죽어도 나머지에서 리더 선출 가능
```

RF(Replication Factor)는 리더를 포함한 복제본의 총 개수입니다. RF=3이면 원본(리더) 포함 3벌이 존재합니다. 프로덕션 환경에서는 RF=3이 사실상 표준이며, 이 경우 브로커가 최소 3개 이상 필요합니다.

Kafka는 다수결 투표 대신 **ISR(In-Sync Replicas)**이라는 동적 집합을 유지합니다. 리더에게 충분히 따라잡은 팔로워만 ISR에 포함되고, `acks=all` 설정 시 ISR의 모든 멤버가 메시지를 수신해야 커밋으로 간주됩니다. ISR 멤버만 리더 선출 후보가 되므로, 데이터 유실 없이 장애에 대응할 수 있습니다.

> **참고**: Kafka 4.0부터는 ELR(Eligible Leader Replicas)이 도입되어, ISR이 비었을 때도 안전한 리더 선출이 가능하도록 개선되었습니다. ISR -> ELR -> 마지막 알려진 리더 순서로 선출 우선순위가 적용됩니다.

## 2. KRaft vs ZooKeeper

### ZooKeeper 방식 (레거시)

```text
Kafka 클러스터
    ↕ 메타데이터 동기화
ZooKeeper 클러스터 (별도 운영)
```

ZooKeeper는 Kafka 바깥의 별도 분산 코디네이션 시스템입니다. 운영 포인트가 두 배가 되고, 메타데이터 동기화 지연이 생기며, 파티션 수 한계가 약 20만 개 수준이었습니다.

### KRaft 방식 (현재 표준)

```text
Kafka 클러스터
  ├── Broker 노드 (데이터 처리)
  └── Controller 노드 (메타데이터 관리, Raft 합의)
      → 외부 의존 없음
```

KRaft는 Kafka 자체에 **Raft 합의 프로토콜**을 내장한 방식입니다. ZooKeeper 없이 Controller 노드들이 직접 메타데이터를 관리합니다. EKS 배포 시 ZooKeeper StatefulSet을 따로 띄울 필요가 없어집니다.

**Kafka 4.0부터 ZooKeeper 모드가 완전히 제거되었습니다.** KRaft가 유일한 메타데이터 관리 방식이며, Kafka 3.3에서 프로덕션 레디(production-ready)로 선언된 이후 현재의 표준이 되었습니다. ZooKeeper 모드를 사용 중인 클러스터는 4.0으로 업그레이드하기 전에 반드시 KRaft로 마이그레이션해야 합니다.

### Controller의 역할

```text
Controller가 관리하는 것:
  - 토픽/파티션 메타데이터
  - 리더 선출 (Broker 장애 감지 → 새 Leader 지정)
  - 브로커 등록/해제
  - ISR(In-Sync Replicas) 및 ELR(Eligible Leader Replicas) 관리
```

KRaft 모드에서는 Controller 노드 3개(또는 홀수 개)가 쿼럼을 구성해 메타데이터를 합의합니다. 이전에는 `control.plane.listener.name`으로 제어하던 것이, KRaft에서는 `controller.listener.names`, `listeners`, `listener.security.protocol.map`으로 관리됩니다.

## 3. Partitioner / Assignor / Controller 역할 분리

이름이 비슷해서 헷갈리기 쉬운 세 컴포넌트입니다. 각각이 **어디에서 동작하는지**가 핵심 구분점입니다.

```text
┌─────────────────────────────────────────────────────┐
│ Producer 클라이언트                                    │
│   Partitioner: "이 메시지를 파티션 2번에 보내자"        │
│   → key가 있으면 hash(key) % partition_count          │
│   → key가 없으면 Sticky Partitioning (배치 단위 분배)  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Consumer 클라이언트                                    │
│   Assignor: "Consumer 1은 파티션 0,1 / Consumer 2는 2,3" │
│   → RangeAssignor, RoundRobinAssignor,               │
│     CooperativeStickyAssignor                         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ 브로커 (서버)                                          │
│   Controller: 토픽/파티션 메타데이터, 리더 선출          │
│   Group Coordinator: Consumer Group 관리, 리밸런싱     │
└─────────────────────────────────────────────────────┘
```

| 컴포넌트 | 위치 | 역할 |
|---------|------|------|
| **Partitioner** | Producer 클라이언트 | 메시지 -> 어느 파티션으로 보낼지 결정 |
| **Assignor** | Consumer 클라이언트 | 파티션 -> 어느 Consumer가 처리할지 할당 |
| **Controller** | 브로커 (KRaft 쿼럼) | 토픽 메타데이터 관리, 리더 선출 |
| **Group Coordinator** | 브로커 | Consumer Group 리밸런싱 조율 |

> **Partitioner 참고**: Kafka 3.x 이후 기본 Partitioner는 key가 null일 때 라운드로빈 대신 **Sticky Partitioning**을 사용합니다. 하나의 배치가 채워질 때까지 같은 파티션에 보내고, 배치가 완성되면 다음 파티션으로 넘깁니다. 이 방식이 레코드 단위 라운드로빈보다 배치 효율이 높아 처리량(throughput)이 향상됩니다.

> **Assignor 참고**: Kafka 4.0에서는 새로운 Consumer 프로토콜이 도입되어, 파티션 할당 전략이 서버 측(`group.consumer.assignors`)에서도 제어됩니다. 기본값은 `uniform`과 `range` Assignor입니다. 기존 클라이언트 측 Assignor를 사용하는 경우에도, `CooperativeStickyAssignor`가 리밸런싱 시 기존 할당을 최대한 유지하면서 점진적으로 재할당하므로 **Stop-the-World 리밸런싱**을 피할 수 있어 권장됩니다.

## 4. PartitionKey와 순서 보장

### Key 있음 vs 없음

```text
Key 있음: hash(key) % partition_count
  → 같은 key → 항상 같은 파티션
  → 해당 파티션 내 순서 보장
  → 예: orderId="ORD-123" → 항상 Partition 2

Key 없음: Sticky Partitioning (배치 단위 분배)
  → Throughput 최대화
  → 파티션 간 순서 보장 불가
```

파티션 내부의 순서는 보장되지만, **파티션 간 순서는 보장되지 않습니다.** 전체 토픽 수준에서 순서가 필요하면 파티션을 1개로 줄여야 하며, 이 경우 처리량을 희생하게 됩니다.

> **주의**: 파티션 수를 변경하면 `hash(key) % partition_count`의 결과가 달라져 기존 key의 파티션 매핑이 깨집니다. 파티션 수 변경 시 순서 보장이 필요한 key에 대해서는 마이그레이션 계획이 필요합니다.

### 실무에서 순서 보장 패턴 3가지

```text
1. PartitionKey 활용
   → orderId, deviceId, userId 등 자연 키 사용
   → 같은 엔티티의 이벤트가 한 파티션에 집중
   → 가장 간단하고 널리 쓰이는 방법

2. Event Time + Watermark (Flink/Spark 조합)
   → 파티션 도착 순서가 달라도 이벤트 타임스탬프 기준 재정렬
   → Watermark로 늦게 도착한 이벤트 허용 범위 설정
   → Kafka 자체가 아닌 처리 계층에서 순서를 복원하는 방식

3. SequenceNumber
   → Producer가 메시지에 시퀀스 번호를 부여
   → Consumer가 시퀀스 갭 감지 → 재처리 요청
   → 애플리케이션 레벨에서 직접 관리해야 하므로 구현 부담이 큼
```

## 5. EKS 배포 관련 인프라 개념

이 섹션은 Kafka 자체보다는 EKS에 배포할 때 마주치는 인프라 결정들입니다.

### arm64 vs amd64

```text
amd64 (x86_64): Intel/AMD CPU, 대부분의 기존 서버
arm64 (aarch64): AWS Graviton, Apple Silicon

EKS 노드가 Graviton(arm64)이라면:
  → Docker 이미지도 arm64 빌드 필요
  → bitnami/kafka:latest는 multi-arch 지원
  → 직접 빌드한 이미지는 --platform linux/arm64 확인 필요
```

### gp2 vs gp3 (EBS 볼륨)

```text
gp2: IOPS가 볼륨 크기(GB)에 연동 (3 IOPS/GB, 최소 100 IOPS)
gp3: IOPS와 throughput을 독립 설정 가능, 기본 3000 IOPS

Kafka 데이터 디렉토리 권장: gp3
  → 볼륨 크기와 무관하게 원하는 IOPS 지정 가능
  → 같은 성능 기준으로 gp2 대비 약 20% 저렴
```

### IRSA (IAM Roles for Service Accounts)

```text
문제: 브로커 파드가 AWS 리소스(S3, CloudWatch 등)에 접근해야 할 때
      → 노드 전체에 IAM Role 부여하면 과도한 권한

해결: IRSA
  ServiceAccount ← IAM Role (최소 권한)
  파드 → ServiceAccount 사용
  → 파드별로 다른 AWS 권한 부여 가능
  → 최소 권한 원칙(Principle of Least Privilege) 준수
```

### resourcesPreset 함정 (Kafka + JVM)

Bitnami Kafka Helm 차트의 `resourcesPreset` 기본값은 `nano`나 `micro`인 경우가 있습니다. Kafka는 JVM 기반이므로 힙 메모리가 충분해야 합니다.

```text
nano:   CPU 100m, Memory 128Mi → Kafka JVM OOM 확정
micro:  CPU 250m, Memory 256Mi → 기동은 되지만 불안정
small:  CPU 500m, Memory 512Mi → 개발/테스트 최소치
medium: CPU 1,    Memory 1Gi   → 프로덕션 최소치

Kafka JVM 기본 힙 = 256MB 이상
→ resourcesPreset: small 이상으로 설정하거나,
   직접 resources.requests/limits를 명시하는 것을 권장
```

## 6. Kafka vs Kinesis 비교

EKS에 Kafka를 직접 운영하는 것과 AWS Kinesis Data Streams를 쓰는 것의 트레이드오프입니다.

| 항목 | Kafka (자체 운영) | Kinesis Data Streams |
|------|-----------------|---------|
| **비용 구조** | 브로커 고정비 (EC2/EKS 인스턴스) | 샤드 시간 + PUT 페이로드 유닛 종량제 |
| **소량 트래픽** | 브로커 고정 비용 발생 | 종량제라 저렴 |
| **대량 트래픽** | 예측 가능한 고정비 | 비용 급증 가능 |
| **운영 부담** | 직접 관리 (업그레이드, 모니터링, 보안) | 서버리스, AWS 관리 |
| **파티션 유연성** | 파티션 수 자유롭게 조정 | 샤드 단위, 계정당 상한 있음 |
| **데이터 보존** | 무제한 (설정에 따라) | 기본 24시간, 최대 365일 |
| **생태계** | Connect, Streams, Schema Registry 등 풍부 | AWS 서비스 통합(Lambda, Firehose 등) |

### 코드 변경 범위

Kafka에서 Kinesis로 전환할 때 변경 범위가 생각보다 좁습니다.

```text
변경 필요:
  1. Producer: KafkaProducer → Kinesis SDK (putRecord/putRecords)
  2. Consumer/Flink: Kafka Source Connector → Kinesis Source Connector

변경 불필요:
  - 비즈니스 로직 (Flink 처리 코드)
  - 메시지 스키마 (Avro/JSON)
  - 토픽 구조 (Kinesis Stream으로 1:1 매핑 가능)
```

### Kafka 전용 설정이 Kinesis에서 불필요한 이유

```text
acks=all    → Kinesis는 내부적으로 3개 AZ에 동기 복제 후 응답, 설정 불필요
retries     → Kinesis SDK(KPL)가 자동 재시도, 별도 설정 불필요
linger.ms   → Kinesis는 레코드 집계(aggregation) 방식이 다르므로 해당 없음

Kafka의 "안전한 전송 설정"은 Kafka 브로커 프로토콜에서 필요한 것.
Kinesis는 AWS 서비스 레벨에서 이를 추상화하므로 별도 튜닝이 불필요합니다.
```

## 정리

| 주제 | 핵심 |
|------|------|
| **토픽 분리** | Consumer가 다르면 토픽 분리 |
| **파티션 수** | max(브로커, Consumer 병렬도)의 배수, 줄이기 불가 |
| **Replication Factor** | 리더 포함 복제본 수, 프로덕션에서는 RF=3 권장 |
| **ISR** | 리더에 동기화된 복제본 집합, acks=all 시 커밋 기준 |
| **KRaft** | ZooKeeper 없이 Raft로 메타데이터 관리, Kafka 4.0부터 유일한 방식 |
| **Partitioner** | Producer 클라이언트, key -> 파티션 결정 (null key 시 Sticky Partitioning) |
| **Assignor** | Consumer 클라이언트, 파티션 -> Consumer 할당 |
| **Controller** | 브로커 (KRaft 쿼럼), 리더 선출 + 메타데이터 관리 |
| **PartitionKey** | 같은 key -> 같은 파티션 -> 순서 보장 |
| **gp3** | Kafka EBS로 gp2보다 비용 효율적, IOPS 독립 설정 |
| **IRSA** | 파드별 최소 권한 IAM 부여 |

## Reference

- [Apache Kafka Documentation - Design](https://kafka.apache.org/documentation/#design)
- [KRaft Mode (KIP-500)](https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum)
- [Kafka 4.0 Release Notes - ZooKeeper Removal](https://kafka.apache.org/documentation/#upgrade_4_0_0)
- [Kafka Replication Design](https://kafka.apache.org/documentation/#replication)
- [Bitnami Kafka Helm Chart](https://github.com/bitnami/charts/tree/main/bitnami/kafka)
- [AWS IRSA Documentation](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
- [Amazon Kinesis Data Streams FAQ](https://aws.amazon.com/kinesis/data-streams/faqs/)
