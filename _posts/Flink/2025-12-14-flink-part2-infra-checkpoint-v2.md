---
title: "Flink 스터디 Part 2 (Ch20-22) - 프로젝트 구조화, 환경 분리, Checkpoint"
date: 2026-03-16
categories: [Flink]
tags: [Flink, Java, Checkpoint, StateBackend, RocksDB, ExactlyOnce, RestartStrategy]
---

### 들어가며

Part 2의 마지막 인프라 편이다. Ch14-19가 "무엇을 처리할 것인가"에 관한 것이었다면, Ch20-22는 "어떻게 프로덕션에 배포하고 운영할 것인가"에 관한 것이다.

- **Ch20**: 흩어진 공통 코드를 `common` 패키지로 정리하고, fat jar로 패키징
- **Ch21**: 환경별(dev/prod) 설정 분리와 Secret 관리
- **Ch22**: Checkpoint 상세 설정, State Backend, Restart Strategy, Web UI 모니터링

이 글은 특히 Checkpoint 동작 원리(barrier alignment, EXACTLY_ONCE)와 State Backend 선택 기준에 집중한다. 개념을 이해한 뒤 실제 설정 코드를 따라가는 순서로 구성했다.

#### 사전 지식

- Flink DataStream API 기본 사용법 (Source, Transformation, Sink)
- Maven 빌드 기본 개념 (pom.xml, dependency scope)
- Java의 `static` 키워드와 클래스 로딩 순서

#### 챕터 구성

| 챕터 | 주제 | 핵심 API / 도구 |
|------|------|-----------------|
| Ch20 | 프로젝트 구조화 | `maven-shade-plugin`, `ServicesResourceTransformer` |
| Ch21 | 환경 분리 & Secret | `ParameterTool`, `mergeWith`, `System.getenv` |
| Ch22 | Checkpoint & 모니터링 | `CheckpointConfig`, `StateBackendOptions`, `RestartStrategies` |

---

### Ch20: 프로젝트 구조화

#### common 패키지 추출

챕터가 쌓이면서 같은 코드(Kinesis Consumer 생성, 필터 로직, 설정 로드)가 각 클래스에 복붙되기 시작했다. Ch20에서는 이를 `com.study.common` 패키지로 추출한다.

```
com.study
├── common/
│   ├── ConfigLoader.java         -- 설정 로드 (Ch21에서 개선)
│   ├── KinesisSourceFactory.java -- Kinesis Consumer 팩토리
│   └── TSAggFilter.java          -- 공통 필터
└── Ch22_Checkpoint.java          -- main()이 3줄로 줄어듦
```

