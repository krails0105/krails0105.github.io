---
title: "Flink + Kinesis EKS 배포 디버깅 전체 기록 — 에러 9개 해부"
categories:
  - Flink
tags: [Flink, Kinesis, EKS, Kubernetes, Java, Kryo, FlinkOperator, AWS, Debugging, Pipeline, Monitoring]
---

## 개요

이전 글에서 Kafka를 포기하고 Kinesis로 전환하기로 했다. 이번에는 실제로 Kinesis 스트림을 만들고, Flink 코드를 Kinesis Connector로 바꾸고, EKS에 올리기까지의 전 과정을 기록한다.

배포 자체보다 디버깅이 훨씬 많은 시간을 차지했다. EKS에 처음 `kubectl apply`를 날린 순간부터 E2E 성공까지, **에러 9개**를 순서대로 만났다. 각 에러가 왜 발생했고 어떻게 고쳤는지 상세히 남긴다.

이 글을 읽고 나면 다음을 이해할 수 있다.

- Kinesis 스트림 비용 계산 (프로비저닝 vs 온디맨드)
- `KafkaSource` → `KinesisStreamsSource` 전환 시 달라지는 코드
- Flink Kubernetes Operator의 동작 원리 (Reconcile 개념)
- EKS 배포에서 반복적으로 나타나는 에러 패턴과 원인
- Kryo 직렬화 문제가 생기는 조건과 완전한 해결법
- 로컬 통합 테스트로 미리 잡을 수 있었던 에러 vs 못 잡는 에러 분류

## 사전 준비

이 글의 내용을 따라하려면 아래 환경이 갖춰져 있어야 한다.

| 항목 | 버전/조건 |
|---|---|
| Java | 17 (Flink 1.20 기준 권장) |
| Apache Flink | 1.20 |
| Flink Kubernetes Operator | Helm으로 설치 완료 |
| EKS 클러스터 | amd64 노드 포함 |
| AWS CLI | 프로필 설정 완료, ECR/Kinesis 접근 가능 |
| Docker | `--platform linux/amd64` 빌드 가능 |
| kubectl | EKS 클러스터에 연결된 상태 |
| Python 3 + boto3 | E2E 테스트 Producer용 (선택) |

---

## Part 1: Kinesis 스트림 생성

### 프로비저닝 vs 온디맨드 비용 비교

Kinesis는 두 가지 용량 모드를 제공한다.

| 항목 | 온디맨드 | 프로비저닝 (1샤드) |
|---|---|---|
| 시간당 비용 (us-west-1) | $0.049/스트림 | $0.0182/샤드 |
| 월 고정비 | ~$35 | ~$13 |
| 데이터 수집 | $0.014/GB | $0.014/GB |
| 특징 | 트래픽에 따라 자동 조절 | 샤드 수 고정 |

이 프로젝트의 트래픽은 **초당 0.06건, 레코드당 약 300B**다. 샤드 1개의 한도(쓰기 1,000건/초, 1MB/초 / 읽기 2MB/초)에 비교하면 극소량이다. 이 수준에서는 프로비저닝이 온디맨드 대비 약 1/3 비용이다.

**샤드 계산법**: 초당 최대 레코드 수 1건, 소비자 1개 → 샤드 1개로 충분.

```bash
# 스트림 생성 (프로비저닝 모드, 샤드 1개)
aws kinesis create-stream \
  --stream-name my-stream \
  --shard-count 1 \
  --region <REGION>
```

> 샤드 한도 요약: 쓰기 1,000건/초 또는 1MB/초, 읽기 2MB/초. 초과하면 `ProvisionedThroughputExceededException` 발생. 늘리려면 샤드를 추가해야 한다.

---

## Part 2: Flink Connector 전환

### KafkaSource에서 KinesisStreamsSource로

`pom.xml`에서 Kafka 커넥터를 Kinesis로 교체한다. `flink-connector-kinesis` 아티팩트 하나에 `KinesisStreamsSource`(DataStream API)와 Table API 커넥터가 모두 포함되어 있다.

```xml
<!-- pom.xml -->

<!-- 제거 -->
<!-- <artifactId>flink-connector-kafka</artifactId> -->

<!-- 추가 -->
<dependency>
    <groupId>org.apache.flink</groupId>
    <artifactId>flink-connector-kinesis</artifactId>
    <version>5.0.0-1.20</version>
</dependency>
```

