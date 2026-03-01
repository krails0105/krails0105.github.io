---
layout: post
title: "[RealtimePipeline] Phase 1 - Spring Boot + Redis 초기 세팅"
categories: [RealtimePipeline]
tags: [Spring Boot, Redis, Docker Compose, Lombok, Java]
---

# Introduction

---

실시간 주식 시세 데이터 파이프라인을 단계적으로 구축하는 학습 프로젝트를 시작합니다. 최종 목표는 Redis, Kafka, Flink, MongoDB를 모두 연결하는 완전한 파이프라인이지만, Phase 1에서는 가장 기초가 되는 **Spring Boot 애플리케이션과 Redis 연동 환경을 세팅**하는 데 집중합니다.

이 포스트에서는 프로젝트 생성부터 Mock 시세 데이터를 반환하는 REST API 완성까지, 각 단계에서 왜 그런 선택을 했는지 이유와 함께 정리합니다.

# 프로젝트 개요

---

## 전체 아키텍처

```
[Mock 시세 데이터]
        ↓
    Kafka (Phase 3)
        ↓
    Flink (Phase 4)
        ↓
    MongoDB (Phase 2)
        ↓
    Spring Boot API
    ├─ Redis (최신 시세 캐시) ← Phase 1 목표
    └─ REST API
        ↓
    React 대시보드 (Phase 5)
```

Phase 1은 이 아키텍처에서 **Spring Boot API와 Redis 캐시** 부분의 기반을 만드는 단계입니다.

## 기술 스택

| 기술 | 버전 | 역할 |
|------|------|------|
| Java | 17 | 언어 |
| Spring Boot | 3.x | 웹 애플리케이션 프레임워크 |
| Spring Data Redis | - | Redis 연동 |
| Lombok | - | 보일러플레이트 코드 제거 |
| Docker Compose | - | Redis 인프라 실행 |

# 단계별 구현 과정

---

## Step 1: Spring Initializr로 프로젝트 생성

