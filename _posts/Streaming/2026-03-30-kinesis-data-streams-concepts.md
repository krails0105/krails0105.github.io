---
title: "[Kinesis] Amazon Kinesis Data Streams 핵심 개념 정리 - Kafka 경험자를 위한 가이드"
categories:
  - Streaming
tags:
  - Kinesis
  - Kafka
  - Flink
  - AWS
  - Streaming
  - Shard
  - DataEngineering
---

## 들어가며

Kafka에서 Kinesis로 전환하면서 "샤드가 파티션이랑 뭐가 다르지?", "온디맨드가 비싸다는데 얼마나?", "Flink에서 어떻게 읽지?" 같은 질문이 연달아 나왔다.

이 글은 그 과정에서 정리한 Kinesis 핵심 개념 노트다. Kafka를 아는 사람이라면 용어 매핑부터 시작하면 빠르게 이해할 수 있고, Kinesis가 처음이라면 샤드 구조부터 Flink 연동까지 한 흐름으로 따라갈 수 있다.

### 이 글에서 다루는 내용

- Kafka와 Kinesis 용어 매핑
- 샤드(Shard)의 구조와 라우팅 원리 (PartitionKey, HashKeyRange)
- 프로비저닝 vs 온디맨드 용량 모드 비용 비교
- 리샤딩(Resharding) 동작 방식
- 데이터 읽기 방식 (Shard Iterator, Enhanced Fan-Out)
- 보존 기간(Retention) 설정
- Apache Flink `KinesisStreamsSource` 연동

### 사전 지식

- Kafka의 토픽, 파티션, 프로듀서/컨슈머 개념에 대한 기본 이해
- AWS CLI 기본 사용법
- (Flink 연동 섹션) Apache Flink DataStream API 기본 개념

---

## Kinesis vs Kafka 용어 매핑

Kafka를 이미 알고 있다면, Kinesis는 용어만 바꾼 거라고 봐도 크게 틀리지 않는다.

| Kafka | Kinesis | 설명 |
|---|---|---|
| 토픽(Topic) | 스트림(Stream) | 메시지를 담는 논리적 단위 |
| 파티션(Partition) | 샤드(Shard) | 스트림 내 병렬 처리 단위 |
| Producer key | PartitionKey | 어느 샤드로 보낼지 결정하는 키 |
| `produce()` | `put_record()` | 메시지 발행 API |
| `poll()` | `get-records` | 메시지 읽기 API |
| Consumer Group | Enhanced Fan-Out / 공유 읽기 | 복수 소비자 처리 방식 |

Kafka의 `key`가 파티션을 결정하듯, Kinesis의 `PartitionKey`가 샤드를 결정한다. boto3에서는 다음과 같이 사용한다.

```python
import json
import boto3

client = boto3.client("kinesis", region_name="us-west-1")

# boto3 Kinesis put_record
# Data는 반드시 bytes 타입이어야 한다 (Kafka와 달리 SDK가 인코딩을 자동으로 해주지 않음)
client.put_record(
    StreamName="my-stream",
    Data=json.dumps({"pipeline": "etl-job", "status": "running"}).encode("utf-8"),
    PartitionKey="etl-job.extract"  # string - Kafka의 key에 해당
)
```

---

## 샤드(Shard) 깊게 이해하기

### 샤드당 처리량 한도

샤드는 Kinesis의 기본 처리 단위다. 샤드 하나가 보장하는 처리량에는 **하드 한도(hard limit)**가 있다.

| 방향 | 한도 |
|---|---|
| 쓰기(Ingestion) | 초당 1 MB **또는** 1,000건 (둘 중 먼저 걸리는 쪽) |
| 읽기(Consumption) | 초당 2 MB (공유 읽기 기준) |

이 한도를 초과하면 `ProvisionedThroughputExceededException`이 발생한다. 프로듀서 측에서는 재시도 로직(exponential backoff)을 반드시 구현해야 한다.

### PartitionKey에서 샤드로의 라우팅 원리

Kinesis는 PartitionKey를 **MD5 해싱**하여 0 ~ 2^128-1 범위의 128비트 정수로 변환한다. 각 샤드는 이 범위의 일부(`HashKeyRange`)를 담당하며, 해시값이 해당 범위에 속하는 레코드가 그 샤드로 라우팅된다.

```
PartitionKey "etl-job.extract"
    -> MD5 해싱
    -> 128비트 정수값 X
    -> X가 속하는 HashKeyRange의 샤드로 전송
```

같은 PartitionKey는 항상 같은 샤드로 가기 때문에, **순서 보장이 필요한 이벤트는 PartitionKey를 동일하게** 설정하면 된다. 예를 들어, 같은 파이프라인의 시작/완료/실패 이벤트를 순서대로 처리하고 싶다면 파이프라인 ID를 PartitionKey로 사용한다.

