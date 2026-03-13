---
layout: post
title: "Flink 스터디 Ch02 - Kinesis Source 연결: 실제 스트림에서 데이터 읽기"
date: 2026-03-13
categories: [Flink]
tags: [Flink, Kinesis, Java, FlinkKinesisConsumer, DeserializationSchema, Lombok, Maven, Jackson]
---

## 들어가며

Ch01에서 `DataGen` Source로 가상 데이터를 생성했다면, Ch02에서는 실제 AWS Kinesis 스트림에 연결해 암호화폐 OHLCV(캔들) 데이터를 읽는다. Java와 Maven을 처음 다루면서 `FlinkKinesisConsumer`, `DeserializationSchema`, Lombok까지 한꺼번에 다뤄야 하는 챕터였다.

이 글을 마치면 다음을 할 수 있게 된다.

- Flink 잡에서 Kinesis 스트림을 데이터 소스로 연결
- `DeserializationSchema`를 구현하여 JSON 바이트를 Java 객체로 변환
- 운영 환경에 영향을 주지 않도록 폴링 파라미터를 보수적으로 설정

## 사전 준비 (Prerequisites)

| 항목 | 버전/조건 |
|------|-----------|
| Java | 11+ |
| Apache Flink | 1.20.x |
| flink-connector-kinesis | 5.x (Legacy API) |
| Maven | 3.8+ |
| AWS 자격 증명 | `~/.aws/credentials` 또는 환경변수 설정 완료 |
| Kinesis 스트림 | 읽을 수 있는 스트림이 이미 존재 |

Ch01의 프로젝트 구조 위에 이어서 작업한다. Ch01을 먼저 완료해야 한다.

## 배경 (Problem & Context)

실습 환경에는 이미 운영 중인 Kinesis 스트림(`tech-cex-exchange-ohlcv`)이 있다. 이 스트림에는 거래소에서 수집한 OHLCV 데이터가 JSON 형태로 계속 들어온다. 목표는 Flink 잡이 이 스트림을 읽어서 콘솔에 출력하는 것.

두 가지 전제 조건이 있었다.

1. **운영 Consumer에 영향을 주면 안 된다.** Kinesis는 Kafka의 Consumer Group과 달리 각 Consumer가 독립적으로 읽는다. 하지만 GetRecords API 호출 횟수가 너무 많으면 스로틀링이 발생할 수 있다.
2. **비용이 발생하면 안 된다.** Kinesis POLLING 모드(GetRecords API)는 무료지만, Enhanced Fan-Out(EFO) 모드는 유료다.

이 두 조건 때문에 poll 간격, 배치 크기 등을 운영보다 훨씬 보수적으로 설정해야 했다.

## 접근 방법 (Approach)

**FlinkKinesisConsumer (Legacy Source)** 를 선택했다. Flink 1.17부터 새로운 Source API(`KinesisStreamsSource`)가 나왔지만, `flink-connector-kinesis` 5.x는 여전히 Legacy API(`addSource`)로 사용하는 것이 문서상 표준이다.

> **`addSource()` vs `fromSource()` 구분**
> `FlinkKinesisConsumer`는 Legacy `SourceFunction`을 구현하므로 `env.addSource()`로 등록한다.
> 새로운 FLIP-27 Source API(`fromSource()`)는 커넥터가 `Source` 인터페이스를 구현했을 때 사용한다.

전체 구현 흐름은 다음과 같다.

```text
kinesis-config.properties  →  Properties 로드
                           →  FlinkKinesisConsumer 생성
                           →  OhlcvDeserializer (byte[] → Ohlcv)
                           →  .print() 출력
```

## 구현 (Key Code & Commands)

### 1. Lombok 의존성 추가 (pom.xml)

Lombok은 `@Data`, `@NoArgsConstructor` 같은 어노테이션으로 getter/setter/toString 등 반복적인 보일러플레이트 코드를 컴파일 시점에 자동 생성해준다.

