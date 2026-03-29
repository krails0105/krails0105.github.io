---
title: "[Pipeline Monitor] MonitoringProducer 구현과 Kafka에서 Kinesis 전환기"
categories:
  - Kafka
tags: [Kafka, Kinesis, Python, boto3, Flink, EKS, Helm, Pipeline, Monitoring, AWS]
---

## 개요

파이프라인 모니터링 시스템의 두 번째 단계는 **Producer 구현**이다. 이벤트를 발행하는 `MonitoringProducer` 클래스를 Python으로 작성하고, Airflow DAG / Cloud Functions / BigQuery Pipeline 등 3개 레포에 연동했다. 그리고 EKS Kafka 배포 과정에서 예상치 못한 문제들을 만나면서, 최종적으로 **Kinesis로 전환**하는 결정을 내렸다.

이 글은 그 과정 -- 설계 결정, 연동 패턴, 삽질 기록, 전환 이유 -- 을 정리한다.

이 글을 읽고 나면 다음을 이해할 수 있다.

- 모니터링 코드가 본체 파이프라인을 죽이지 않는 **Silent Fail 패턴** 설계
- 여러 레포에서 공통으로 사용하는 Producer 클라이언트의 **연동 패턴** 3가지
- EKS에 Bitnami Helm chart로 Kafka를 배포할 때 만나는 **실제 에러 5가지**와 해결법
- Kafka에서 Kinesis로 전환한 **비용/운영 근거**

## 배경: 전체 아키텍처에서 Producer의 위치

지금까지 구축한 모니터링 시스템은 다음과 같은 구조다.

```
Producer (Python) --> [Message Broker] --> Flink Job (Java) --> Slack / PostgreSQL
```

Flink Job은 이미 완성된 상태다. `FreshnessAlert`가 파이프라인별 threshold를 기준으로 데이터 신선도를 체크하고, `ErrorRateAlert`가 에러 비율을 감시하며, `DedupFilter`이 중복 알람을 억제한다.

남은 과제는 **Producer** -- 실제 파이프라인에서 이벤트를 발행하는 클라이언트 라이브러리다. 요구사항은 두 가지다.

1. Airflow, Cloud Functions, BigQuery Pipeline 등 **여러 레포에서 공통으로 사용**할 수 있어야 한다.
2. **모니터링 자체가 파이프라인 장애로 이어지면 안 된다** -- 모니터링 코드의 예외가 본체 로직을 중단시키면 본말이 전도된다.

## 설계 원칙

### 1. Silent Fail 패턴

모니터링 코드가 예외를 던지면 실제 파이프라인이 중단된다. 이를 방지하기 위해 모든 `send` 호출을 `try/except`로 감싸고, 실패는 로그만 남긴 채 무시한다.

```python
def _send(self, event: dict):
    try:
        # 실제 발행 로직
        ...
    except Exception as e:
        logger.warning(f"[MonitoringProducer] send failed (silent): {e}")
```

**파이프라인이 죽는 것보다 모니터링 이벤트 하나를 놓치는 게 낫다.** 이 원칙이 모든 설계의 출발점이다.

### 2. Context Manager (`track()`)

`start()` -> 작업 수행 -> `complete()` / `error()` 패턴은 반복 코드가 많아진다. `track()` context manager로 이 패턴을 캡슐화했다.

```python
# 반복 코드 (before)
mp.start("node_poll")
try:
    result = do_work()
    mp.complete("node_poll", elapsed_ms=...)
except Exception as e:
    mp.error("node_poll", error=str(e))
    raise

# context manager (after)
with mp.track("node_poll") as ctx:
    result = do_work()
    ctx["rows"] = len(result)
```

### 3. 브로커 추상화

처음에는 Kafka(`confluent_kafka.Producer`)를 사용했지만, 이후 Kinesis로 전환하면서 `_send()` 메서드만 교체했다. 외부 API(`start`, `complete`, `error`, `track`)는 변경 없음.

이 구조 덕분에 브로커 전환이 `_send()` 한 메서드 수정으로 끝났다. **인프라 의존성을 하나의 메서드 뒤에 숨기는 것**이 핵심이다.

## 구현: MonitoringProducer 핵심 구조

전체 코드 대신 **설계 패턴과 핵심 메서드**만 보여준다.

### Public API

```python
mp = MonitoringProducer(source_id="my_pipeline", stream="my-stream")

mp.start("extract")                # START 이벤트 발행
mp.complete("extract", elapsed_ms=1200)  # COMPLETE 이벤트 발행
mp.error("extract")                # ERROR 이벤트 발행

with mp.track("transform"):       # START → (작업) → COMPLETE or ERROR 자동
    do_work()
```