`MyFlinkJob.java`에서 소스 생성 코드가 달라진다. 핵심 차이는 두 가지다: (1) `setStreamArn()`으로 스트림을 지정하고, (2) Kafka 전용 `KafkaRecordDeserializationSchema` 대신 범용 `DeserializationSchema`를 사용한다.

```java
// MyFlinkJob.java

// Before: KafkaSource
KafkaSource<MyEvent> kafkaSource = KafkaSource.<MyEvent>builder()
    .setBootstrapServers("kafka:9092")
    .setTopics("my-stream")
    .setDeserializer(KafkaRecordDeserializationSchema.of(new MyEventDeserializer()))
    .build();
DataStreamSource<MyEvent> events = env.fromSource(kafkaSource, watermark, "Kafka");

// After: KinesisStreamsSource
KinesisStreamsSource<MyEvent> kinesisSource = KinesisStreamsSource
    .<MyEvent>builder()
    .setStreamArn(env("KINESIS_STREAM_ARN", "arn:aws:kinesis:<REGION>:<ACCOUNT_ID>:stream/my-stream"))
    .setDeserializationSchema(new MyEventDeserializer())
    .build();

SingleOutputStreamOperator<MyEvent> events = env.fromSource(kinesisSource, watermark, "Kinesis Pipeline Events")
    .returns(MyEvent.class);  // ← 이게 없으면 나중에 type erasure 에러 발생 (에러 7)
```

`.returns(MyEvent.class)` 한 줄이 중요하다. Flink는 스트림의 타입 정보를 런타임에 유지해야 직렬화를 처리할 수 있는데, Java 컴파일러의 type erasure 때문에 `KinesisStreamsSource<MyEvent>`의 타입 파라미터가 지워진다. `.returns()`로 명시하지 않으면 배포 단계에서 에러 7번으로 다시 만나게 된다.

### MyEventDeserializer 변경

Kafka용 `KafkaRecordDeserializationSchema`를 범용 `AbstractDeserializationSchema`로 교체한다. 이 클래스는 `flink-core`에 포함되어 있어 별도 의존성이 필요 없다.

```java
// MyEventDeserializer.java

// Before
public class MyEventDeserializer implements KafkaRecordDeserializationSchema<MyEvent> { ... }

// After
public class MyEventDeserializer extends AbstractDeserializationSchema<MyEvent> {
    private static final ObjectMapper mapper = new ObjectMapper();

    @Override
    public MyEvent deserialize(byte[] bytes) throws IOException {
        return mapper.readValue(bytes, MyEvent.class);
    }
}
```

`AbstractDeserializationSchema`는 Kafka/Kinesis 양쪽에서 쓸 수 있는 공통 인터페이스다. 메서드 시그니처가 `deserialize(byte[])` 하나만 있어서 구현이 간단하다.

### 환경변수 외부화

하드코딩된 값들을 `System.getenv()`로 교체한다. 기본값을 두면 로컬 테스트 때 환경변수 없이도 동작한다.

```java
// MyFlinkJob.java

static String env(String key, String defaultValue) {
    String value = System.getenv(key);
    return (value != null && !value.isEmpty()) ? value : defaultValue;
}

// 사용 예시
pgProps.setProperty("url", env("JDBC_URL", "jdbc:postgresql://localhost:5432/mydb"));
pgProps.setProperty("password", env("JDBC_PASSWORD", "changeme"));
```

---

## Part 3: EKS 배포 — 에러 9개 해부

### 배포 구조 먼저 이해하기

아래 에러들을 이해하려면 Flink Kubernetes Operator의 동작 방식을 먼저 알아야 한다.

**Flink Kubernetes Operator**는 `FlinkDeployment`라는 커스텀 리소스(CRD)를 감시한다. `kubectl apply -f flink-deployment.yaml`을 실행하면, Operator가 YAML에 정의된 원하는 상태(desired state)를 읽고 JobManager/TaskManager 파드를 자동으로 생성하고 관리한다. 이 과정을 **Reconcile**이라고 한다.

