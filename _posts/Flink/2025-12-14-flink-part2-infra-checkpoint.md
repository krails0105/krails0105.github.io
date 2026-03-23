---
title: "Flink 스터디 Part 2 (Ch20-22) - 프로젝트 구조화, 환경 분리, Checkpoint"
date: 2026-03-16
categories: [Flink]
tags: [Flink, Java, Checkpoint, StateBackend, RocksDB, ExactlyOnce, RestartStrategy]
---

### 들어가며

Part 2 마지막 인프라 편이다. Ch14-19가 "무엇을 처리할 것인가"에 관한 것이었다면, Ch20-22는 "어떻게 프로덕션에 배포하고 운영할 것인가"에 관한 것이다.

- **Ch20**: 흩어진 공통 코드를 `common` 패키지로 정리하고, fat jar로 패키징
- **Ch21**: 환경별(dev/prod) 설정 분리와 Secret 관리
- **Ch22**: Checkpoint 상세 설정, State Backend, Restart Strategy, Web UI 모니터링

이 글은 특히 Checkpoint 동작 원리(barrier alignment, EXACTLY_ONCE)와 State Backend 선택 기준에 집중한다.

#### 챕터 구성

| 챕터 | 주제 | 핵심 API |
|------|------|----------|
| Ch20 | 프로젝트 구조화 | `maven-shade-plugin`, `ServicesResourceTransformer` |
| Ch21 | 환경 분리 & Secret | `ParameterTool`, `mergeWith`, `System.getenv` |
| Ch22 | Checkpoint & 모니터링 | `CheckpointConfig`, `StateBackendOptions`, `RestartStrategies` |

---

### Ch20: 프로젝트 구조화

---

#### common 패키지 추출

챕터가 쌓이면서 같은 코드(Kinesis Consumer 생성, 필터 로직, 설정 로드)가 각 클래스에 복붙되기 시작했다. Ch20에서는 이를 `com.study.common` 패키지로 추출한다.

```
com.study
├── common/
│   ├── ConfigLoader.java       -- 설정 로드
│   ├── KinesisSourceFactory.java  -- Kinesis Consumer 팩토리
│   └── TSAggFilter.java        -- 공통 필터
└── Ch22_Checkpoint.java        -- 이제 main()이 3줄로 줄어듦
```

이후 각 챕터의 `main()`은 다음처럼 단순해진다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
ConfigLoader.init(args);
DataStreamSource<TSAgg> source = KinesisSourceFactory.create(env);
TSAggFilter.apply(source).print();
```

한 가지 주의할 점: `com.study`와 `com.study.common`은 Java에서 **별개 패키지**다. 같은 `com.study` 하위에 있다고 해서 package-private 접근이 되지 않는다. `common` 패키지의 클래스는 반드시 `public`으로 선언해야 한다.

#### maven-shade-plugin: fat jar 패키징

Flink 클러스터에 제출하려면 모든 의존성이 하나의 jar에 들어 있어야 한다. `maven-shade-plugin`이 그 역할을 한다.

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
        <filter>
          <artifact>*:*</artifact>
          <excludes>
            <!-- 서명 파일 제외 — SecurityException 방지 -->
            <exclude>META-INF/*.SF</exclude>
            <exclude>META-INF/*.DSA</exclude>
            <exclude>META-INF/*.RSA</exclude>
          </excludes>
        </filter>
        <transformers>
          <transformer implementation="...ManifestResourceTransformer">
            <mainClass>com.study.Ch22_Checkpoint</mainClass>
          </transformer>
          <!-- SPI 파일 병합 — 커넥터 인식에 필수 -->
          <transformer implementation="...ServicesResourceTransformer"/>
        </transformers>
      </configuration>
    </execution>
  </executions>
</plugin>
```

**ServicesResourceTransformer가 왜 필요한가?**

Java SPI(Service Provider Interface)는 커넥터가 자기 자신을 등록하는 방식이다. `META-INF/services/` 디렉토리 아래에 인터페이스 이름의 파일을 두고, 구현 클래스 이름을 적어 넣는다.

문제는 여러 커넥터 jar를 하나로 합칠 때 발생한다. `META-INF/services/org.apache.flink.core.plugin.Plugin` 파일이 kinesis-connector jar에도 있고, jdbc-connector jar에도 있으면, 기본 `shade`는 나중 것으로 덮어써 버린다. 앞선 커넥터는 등록이 사라져 인식되지 않는다.

`ServicesResourceTransformer`는 이 파일들을 덮어쓰지 않고 **내용을 이어 붙여** 모든 구현 클래스가 등록되도록 한다.