### 필요한 샤드 수 계산법

필요한 샤드 수는 쓰기와 읽기 양쪽 한도를 모두 고려하여 계산한다.

```
필요 샤드 수 = max(
    ceil(초당 최대 레코드 수 / 1,000),
    ceil(초당 최대 데이터량(MB) / 1),
    ceil(소비자 수 * 초당 읽기량(MB) / 2)
)
```

중요한 점은 **트래픽이 아무리 적어도 최소 1개의 샤드가 필요**하다는 것이다. 초당 0.06건짜리 파이프라인이라도 스트림을 만들면 샤드가 1개 생기고, 그 비용은 발생한다.

---

## 프로비저닝 vs 온디맨드 -- 비용 비교

Kinesis는 두 가지 용량 모드를 제공한다. 어떤 모드를 선택하느냐에 따라 월 비용이 크게 달라진다.

| 항목 | 온디맨드 | 프로비저닝 (1샤드) |
|---|---|---|
| 시간당 비용 (us-west-1) | $0.049 / 스트림 | $0.0182 / 샤드 |
| 월 고정비 (대략) | ~$35 | ~$13 |
| 데이터 수집(PUT) | $0.014 / GB | $0.014 / GB |
| 자동 스케일링 | O (관리 불필요) | X (수동 조정 필요) |

### 언제 무엇을 쓸까

온디맨드는 **스트림당 시간당 $0.049의 고정비**가 발생한다. 트래픽이 적으면 이 고정비가 전체 비용의 대부분을 차지한다. 실제 수치로 보면 us-west-1 기준 온디맨드는 월 약 $35인 반면, 프로비저닝 1샤드는 월 약 $13이다.

**결론**: 트래픽이 예측 가능하고 샤드 1개로 충분하다면 프로비저닝이 약 2.7배 저렴하다. 스파이크가 심하거나 샤드 수를 예측하기 어려울 때 온디맨드를 선택한다.

```bash
# 프로비저닝 모드로 스트림 생성 (샤드 1개)
aws kinesis create-stream \
  --stream-name my-stream \
  --shard-count 1 \
  --region us-west-1
```

> 참고: 온디맨드 모드로 생성하려면 `--stream-mode-details StreamMode=ON_DEMAND` 옵션을 추가한다.

---

## 리샤딩(Resharding) -- 샤드 확장과 축소

운영 중에 트래픽이 변하면 샤드 수를 조정할 수 있다.

```bash
# 샤드 수를 1 -> 2로 확장
aws kinesis update-shard-count \
  --stream-name my-stream \
  --target-shard-count 2 \
  --scaling-type UNIFORM_SCALING
```

### 확장(Split)과 축소(Merge) 동작 방식

**확장(Split)**: 기존 샤드 1개의 HashKeyRange를 반으로 나눠 자식 샤드 2개를 생성한다. 부모 샤드에는 `EndingSequenceNumber`가 찍히며 닫힌다(CLOSED 상태).

**축소(Merge)**: 인접한(adjacent) HashKeyRange를 가진 샤드 2개를 새 샤드 1개로 병합한다. 병합된 새 샤드는 `ParentShardId`와 `AdjacentParentShardId`를 모두 가진다.

### 닫힌 샤드 vs 활성 샤드 구분법

- `EndingSequenceNumber`가 **있으면** 닫힌(CLOSED) 샤드
- `EndingSequenceNumber`가 **없으면** 활성(OPEN) 샤드

Flink이나 다른 컨슈머가 샤드 목록을 주기적으로 갱신해야 리샤딩 이후에도 데이터를 빠뜨리지 않는다. Flink의 `KinesisStreamsSource`는 기본적으로 10초 간격으로 `ListShards`를 호출하여 새 샤드를 자동으로 감지한다.

### 리샤딩 제약사항

- **축소는 24시간 내 2회**로 제한된다. 확장은 상대적으로 자유롭지만, 축소에는 제약이 있으니 미리 계획을 세워야 한다.
- 리샤딩 중에는 새 레코드 쓰기가 가능하지만, 부모 샤드의 데이터를 모두 소비한 뒤에 자식 샤드를 읽어야 순서가 보장된다.

---

## 데이터 읽기 방식

Kinesis에서 데이터를 읽는 것은 2단계로 이루어진다.

### 1단계: Shard Iterator 획득

Shard Iterator는 "어디서부터 읽을 것인가"를 가리키는 포인터다.

```bash
# TRIM_HORIZON: 보존 기간 내 가장 오래된 레코드부터 읽기
aws kinesis get-shard-iterator \
  --stream-name my-stream \
  --shard-id shardId-000000000000 \
  --shard-iterator-type TRIM_HORIZON
```