```
원하는 상태(FlinkDeployment YAML)
         ↓
  Flink Kubernetes Operator
  (Reconcile: 원하는 상태 = 실제 상태?)
         ↓
  JobManager 파드 생성
  TaskManager 파드 생성
```

Reconcile이 계속 실패하면 Operator 로그와 파드 이벤트를 같이 봐야 한다. 아래 두 명령어는 이후 에러 디버깅에서 반복적으로 사용한다.

```bash
# Operator 로그 — Reconcile 실패 원인 확인
kubectl logs -n flink-kubernetes-operator deployment/flink-kubernetes-operator

# FlinkDeployment 상태 — 파드 이벤트, 에러 메시지 확인
kubectl describe flinkdeployment my-flink-app -n my-namespace
```

### 에러 1: ECR 이미지 not found

첫 `kubectl apply` 후 파드가 `ErrImagePull`로 실패했다.

**원인**: ECR에 이미지가 없음. Dockerfile을 build하고 push하는 단계를 먼저 해야 한다.

```dockerfile
# Dockerfile
FROM flink:1.20-java17
COPY target/my-flink-job.jar /opt/flink/usrlib/my-job.jar
```

```bash
# 1. Fat JAR 빌드
mvn package -DskipTests

# 2. Docker 이미지 빌드 (EKS 노드가 amd64이므로 플랫폼 명시 필수)
docker build --platform linux/amd64 -t my-flink-app:latest .

# 3. ECR 로그인
aws ecr get-login-password --region <REGION> \
  | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# 4. 태그 & 푸시
docker tag my-flink-app:latest \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/my-flink-app:latest

docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/my-flink-app:latest
```

### 에러 2: Flink Operator Webhook Not Ready

```
failed calling webhook "mutationwebhook.flink.apache.org": no endpoints available for service "flink-kubernetes-operator"
```

**원인**: Helm으로 Operator를 방금 설치했는데, Operator 파드가 아직 Ready 상태가 아닐 때 `FlinkDeployment`를 apply하면 이 에러가 난다. Operator의 Admission Webhook 서버가 아직 준비되지 않은 상태에서 K8s API Server가 검증 요청을 보내기 때문이다.

**해결**: Operator 파드가 Running/Ready가 될 때까지 기다린 뒤 다시 apply.

```bash
kubectl get pods -n flink-kubernetes-operator -w
# STATUS가 Running, READY가 1/1 되는 것 확인 후
kubectl apply -f flink-deployment.yaml
```

### 에러 3: arm64 노드에 amd64 이미지 스케줄링

```
no match for platform in manifest: not found
```

**원인**: K8s 스케줄러가 Flink 파드를 arm64(Graviton) 노드에 배치했는데, ECR에는 amd64 이미지만 있다. EKS 클러스터에 여러 아키텍처의 노드가 섞여 있으면 이런 일이 발생한다.

**해결**: `podTemplate`에 `nodeSelector`를 추가해서 amd64 노드에만 스케줄링하도록 강제한다.

```yaml
# flink-deployment.yaml
podTemplate:
  spec:
    nodeSelector:
      kubernetes.io/arch: amd64   # ← 이 줄 추가
    containers:
      - name: flink-main-container
        env: [...]
```

### 에러 4: Checkpointing has not been enabled

```
Checkpointing has not been enabled. Cannot get the latest checkpoint location.
```

**원인**: Flink Kubernetes Operator가 savepoint/checkpoint 위치를 조회하려 하는데, Java 코드의 `env.enableCheckpointing()`이 실행되기 전 단계(잡 제출 전)에 Operator가 상태를 확인하려 해서 실패한다. 코드 레벨 설정만으로는 Operator가 인식할 수 없다.

**해결**: `flinkConfiguration`에 checkpoint 설정을 직접 명시해서, 코드 실행 여부와 무관하게 Operator가 설정을 인식하게 한다.

```yaml
# flink-deployment.yaml
flinkConfiguration:
  execution.checkpointing.interval: "300000"   # 5분 (ms 단위)
  execution.checkpointing.externalized-checkpoint-retention: RETAIN_ON_CANCELLATION
```

### 에러 5: S3 파일시스템 플러그인 없음

```
Could not find a file system implementation for scheme 's3'
```