**META-INF 서명 파일 제외**

일부 라이브러리는 jar에 서명을 포함한다(`.SF`, `.DSA`, `.RSA`). fat jar로 합치면 서명이 내용과 불일치하여 JVM이 `SecurityException`을 던진다. 이 파일들을 명시적으로 제외해야 한다.

---

### Ch21: 환경 분리 & Secret 관리

---

#### ParameterTool로 환경 선택

Flink는 `ParameterTool`이라는 내장 유틸리티를 제공한다. CLI 인자(`--key value` 형식)와 properties 파일을 모두 읽을 수 있고, 두 소스를 병합할 수도 있다.

```java
// src/main/java/com/study/common/ConfigLoader.java
public static void init(String[] args) {
    ParameterTool argsParam = ParameterTool.fromArgs(args);
    String env = argsParam.get("env", "dev");  // 기본값 dev

    String filename = "application-" + env + ".properties";
    InputStream is = ConfigLoader.class.getClassLoader().getResourceAsStream(filename);

    try {
        // CLI 인자가 properties보다 우선 (mergeWith 순서)
        params = ParameterTool.fromPropertiesFile(is).mergeWith(argsParam);
    } catch (IOException e) {
        throw new RuntimeException(filename + " 로드 실패", e);
    }
}
```

실행 시 `--env prod`를 넘기면 `application-prod.properties`를 로드한다. 넘기지 않으면 `dev`가 기본값이다.

`mergeWith(argsParam)`의 순서가 중요하다. `a.mergeWith(b)`에서 키가 겹치면 `b`가 우선한다. 즉, CLI 인자가 properties 파일 값을 덮어쓴다. 특정 설정만 일시적으로 바꾸고 싶을 때 유용하다.

#### Secret은 환경변수에서

DB 비밀번호 같은 민감한 값을 properties 파일에 넣으면 git에 커밋될 위험이 있다. 환경변수에서 읽는 것이 기본 패턴이다.

```java
// src/main/java/com/study/common/ConfigLoader.java
public static String getDbPassword() {
    String password = System.getenv("DB_PASSWORD");
    return password != null ? password : "postgres";  // fallback: 로컬 Docker용
}
```

프로덕션에서는 환경변수 대신 AWS Parameter Store나 Secrets Manager를 사용하는 경우가 많다. 패턴은 동일하다: 코드에 값을 하드코딩하지 않고, 런타임에 외부 저장소에서 주입한다.

#### static 블록 vs lazy init 싱글턴

Ch20 초기 `ConfigLoader`는 static 블록으로 구현되어 있었다.

```java
// 이전 방식 (Ch20 초기)
static {
    // 클래스 로딩 시 즉시 실행 — args를 받을 수 없음
    properties = loadPropertiesFile("kinesis-config.properties");
}
```

문제는 static 블록이 클래스 로딩 시점에 즉시 실행되기 때문에, `main(args)`의 `args`를 받기 전에 실행된다. 환경을 CLI 인자로 선택하려면 `init(args)` 메서드 방식으로 바꿔야 한다.

싱글턴 패턴(lazy init)은 첫 호출 시 생성되므로 테스트에서 mock으로 교체하기 더 쉽다는 장점도 있다.

---

### Ch22: Checkpoint & 모니터링

---

#### Checkpoint란

Flink의 Checkpoint는 **실행 중인 스트리밍 잡의 전체 State를 주기적으로 저장하는 메커니즘**이다. 장애가 발생하면 마지막 Checkpoint로 돌아가 재시작하여 데이터 유실을 방지한다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
env.enableCheckpointing(30000);  // 30초마다 체크포인트

CheckpointConfig cpConfig = env.getCheckpointConfig();
cpConfig.setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
cpConfig.setCheckpointTimeout(60000);           // 60초 내 완료 못하면 실패
cpConfig.setMinPauseBetweenCheckpoints(5000);   // CP 끝난 후 최소 5초 대기
cpConfig.setMaxConcurrentCheckpoints(1);        // 동시에 1개만
```

각 설정이 왜 필요한지 하나씩 살펴보자.

#### EXACTLY_ONCE와 barrier alignment

`CheckpointingMode.EXACTLY_ONCE`는 Flink의 핵심 보장이다. 장애가 발생해도 각 레코드가 정확히 한 번 처리되었음을 보장한다.

이를 구현하는 핵심 메커니즘이 **barrier alignment**다.

Flink는 Checkpoint를 찍을 때 소스에서 특별한 마커 메시지인 **barrier**를 내려보낸다. Barrier가 연산자에 도착하면 그 시점까지의 State를 스냅샷으로 저장한다.

문제는 연산자가 여러 입력 채널(병렬 소스)에서 데이터를 받을 때다.

```
[채널1] A → B → [barrier 5] → C → D → ...
[채널2] X → [barrier 5] → Y → Z → ...
```

채널2의 barrier가 먼저 도착했다. 이때 채널2에서 오는 이후 데이터(Y, Z)를 그냥 처리하면 어떻게 될까? Checkpoint 5에 Y, Z가 섞여 저장된다. 장애 후 Checkpoint 5로 복구하면 Y, Z를 다시 처리하게 되어 중복 처리가 발생한다. EXACTLY_ONCE가 깨지는 것이다.

Barrier alignment는 이를 막기 위해 **빠른 채널의 barrier 이후 데이터를 버퍼에 홀드**한다.

```
채널2 barrier 먼저 도착
  → 채널2의 이후 데이터(Y, Z)를 버퍼에 홀드
  → 채널1의 barrier 대기