```xml
<!-- pom.xml -->

<!-- build > plugins 안에 추가 — Lombok은 컴파일 시점에 코드를 생성하므로
     maven-compiler-plugin이 Lombok을 어노테이션 프로세서로 인식해야 한다 -->
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-compiler-plugin</artifactId>
  <version>${maven-compiler-plugin.version}</version>
  <configuration>
    <annotationProcessorPaths>
      <path>
        <groupId>org.projectlombok</groupId>
        <artifactId>lombok</artifactId>
        <version>${lombok.version}</version>
      </path>
    </annotationProcessorPaths>
  </configuration>
</plugin>

<!-- dependencies 안에 추가 — scope: provided
     컴파일 시에만 필요하고 런타임에는 불필요 (이미 코드가 생성됨) -->
<dependency>
  <groupId>org.projectlombok</groupId>
  <artifactId>lombok</artifactId>
  <version>${lombok.version}</version>
  <scope>provided</scope>
</dependency>
```

**왜 `provided` scope인가?** Lombok은 컴파일할 때 어노테이션을 읽어 실제 Java 코드(getter, setter 등)를 생성한다. 생성이 끝나면 런타임에는 Lombok 자체가 필요 없다. `provided`로 설정하면 빌드된 JAR에 Lombok이 포함되지 않아 용량도 줄어든다. mvnrepository.com에서도 Lombok은 명시적으로 `provided`를 권장한다.

**왜 `annotationProcessorPaths`가 필요한가?** Maven 3.5+ / `maven-compiler-plugin` 3.5+부터는 어노테이션 프로세서를 `annotationProcessorPaths`에 명시적으로 등록해야 한다. 이를 빠뜨리면 Lombok 어노테이션이 처리되지 않아 getter/setter가 생성되지 않고, 컴파일 에러가 발생한다.

### 2. Ohlcv 모델 클래스

```java
// src/main/java/com/study/model/Ohlcv.java

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.math.BigDecimal;

@Data                                        // getter/setter/toString/equals/hashCode 자동 생성
@NoArgsConstructor                           // Jackson이 JSON → 객체 변환 시 기본 생성자 필요
@JsonIgnoreProperties(ignoreUnknown = true)  // 모르는 JSON 필드가 와도 에러 없이 무시
public class Ohlcv implements Serializable { // Flink이 네트워크로 객체 전송 시 직렬화 필요

    private String symbol;      // 거래쌍 (BTC/USDT 등)
    private String base;        // 기준 통화 (BTC, ETH 등)
    private String quote;       // 견적 통화 (USDT, USD 등)

    @JsonProperty("market_type")  // JSON의 snake_case → Java의 camelCase 매핑
    private String marketType;    // spot, futures 등

    private Long timestamp;
    private BigDecimal open;     // float/double이 아닌 BigDecimal — 금융 데이터는
    private BigDecimal high;     // 부동소수점 오차가 치명적이므로 정확한 소수 연산 필수
    private BigDecimal low;
    private BigDecimal close;
    private BigDecimal volume;
}
```

**`Serializable`을 구현하는 이유:** Flink은 분산 환경에서 동작하므로 JobManager가 Task를 TaskManager로 전송할 때 객체를 byte[]로 변환(직렬화)한다. `Serializable`을 구현하지 않으면 런타임에 `java.io.NotSerializableException`이 발생한다.

**`@JsonIgnoreProperties(ignoreUnknown = true)`를 쓰는 이유:** Kinesis 스트림의 JSON에 이 클래스에 정의하지 않은 필드(예: `interval`, `exchange`)가 포함되어 있을 수 있다. 이 어노테이션이 없으면 Jackson이 `UnrecognizedPropertyException`을 던진다. 대안으로 ObjectMapper 레벨에서 `DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES`를 `false`로 설정하는 방법도 있지만, 모델 클래스에 선언하는 편이 의도가 명확하다.

### 3. kinesis-config.properties

```properties
# src/main/resources/kinesis-config.properties

stream.name=tech-cex-exchange-ohlcv
stream.initial.position=LATEST
aws.region=us-east-1

# 운영 Consumer 영향 최소화 설정
poll.interval.ms=2000
max.records.per.get=200
```

각 설정의 의미를 정리하면 다음과 같다.