**원인**: `state.checkpoints.dir: s3://my-bucket/checkpoints`로 설정했는데, 기본 `flink:1.20-java17` 이미지에는 S3 플러그인이 포함되어 있지 않다. Flink의 S3 지원은 플러그인 방식으로 분리되어 있어서, 별도로 이미지에 포함시켜야 한다.

**임시 해결**: 개발/테스트 단계이므로 checkpoint 경로를 로컬 파일시스템으로 변경.

```yaml
flinkConfiguration:
  state.checkpoints.dir: file:///tmp/flink-checkpoints
```

> **프로덕션 참고**: S3 플러그인(`flink-s3-fs-hadoop` 또는 `flink-s3-fs-presto`)을 Dockerfile에 추가해야 한다. `COPY --from=flink:1.20-java17 /opt/flink/opt/flink-s3-fs-hadoop-*.jar /opt/flink/plugins/s3-fs-hadoop/` 같은 방식으로 플러그인 디렉토리에 복사하면 된다.

### 에러 6: Java 모듈 시스템 (add-opens)

```
InaccessibleObjectException: Unable to make field ... accessible:
module java.base does not "opens java.util" to unnamed module
```

**원인**: Java 17의 모듈 시스템(JPMS)은 기본적으로 내부 API 접근을 막는다. Flink의 Kryo 직렬화기가 `java.util.Collections$UnmodifiableMap` 같은 내부 클래스를 리플렉션으로 접근하려다 차단된다. Java 8이나 11에서는 경고만 나오던 것이 Java 17부터는 에러로 바뀌었다.

**해결**: `flinkConfiguration`에 JVM 옵션을 추가해서 필요한 패키지를 열어준다.

```yaml
# flink-deployment.yaml
flinkConfiguration:
  env.java.opts.all: >-
    --add-opens java.base/java.util=ALL-UNNAMED
    --add-opens java.base/java.lang=ALL-UNNAMED
```

로컬 Maven 테스트에서도 같은 문제가 난다. `pom.xml`의 Surefire 플러그인에 `argLine`으로 추가해야 테스트가 통과한다.

```xml
<!-- pom.xml -->
<plugin>
    <artifactId>maven-surefire-plugin</artifactId>
    <configuration>
        <argLine>
            --add-opens java.base/java.util=ALL-UNNAMED
            --add-opens java.base/java.lang=ALL-UNNAMED
            --add-opens java.base/java.lang.invoke=ALL-UNNAMED
            --add-opens java.base/java.io=ALL-UNNAMED
            --add-opens java.base/java.time=ALL-UNNAMED
        </argLine>
    </configuration>
</plugin>
```

### 에러 7: Type Erasure (KinesisStreamsSource 제네릭 타입 추론 실패)

```
The return type of function 'Kinesis Pipeline Events' could not be determined automatically,
due to type erasure in the Java compiler.
```

**원인**: Flink는 스트림의 타입 정보를 런타임에 유지해야 직렬화/역직렬화를 처리할 수 있다. Java 컴파일러의 type erasure로 `KinesisStreamsSource<MyEvent>`의 타입 파라미터가 지워지면서, Flink가 런타임에 타입을 추론하지 못한다. 이 문제는 Flink 공식 문서의 [Java Lambda Expressions](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/java_lambdas/) 페이지에서도 다루고 있다.

**해결**: `.returns()`로 타입을 명시한다. 단순 POJO라면 `.returns(MyEvent.class)`로 충분하고, 제네릭 타입이라면 `.returns(new TypeHint<Tuple2<Integer, SomeType>>(){})` 형태를 쓴다.

```java
// MyFlinkJob.java

SingleOutputStreamOperator<MyEvent> events =
    env.fromSource(kinesisSource, watermarkStrategy, "Kinesis Pipeline Events")
       .returns(MyEvent.class);  // ← 이 한 줄이 핵심
```

**추가 주의사항 — imagePullPolicy 함정**: 이 에러를 고치고 이미지를 다시 빌드/푸시했는데도 같은 에러가 계속 났다. `imagePullPolicy: Always`가 없으면 K8s가 `latest` 태그 이미지를 캐시에서 그대로 쓰기 때문이다. `FlinkDeployment`에 반드시 `imagePullPolicy: Always`를 명시해야 매 배포마다 최신 이미지를 가져온다.