채널1 barrier 도착
  → 정렬 완료 → State 스냅샷 저장
  → 홀드된 Y, Z 처리 재개
```

`AT_LEAST_ONCE`는 이 정렬을 하지 않는다. 처리량은 높아지지만 중복 처리 가능성이 있다.

#### setMinPauseBetweenCheckpoints

CP 간격을 30초로 설정했는데, 만약 CP가 28초 걸렸다면? 끝나자마자 2초 후에 다음 CP가 시작된다. 실제 데이터 처리에 쓸 수 있는 시간이 거의 없다.

`setMinPauseBetweenCheckpoints(5000)`은 CP가 완료된 후 **최소 5초를 쉬고** 다음 CP를 시작하도록 강제한다. 이 설정은 `enableCheckpointing`에 지정한 간격을 오버라이드한다.

#### setMaxConcurrentCheckpoints

CP 간격 30초인데 CP가 40초 걸리면? 기본적으로 다음 CP가 이전 CP가 끝나기 전에 시작될 수 있다.

`setMaxConcurrentCheckpoints(1)`로 설정하면 이전 CP가 완료될 때까지 다음 CP를 시작하지 않는다. 대부분의 프로덕션 환경에서 1을 사용한다. State가 크거나 저장소(S3)가 느릴 때 CP가 오래 걸리는 상황을 방어하는 설정이다.

**CP가 오래 걸리는 주요 원인:**
- State 크기가 큼 (키 수백만 개 이상)
- S3 업로드 지연
- Barrier alignment 대기 시간 과다 (backpressure가 barrier 전파를 막음)

#### State Backend: hashmap vs rocksdb

Flink의 State는 어딘가에 저장되어야 한다. 그 위치를 결정하는 것이 State Backend다.

| 항목 | hashmap (기본) | rocksdb |
|------|--------------|---------|
| 저장 위치 | JVM 힙 메모리 | 디스크 (임베디드 DB) |
| 속도 | 빠름 | 느림 (디스크 I/O) |
| 용량 한계 | JVM 힙 크기 | 디스크 크기 (10GB+ 가능) |
| GC 영향 | 큼 (힙에 상주) | 없음 |
| 적합한 케이스 | 학습, State가 작을 때 | 키 수백만 개 이상, 대규모 State |

```java
// src/main/java/com/study/Ch22_Checkpoint.java
Configuration conf = new Configuration();
conf.set(StateBackendOptions.STATE_BACKEND, "rocksdb");
conf.set(CheckpointingOptions.CHECKPOINTS_DIRECTORY, "file:///tmp/flink-checkpoints");
env.configure(conf);
```

프로덕션에서는 `file:///tmp/...` 대신 S3 경로(`s3://bucket/checkpoints/job-name`)를 사용한다. 로컬 파일은 TaskManager가 재시작되면 사라지기 때문이다.

#### Restart Strategy

장애 발생 시 잡을 자동으로 재시작하는 설정이다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
env.setRestartStrategy(
    RestartStrategies.fixedDelayRestart(3, Time.of(10, TimeUnit.SECONDS))
);
```

3회 재시도, 재시도 간격 10초. 3회를 모두 소진하면 잡이 FAILED 상태로 전환된다.

재시작 시 Flink는 마지막으로 성공한 Checkpoint로 되돌아간다. Checkpoint 저장소가 없으면 처음부터 다시 시작한다.

#### Flink Web UI

로컬 개발 중 Checkpoint 상태를 시각적으로 확인하려면 Web UI를 활성화한다.

```java
// src/main/java/com/study/Ch22_Checkpoint.java
Configuration conf = new Configuration();
conf.setString("rest.port", "8081");
StreamExecutionEnvironment env =
    StreamExecutionEnvironment.createLocalEnvironmentWithWebUI(conf);