| 키 | 값 | 설명 |
|----|-----|------|
| `stream.initial.position` | `LATEST` | 지금부터 들어오는 데이터만 읽기 (과거 데이터 스킵) |
| `poll.interval.ms` | `2000` | 운영 500ms의 4배 -- 느리게 폴링하여 스로틀링 방지 |
| `max.records.per.get` | `200` | 운영 1000의 1/5 -- 작은 배치로 영향 최소화 |

> **참고:** `LATEST`로 설정했기 때문에 잡을 실행하자마자 데이터가 출력되지 않는다. 스트림에 새 레코드가 들어와야 비로소 출력된다. `TRIM_HORIZON`으로 바꾸면 샤드에 보관된 가장 오래된 데이터부터 읽는다. `AT_TIMESTAMP`를 사용하면 특정 시점부터 읽을 수도 있다.

### 4. Ch02_KinesisSource.java (메인 클래스)

```java
// src/main/java/com/study/Ch02_KinesisSource.java

import com.study.model.Ohlcv;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.connectors.kinesis.FlinkKinesisConsumer;
import org.apache.flink.streaming.connectors.kinesis.config.ConsumerConfigConstants;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

public class Ch02_KinesisSource {

    public static void main(String[] args) throws Exception {
        // 1. 실행 환경 생성
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        env.setParallelism(1);  // 학습용이므로 단일 스레드로 실행

        // 2. 설정 파일 로드
        Properties config = loadConfig();

        // 3. ConsumerConfigConstants: Flink이 알아듣는 Kinesis 설정 키 모음
        Properties kinesisProps = new Properties();
        kinesisProps.setProperty(
                ConsumerConfigConstants.AWS_REGION,
                config.getProperty("aws.region"));
        kinesisProps.setProperty(
                ConsumerConfigConstants.AWS_CREDENTIALS_PROVIDER,
                "AUTO");  // ~/.aws/credentials 또는 환경변수 자동 탐색
        kinesisProps.setProperty(
                ConsumerConfigConstants.STREAM_INITIAL_POSITION,
                config.getProperty("stream.initial.position"));
        kinesisProps.setProperty(
                ConsumerConfigConstants.SHARD_GETRECORDS_INTERVAL_MILLIS,
                config.getProperty("poll.interval.ms"));
        kinesisProps.setProperty(
                ConsumerConfigConstants.SHARD_GETRECORDS_MAX,
                config.getProperty("max.records.per.get"));

        // 4. FlinkKinesisConsumer: Legacy Source — env.addSource()로 등록
        FlinkKinesisConsumer<Ohlcv> consumer = new FlinkKinesisConsumer<>(
                config.getProperty("stream.name"),  // 스트림 이름
                new OhlcvDeserializer(),             // byte[] → Ohlcv 변환기
                kinesisProps
        );

        // 5. Source 등록 → 콘솔 출력
        env.addSource(consumer, "Kinesis OHLCV")
                .print();  // Ohlcv.toString() 호출 — Lombok @Data가 자동 생성

        // 6. 실행 — 이 줄이 없으면 프로그램이 아무것도 하지 않고 바로 종료됨!
        env.execute("Ch02 - Kinesis Source");
    }

    private static Properties loadConfig() throws IOException {
        Properties props = new Properties();
        try (InputStream is = Ch02_KinesisSource.class.getClassLoader()
                .getResourceAsStream("kinesis-config.properties")) {
            if (is == null) {
                throw new IOException("kinesis-config.properties not found in classpath");
            }
            props.load(is);
        }
        return props;
    }
}
```

`ConsumerConfigConstants`의 주요 상수를 정리하면 다음과 같다.

| 상수 | 실제 키 값 | 역할 |
|------|-----------|------|
| `AWS_REGION` | `aws.region` | Kinesis 스트림이 위치한 AWS 리전 |
| `AWS_CREDENTIALS_PROVIDER` | `aws.credentials.provider` | 인증 방식 (`AUTO`, `BASIC`, `PROFILE` 등) |
| `STREAM_INITIAL_POSITION` | `flink.stream.initpos` | 읽기 시작 위치 (`LATEST`, `TRIM_HORIZON`, `AT_TIMESTAMP`) |
| `SHARD_GETRECORDS_INTERVAL_MILLIS` | `flink.shard.getrecords.intervalmillis` | GetRecords API 호출 간격 (ms) |
| `SHARD_GETRECORDS_MAX` | `flink.shard.getrecords.maxrecordcount` | 한 번에 가져올 최대 레코드 수 |