```yaml
# flink-deployment.yaml
spec:
  image: <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/my-flink-app:latest
  imagePullPolicy: Always   # ← latest 태그 사용 시 필수
```

### 에러 8: Kinesis IAM 권한 부족

```
AccessDeniedException: User: arn:aws:sts::<ACCOUNT_ID>:assumed-role/MyNodeRole/...
is not authorized to perform: kinesis:DescribeStreamSummary
```

이후 `kinesis:GetRecords`, `kinesis:ListShards`도 순차적으로 실패했다.

**원인**: EKS 노드가 사용하는 IAM Role에 Kinesis 권한이 없었다. `AmazonKinesisReadOnlyAccess`를 붙여봤는데 부족했고, 결국 `AmazonKinesisFullAccess`로 변경해서 해결했다.

**해결**:
```bash
aws iam attach-role-policy \
  --role-name MyNodeRole-my-cluster \
  --policy-arn arn:aws:iam::aws:policy/AmazonKinesisFullAccess
```

> **프로덕션 참고**: FullAccess 대신 필요한 액션만 허용하는 인라인 정책을 작성하는 것이 맞다. 최소 권한 목록은 다음과 같다: `kinesis:GetRecords`, `kinesis:GetShardIterator`, `kinesis:DescribeStream`, `kinesis:DescribeStreamSummary`, `kinesis:ListShards`, `kinesis:ListStreams`, `kinesis:SubscribeToShard`.

### 에러 9: Kryo 직렬화 — Map.of() / Map.ofEntries() 문제

```
KryoException: NullPointerException: Cannot read the array length
because "table" is null
```

TaskManager 로그에서 발견했다. 잡은 시작됐는데 이벤트를 처리하다가 죽는 형태였다. 9개 에러 중 원인을 추적하는 데 가장 오래 걸렸다.

**원인**: `Map.of()`, `Map.ofEntries()`는 JDK 내부의 `ImmutableCollections$MapN` 또는 `UnmodifiableMap`을 반환한다. 이 클래스들은 내부 구조가 특수해서 Kryo가 역직렬화할 때 빈 생성자(`new HashMap()` 식으로 인스턴스를 만들고 필드를 채우는 방식)로 접근하면 `table` 필드가 null이 된다.

**문제가 된 코드 위치 4곳**:

**1) `MyFlinkJob.java`의 `thresholds` 맵** -- static 필드라 직렬화 대상이 아니므로 문제없음:
```java
// 이건 static 필드라 직렬화 대상 아님 — 문제 없음
static Map<String, Long> thresholds = Map.ofEntries(...);
```

**2) `MetricChecker`와 `AlertChecker`에서 Alert 생성 시** -- Flink 오퍼레이터 내부에서 만들어진 객체는 직렬화 대상:
```java
// Before: Map.of() → JDK 불변 맵 반환
.context(Map.of())

// After: new HashMap<>() → Kryo 친화적
.context(new java.util.HashMap<>())
```

**3) `MyEvent`와 `Alert`의 필드 타입 변경** -- `Object` 타입은 Kryo가 런타임에 타입을 추론해야 해서 불안정:
```java
// Before: Map<String, Object> — Kryo가 Object 타입 직렬화 어려움
private Map<String, Object> metadata;

// After: Map<String, String> — 단순 타입으로 변경
private Map<String, String> metadata;
```

**4) `@NoArgsConstructor` 추가** -- Kryo 역직렬화 시 빈 생성자가 없으면 인스턴스 생성 실패:
```java
// Alert.java — Kryo 역직렬화에 빈 생성자 필요
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Alert implements Serializable { ... }
```

**Kryo 직렬화 핵심 규칙 정리**:

| 규칙 | 이유 |
|---|---|
| `@NoArgsConstructor` 필수 | Kryo는 빈 생성자로 인스턴스를 만들고 필드를 채운다 |
| `Map.of()` / `List.of()` 사용 금지 | JDK 불변 컬렉션은 Kryo 역직렬화 시 내부 구조 복원 불가 |
| `Map<String, Object>` 피하기 | Object 타입 값은 Kryo가 런타임에 타입을 추론해야 해서 불안정 |

---

## Part 4: E2E 성공 확인

모든 에러를 수정하고 배포 후, Python 테스트 Producer로 이벤트를 발행해서 전체 파이프라인을 검증했다.