| Iterator 타입 | 시작 위치 | 용도 |
|---|---|---|
| `TRIM_HORIZON` | 보존 기간 내 가장 오래된 레코드 | 재처리, 초기 로딩 |
| `LATEST` | 지금 이후에 도착하는 레코드만 | 실시간 모니터링 |
| `AT_TIMESTAMP` | 특정 시각 이후 | 특정 시점 복구 |
| `AT_SEQUENCE_NUMBER` | 특정 시퀀스 번호부터 | 정확한 위치 지정 |
| `AFTER_SEQUENCE_NUMBER` | 특정 시퀀스 번호 다음부터 | 마지막 처리 지점 이후 재개 |

### 2단계: 레코드 읽기

```bash
aws kinesis get-records \
  --shard-iterator "AAAAA..."
```

응답에 포함된 `Records[].Data`는 **base64 인코딩**되어 있다. 실제 데이터를 보려면 디코딩이 필요하다.

```python
import base64
import json

# get-records 응답의 각 레코드 처리
for record in response["Records"]:
    raw = base64.b64decode(record["Data"]).decode("utf-8")
    event = json.loads(raw)
    print(event)
```

응답에는 다음 레코드를 읽기 위한 `NextShardIterator`도 포함되어 있다. 이를 반복 호출하면 연속적으로 데이터를 읽을 수 있다. 단, **Shard Iterator는 5분 후 만료**되므로, 수동 테스트 시 주의가 필요하다.

### Kafka Consumer Group과의 차이

Kafka의 Consumer Group은 파티션을 그룹 내 컨슈머들에게 자동 분배한다. Kinesis에는 이 개념이 없고, 대신 두 가지 읽기 방식을 제공한다.

| 방식 | 처리량 | 비용 | 적합한 상황 |
|---|---|---|---|
| **공유 읽기(Shared/Polling)** | 샤드당 2 MB/초를 전체 컨슈머가 나눠 씀 | 추가 비용 없음 | 컨슈머가 1-2개일 때 |
| **Enhanced Fan-Out(EFO)** | 컨슈머마다 전용 2 MB/초 할당 | 추가 비용 발생 | 컨슈머가 3개 이상이거나 지연에 민감할 때 |

공유 읽기에서 컨슈머 3개가 같은 샤드를 읽으면, 각각 약 0.67 MB/초밖에 쓸 수 없다. 이 병목이 문제가 된다면 EFO로 전환을 고려한다.

---

## 보존 기간(Retention)

| 보존 기간 | 비용 |
|---|---|
| 24시간 (기본값) | 무료 |
| 최대 7일 (168시간) | 시간당 샤드당 추가 과금 |
| 최대 365일 | 별도 장기 보존 과금 |

기본 24시간은 짧기 때문에, 재처리나 장애 복구 시나리오가 있다면 7일로 늘리는 것을 권장한다.

```bash
# 보존 기간을 7일(168시간)로 연장
aws kinesis increase-stream-retention-period \
  --stream-name my-stream \
  --retention-period-hours 168
```

> 보존 기간을 줄일 때는 `decrease-stream-retention-period`를 사용한다. 단, 24시간 미만으로는 줄일 수 없다.

---

## Flink `KinesisStreamsSource` 연동

Apache Flink에서 Kinesis를 읽을 때는 `KinesisStreamsSource`를 사용한다. 이전에 쓰던 `FlinkKinesisConsumer`(AWS SDK v1 기반)는 deprecated 상태이며, `KinesisStreamsSource`(AWS SDK v2 기반)가 공식 권장 방식이다.

<!-- TODO: verify - FlinkKinesisConsumer에서 KinesisStreamsSource로의 마이그레이션 시 체크포인트 상태 호환성이 없으므로, 전환 시 상태 초기화가 필요하다 -->

### Maven 의존성

```xml
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-connector-aws-kinesis-streams</artifactId>
    <version>5.0.0-1.19</version>
</dependency>
```

