---
title: "[StockInfo] 06. Spring Configuration - 환경 설정과 Profile"
categories:
  - StockInfo
tags:
  - [Java, Spring, Configuration, YAML]
---

# Introduction

---

애플리케이션 설정(포트, DB 접속 정보, API 키 등)을 코드에 직접 쓰면 어떻게 될까요? 설정을 바꿀 때마다 코드를 수정하고 다시 빌드해야 합니다.

Spring Boot는 **application.yml**을 통해 설정을 코드와 분리하고, **Profile**로 환경별 설정을 관리합니다.

# application.yml 기초

---

## 설정 파일 위치

```
src/main/resources/
├── application.yml           # 공통 설정
├── application-local.yml     # 로컬 개발용
├── application-prod.yml      # 운영용
└── application-secret.yml    # 민감 정보 (Git 제외)
```

## YAML 문법

YAML은 **들여쓰기로 계층 구조**를 표현합니다.

```yaml
# 단순 값
server:
  port: 8080

# 리스트
news:
  feeds:
    - https://news.google.com/rss/feed1
    - https://news.google.com/rss/feed2

# 중첩 구조
spring:
  datasource:
    url: jdbc:h2:mem:stockinfo
    username: sa
    password:
```

**주의**: 들여쓰기는 **공백 2칸**을 사용합니다. 탭(Tab)은 오류 발생!

# Stock-Info의 설정

---

## application.yml 전체 구조

```yaml
# ===========================================
# 서버 설정
# ===========================================
server:
  port: 8080

# ===========================================
# Spring 프레임워크 설정
# ===========================================
spring:
  # 활성화할 프로필 (환경 변수로 오버라이드 가능)
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}
    include: secret    # secret 프로필 항상 포함

  # 애플리케이션 이름
  application:
    name: stock-info-api

  # 데이터소스 (H2 인메모리 DB)
  datasource:
    url: jdbc:h2:mem:stockinfo;DB_CLOSE_DELAY=-1;MODE=PostgreSQL
    username: sa
    password:
    driver-class-name: org.h2.Driver

  # JPA 설정
  jpa:
    hibernate:
      ddl-auto: create-drop    # 시작 시 테이블 생성, 종료 시 삭제
    show-sql: false            # SQL 로그 출력 여부
    properties:
      hibernate:
        format_sql: true
        dialect: org.hibernate.dialect.H2Dialect

  # H2 콘솔 (개발용 DB 관리 화면)
  h2:
    console:
      enabled: true
      path: /h2-console

# ===========================================
# 외부 API 클라이언트 설정
# ===========================================
rest-client:
  # KIS (한국투자증권) API
  kis:
    base-url: https://openapi.koreainvestment.com:9443
    app-key: ${KIS_APP_KEY:}
    app-secret: ${KIS_APP_SECRET:}
    account-number: ${KIS_ACCOUNT_NUMBER:}

  # KRX (한국거래소) API
  krx:
    base-url: http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd

# ===========================================
# 뉴스 수집/처리 설정
# ===========================================
news:
  collection:
    enabled: true              # 수집 활성화
    interval-minutes: 15       # 수집 주기 (분)

  processing:
    batch-size: 100            # 배치 처리 크기
    interval-minutes: 5        # 처리 주기 (분)

  clustering:
    similarity-threshold: 0.6  # Jaccard 유사도 임계값
    window-hours: 72           # 클러스터링 윈도우 (시간)

# ===========================================
# 로깅 설정
# ===========================================
logging:
  level:
    root: INFO
    io.github.krails0105: DEBUG
    org.springframework.web: INFO
    org.hibernate.SQL: DEBUG
```

## 설정 항목별 설명

### 서버 설정

```yaml
server:
  port: 8080    # HTTP 포트 (기본값 8080)
```

### Profile 설정

```yaml
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}
    include: secret
```

- `${변수명:기본값}`: 환경 변수가 있으면 사용, 없으면 기본값
- `include`: 지정한 프로필을 항상 포함 (secret 설정)

### 데이터베이스 설정

```yaml
spring:
  datasource:
    url: jdbc:h2:mem:stockinfo;DB_CLOSE_DELAY=-1;MODE=PostgreSQL
    username: sa
    password:
    driver-class-name: org.h2.Driver
```

- `jdbc:h2:mem:stockinfo`: 인메모리 H2 DB (이름: stockinfo)
- `DB_CLOSE_DELAY=-1`: 애플리케이션 종료 전까지 DB 유지
- `MODE=PostgreSQL`: PostgreSQL 호환 모드 (운영 DB 전환 대비)

### JPA 설정

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: create-drop
```

`ddl-auto` 옵션:

| 옵션 | 동작 | 용도 |
|------|------|------|
| none | 아무것도 안함 | 운영 |
| validate | 스키마 검증만 | 운영 |
| update | 변경분만 적용 | 개발 |
| create | 시작 시 생성 | 테스트 |
| create-drop | 생성 후 종료 시 삭제 | 테스트 |

### 외부 API 설정

```yaml
rest-client:
  kis:
    base-url: https://openapi.koreainvestment.com:9443
    app-key: ${KIS_APP_KEY:}