### Silent Fail: `_send()` 패턴

모니터링 실패가 파이프라인을 죽이지 않도록, 발행 메서드를 `try/except`로 감싼다.

```python
def _send(self, event: dict):
    try:
        self._client.put_record(
            StreamName=self.stream_name,
            Data=json.dumps(event).encode(),
            PartitionKey=f"{event['source_id']}.{event['stage']}",
        )
    except Exception:
        logger.warning("send failed (silent)", exc_info=True)
```

### `track()` context manager 핵심 로직

```python
@contextmanager
def track(self, stage: str):
    self.start(stage)
    t0 = time.monotonic()
    try:
        yield
    except Exception:
        elapsed = int((time.monotonic() - t0) * 1000)
        self.error(stage, metadata={"elapsed_ms": elapsed})
        raise   # 본체 예외는 반드시 re-raise
    else:
        elapsed = int((time.monotonic() - t0) * 1000)
        self.complete(stage, elapsed_ms=elapsed)
```

주요 포인트:

- **`put_record` 필수 파라미터**: `StreamName`, `Data` (bytes), `PartitionKey` (string). `Data`는 최대 1MB.
- **`PartitionKey`**: `source_id.stage` 형식으로 같은 파이프라인 이벤트가 같은 샤드로 라우팅된다.
- **`track()`의 `raise`**: 모니터링 이벤트(`ERROR`) 발행 후 반드시 re-raise. 모니터링이 본체 에러를 삼키면 안 된다.

## 연동: 레포별 적용 패턴 3가지

### 패턴 1: Airflow DAG -- `track()` + callback

직접 제어가 필요한 task는 `track()`, 내부를 수정하기 어려운 Operator는 `pre_execute` + callback 패턴을 사용한다.

```python
# 패턴 A: 직접 제어 가능한 함수 → track()
def my_task(**context):
    with mp.track("my_stage"):
        do_work()

# 패턴 B: 수정 불가한 Operator → callback으로 외부에서 계측
task.pre_execute = lambda ctx: mp.start("my_stage")
task.on_success_callback = lambda ctx: mp.complete("my_stage")
task.on_failure_callback = lambda ctx: mp.error("my_stage")
```

### 패턴 2: Cloud Functions -- 공통 Base 클래스에 한 줄 추가

모든 function이 상속하는 Base 클래스의 `run()`에 `track()`을 추가하면 전체 function에 자동 적용된다.

```python
class BaseWorker:
    def run(self):
        with self.mp.track("run"):
            self._execute()  # 각 function이 오버라이드
```

### 패턴 3: 배치 파이프라인 -- `run_step()` 래퍼

여러 stage를 순차 실행하는 구조에서는 `run_step()` 래퍼로 각 stage를 감싼다.

```python
def run_step(self, name, fn):
    stage = name.lower().replace(" ", "_")
    with self.mp.track(stage):
        fn()

# 사용
run_step("Bronze DML", run_bronze)
run_step("Silver DML", run_silver)
```

## Flink Threshold 설정: `Map.ofEntries()` 전환

파이프라인이 늘어나면서 threshold 항목이 10개를 초과했다. Java의 `Map.of()`는 **최대 10개까지만** 지원하므로(`Map.of(k1,v1,...,k10,v10)`) `Map.ofEntries()`로 변경해야 한다. 11개 이상의 항목을 `Map.of()`에 넘기면 컴파일 에러가 발생한다.

```java
// 10개 초과 시 Map.of() → Map.ofEntries()로 전환
static Map<String, Long> thresholds = Map.ofEntries(
    Map.entry("pipeline_a.stage_1",   600_000L),    // 5분 주기 → 10분
    Map.entry("pipeline_a.stage_2",   900_000L),
    Map.entry("pipeline_b.run",       7_200_000L),  // 1시간 주기 → 2시간
    Map.entry("pipeline_c.run",       90_000_000L), // 일별 → 25시간
    Map.entry("pipeline_d.bronze",    90_000_000L),
    // ... 항목이 10개를 넘으면 Map.of()는 컴파일 에러
);
```

**threshold 계산 기준:**

| 스케줄 주기 | Threshold | 비고 |
|---|---|---|
| 5분 | 10분 (주기 x 2) | 일시 지연 허용 |
| 1시간 | 2시간 (주기 x 2) | 동일 |
| 일별 | 25시간 | 시간대/서머타임 여유 |
| 주별 | 8일 | 주말/공휴일 여유 |

일시적인 지연과 실제 장애를 구분하기 위한 여유폭이다.

## 삽질 기록: EKS Kafka 배포 5연속 실패