이후 각 챕터의 `main()`은 다음처럼 단순해진다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
ConfigLoader.init(args);
DataStreamSource<TSAgg> source = KinesisSourceFactory.create(env);
TSAggFilter.apply(source).print();
```

한 가지 주의할 점이 있다. `com.study`와 `com.study.common`은 Java에서 **별개 패키지**다. 같은 `com.study` 하위에 있다고 해서 package-private 접근이 되지 않는다. `common` 패키지의 클래스와 메서드는 반드시 `public`으로 선언해야 다른 패키지에서 사용할 수 있다.

#### maven-shade-plugin: fat jar 패키징

Flink 클러스터에 잡을 제출하려면, 모든 의존성이 하나의 jar에 포함되어야 한다. `maven-shade-plugin`이 그 역할을 한다.

```xml
<!-- pom.xml -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-shade-plugin</artifactId>
  <version>3.6.0</version>
  <executions>
    <execution>
      <phase>package</phase>
      <goals><goal>shade</goal></goals>
      <configuration>
        <filters>
          <filter>
            <artifact>*:*</artifact>
            <excludes>
              <!-- 서명 파일 제외 — SecurityException 방지 -->
              <exclude>META-INF/*.SF</exclude>
              <exclude>META-INF/*.DSA</exclude>
              <exclude>META-INF/*.RSA</exclude>
            </excludes>
          </filter>
        </filters>
        <transformers>
          <transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
            <mainClass>com.study.Ch22_Checkpoint</mainClass>
          </transformer>
          <!-- SPI 파일 병합 — 커넥터 인식에 필수 -->
          <transformer implementation="org.apache.maven.plugins.shade.resource.ServicesResourceTransformer"/>
        </transformers>
      </configuration>
    </execution>
  </executions>
</plugin>
```

여기서 두 가지 설정이 핵심이다.

**ServicesResourceTransformer가 왜 필요한가?**

Java SPI(Service Provider Interface)는 커넥터가 자기 자신을 Flink 런타임에 등록하는 방식이다. 각 커넥터 jar는 `META-INF/services/` 디렉토리 아래에 인터페이스 이름의 파일을 두고, 구현 클래스의 FQCN(Fully Qualified Class Name)을 적어 넣는다.

문제는 여러 커넥터 jar를 하나로 합칠 때 발생한다. 예를 들어, `META-INF/services/org.apache.flink.table.factories.Factory` 파일이 kinesis-connector jar에도 있고 jdbc-connector jar에도 있으면, 기본 shade 동작은 나중 파일로 덮어써 버린다. 먼저 처리된 커넥터의 등록 정보가 사라져 런타임에 인식되지 않는다.

`ServicesResourceTransformer`는 이 파일들을 덮어쓰지 않고 **내용을 이어 붙여(append)** 모든 구현 클래스가 등록되도록 한다.

**META-INF 서명 파일 제외**

일부 라이브러리는 jar에 디지털 서명을 포함한다(`.SF`, `.DSA`, `.RSA` 파일). fat jar로 합치면 원본 jar의 내용이 바뀌어 서명과 불일치하게 되고, JVM이 `SecurityException`을 던진다. 이 파일들을 명시적으로 제외해야 한다.

---

### Ch21: 환경 분리 & Secret 관리

#### ParameterTool로 환경 선택

Flink는 `ParameterTool`이라는 내장 유틸리티를 제공한다. CLI 인자(`--key value` 형식)와 properties 파일을 모두 읽을 수 있고, 두 소스를 병합할 수도 있다.

```java
// src/main/java/com/study/common/ConfigLoader.java
public static void init(String[] args) throws IOException {
    ParameterTool argsParam = ParameterTool.fromArgs(args);
    String env = argsParam.get("env", "dev");  // 기본값 dev

    String filename = "application-" + env + ".properties";
    InputStream is = ConfigLoader.class.getClassLoader().getResourceAsStream(filename);
    if (is == null) {
        throw new IllegalArgumentException(filename + " 파일을 찾을 수 없습니다 (classpath 확인)");
    }

    // CLI 인자가 properties보다 우선 (mergeWith 순서)
    params = ParameterTool.fromPropertiesFile(is).mergeWith(argsParam);
}
```

실행 시 `--env prod`를 넘기면 `application-prod.properties`를 로드한다. 넘기지 않으면 `dev`가 기본값이다.

`mergeWith(argsParam)`의 순서가 중요하다. `a.mergeWith(b)`에서 키가 겹치면 **`b`가 우선**한다. 따라서 위 코드에서 CLI 인자가 properties 파일 값을 덮어쓴다. 특정 설정만 일시적으로 바꾸고 싶을 때 유용하다. 예를 들어 `--parallelism 4`를 넘기면 properties 파일의 parallelism 값을 무시하고 4를 사용한다.

#### Secret은 환경변수에서

DB 비밀번호 같은 민감한 값을 properties 파일에 넣으면 git에 커밋될 위험이 있다. 환경변수에서 읽는 것이 기본 패턴이다.

```java
// src/main/java/com/study/common/ConfigLoader.java
public static String getDbPassword() {
    String password = System.getenv("DB_PASSWORD");
    return password != null ? password : "postgres";  // fallback: 로컬 Docker용
}
```

프로덕션에서는 환경변수 대신 AWS Parameter Store나 Secrets Manager를 사용하는 경우가 많다. 핵심 패턴은 동일하다: 코드에 값을 하드코딩하지 않고, 런타임에 외부 저장소에서 주입한다.

#### static 블록 vs init() 메서드

Ch20 초기 `ConfigLoader`는 static 블록으로 구현되어 있었다.

```java
// 이전 방식 (Ch20 초기) - 문제가 있는 코드
static {
    // 클래스 로딩 시 즉시 실행 — args를 받을 수 없음
    properties = loadPropertiesFile("kinesis-config.properties");
}
```

문제는 static 블록이 **클래스 로딩 시점에 즉시 실행**되기 때문에, `main(args)`의 `args`를 받기 전에 실행된다는 점이다. 환경을 CLI 인자로 선택하려면 `init(args)` 메서드 방식으로 바꿔야 한다.

`init()` 메서드 방식은 테스트에서도 유리하다. 테스트용 설정 파일이나 mock을 주입하기가 훨씬 수월하기 때문이다.

---

### Ch22: Checkpoint & 모니터링

이 챕터가 이 글의 핵심이다. Checkpoint가 무엇인지, 내부적으로 어떻게 동작하는지 먼저 이해한 뒤 설정 코드를 살펴보자.

#### Checkpoint란

Flink의 Checkpoint는 **실행 중인 스트리밍 잡의 전체 State를 주기적으로 스냅샷 저장하는 메커니즘**이다. 장애가 발생하면 마지막으로 성공한 Checkpoint 지점으로 되돌아가 재시작함으로써 데이터 유실을 방지한다.

간단히 말하면, 게임의 "세이브 포인트"와 비슷하다. 주기적으로 자동 저장되고, 게임 오버 시 마지막 저장 지점에서 다시 시작한다.

#### EXACTLY_ONCE와 barrier alignment

Checkpoint의 기본 모드인 `CheckpointingMode.EXACTLY_ONCE`는 장애가 발생해도 각 레코드가 **정확히 한 번** 처리되었음을 보장한다.

이를 구현하는 핵심 메커니즘이 **barrier alignment**이다.

Flink는 Checkpoint를 시작할 때 소스에서 특별한 마커 메시지인 **checkpoint barrier**를 데이터 스트림에 삽입한다. 이 barrier가 연산자(operator)에 도착하면, 그 시점까지의 State를 스냅샷으로 저장한다.

문제는 연산자가 **여러 입력 채널**(병렬 소스 파티션)에서 데이터를 받을 때 발생한다.

```
[채널1] A -> B -> |barrier 5| -> C -> D -> ...
[채널2] X -> |barrier 5| -> Y -> Z -> ...
```

채널2의 barrier 5가 먼저 도착했다. 이때 채널2에서 오는 이후 데이터(Y, Z)를 그냥 처리하면 어떻게 될까?

Checkpoint 5의 스냅샷에 Y, Z의 처리 결과가 섞여 저장된다. 이후 장애가 발생해서 Checkpoint 5로 복구하면, 소스가 barrier 5 이후부터 데이터를 다시 보내므로 Y, Z가 **두 번 처리**된다. EXACTLY_ONCE 보장이 깨지는 것이다.

Barrier alignment은 이를 막기 위해 **빠른 채널의 barrier 이후 데이터를 버퍼에 홀드**한다.

```
1. 채널2의 barrier 5가 먼저 도착
   -> 채널2의 이후 데이터(Y, Z)를 버퍼에 홀드 (처리하지 않음)
   -> 채널1의 barrier 5 도착을 대기

2. 채널1의 barrier 5 도착
   -> 모든 채널의 barrier가 정렬(align) 완료
   -> State 스냅샷 저장

3. 스냅샷 완료
   -> 홀드되었던 Y, Z 처리 재개
```

`AT_LEAST_ONCE` 모드는 이 정렬을 하지 않는다. Barrier를 기다리지 않고 모든 데이터를 즉시 처리하므로 처리량(throughput)은 높아지지만, 장애 복구 시 일부 레코드가 중복 처리될 수 있다.

#### Checkpoint 설정 코드

개념을 이해했으니 실제 설정 코드를 보자.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
env.enableCheckpointing(30000);  // 30초마다 체크포인트 시작

CheckpointConfig cpConfig = env.getCheckpointConfig();
cpConfig.setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);  // 기본값이지만 명시
cpConfig.setCheckpointTimeout(60000);           // 60초 내 완료 못하면 해당 CP 폐기
cpConfig.setMinPauseBetweenCheckpoints(5000);   // CP 완료 후 최소 5초 대기
cpConfig.setMaxConcurrentCheckpoints(1);        // 동시에 1개만 진행
```

각 설정이 왜 필요한지 하나씩 살펴보자.

**setCheckpointTimeout(60000)**

Checkpoint가 60초 안에 완료되지 않으면 해당 Checkpoint를 폐기한다. State가 크거나 저장소 응답이 느릴 때 무한 대기를 방지하는 안전장치다.

**setMinPauseBetweenCheckpoints(5000)**

CP 간격을 30초로 설정했는데, 만약 CP가 28초 걸렸다면? 끝나자마자 2초 후에 다음 CP가 시작된다. 실제 데이터 처리에 쓸 수 있는 시간이 거의 없어진다.

`setMinPauseBetweenCheckpoints(5000)`은 CP가 완료된 후 **최소 5초를 쉬고** 다음 CP를 시작하도록 강제한다. 이 값이 `enableCheckpointing`에 지정한 간격보다 우선한다.

**setMaxConcurrentCheckpoints(1)**

CP 간격 30초인데 CP가 40초 걸리면? 기본적으로는 이전 CP가 끝나기 전에 다음 CP가 시작될 수 있다.

`setMaxConcurrentCheckpoints(1)`로 설정하면 이전 CP가 완료될 때까지 다음 CP를 시작하지 않는다. 대부분의 프로덕션 환경에서 1을 권장한다. State가 크거나 저장소(S3)가 느릴 때 CP 간의 자원 경합을 방지한다.

**CP가 오래 걸리는 주요 원인:**

- State 크기가 큼 (키 수백만 개 이상)
- S3 업로드 지연
- Barrier alignment 대기 시간 과다 (backpressure가 barrier 전파를 지연시킴)

#### State Backend: hashmap vs rocksdb

Flink의 State는 어딘가에 저장되어야 한다. 그 "어딘가"를 결정하는 것이 State Backend다.

| 항목 | hashmap (기본) | rocksdb |
|------|---------------|---------|
| 저장 위치 | JVM 힙 메모리 | 디스크 (임베디드 RocksDB) |
| 접근 속도 | 빠름 (메모리 직접 접근) | 상대적으로 느림 (직렬화/역직렬화 + 디스크 I/O) |
| 용량 한계 | JVM 힙 크기에 제한됨 | 디스크 크기 (수십 GB 이상 가능) |
| GC 영향 | 큼 (대량 객체가 힙에 상주) | 거의 없음 (off-heap) |
| 적합한 케이스 | 학습/개발, State가 작을 때 | 키 수백만 개 이상, 프로덕션 대규모 State |

```java
// src/main/java/com/study/Ch22_Checkpoint.java
Configuration conf = new Configuration();
conf.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
conf.set(CheckpointingOptions.CHECKPOINT_STORAGE, "filesystem");
conf.set(CheckpointingOptions.CHECKPOINTS_DIRECTORY, "file:///tmp/flink-checkpoints");
env.configure(conf);
```

RocksDB를 사용할 때는 `CHECKPOINT_STORAGE`를 `"filesystem"`으로, `CHECKPOINTS_DIRECTORY`를 함께 지정해야 한다. Flink 공식 문서에서도 이 세 가지를 세트로 설정하는 것을 권장한다.

프로덕션에서는 `file:///tmp/...` 대신 S3 경로(`s3://bucket/checkpoints/job-name`)를 사용한다. 로컬 파일 시스템은 TaskManager가 재시작되면 데이터가 사라지기 때문이다.

#### Restart Strategy

장애 발생 시 잡을 자동으로 재시작하는 전략을 설정한다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
env.setRestartStrategy(
    RestartStrategies.fixedDelayRestart(
        3,                                    // 최대 재시도 횟수
        Time.of(10, TimeUnit.SECONDS)         // 재시도 간격
    )
);
```

위 설정은 장애 시 최대 3회 재시도하며, 각 재시도 사이에 10초를 대기한다. 3회를 모두 소진하면 잡이 FAILED 상태로 전환된다.

재시작 시 Flink는 마지막으로 성공한 Checkpoint 지점으로 되돌아간다. Checkpoint가 활성화되어 있지 않거나 성공한 Checkpoint가 없으면 처음부터(State 없이) 다시 시작한다.

#### Flink Web UI로 Checkpoint 모니터링

로컬 개발 중 Checkpoint 상태를 시각적으로 확인하려면 Web UI를 활성화한다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
Configuration conf = new Configuration();
conf.setString("rest.port", "8081");
StreamExecutionEnvironment env =
    StreamExecutionEnvironment.createLocalEnvironmentWithWebUI(conf);
```

일반적인 `getExecutionEnvironment()` 대신 `createLocalEnvironmentWithWebUI(conf)`를 사용한다. 이를 위해 `flink-runtime-web` 의존성이 필요하다.

```xml
<!-- pom.xml -->
<dependency>
  <groupId>org.apache.flink</groupId>
  <artifactId>flink-runtime-web</artifactId>
  <version>${flink.version}</version>
  <scope>compile</scope>
</dependency>
```

`localhost:8081`에 접속하면 다음을 확인할 수 있다:

- **Checkpoints 탭**: 각 CP의 소요 시간, 성공/실패 여부, 저장된 State 크기
- **Backpressure 탭**: 파이프라인의 병목 지점 파악 (CP가 느린 원인 진단에 유용)

---

### 주의할 점

#### ObjectMapper 지역변수 섀도잉 버그

`KinesisSourceFactory`의 `TSAggDeserializer`를 작성할 때 흔히 하는 실수가 있다.

```java
// 잘못된 코드 -- 지역변수가 필드를 가림(shadowing)
private ObjectMapper objectMapper;

public TSAgg deserialize(byte[] message) {
    ObjectMapper objectMapper = new ObjectMapper();  // 타입을 붙이면 지역변수 선언!
    return objectMapper.readValue(message, TSAgg.class);
}
```

`ObjectMapper objectMapper = new ObjectMapper()`처럼 타입을 붙여서 선언하면 필드가 아닌 **지역변수**가 된다. 필드에는 영원히 `null`이 들어 있고, 매 호출마다 새 인스턴스가 생성되어 성능이 낭비된다. lazy init을 의도했다면 타입 없이 `objectMapper = new ObjectMapper()`로 필드에 할당해야 한다.

```java
// 올바른 코드 -- src/main/java/com/study/common/KinesisSourceFactory.java
private transient ObjectMapper objectMapper;

public TSAgg deserialize(byte[] message) throws IOException {
    if (objectMapper == null) {
        objectMapper = new ObjectMapper();  // 타입 없이 필드에 할당
    }
    return objectMapper.readValue(message, TSAgg.class);
}
```

`transient` 키워드는 Flink가 이 Deserializer 객체를 직렬화하여 TaskManager에 전송할 때 `ObjectMapper` 필드를 제외하도록 한다. `ObjectMapper`는 `Serializable`을 구현하지 않으므로, `transient`가 없으면 직렬화 시 예외가 발생한다.

#### RocksDB ClassNotFoundException

`flink-statebackend-rocksdb` 의존성 없이 `"rocksdb"` State Backend를 설정하면 런타임에 `ClassNotFoundException`이 발생한다.

```xml
<!-- pom.xml -- rocksdb 사용 시 필수 -->
<dependency>
  <groupId>org.apache.flink</groupId>
  <artifactId>flink-statebackend-rocksdb</artifactId>
  <version>${flink.version}</version>
  <scope>compile</scope>
</dependency>
```

에러 메시지에 `EmbeddedRocksDBStateBackend`나 RocksDB 관련 클래스 이름이 보인다면 이 의존성을 먼저 확인하자.

#### JDK 17 + Kryo 직렬화 문제

JDK 17의 모듈 시스템(JPMS)은 리플렉션을 기본으로 차단한다. Flink가 POJO 타입으로 인식하지 못한 클래스는 Kryo 직렬화로 폴백되는데, Kryo는 내부적으로 리플렉션에 의존하기 때문에 JDK 17에서 `InaccessibleObjectException`이 발생할 수 있다.

근본적인 해결 방법은 **Flink POJO 조건을 충족**하는 것이다:

- `public` 클래스
- `public` 기본 생성자 (Lombok의 `@NoArgsConstructor` 활용 가능)
- 모든 필드에 대한 `public` getter/setter

이 조건을 충족하면 Flink는 자체 TypeSerializer를 생성하여 Kryo를 우회한다. VM 옵션(`--add-opens`)으로 모듈 접근을 허용하는 방법도 있지만, 근본 원인인 Kryo 폴백 자체를 제거하는 것이 더 바람직하다.

---

### 핵심 정리

| 주제 | 핵심 내용 |
|------|-----------|
| **프로젝트 구조화** | 공통 코드를 `common` 패키지로 추출, `ServicesResourceTransformer`로 SPI 파일 병합 |
| **환경 분리** | `ParameterTool.mergeWith()`로 properties + CLI 인자 병합, CLI가 우선 |
| **Secret 관리** | 환경변수 또는 외부 Secret Store에서 주입, 코드에 하드코딩 금지 |
| **Checkpoint** | barrier alignment으로 EXACTLY_ONCE 보장, `minPause`와 `maxConcurrent`로 안정성 확보 |
| **State Backend** | hashmap(소규모/개발) vs rocksdb(대규모/프로덕션) |
| **Restart Strategy** | `fixedDelayRestart`로 자동 복구, 재시도 소진 시 FAILED 전환 |

---

### 다음 단계

Ch23에서는 Ch14-22에서 구현한 모든 요소를 통합하여 프로덕션 파이프라인을 완성한다.

- fat jar 빌드 후 실제 Flink 클러스터에 제출
- Checkpoint 저장소를 S3로 전환
- Flink 라이브러리를 `provided` scope으로 변경하여 jar 크기 최적화

---

### Reference

- `src/main/java/com/study/Ch22_Checkpoint.java`
- `src/main/java/com/study/common/ConfigLoader.java`
- `src/main/java/com/study/common/KinesisSourceFactory.java`
- `src/main/java/com/study/common/TSAggFilter.java`
- `pom.xml`
- [Apache Flink - Checkpointing](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/checkpointing/)
- [Apache Flink - State Backends](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/state_backends/)
- [Apache Flink - Application Parameters](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/application_parameters/)