```

`getExecutionEnvironment()` 대신 `createLocalEnvironmentWithWebUI(conf)`를 사용한다. `flink-runtime-web` 의존성도 추가해야 한다.

```xml
<!-- pom.xml -->
<dependency>
  <groupId>org.apache.flink</groupId>
  <artifactId>flink-runtime-web</artifactId>
  <version>${flink.version}</version>
  <scope>compile</scope>
</dependency>
```

`localhost:8081`에 접속하면 Checkpoints 탭에서 각 CP의 소요 시간, 성공/실패 여부, 저장된 State 크기를 확인할 수 있다. backpressure 탭에서 파이프라인의 병목 지점도 파악 가능하다.

---

### 주의할 점

---

#### ObjectMapper 지역변수 섀도잉 버그

`KinesisSourceFactory`의 `TSAggDeserializer`를 처음 작성할 때 흔히 하는 실수가 있다.

```java
// 잘못된 코드 — 지역변수가 필드를 가림(shadowing)
private ObjectMapper objectMapper;

public TSAgg deserialize(byte[] message) {
    ObjectMapper objectMapper = new ObjectMapper();  // 지역변수 선언!
    return objectMapper.readValue(message, TSAgg.class);
}
```

`ObjectMapper objectMapper = new ObjectMapper()`라고 타입을 붙여서 선언하면 지역변수가 된다. 필드에는 값이 들어가지 않고, 매번 새 인스턴스가 생성된다. lazy init을 의도했다면 타입 없이 `objectMapper = new ObjectMapper()`로 써야 한다.

```java
// 올바른 코드 — src/main/java/com/study/common/KinesisSourceFactory.java
private transient ObjectMapper objectMapper;

public TSAgg deserialize(byte[] message) throws IOException {
    if (objectMapper == null) {
        objectMapper = new ObjectMapper();  // 필드에 할당
    }
    return objectMapper.readValue(message, TSAgg.class);
}
```

`transient`는 Flink가 Deserializer를 직렬화해서 TaskManager에 전송할 때 `ObjectMapper`를 포함하지 않도록 한다. `ObjectMapper`는 `Serializable`을 구현하지 않기 때문이다.

#### RocksDB ClassNotFoundException

`flink-statebackend-rocksdb` 의존성 없이 `rocksdb` State Backend를 설정하면 런타임에 `ClassNotFoundException`이 발생한다.

```xml
<!-- pom.xml — rocksdb 사용 시 필수 -->
<dependency>
  <groupId>org.apache.flink</groupId>
  <artifactId>flink-statebackend-rocksdb</artifactId>
  <version>${flink.version}</version>
  <scope>compile</scope>
</dependency>
```

에러 메시지에 RocksDB 관련 클래스 이름이 보인다면 이 의존성을 추가했는지 확인한다.

#### JDK 17 + Kryo 직렬화 문제

JDK 17의 모듈 시스템은 리플렉션을 기본으로 차단한다. Flink가 POJO 타입으로 인식하지 못한 클래스는 Kryo 직렬화로 폴백되는데, Kryo는 리플렉션에 의존하기 때문에 JDK 17에서 오류가 발생한다.

해결 방법은 Flink POJO 조건을 충족하는 것이다: `public` 클래스, `public` 기본 생성자(`@NoArgsConstructor`), `public` getter/setter. 조건을 충족하면 Flink는 직접 필드에 접근하는 TypeSerializer를 생성해 Kryo를 우회한다.

VM 옵션(`--add-opens`)으로 모듈 접근을 허용하는 방법도 있지만, 근본 원인인 Kryo 폴백을 없애는 것이 더 낫다.

---

### 다음 단계

---

Ch23에서는 Ch14-22에서 구현한 모든 요소를 통합하여 프로덕션 파이프라인을 완성한다.

- fat jar 빌드 후 실제 Flink 클러스터에 제출
- Checkpoint 저장소를 S3로 전환
- Flink 라이브러리를 `provided` scope으로 변경하여 jar 크기 최적화

---

### Reference

---

- `src/main/java/com/study/Ch22_Checkpoint.java`
- `src/main/java/com/study/common/ConfigLoader.java`
- `src/main/java/com/study/common/KinesisSourceFactory.java`
- `src/main/java/com/study/common/TSAggFilter.java`
- `pom.xml`
- [Apache Flink - Checkpointing](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/datastream/fault-tolerance/checkpointing/)
- [Apache Flink - State Backends](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/ops/state/state_backends/)