```python
# test_producer.py — boto3 Kinesis put_record 테스트
import boto3, json

kinesis = boto3.client("kinesis", region_name="<REGION>")

event = {
    "domain": "batch",
    "source": "warehouse",
    "source_id": "my_database.my_table",
    "stage": "error",
    "event_type": "ERROR",
    "event_time": "2026-03-29T10:00:00Z",
    "elapsed_ms": 0,
    "metadata": {}
}

response = kinesis.put_record(
    StreamName="my-stream",
    Data=json.dumps(event),
    PartitionKey="my_database.my_table"
)
# response에 ShardId, SequenceNumber가 포함되면 발행 성공
print(response["ShardId"], response["SequenceNumber"])
```

PostgreSQL에서 결과 확인:

```sql
SELECT alert_key, severity, status, created_at
FROM alerts
ORDER BY created_at DESC
LIMIT 5;
```

```
alert_key                                    | severity | status  | created_at
---------------------------------------------|----------|---------|----------------------------
my_database.my_table.error.error | CRITICAL | FIRING  | 2026-03-29 10:00:05.123+00
```

Producer → Kinesis → Flink (EKS) → PostgreSQL 전체 파이프라인 E2E 성공.

---

## Part 5: 로컬에서 미리 잡을 수 있었던 에러 vs 못 잡는 에러

9개 에러를 돌아보면, 절반 정도는 로컬 통합 테스트(Flink MiniCluster)로 미리 발견할 수 있었다.

| 에러 | 로컬에서 잡을 수 있나? | 이유 |
|---|---|---|
| Type erasure (에러 7) | **가능** | MiniCluster 통합 테스트로 발견 |
| S3 플러그인 없음 (에러 5) | **가능** | `s3://` checkpoint로 로컬 실행 시 발견 |
| Kryo 직렬화 (에러 9) | **가능** | 실제 이벤트로 E2E 테스트 시 발견 |
| Java add-opens (에러 6) | **가능** | Java 17 + Flink 로컬 실행 시 발견 |
| IAM 권한 (에러 8) | **불가** | EKS 노드 Role 문제 — 로컬과 무관 |
| 이미지 캐시 (에러 7 후반) | **불가** | K8s `imagePullPolicy` 문제 |
| arm64 노드 (에러 3) | **불가** | K8s 스케줄링 문제 |
| Webhook not ready (에러 2) | **불가** | K8s Operator 타이밍 문제 |
| ECR 이미지 없음 (에러 1) | **불가** | 배포 절차 문제 |

**결론**: 통합 테스트(MiniCluster)를 돌렸으면 9개 중 4개(type erasure, S3 플러그인, Kryo 직렬화, add-opens)를 미리 잡을 수 있었다. 나머지 5개는 실제 K8s 환경에서만 나타나는 인프라 문제다.

Flink 잡을 처음 작성할 때 MiniCluster 통합 테스트를 작성하는 비용은 그리 크지 않다. 배포 환경에서 삽질하는 시간을 줄이려면, 적어도 실제 이벤트를 넣고 결과 스트림을 확인하는 테스트 하나는 두는 게 좋다.

---

## 기술 개념 정리 (Q&A)

### Flink Kubernetes Operator는 어떻게 동작하는가?

`FlinkDeployment` YAML을 보고 JobManager, TaskManager 파드를 자동으로 생성하고 관리한다. K8s의 Controller 패턴을 따른다 — 원하는 상태(desired state)와 실제 상태(actual state)를 주기적으로 비교하고 맞추는 것을 Reconcile이라고 한다. KRaft(Kafka Raft)와는 다른 개념이다.

### TaskSlot이란?

TaskManager 한 대 안에서 동시에 실행할 수 있는 파이프라인 슬롯 수다. `taskmanager.numberOfTaskSlots: 1`이면 TM 1대당 1개의 태스크를 병렬 실행할 수 있다. CPU 코어 수에 맞게 설정하는 것이 일반적이다.

### imagePullPolicy: Always가 왜 필요한가?