```

- 민감 정보(API 키)는 **환경 변수**로 주입
- 빈 문자열 기본값으로 개발 환경에서도 시작 가능

### 뉴스 설정

```yaml
news:
  collection:
    enabled: true
    interval-minutes: 15
```

비즈니스 설정을 코드가 아닌 설정 파일에서 관리합니다.

# 환경 변수와 민감 정보

---

## 환경 변수 사용

```yaml
# YAML에서 환경 변수 참조
kis:
  app-key: ${KIS_APP_KEY:}           # 환경 변수
  app-secret: ${KIS_APP_SECRET:}     # 환경 변수
```

설정 방법:

```bash
# 방법 1: 실행 시 지정
KIS_APP_KEY=mykey KIS_APP_SECRET=mysecret ./gradlew bootRun

# 방법 2: .env 파일 (dotenv 사용 시)
# .env 파일 내용
KIS_APP_KEY=mykey
KIS_APP_SECRET=mysecret

# 방법 3: 쉘 설정 (~/.bashrc 또는 ~/.zshrc)
export KIS_APP_KEY=mykey
export KIS_APP_SECRET=mysecret
```

## application-secret.yml

민감 정보를 별도 파일로 분리합니다.

```yaml
# application-secret.yml (Git에서 제외!)
rest-client:
  kis:
    app-key: 실제키값
    app-secret: 실제시크릿값
    account-number: 계좌번호
```

**.gitignore에 추가**:

```
# .gitignore
application-secret.yml
```

**메인 설정에서 include**:

```yaml
# application.yml
spring:
  profiles:
    include: secret    # application-secret.yml 포함
```

# Spring Profile

---

## Profile이란?

환경(개발/테스트/운영)별로 다른 설정을 적용합니다.

```
┌─────────────────┐
│ application.yml │  공통 설정
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│ local │ │ prod  │
│ Mock  │ │ KRX   │
│ H2 DB │ │ Prod  │
└───────┘ └───────┘
```

## Profile 활성화

```bash
# 환경 변수로 활성화
SPRING_PROFILES_ACTIVE=prod ./gradlew bootRun

# 커맨드라인 인자로 활성화
./gradlew bootRun --args='--spring.profiles.active=prod'
```

## Profile별 설정 파일

```yaml
# application-local.yml (개발용)
logging:
  level:
    io.github.krails0105: DEBUG
    org.hibernate.SQL: DEBUG

spring:
  h2:
    console:
      enabled: true

# application-prod.yml (운영용)
logging:
  level:
    root: WARN
    io.github.krails0105: INFO

spring:
  h2:
    console:
      enabled: false
```

## @Profile 어노테이션

Bean을 특정 Profile에서만 활성화합니다.

```java
@Component
@Profile("local")    // local Profile에서만 활성화
public class MockStockDataProvider implements StockDataProvider { }

@Component
@Profile("prod")     // prod Profile에서만 활성화
public class KrxStockDataProvider implements StockDataProvider { }
```

# 설정값을 코드에서 사용

---

## @Value 어노테이션

개별 값을 주입받습니다.

```java
@Service
public class NewsCollectorService {

    @Value("${news.collection.interval-minutes}")
    private int intervalMinutes;

    @Value("${news.clustering.similarity-threshold}")
    private double similarityThreshold;
}
```

## @ConfigurationProperties

관련 설정을 클래스로 묶어서 주입받습니다.

```java
@ConfigurationProperties(prefix = "news.collection")
@Component
@Getter
@Setter
public class NewsCollectionProperties {
    private boolean enabled;
    private int intervalMinutes;
}
```

```java
@Service
@RequiredArgsConstructor
public class NewsCollectorService {

    private final NewsCollectionProperties properties;

    public void collect() {
        if (properties.isEnabled()) {
            // 수집 로직
        }
    }
}
```

장점:
- 타입 안전성
- IDE 자동완성 지원
- 관련 설정을 그룹화

# CORS 설정

---

프론트엔드(다른 도메인)에서 API를 호출하려면 CORS 설정이 필요합니다.

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")           // /api/** 경로에 대해
            .allowedOriginPatterns("*")          // 모든 출처 허용
            .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
            .allowedHeaders("*")
            .allowCredentials(true)
            .maxAge(3600);                       // preflight 캐시 1시간
    }
}
```

## CORS란?

**Cross-Origin Resource Sharing**: 브라우저가 다른 도메인의 리소스를 요청할 때 보안 정책.

```
Frontend (localhost:5173) → Backend (localhost:8080)
                              ↓
                         다른 Origin!
                              ↓
                         CORS 필요
```

# 정리

---

| 개념 | 설명 |
|------|------|
| application.yml | 메인 설정 파일 (YAML 형식) |
| ${변수:기본값} | 환경 변수 참조 |
| Profile | 환경별 설정 (local, prod) |
| @Profile | 특정 환경에서만 Bean 활성화 |
| @Value | 설정값 주입 |
| @ConfigurationProperties | 설정 그룹 주입 |

설정을 코드와 분리하면:
- **재빌드 없이** 설정 변경 가능
- **환경별** 다른 설정 적용
- **민감 정보** 안전하게 관리

다음 글에서는 **JPA Entity와 Repository**에 대해 알아봅니다.

# Reference

---

- [Spring Boot Externalized Configuration](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.external-config)
- [Spring Profiles](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.profiles)