> 버전 형식은 `{커넥터 버전}-{Flink 버전}`이다. 사용 중인 Flink 버전에 맞는 커넥터를 선택해야 한다. 최신 버전은 [Flink AWS Connectors 릴리즈](https://github.com/apache/flink-connector-aws/releases)에서 확인할 수 있다.

### 소스 설정 예시

```java
import org.apache.flink.connector.aws.kinesis.source.KinesisStreamsSource;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;

// KinesisStreamsSource 생성
KinesisStreamsSource<MyEvent> kinesisSource = KinesisStreamsSource
    .<MyEvent>builder()
    .setStreamArn("arn:aws:kinesis:us-west-1:ACCOUNT_ID:stream/STREAM_NAME")
    .setDeserializationSchema(new MyEventDeserializer())
    .build();

// Flink 실행 환경에 소스 등록
SingleOutputStreamOperator<MyEvent> events = env
    .fromSource(kinesisSource, WatermarkStrategy.noWatermarks(), "Kinesis Source")
    .returns(MyEvent.class);  // type erasure 방지 - 없으면 런타임 에러 발생
```

`.returns(MyEvent.class)` 한 줄이 중요하다. Java의 **type erasure** 때문에 Flink가 제네릭 타입 정보를 잃어버리면 Kryo 직렬화로 폴백되거나 런타임 에러가 발생한다. `fromSource()` 바로 뒤에 `.returns()` 호출을 습관화하자.

### 필요한 IAM 권한

EKS에서 IRSA(IAM Role for Service Account)로 실행하거나, EC2 인스턴스 프로파일을 사용할 경우 다음 권한이 필요하다.

```json
{
  "Effect": "Allow",
  "Action": [
    "kinesis:DescribeStreamSummary",
    "kinesis:GetRecords",
    "kinesis:GetShardIterator",
    "kinesis:ListShards",
    "kinesis:SubscribeToShard"
  ],
  "Resource": "arn:aws:kinesis:REGION:ACCOUNT_ID:stream/STREAM_NAME"
}
```

> `SubscribeToShard`는 Enhanced Fan-Out(EFO) 모드를 사용할 경우에 필요하다. Polling 모드만 사용한다면 생략해도 된다.

---

## 자주 겪는 실수와 주의사항

### `put_record`의 `Data`는 bytes 타입이어야 한다

Kafka는 직렬화를 SDK의 Serializer가 처리하지만, Kinesis boto3 클라이언트는 직접 바이트로 인코딩해야 한다.

```python
# 잘못된 예 - TypeError 발생
client.put_record(
    StreamName="my-stream",
    Data=json.dumps(event),         # str 타입 -> 에러
    PartitionKey="key-1"
)

# 올바른 예
client.put_record(
    StreamName="my-stream",
    Data=json.dumps(event).encode("utf-8"),  # bytes 타입
    PartitionKey="key-1"
)
```

### Shard Iterator는 5분 내로 사용해야 한다

`get-shard-iterator`로 받은 iterator는 **5분 후 만료**된다. Flink 같은 프레임워크는 자동으로 갱신하지만, AWS CLI나 boto3로 수동 테스트할 때 iterator를 받아놓고 시간이 지나면 `ExpiredIteratorException`이 발생한다.

### 샤드 축소는 24시간 내 2회 제한

확장(split)은 비교적 자유롭게 가능하지만, 축소(merge)에는 제약이 있다. 샤드 수를 줄여야 할 계획이 있다면 미리 여유 있게 진행한다.

### GetRecords 호출 제한

`GetRecords`는 샤드당 초당 5회까지 호출할 수 있다. 이 제한을 초과하면 `ProvisionedThroughputExceededException`이 발생하므로, 폴링 간격을 200ms 이상으로 설정하는 것이 안전하다.

---

## 다음 단계

- Enhanced Fan-Out 설정 -- 소비자가 여러 개로 늘어날 경우
- Kinesis Data Firehose 연동으로 S3 아카이브 구성
- CloudWatch 메트릭(`GetRecords.IteratorAgeMilliseconds`)으로 소비 지연 모니터링

---

## 핵심 요약

| 개념 | 핵심 포인트 |
|---|---|
| 샤드 | 쓰기 1 MB/s or 1,000건, 읽기 2 MB/s 한도 |
| PartitionKey | MD5 해싱 -> HashKeyRange로 샤드 결정 |
| 용량 모드 | 예측 가능하면 프로비저닝(~$13/월), 불확실하면 온디맨드(~$35/월) |
| 리샤딩 | Split(확장)은 자유, Merge(축소)는 하루 2회 제한 |
| 읽기 방식 | 공유 읽기(무료) vs EFO(전용 처리량, 유료) |
| 보존 기간 | 기본 24시간, 재처리 필요 시 7일 권장 |
| Flink 연동 | `KinesisStreamsSource` 사용 (FlinkKinesisConsumer는 deprecated) |

---

## 참고 자료

- [Amazon Kinesis Data Streams 개발자 가이드](https://docs.aws.amazon.com/streams/latest/dev/introduction.html)
- [Flink Kinesis Connector 공식 문서 (1.19)](https://nightlies.apache.org/flink/flink-docs-release-1.19/docs/connectors/datastream/kinesis/)
- [boto3 Kinesis put_record API 레퍼런스](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/kinesis/client/put_record.html)
- [Flink AWS Connectors GitHub](https://github.com/apache/flink-connector-aws)