`latest` 태그를 쓰면 K8s는 기본적으로 로컬에 캐시된 이미지를 재사용한다(`IfNotPresent`가 기본값). 이미지를 새로 빌드해서 ECR에 push해도 파드는 이전 이미지로 뜬다. `Always`로 설정하면 매번 레지스트리에서 이미지를 확인하고 가져온다. 개발/테스트 환경에서 `latest` 태그를 쓸 때는 거의 필수 설정이다.

---

## 최종 FlinkDeployment YAML 구조

실제 동작하는 설정 파일의 핵심 부분을 정리한다. 각 설정값 옆에 해당 에러 번호를 주석으로 달아 두었으니, 문제가 재발하면 해당 에러 섹션을 다시 참고하면 된다.

```yaml
# FlinkDeployment YAML 핵심 설정 (주요 부분만 발췌)
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: my-flink-app
spec:
  image: <ECR_URI>/my-flink-app:latest
  imagePullPolicy: Always          # 에러 7: 이미지 캐시 방지
  flinkVersion: v1_20

  flinkConfiguration:
    taskmanager.numberOfTaskSlots: "1"
    state.backend: rocksdb
    state.checkpoints.dir: file:///tmp/flink-checkpoints   # 에러 5: S3 플러그인 없음 회피
    execution.checkpointing.interval: "300000"              # 에러 4: Operator가 checkpoint 설정 인식
    execution.checkpointing.externalized-checkpoint-retention: RETAIN_ON_CANCELLATION
    env.java.opts.all: >-                                    # 에러 6: Java 17 모듈 시스템
      --add-opens java.base/java.util=ALL-UNNAMED
      --add-opens java.base/java.lang=ALL-UNNAMED

  podTemplate:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64  # 에러 3: arm64 노드 배제
      containers:
        - name: flink-main-container
          env:
            - name: KINESIS_STREAM_ARN
              value: "<STREAM_ARN>"
            - name: JDBC_URL
              value: "<JDBC_URL>"
            # ... DB 인증 정보는 K8s Secret으로 분리 권장

  job:
    jarURI: local:///opt/flink/usrlib/my-job.jar
    entryClass: com.example.flink.MyFlinkJob
    parallelism: 1
    upgradeMode: stateless
```

---

## 핵심 정리

1. **Kinesis 비용**: 저트래픽 환경에서는 프로비저닝 모드(샤드 1개)가 온디맨드 대비 약 1/3 비용이다.
2. **커넥터 전환**: `KafkaSource` → `KinesisStreamsSource`로 바꿀 때 `setStreamArn()` + `AbstractDeserializationSchema` + `.returns()` 세 가지만 챙기면 된다.
3. **EKS 배포 에러의 절반은 인프라 문제**: 9개 에러 중 5개는 K8s/AWS 환경에서만 발생하는 문제로, 로컬 테스트로는 잡을 수 없다.
4. **나머지 절반은 MiniCluster 테스트로 예방 가능**: type erasure, Kryo 직렬화, Java 모듈 시스템, S3 플러그인 문제는 로컬 통합 테스트로 사전에 발견할 수 있다.
5. **Kryo 직렬화 3원칙**: `@NoArgsConstructor` 필수, `Map.of()` / `List.of()` 사용 금지, `Map<String, Object>` 대신 구체 타입 사용.

---

## 다음 단계

- **S3 Checkpoint 연동**: Dockerfile에 `flink-s3-fs-hadoop` 플러그인 추가
- **K8s Secret 사용**: JDBC 패스워드, Slack 토큰을 Secret으로 분리
- **MiniCluster 통합 테스트 작성**: 에러 재발 방지용 테스트 커버리지 확보
- **IAM 최소 권한 정책**: `AmazonKinesisFullAccess` → 인라인 정책으로 권한 축소
- **Airflow/Databricks Producer 연동**: 실제 파이프라인 레포들에 이벤트 발행 추가

---

## Reference

**공식 문서**:
- [Flink Amazon Kinesis Data Streams Connector](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/kinesis/)
- [Flink Java Lambda Expressions (Type Erasure)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/java_lambdas/)
- [Flink Type Serialization and Type Hints](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/serialization/types_serialization/)
- [Flink Kubernetes Operator](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/)
- [AWS Kinesis Data Streams Pricing](https://aws.amazon.com/kinesis/data-streams/pricing/)
- [boto3 Kinesis put_record](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/kinesis/client/put_record.html)