[start.spring.io](https://start.spring.io)에서 아래 의존성을 선택하여 프로젝트를 생성합니다.

- **Spring Web**: REST API를 만들기 위한 기본 의존성
- **Spring Data Redis**: Redis 연동
- **Lombok**: 반복적인 getter/setter/생성자 코드를 어노테이션으로 대체

생성된 `build.gradle`의 의존성 부분은 아래와 같습니다.

```groovy
// realtime-pipeline/build.gradle

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-data-redis'
    implementation 'org.springframework.boot:spring-boot-starter-web'
    compileOnly 'org.projectlombok:lombok'
    annotationProcessor 'org.projectlombok:lombok'
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
}
```

`compileOnly`와 `annotationProcessor`를 함께 선언하는 이유는 Lombok이 **컴파일 시점에만 동작**하기 때문입니다. 런타임에는 Lombok이 필요 없고, 컴파일 때 어노테이션을 읽어 코드를 자동 생성합니다.

## Step 2: Docker Compose로 Redis 실행

Redis를 직접 로컬에 설치하는 대신 Docker Compose를 사용합니다. 이렇게 하면 팀원과 동일한 환경을 쉽게 공유할 수 있고, 나중에 Kafka, MongoDB 등을 추가할 때도 같은 `docker-compose.yml`에 서비스를 추가하기만 하면 됩니다.

```yaml
# realtime-pipeline/docker-compose.yml

services:
  redis:
    image: redis:7-alpine   # alpine은 경량화된 Linux 이미지 (용량 최소화)
    ports:
      - 6379:6379           # 호스트:컨테이너 포트 매핑
    volumes:
      - redis-data:/data    # 컨테이너 재시작 후에도 데이터 유지

volumes:
  redis-data:               # Docker가 관리하는 Named Volume 선언
```

`redis:7-alpine`을 선택한 이유는 `alpine` 기반 이미지가 일반 이미지보다 훨씬 가볍기 때문입니다. 개발 환경에서는 최신 안정 버전의 경량 이미지가 적합합니다.

실행 명령어:

```bash
docker-compose up -d   # -d 옵션: 백그라운드로 실행
```

## Step 3: application.properties에 Redis 연결 설정

Spring Boot가 Redis 서버를 찾을 수 있도록 연결 정보를 설정합니다.

```properties
# realtime-pipeline/src/main/resources/application.properties

spring.application.name=realtime-pipeline

spring.data.redis.host=localhost
spring.data.redis.port=6379
```

Docker Compose에서 `6379:6379`로 포트를 매핑했기 때문에 `localhost:6379`로 접근할 수 있습니다.

## Step 4: StockPrice 도메인 모델

주식 시세 데이터를 담을 Java 클래스를 만듭니다.

```java
// realtime-pipeline/src/main/java/com/example/realtime_pipeline/domain/StockPrice.java

@Data               // getter, setter, equals, hashCode, toString 자동 생성
@Builder            // 빌더 패턴으로 객체 생성 가능 (StockPrice.builder().symbol("...").build())
@AllArgsConstructor // 모든 필드를 받는 생성자 자동 생성 (@Builder가 필요로 함)
@NoArgsConstructor  // 기본 생성자 자동 생성 (JSON 역직렬화에 필요)
public class StockPrice {
    private String symbol;          // 종목코드 (예: "005930")
    private String name;            // 종목명 (예: "삼성전자")
    private int price;              // 현재가 (원 단위)
    private double changeRate;      // 등락률 (%)
    private long volume;            // 거래량
    private LocalDateTime timestamp; // 시세 기준 시각
}
```

**왜 Lombok을 쓰는가?** `StockPrice`처럼 단순히 데이터를 담는 클래스는 필드 외에도 getter/setter, 생성자, `toString` 등 수십 줄의 반복 코드가 필요합니다. Lombok 어노테이션 4개로 이 모든 코드를 자동 생성합니다.

**`@Builder`와 `@AllArgsConstructor`를 함께 쓰는 이유:** `@Builder`는 내부적으로 모든 필드 생성자를 사용합니다. `@AllArgsConstructor`를 명시하지 않으면 `@Builder`가 생성한 생성자와 충돌이 발생할 수 있어 함께 선언합니다.

## Step 5: MockStockDataGenerator - 랜덤 시세 생성

실제 주식 API가 없으므로, 랜덤 시세를 생성하는 Mock 서비스를 만듭니다.

```java
// realtime-pipeline/src/main/java/com/example/realtime_pipeline/service/MockStockDataGenerator.java

@Component  // Spring이 이 클래스를 Bean으로 관리하게 함
public class MockStockDataGenerator {

    // Java 16+의 record: 데이터만 담는 불변 클래스를 한 줄로 정의
    // record를 쓰면 name(), basePrice() 같은 접근자 메서드가 자동 생성됨
    record StockInfo(String name, int basePrice) {}

    // 종목코드 → 종목 정보 매핑 테이블
    Map<String, StockInfo> symbolNameMap = Map.of(
        "005930", new StockInfo("삼성전자", 71000),
        "000660", new StockInfo("SK하이닉스", 185000)
    );

    public List<StockPrice> getStockPrice() {
        ArrayList<StockPrice> stockPrices = new ArrayList<>();

        for (String key : symbolNameMap.keySet()) {
            String name = symbolNameMap.get(key).name();
            int basePrice = symbolNameMap.get(key).basePrice();

            // 기준가 ±5% 범위에서 랜덤 가격 생성
            int price = ThreadLocalRandom.current().nextInt(
                (int)(basePrice * 0.95),
                (int)(basePrice * 1.05)
            );

            // 등락률 = (현재가 - 기준가) / 기준가 × 100
            double changeRate = (price - basePrice) / (double) basePrice * 100;

            // 거래량도 랜덤 생성
            long volume = ThreadLocalRandom.current().nextLong(10000, 100000);

            StockPrice stockPrice = StockPrice.builder()
                .symbol(key)
                .name(name)
                .price(price)
                .changeRate(changeRate)
                .volume(volume)
                .build();

            stockPrices.add(stockPrice);
        }

        return stockPrices;
    }
}
```

### 코드 리뷰에서 개선된 사항들

초기 구현에서 코드 리뷰를 통해 아래 부분들을 개선했습니다.

**1. Java record 도입**

처음에는 종목 정보를 `Object[]`나 별도 클래스로 관리하려 했지만, `record`를 사용하면 한 줄로 타입 안전한 데이터 클래스를 만들 수 있습니다.

```java
// 개선 전: 타입이 없어서 실수하기 쉬움
Object[] info = {"삼성전자", 71000};

// 개선 후: 타입 명확, 자동으로 name(), basePrice() 메서드 생성
record StockInfo(String name, int basePrice) {}
```

**2. ThreadLocalRandom 선택**

`Math.random()`이나 `new Random()` 대신 `ThreadLocalRandom`을 선택했습니다. 이 프로젝트는 나중에 Kafka Consumer 등 멀티스레드 환경으로 확장됩니다. `Random`은 여러 스레드가 동시에 사용하면 경합이 발생하지만, `ThreadLocalRandom`은 **스레드마다 독립적인 인스턴스**를 사용해 경합 없이 안전합니다.

**3. changeRate 계산 방식 수정**

```java
// 개선 전: 임의의 랜덤 등락률 (가격과 무관)
double changeRate = ThreadLocalRandom.current().nextDouble(-5.0, 5.0);

// 개선 후: 실제 가격에서 계산한 등락률 (price와 일관성 유지)
double changeRate = (price - basePrice) / (double) basePrice * 100;
```

랜덤 가격과 랜덤 등락률이 따로 놀면 데이터의 일관성이 깨집니다. 등락률은 실제 생성된 가격에서 역산하는 것이 맞습니다.

## Step 6: StockController - REST API 노출

```java
// realtime-pipeline/src/main/java/com/example/realtime_pipeline/controller/StockController.java

@RestController             // @Controller + @ResponseBody: 반환값을 JSON으로 직렬화
@RequestMapping("/api/stocks")
@RequiredArgsConstructor    // final 필드를 받는 생성자 자동 생성 (의존성 주입용)
public class StockController {

    // @RequiredArgsConstructor가 생성자를 만들어주므로 @Autowired 없이 주입됨
    private final MockStockDataGenerator mockStockDataGenerator;

    @GetMapping             // GET /api/stocks
    public List<StockPrice> listPrices() {
        return mockStockDataGenerator.getStockPrice();
    }
}
```

`@RequiredArgsConstructor`를 사용하면 `private final MockStockDataGenerator mockStockDataGenerator`에 대한 생성자를 Lombok이 자동으로 만들어 줍니다. Spring은 이 생성자를 통해 Bean을 주입합니다 (생성자 주입 방식).

# 동작 확인

---

1. Docker Compose로 Redis 실행
```bash
docker-compose up -d
```

2. Spring Boot 애플리케이션 실행
```bash
./gradlew bootRun
```

3. API 호출 확인
```bash
curl http://localhost:8080/api/stocks
```

응답 예시:
```json
[
  {
    "symbol": "005930",
    "name": "삼성전자",
    "price": 72540,
    "changeRate": 2.17,
    "volume": 54321,
    "timestamp": null
  },
  {
    "symbol": "000660",
    "name": "SK하이닉스",
    "price": 181230,
    "changeRate": -2.04,
    "volume": 87654,
    "timestamp": null
  }
]
```

호출할 때마다 `price`, `changeRate`, `volume`이 랜덤하게 바뀌는 것을 확인할 수 있습니다.

# 주의할 점

---

**1. `@AllArgsConstructor`와 `@Builder`는 세트**

`@Builder`만 선언하면 컴파일러가 생성자 관련 경고를 낼 수 있습니다. 두 어노테이션을 항상 함께 선언하는 습관을 들이세요.

**2. Docker Compose 볼륨 설정**

`volumes` 없이 Redis 컨테이너를 띄우면 컨테이너를 재시작할 때 Redis에 저장된 데이터가 사라집니다. 개발 중에는 크게 문제없지만, Phase 1에서 캐시 테스트를 할 때 예상치 못한 결과가 나올 수 있으니 볼륨을 반드시 설정합니다.

**3. `int` vs `long`의 선택**

주식 가격은 `int`(최대 약 21억)로 충분하지만, 거래량은 하루 수억 건이 넘는 종목이 있어 `long`을 사용했습니다. 데이터 크기에 맞는 타입을 처음부터 선택하는 것이 중요합니다.

# 다음 단계

---

Phase 1의 다음 작업은 실제 Redis 연동입니다.

- **Spring Data Redis로 시세 캐싱**: `@Cacheable`을 사용해 매번 랜덤 생성하는 대신 Redis에 캐싱
- **TTL 설정**: 시세는 일정 시간이 지나면 오래된 데이터이므로 자동 만료 처리
- **Sorted Set으로 등락률 랭킹**: Redis의 Sorted Set 자료구조를 활용한 실시간 랭킹

# Reference

---

- [`realtime-pipeline/build.gradle`](https://github.com/krails0105/side-project/blob/main/realtime-pipeline/build.gradle)
- [`realtime-pipeline/docker-compose.yml`](https://github.com/krails0105/side-project/blob/main/realtime-pipeline/docker-compose.yml)
- [`realtime-pipeline/src/main/java/com/example/realtime_pipeline/domain/StockPrice.java`](https://github.com/krails0105/side-project/blob/main/realtime-pipeline/src/main/java/com/example/realtime_pipeline/domain/StockPrice.java)
- [`realtime-pipeline/src/main/java/com/example/realtime_pipeline/service/MockStockDataGenerator.java`](https://github.com/krails0105/side-project/blob/main/realtime-pipeline/src/main/java/com/example/realtime_pipeline/service/MockStockDataGenerator.java)
- [`realtime-pipeline/src/main/java/com/example/realtime_pipeline/controller/StockController.java`](https://github.com/krails0105/side-project/blob/main/realtime-pipeline/src/main/java/com/example/realtime_pipeline/controller/StockController.java)