### 5. OhlcvDeserializer (inner class)

```java
// Ch02_KinesisSource.java 내부

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;

static class OhlcvDeserializer implements DeserializationSchema<Ohlcv> {

    // transient: Flink이 이 클래스를 직렬화할 때 ObjectMapper를 포함시키지 않음
    // ObjectMapper는 Serializable이 아니라서 직렬화 자체가 불가능
    // deserialize() 첫 호출 시 lazy init으로 생성
    private transient ObjectMapper mapper;

    @Override
    public Ohlcv deserialize(byte[] bytes) throws IOException {
        if (mapper == null) {
            mapper = new ObjectMapper();
        }
        return mapper.readValue(bytes, Ohlcv.class);
    }

    @Override
    public boolean isEndOfStream(Ohlcv ohlcv) {
        return false;  // 무한 스트림 — 끝이 없다
    }

    @Override
    public TypeInformation<Ohlcv> getProducedType() {
        return TypeInformation.of(Ohlcv.class);  // null 리턴하면 런타임 에러
    }
}
```

이 코드에서 짚고 넘어갈 점 세 가지가 있다.

**왜 `transient`인가?** Flink은 이 `OhlcvDeserializer` 인스턴스를 Java 직렬화로 TaskManager에 전송한다. Jackson의 `ObjectMapper`는 `Serializable`을 구현하지 않기 때문에 `transient`로 선언하지 않으면 `NotSerializableException`이 발생한다. 대신 `deserialize()` 메서드 첫 호출 시 lazy initialization으로 생성한다.

> **참고:** 로컬 미니 클러스터(parallelism 1)에서는 `transient` 없이도 에러가 안 날 수 있다. 직렬화/네트워크 전송 과정이 생략되기 때문이다. 하지만 실제 클러스터에 배포하면 JobManager → TaskManager 간 네트워크 전송이 발생하므로 `NotSerializableException`이 터진다. `transient`는 분산 배포를 위한 안전장치다.

**왜 `static` inner class인가?** `main()` 메서드는 `static` 컨텍스트이므로, 내부에서 참조하는 클래스도 `static`으로 선언되어야 한다. `static`을 빼면 외부 클래스의 인스턴스를 참조하게 되어 컴파일 에러가 발생한다.

**`ObjectMapper` 재사용:** `ObjectMapper`는 스레드 세이프하고 생성 비용이 크다. `deserialize()`가 호출될 때마다 새로 생성하지 않고, `null` 체크를 통해 한 번만 생성하여 재사용한다. Jackson 공식 문서에서도 `ObjectMapper` 인스턴스를 재사용할 것을 권장한다.

### 실행 결과 예시

잡을 실행하고 스트림에 데이터가 들어오면 다음과 같은 형태로 콘솔에 출력된다.

```text
Ohlcv(symbol=BTC/USDT, base=BTC, quote=USDT, marketType=spot, timestamp=1710300000000, open=67234.5, high=67300.0, low=67100.2, close=67250.8, volume=123.456)
```

출력이 나오지 않는다면 `stream.initial.position=LATEST` 설정 때문에 잡 실행 이후에 들어온 데이터만 출력되는 것이니, 스트림에 새 데이터가 들어올 때까지 기다려야 한다.

## 삽질 기록 (Gotchas)

이번 챕터에서 만난 실수들을 기록해 둔다. properties 관련 실수가 유독 많았는데, Java의 `Properties`는 키가 틀려도 에러 없이 `null`을 반환하거나 조용히 무시하기 때문이다.

### 1. properties 파일명 오타

`kinensis-config.properties` (**kinENsis**)로 잘못 저장해서 `inStream parameter is null` 에러가 발생했다. `getResourceAsStream()`이 파일을 찾지 못해 `null`을 반환한 것이다. 초기에는 null 체크 코드가 없어서 이후 `NullPointerException`으로 나타났고, 원인을 찾기가 훨씬 어려웠다. 이후 `if (is == null) throw new IOException(...)` 방어 코드를 추가했다.