EKS에 Bitnami Helm chart로 Kafka를 배포하면서 5개의 문제를 순서대로 만났다. 각 문제를 해결하면 다음 문제가 나타나는 연쇄 구조였다.

### 문제 1: EBS CSI IRSA 미설정 -- PVC Pending

EBS 볼륨을 프로비저닝하려면 EBS CSI 드라이버에 IRSA(IAM Role for Service Account)가 설정되어 있어야 한다. 설정 없이 배포하면 PVC가 `Pending` 상태에서 멈춘다.

```bash
kubectl describe pvc data-kafka-broker-0 -n monitoring
# 출력 예: waiting for a volume to be created, either by external provisioner "ebs.csi.aws.com"
```

**해결**: EBS CSI 드라이버에 IRSA를 설정한다. `eksctl`을 사용하거나 Terraform `aws_iam_role_policy_attachment`로 `AmazonEBSCSIDriverPolicy`를 연결한다.

### 문제 2: Bitnami 이미지 Docker Hub 제거

Bitnami가 Docker Hub에서 공식 이미지를 제거했다. `bitnamilegacy` 레지스트리로 대체하고 보안 검증 우회 설정을 추가해야 한다.

```yaml
global:
  security:
    allowInsecureImages: true   # bitnamilegacy 이미지는 서명 검증 불가
image:
  repository: bitnamilegacy/kafka
  tag: 3.9.0-debian-12-r4
```

### 문제 3: Chart v32 + Kafka 3.9 이미지 호환 불가

Bitnami Kafka Helm chart v32.0.0부터 KRaft가 기본 모드가 되면서 `kraft.enabled` 파라미터가 제거되었고, Kafka 4.0을 기본 이미지로 사용한다. Kafka 3.9 이미지를 사용하려면 **chart를 v31.x로 다운그레이드**해야 한다.

```bash
helm install kafka bitnami/kafka --version 31.5.0 -f helm-values.yaml -n monitoring
```

### 문제 4: `extraConfig` 인라인 주석이 값에 포함됨

`extraConfig` 블록의 인라인 주석(`# 10min`)이 설정값 파싱 에러를 일으킨다. Kafka 설정 파서는 줄 내 `#` 이후를 설정값의 일부로 처리한다.

```yaml
# 잘못된 예 -- "168  # 7d"가 값으로 파싱됨
extraConfig: |
  log.retention.hours=168  # 7d

# 올바른 예 -- 주석을 별도 줄로 분리
extraConfig: |
  # 7d
  log.retention.hours=168
```

### 문제 5: `resourcesPreset: micro`(256Mi) -- OOM

`resourcesPreset: "micro"`는 256Mi 메모리를 할당하는데, Kafka broker는 JVM 기반이라 OOM(Out Of Memory)으로 죽는다. `"small"`(512Mi)로 변경하면 정상 동작한다.

### 최종 Helm values (성공 구성)

5개의 문제를 모두 해결한 최종 구성이다. chart v31.5.0 + Kafka 3.9 + KRaft 모드 조합이다.

```yaml
# infra/kafka/helm-values.yaml

global:
  security:
    allowInsecureImages: true         # 문제 2 해결

image:
  registry: docker.io
  repository: bitnamilegacy/kafka     # 문제 2 해결
  tag: 3.9.0-debian-12-r4            # 문제 3: chart v31.5.0과 호환

kraft:
  enabled: true                       # 문제 3: v31에서는 명시 필요

controller:
  replicaCount: 2
  resourcesPreset: "small"            # 문제 5: micro(256Mi) -> small(512Mi)
  persistence:
    size: 10Gi
    storageClass: gp3
  nodeSelector:
    karpenter.sh/capacity-type: spot

broker:
  replicaCount: 2
  resourcesPreset: "small"            # 문제 5 해결
  persistence:
    size: 10Gi
    storageClass: gp3
  nodeSelector:
    karpenter.sh/capacity-type: spot

listeners:
  client:
    protocol: PLAINTEXT
  interbroker:
    protocol: PLAINTEXT

extraConfig: |                        # 문제 4: 인라인 주석 제거
  min.insync.replicas=1
  default.replication.factor=2
  num.partitions=4
  log.retention.hours=168
  auto.create.topics.enable=false
```

## Kafka에서 Kinesis로 전환한 이유

EKS Kafka를 성공적으로 배포했지만, GCP Cloud Functions에서 접근하려면 **외부 노출이 필수**였다. 이 시점에서 비용과 운영 부담을 다시 계산했다.

**Kafka 유지 시 비용/부담:**

- Kafka broker 외부 노출: NLB 4개(broker 2 + controller 2) -- 월 약 $64
- 외부 접근을 위한 SSL/SASL 설정 추가 필요
- GCP <-> AWS 간 네트워크 레이턴시 관리
- Kafka 클러스터 자체의 운영 부담 (모니터링, 업그레이드, 장애 대응)