### 2. 설정 키 오타

`max.record.per.get`(**record** 단수)으로 썼다가 설정이 먹히지 않았다. 정확한 키는 `max.records.per.get`(**records** 복수형). Properties는 키가 틀려도 에러 없이 `null`을 반환하므로, `ConsumerConfigConstants.SHARD_GETRECORDS_MAX`에 `null`이 들어가 기본값이 적용된다. 이런 종류의 버그는 "동작은 하는데 의도와 다르게" 동작하므로 발견이 어렵다.

### 3. FlinkKinesisConsumer 첫 번째 인자

생성자 첫 번째 파라미터는 **Kinesis 스트림 이름**이다. `"kinesis-consumer"` 같은 임의 이름을 넣었다가 `ResourceNotFoundException`으로 연결에 실패했다. `config.getProperty("stream.name")`으로 properties에서 실제 스트림 이름을 읽어오는 것이 맞다.

### 4. getProducedType()에서 null 리턴

처음에 `return null`로 두었다가 런타임에 Flink의 타입 시스템이 `NullPointerException`을 냈다. `TypeInformation.of(Ohlcv.class)`를 반드시 리턴해야 한다. Flink은 이 타입 정보를 기반으로 직렬화/역직렬화 전략과 메모리 관리를 결정하기 때문이다.

### 5. env.execute() 누락

Flink는 **Lazy Evaluation** 방식이다. `env.addSource().print()`까지는 DAG(실행 계획)를 구성할 뿐이고, `env.execute()`를 호출해야 실제 실행된다. 빠뜨리면 프로그램이 아무것도 하지 않고 바로 종료된다. 에러 메시지도 없이 깨끗하게 종료되므로 원인을 모르면 한참 헤맬 수 있다.

## 핵심 정리 (Key Takeaways)

1. **FlinkKinesisConsumer**는 Legacy Source API(`addSource`)로 Kinesis 스트림을 읽는다. 새로운 `KinesisStreamsSource`(FLIP-27)와 혼동하지 않도록 주의.
2. **DeserializationSchema**는 Flink이 Source의 raw bytes를 Java 객체로 변환할 때 사용하는 인터페이스다. `deserialize()`, `isEndOfStream()`, `getProducedType()` 세 메서드를 구현해야 한다.
3. **ObjectMapper는 `transient`로 선언**하고 lazy init 패턴을 사용한다. Flink의 직렬화 메커니즘과 Jackson의 비호환성 때문이다.
4. **Kinesis POLLING 모드는 무료**, EFO는 유료다. 학습 환경에서는 poll 간격과 배치 크기를 보수적으로 설정하여 운영에 영향을 주지 않도록 한다.
5. **Properties 파일은 오타에 관대하다** (에러 없이 `null` 반환). 방어적 null 체크를 습관화하자.

## 다음 단계 (Next Steps)

- **Ch03: 데이터 변환** -- `map()`, `filter()`로 스트림 데이터 가공
- **Ch04: 윈도우 집계** -- Tumbling Window로 1분봉 집계
- **체크포인트 설정** -- 잡 재시작 시 마지막으로 읽은 위치부터 재개하는 방법
- `TRIM_HORIZON`으로 바꿔서 과거 데이터 전체를 읽어보는 실험

## Reference

- [src/main/java/com/study/Ch02_KinesisSource.java](../../flink-study/src/main/java/com/study/Ch02_KinesisSource.java)
- [src/main/java/com/study/model/Ohlcv.java](../../flink-study/src/main/java/com/study/model/Ohlcv.java)
- [src/main/resources/kinesis-config.properties](../../flink-study/src/main/resources/kinesis-config.properties)
- [pom.xml](../../flink-study/pom.xml)
- [Apache Flink Kinesis Connector 공식 문서 (1.20)](https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/connectors/datastream/kinesis/)
- [Jackson Databind - ObjectMapper](https://github.com/FasterXML/jackson-databind)
- [Project Lombok 공식 문서](https://projectlombok.org/)