**Kinesis 전환 시 이점:**

- 서버리스 -- 인프라 관리 불필요
- GCP Cloud Functions에서 `boto3`로 AWS credentials만 설정하면 바로 접근 가능
- 월 비용 약 $5~10 (소량 이벤트 기준, 샤드 1개 + PUT 요청 비용)

### 전환 작업: `_send()` 메서드 하나

Producer 코드 변경은 `_send()` 메서드 하나뿐이었다. `confluent_kafka.Producer.produce()` -> `boto3.client("kinesis").put_record()`로 교체하고, `confluent-kafka` 의존성을 제거했다. 외부 API(`start`, `complete`, `error`, `track`)는 그대로다.

```python
# Before (Kafka)
from confluent_kafka import Producer as KafkaProducer

def _send(self, event: dict):
    try:
        self._producer.produce(
            topic=self.topic,
            value=json.dumps(event).encode("utf-8"),
            key=f"{event['source_id']}.{event['stage']}".encode("utf-8"),
        )
        self._producer.flush()
    except Exception as e:
        logger.warning(f"[MonitoringProducer] send failed (silent): {e}")

# After (Kinesis)
import boto3

def _send(self, event: dict):
    try:
        self._client.put_record(
            StreamName=self.stream_name,
            Data=json.dumps(event).encode("utf-8"),
            PartitionKey=f"{event['source_id']}.{event['stage']}",
        )
    except Exception as e:
        logger.warning(f"[MonitoringProducer] send failed (silent): {e}")
```

참고: `confluent_kafka.Producer.produce()`의 `key` 파라미터는 bytes를 받고, Kinesis `put_record()`의 `PartitionKey`는 string을 받는다. 전환 시 `.encode()` 제거에 주의해야 한다.

이 결정이 보여주는 패턴이 중요하다. **브로커를 `_send()`로 추상화**해두면 나중에 인프라가 바뀌어도 클라이언트 코드를 수정할 필요가 없다.

## 흔한 실수와 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `put_record` 호출 시 `NoCredentialsError` | boto3가 AWS 자격증명을 찾지 못함 | 환경변수(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) 또는 IAM Role 설정 확인 |
| Kinesis `ResourceNotFoundException` | 스트림 이름 오타 또는 리전 불일치 | `stream_name`과 `region` 값이 실제 Kinesis 스트림 설정과 일치하는지 확인 |
| `track()` 내부 예외가 사라짐 | `error()` 호출 후 `raise`를 빠뜨림 | `track()` 구현에서 예외를 반드시 re-raise |
| Flink에서 이벤트가 다른 키로 라우팅됨 | `PartitionKey`와 Flink `keyBy` 키 불일치 | 양쪽 모두 `source_id.stage` 형식인지 확인 |
| Helm 배포 후 Kafka broker OOM | `resourcesPreset: "micro"` 사용 | `"small"` 이상으로 변경 |

## 다음 단계

- **Flink Consumer 전환**: 현재 Flink Job은 `KafkaSource`를 사용 중이다. Kinesis 전환에 맞춰 `KinesisStreamsSource`(Flink 1.19+, AWS SDK v2 기반)로 교체하거나, 레거시 `FlinkKinesisConsumer`를 사용할 수 있다. Enhanced Fan-Out 필요 여부에 따라 결정한다.
- **MonitoringProducer 패키징**: 3개 레포에서 공통 사용하는 만큼 내부 PyPI 패키지로 배포한다.
- **Kinesis 스트림 설정**: 샤드 수, retention 기간(기본 24시간 -> 7일), Enhanced Fan-Out 여부를 결정한다.
- **E2E 테스트**: 실제 Airflow DAG에서 이벤트를 발행하고 Slack 알람까지 전달되는 전체 흐름을 검증한다.

## 참고 자료

- [boto3 Kinesis put_record API](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/kinesis/client/put_record.html) -- `StreamName`, `Data`, `PartitionKey` 파라미터 레퍼런스
- [Apache Flink Kinesis Connector](https://nightlies.apache.org/flink/flink-docs-release-1.19/docs/connectors/datastream/kinesis/) -- `KinesisStreamsSource` 설정 및 사용법
- [Bitnami Kafka Helm Chart](https://github.com/bitnami/charts/tree/main/bitnami/kafka) -- chart 버전별 breaking changes 주의
- [confluent-kafka-python Producer](https://docs.confluent.io/platform/current/clients/confluent-kafka-python/html/index.html#producer) -- 전환 전 사용했던 Kafka Producer API
