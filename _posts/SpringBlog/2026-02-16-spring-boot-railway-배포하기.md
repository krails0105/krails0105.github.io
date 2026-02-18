---
layout: single
title: "[SpringBlog] Spring Boot 애플리케이션 Railway에 배포하기 - H2에서 PostgreSQL로 전환, 프로필 분리, PaaS 배포"
categories:
  - SpringBlog
tags:
  - [Spring Boot, Railway, PostgreSQL, H2, Profile, Deploy, PaaS, Nixpacks, Procfile]
---

# Introduction

---

지금까지 로컬 환경에서 Spring Blog 프로젝트를 개발했습니다. 하지만 실제로 다른 사람들이 사용할 수 있도록 하려면 **인터넷에서 접근 가능한 서버에 배포**해야 합니다.

이번 Phase 7에서는 Spring Blog 프로젝트를 **Railway라는 PaaS(Platform as a Service)에 배포**했습니다.

이 글에서 다루는 내용:
- H2 인메모리 DB에서 PostgreSQL로 전환하는 이유
- Spring Boot Profile(dev/prod)로 환경 분리하는 방법
- Railway 배포 과정과 환경 설정
- PaaS 배포 중 만난 에러와 해결 방법
- Jenkins vs PaaS, Procfile의 역할 등 배포 관련 개념 정리

# 배경 (Problem & Context)

---

## 왜 H2를 그대로 배포할 수 없나?

개발 중에는 H2 인메모리 DB를 사용했습니다. 하지만 H2를 운영 환경에 그대로 배포하면 다음과 같은 문제가 발생합니다.

| 문제 | 설명 | 예시 |
|---|---|---|
| 데이터 휘발성 | 애플리케이션을 재시작하면 모든 데이터가 사라짐 | 서버 재배포 시 작성한 모든 게시글 삭제 |
| 영속성 부족 | 메모리에만 저장되므로 데이터가 디스크에 저장되지 않음 | 서버 크래시 시 복구 불가능 |
| 동시 접속 제한 | 인메모리 DB는 대규모 트래픽 처리에 적합하지 않음 | 여러 사용자 동시 접속 시 성능 저하 |

**H2는 개발 편의를 위한 도구**입니다. 설정이 간단하고 DB 설치 없이 사용할 수 있어 로컬 개발에는 최적이지만, 운영 환경에서는 **데이터를 영구 보관할 수 있는 DB**가 필요합니다.

## 개발 환경 vs 운영 환경

소프트웨어를 배포할 때는 **환경을 분리**하는 것이 일반적입니다.

| 환경 | 특징 | 목적 | DB |
|---|---|---|---|
| 개발(Development) | 로컬 PC에서 실행 | 기능 개발 및 테스트 | H2 (인메모리) |
| 운영(Production) | 실제 서버에서 실행 | 실제 사용자에게 서비스 제공 | PostgreSQL, MySQL 등 |

두 환경의 요구사항이 다르므로, **환경별로 설정을 다르게 구성**해야 합니다.

### 개발 환경에서 원하는 것
- 빠른 재시작 (DB 초기화 포함)
- SQL 쿼리 로그 출력 (학습 목적)
- H2 웹 콘솔 접근
- 매번 테이블 재생성 (`ddl-auto=create`)

### 운영 환경에서 원하는 것
- 데이터 영속성 (재시작 시에도 데이터 보존)
- SQL 로그 비활성화 (성능 + 보안)
- H2 콘솔 비활성화 (보안)
- 기존 테이블 유지 (`ddl-auto=update`)

## Spring Boot Profile이란?

Spring Boot는 **Profile** 기능을 통해 환경별로 다른 설정을 적용할 수 있습니다.

**Profile의 개념**:
- 하나의 애플리케이션에서 **환경별로 설정을 나누는 메커니즘**
- `application-{profile}.properties` 파일로 각 환경의 설정을 관리
- `spring.profiles.active` 속성으로 활성화할 프로필을 선택

**파일 구조**:
```
src/main/resources/
  application.properties          # 공통 설정
  application-dev.properties      # 개발 환경 설정
  application-prod.properties     # 운영 환경 설정
```

**동작 방식**:
```properties
# application.properties
spring.profiles.active=dev  # dev 프로필 활성화
```

위 설정을 하면 Spring Boot는 다음 순서로 설정을 읽습니다:
1. `application.properties` (공통 설정)
2. `application-dev.properties` (dev 프로필 설정, 공통 설정을 덮어씀)

운영 환경에서는 `spring.profiles.active=prod`로 변경하여 `application-prod.properties`를 사용합니다.

## H2 vs PostgreSQL 비교

| | H2 | PostgreSQL |
|---|---|---|
| 타입 | 인메모리/파일 DB (Embedded) | 독립 서버 기반 DB |
| 데이터 저장 | 메모리 (또는 로컬 파일) | 디스크 (영구 저장) |
| 재시작 시 데이터 | 사라짐 (인메모리 모드) | 유지됨 |
| 설치 | 불필요 (라이브러리만 추가) | 별도 서버 설치 필요 |
| 성능 | 개발용으로 충분 | 대규모 트래픽 처리 가능 |
| 용도 | 로컬 개발, 테스트 | 운영 환경 |
| Spring Boot 설정 | 별도 설정 거의 없음 | URL, 드라이버, 계정 정보 필요 |

## Railway vs Render vs AWS

PaaS(Platform as a Service)는 인프라 관리 없이 애플리케이션을 배포할 수 있는 서비스입니다.

| | Railway | Render | AWS (EC2 + RDS) |
|---|---|---|---|
| 난이도 | 쉬움 | 쉬움 | 어려움 (설정 복잡) |
| 무료 플랜 | $5 크레딧/월 | 750시간/월 (슬립 정책 있음) | 12개월 프리티어 |
| DB 제공 | PostgreSQL 포함 | PostgreSQL 별도 (슬립 주의) | RDS 별도 구성 필요 |
| 카드 등록 | 필수 | 불필요 (무료) | 필수 |
| 슬립 정책 | 없음 | 15분 미사용 시 슬립 | 없음 (항상 실행) |
| 자동 빌드 | Nixpacks (자동 감지) | 자동 | 수동 (CI/CD 구성 필요) |
| 실무 사용 빈도 | 낮음 (사이드 프로젝트) | 낮음 | 매우 높음 |

### Jenkins vs PaaS의 역할 차이

많은 초보자가 "Jenkins vs Railway" 같은 비교를 하는데, 두 도구는 **역할이 다릅니다**.

| | Jenkins | Railway/Render |
|---|---|---|
| 역할 | **CI/CD 도구** (빌드/테스트/배포 자동화) | **호스팅 플랫폼** (서버 제공) |
| 주요 기능 | Git 푸시 → 테스트 → 빌드 → 배포 자동화 | 코드 → 빌드 → 실행 |
| 서버 제공 여부 | X (배포 대상 서버가 별도로 필요) | O (서버 호스팅 포함) |
| 실무 조합 예시 | Jenkins + AWS EC2 | Railway 단독 사용 가능 |

**실무 배포 환경 예시**:
- **대규모 서비스**: GitHub → Jenkins (빌드/테스트) → AWS EC2 (배포)
- **사이드 프로젝트**: GitHub → Railway (빌드 + 배포 + 호스팅 통합)

### 실무에서 가장 보편적인 조합

| 역할 | 도구 |
|---|---|
| 코드 저장소 | GitHub/GitLab |
| CI/CD | Jenkins / GitHub Actions |
| 서버 | AWS EC2 |
| DB | AWS RDS (PostgreSQL/MySQL) |
| 로드 밸런서 | AWS ELB |
| CDN | AWS CloudFront |

Railway/Render는 **학습 및 소규모 프로젝트에 적합**합니다. 실무에서는 AWS 같은 클라우드 플랫폼이 주로 사용됩니다.

# 접근 방법 (Approach)

---

## 1. DB 전환: H2 → PostgreSQL

개발 환경에서는 H2를, 운영 환경에서는 PostgreSQL을 사용하도록 설정을 분리합니다.

**방법**:
- `build.gradle`에 PostgreSQL 의존성 추가
- `application-dev.properties`에서 H2 설정 유지
- `application-prod.properties`에서 PostgreSQL 설정 추가

## 2. 프로필 분리: dev / prod

Spring Boot Profile을 사용하여 환경별 설정을 분리합니다.

**파일 구성**:
- `application.properties`: 공통 설정 (앱 이름, 기본 프로필)
- `application-dev.properties`: 개발 환경 설정 (H2)
- `application-prod.properties`: 운영 환경 설정 (PostgreSQL)

**프로필 활성화**:
- 로컬: `spring.profiles.active=dev` (기본값)
- Railway: 환경변수 `SPRING_PROFILES_ACTIVE=prod`

## 3. Railway 배포 설정

Railway는 **Nixpacks**라는 빌드팩을 사용하여 코드를 자동으로 분석하고 빌드합니다.

### Nixpacks란?

Nixpacks는 Railway의 자동 빌드 도구입니다.

**동작 방식**:
1. 코드 저장소를 분석하여 언어/프레임워크 감지 (예: `build.gradle` → Java/Gradle)
2. 적합한 빌드 환경 구성 (JDK 설치, Gradle 실행)
3. 빌드 명령어 실행 (`./gradlew build`)
4. 실행 방법 감지 (jar 파일 실행)

**Nixpacks가 자동으로 처리하는 것**:
- JDK 설치
- Gradle 빌드 실행
- 빌드된 jar 파일 감지

**Nixpacks가 처리하지 못하는 것**:
- jar 파일 실행 방법 명시 (→ `Procfile`로 해결)

### Procfile이란?

`Procfile`은 **PaaS에서 애플리케이션을 어떻게 실행할지 지정하는 파일**입니다.

**역사적 배경**:
- Heroku라는 PaaS가 처음 도입한 표준
- Railway, Render 등 다른 PaaS도 이 표준을 따름

**형식**:
```
<프로세스 타입>: <실행 명령어>
```

**예시**:
```
web: java -jar build/libs/blog-0.0.1-SNAPSHOT.jar
```

- `web`: 웹 서버 프로세스를 의미 (HTTP 요청을 받는 프로세스)
- `java -jar ...`: 빌드된 jar 파일을 실행하는 명령어

### java -jar 명령어란?

`java -jar` 명령어는 **빌드된 jar 파일을 실행**하는 명령어입니다.

| 명령어 | 역할 | 실행 시점 |
|---|---|---|
| `./gradlew build` | 소스 코드를 컴파일하고 jar 파일 생성 | 빌드 시 (Railway가 자동 실행) |
| `java -jar xxx.jar` | 생성된 jar 파일을 실행하여 애플리케이션 시작 | 실행 시 (Procfile로 명시) |

**Spring Boot의 jar 구조**:
- Spring Boot는 "executable jar"를 생성합니다.
- 이 jar 파일에는 애플리케이션 코드 + 의존성 라이브러리 + 내장 Tomcat이 모두 포함되어 있습니다.
- `java -jar`로 실행하면 내장 Tomcat이 시작되며 웹 서버가 동작합니다.

## 4. 환경변수로 DB 정보 주입

운영 환경에서는 DB URL, 비밀번호 등 민감한 정보를 **환경변수**로 주입합니다.

**이유**:
- **보안**: DB 비밀번호를 코드에 직접 작성하면 Git에 노출됨
- **유연성**: 환경마다 다른 DB를 사용할 수 있음 (테스트용 DB, 운영용 DB 분리)
- **표준**: 12-Factor App 원칙에 따름

**방법**:
```properties
# application-prod.properties
spring.datasource.url=${DATABASE_URL}
```

`${DATABASE_URL}`은 Railway 환경변수에서 값을 가져옵니다. Railway는 PostgreSQL을 생성하면 자동으로 `DATABASE_URL` 환경변수를 제공합니다.

## 5. ddl-auto 전략 변경

| 환경 | 설정 | 동작 | 이유 |
|---|---|---|---|
| 개발 | `ddl-auto=create` | 매번 테이블을 삭제하고 재생성 | 스키마 변경이 잦으므로 깔끔하게 재생성 |
| 운영 | `ddl-auto=update` | 기존 테이블을 유지하며 변경사항만 반영 | 데이터 손실 방지 |

**주의**: `ddl-auto=update`는 컬럼 추가는 가능하지만, 컬럼 삭제나 타입 변경은 처리하지 못합니다. 실무에서는 Flyway, Liquibase 같은 마이그레이션 도구를 사용합니다.

# 구현 (Key Code & Commands)

---

## 1. build.gradle에 PostgreSQL 의존성 추가

```gradle
// spring-blog/build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    implementation 'org.springframework.boot:spring-boot-starter-thymeleaf'
    implementation 'nz.net.ultraq.thymeleaf:thymeleaf-layout-dialect'
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'com.vladsch.flexmark:flexmark-all:0.64.8'
    compileOnly 'org.projectlombok:lombok'

    // 운영 환경용 PostgreSQL 드라이버 추가
    // runtimeOnly -> 컴파일 시에는 불필요하고, 실행 시에만 필요함
    runtimeOnly 'org.postgresql:postgresql'

    // 개발 환경용 H2 DB 유지
    runtimeOnly 'com.h2database:h2'

    annotationProcessor 'org.projectlombok:lombok'
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
    testRuntimeOnly 'org.junit.platform:junit-platform-launcher'
}
```

**핵심 포인트**:
- `runtimeOnly`: 런타임에만 필요한 의존성 (컴파일 시에는 사용하지 않음)
- PostgreSQL과 H2를 동시에 포함 가능 (프로필에 따라 선택적으로 사용됨)

### PostgreSQL dependency의 group ID

처음에는 `com.postgresql:postgresql`로 추가했으나 다음 에러가 발생했습니다:

```
Could not find com.postgresql:postgresql:.
```

**원인**: PostgreSQL JDBC 드라이버의 올바른 group ID는 `org.postgresql`입니다.

| | 공식 group ID |
|---|---|
| PostgreSQL JDBC | `org.postgresql:postgresql` |

Spring Boot BOM(Bill of Materials)에서 관리하는 의존성은 버전을 명시하지 않아도 자동으로 호환되는 버전을 사용합니다.

## 2. 프로필별 설정 파일 구성

### application.properties (공통 설정)

```properties
# spring-blog/src/main/resources/application.properties

# 애플리케이션 이름 (Spring Boot가 내부적으로 사용)
spring.application.name=blog

# 활성화할 프로필 선택
# dev -> application-dev.properties를 로드
# prod -> application-prod.properties를 로드
spring.profiles.active=dev
```

### application-dev.properties (개발 환경)

```properties
# spring-blog/src/main/resources/application-dev.properties

# H2 in-memory DB
# jdbc:h2:mem:blogdb -> create DB named 'blogdb' in memory (data lost on app restart)
spring.datasource.url=jdbc:h2:mem:blogdb
spring.datasource.driver-class-name=org.h2.Driver
spring.datasource.username=sa
spring.datasource.password=

# H2 web console (browse DB at localhost:8080/h2-console)
spring.h2.console.enabled=true

# JPA
# ddl-auto=create -> auto-create tables from entity classes (resets on every restart)
spring.jpa.hibernate.ddl-auto=create
# show-sql=true -> print SQL queries to console (for learning/debugging)
spring.jpa.show-sql=true
```

**핵심 포인트**:
- `jdbc:h2:mem:blogdb`: 메모리에 `blogdb`라는 이름의 DB 생성
- `ddl-auto=create`: 애플리케이션 시작 시 테이블을 매번 새로 생성
- `show-sql=true`: SQL 쿼리를 콘솔에 출력 (학습 목적)

### application-prod.properties (운영 환경)

```properties
# spring-blog/src/main/resources/application-prod.properties

# PostgreSQL DB URL을 환경변수에서 가져옴
# Railway는 DATABASE_URL 환경변수를 자동으로 제공
spring.datasource.url=${DATABASE_URL}
spring.datasource.driver-class-name=org.postgresql.Driver

# 운영 환경에서는 H2 콘솔 비활성화 (보안)
spring.h2.console.enabled=false

# ddl-auto=update -> 기존 테이블을 유지하며 변경사항만 반영 (데이터 보존)
spring.jpa.hibernate.ddl-auto=update

# SQL 쿼리 출력 비활성화 (성능 + 보안)
spring.jpa.show-sql=false
```

**핵심 포인트**:
- `${DATABASE_URL}`: 환경변수에서 값을 가져옴 (Railway가 자동 제공)
- `ddl-auto=update`: 기존 데이터를 유지하며 스키마 변경사항만 반영
- `show-sql=false`: 운영 환경에서는 SQL 로그를 출력하지 않음

## 3. Procfile 작성

```
web: java -jar build/libs/blog-0.0.1-SNAPSHOT.jar
```

**파일 위치**: 프로젝트 루트 (`spring-blog/Procfile`)

**설명**:
- `web`: HTTP 요청을 받는 웹 프로세스 타입
- `java -jar`: jar 파일을 실행하는 명령어
- `build/libs/blog-0.0.1-SNAPSHOT.jar`: Gradle이 생성한 jar 파일 경로

Railway는 이 파일을 읽고 빌드 완료 후 지정된 명령어로 애플리케이션을 실행합니다.

## 4. Railway 배포 과정

### 4.1. Railway 프로젝트 생성

1. Railway 웹사이트 (railway.app)에서 GitHub 로그인
2. "New Project" → "Deploy from GitHub repo" 선택
3. Spring Blog 저장소 선택

### 4.2. PostgreSQL 서비스 추가

1. Railway 대시보드에서 "New" → "Database" → "Add PostgreSQL" 선택
2. Railway가 자동으로 PostgreSQL 인스턴스 생성
3. `DATABASE_URL` 환경변수가 자동으로 생성됨

### 4.3. 환경변수 설정

Railway 대시보드 → Variables 탭에서 다음 환경변수 추가:

| 변수명 | 값 | 설명 |
|--------|-----|------|
| `SPRING_PROFILES_ACTIVE` | `prod` | 프로필을 prod로 전환 |
| `DATABASE_URL` | (자동 생성됨) | PostgreSQL 접속 URL |
| `PORT` | `8080` | 애플리케이션이 리스닝할 포트 |

**DATABASE_URL 형식**:
```
jdbc:postgresql://host:port/database?user=username&password=password
```

Railway가 자동으로 이 형식에 맞춰 URL을 생성합니다.

### 4.4. 네트워크 설정

Railway는 기본적으로 외부 접근을 허용하지 않습니다. 다음 설정이 필요합니다:

1. **PORT 환경변수 추가**: Railway는 `PORT` 환경변수를 통해 애플리케이션 포트를 인식합니다.
2. **Generate Domain**: Settings → Networking → Generate Domain 버튼 클릭

이렇게 하면 `https://your-app.up.railway.app` 형태의 공개 URL이 생성됩니다.

### 4.5. 배포 확인

1. Railway 대시보드에서 "Deployments" 탭 확인
2. 빌드 로그에서 에러 확인
3. 생성된 도메인으로 접속하여 애플리케이션 동작 확인

# 주의할 점 (Gotchas)

---

## 1. PostgreSQL dependency group ID 혼동

**에러 메시지**:
```
Could not find com.postgresql:postgresql:.
```

**원인**: PostgreSQL JDBC 드라이버의 group ID를 잘못 입력했습니다.

| 잘못된 ID | 올바른 ID |
|---|---|
| `com.postgresql:postgresql` | `org.postgresql:postgresql` |

**해결**: `build.gradle`에서 `runtimeOnly 'org.postgresql:postgresql'`로 수정합니다.

## 2. Procfile 없이 배포 시 실행 실패

**에러 메시지**:
```
ls: cannot access '*/build/libs/*jar': No such file or directory
```

**원인**: Nixpacks가 jar 파일을 찾았지만 실행 방법을 몰라서 발생합니다.

**해결**: 프로젝트 루트에 `Procfile`을 추가하여 실행 명령어를 명시합니다.

```
web: java -jar build/libs/blog-0.0.1-SNAPSHOT.jar
```

## 3. 네트워크 설정 누락

**에러 메시지**:
```
Error configuring network
Unexposed service
```

**원인**: Railway는 기본적으로 서비스를 외부에 노출하지 않습니다.

**해결**:
1. `PORT` 환경변수 추가 (값: `8080`)
2. Settings → Networking → "Generate Domain" 클릭

## 4. 프로필 전환 누락

운영 환경에서 `spring.profiles.active=dev`로 실행하면 H2 DB를 사용하려 하므로 데이터가 저장되지 않습니다.

**해결**: Railway 환경변수에 `SPRING_PROFILES_ACTIVE=prod`를 반드시 추가합니다.

## 5. ddl-auto=create를 운영에서 사용하는 실수

`ddl-auto=create`를 운영 환경에서 사용하면 애플리케이션을 재시작할 때마다 모든 데이터가 삭제됩니다.

| 환경 | 올바른 설정 |
|---|---|
| 개발 | `ddl-auto=create` |
| 운영 | `ddl-auto=update` 또는 `none` |

## 6. Railway의 sleep 정책

Railway 무료 플랜($5 크레딧)에는 슬립 정책이 없습니다. 하지만 크레딧을 모두 소진하면 서비스가 중지됩니다.

| PaaS | 슬립 정책 | 무료 플랜 조건 |
|---|---|---|
| Railway | 없음 | $5 크레딧/월, 카드 등록 필수 |
| Render | 15분 미사용 시 슬립 | 750시간/월, 카드 등록 불필요 |

## 7. jar 파일 이름 불일치

`Procfile`에 명시한 jar 파일 이름이 실제 빌드된 파일 이름과 다르면 실행에 실패합니다.

**확인 방법**:
```bash
./gradlew build
ls build/libs/
```

`build.gradle`의 `version`을 변경하면 jar 파일 이름도 바뀌므로, `Procfile`도 함께 수정해야 합니다.

## 8. 환경변수 형식 주의

`DATABASE_URL`은 `jdbc:postgresql://...` 형태여야 합니다. Railway가 제공하는 URL이 `postgres://` 형태라면 `jdbc:postgresql://`로 변환해야 합니다.

**변환 예시**:
```
# Railway가 제공한 URL
postgres://user:pass@host:5432/db

# Spring Boot용 JDBC URL
jdbc:postgresql://host:5432/db?user=user&password=pass
```

Railway는 일반적으로 JDBC 형식의 URL을 제공하므로 수동 변환이 불필요합니다. 하지만 다른 PaaS를 사용할 경우 이 점을 주의해야 합니다.

# 다음 단계 (Next Steps)

---

## 기능 확장

1. **Custom Domain 연결**:
   - Railway의 기본 도메인 대신 개인 도메인 연결
   - `blog.your-domain.com` 형태로 접근

2. **HTTPS 설정**:
   - Railway는 자동으로 HTTPS를 제공하지만, Custom Domain 사용 시 Let's Encrypt 인증서 설정 필요

3. **CI/CD 파이프라인 추가**:
   - GitHub Actions로 테스트 자동화
   - main 브랜치에 푸시 시 자동 배포

4. **로그 모니터링**:
   - Railway 대시보드에서 실시간 로그 확인
   - 에러 발생 시 알림 설정

## 성능 최적화

1. **DB 마이그레이션 도구 도입**:
   - Flyway 또는 Liquibase 사용
   - `ddl-auto=update` 대신 안전한 마이그레이션 스크립트 관리

2. **Connection Pool 설정**:
   - HikariCP 설정 튜닝 (기본값으로 충분하지만 트래픽 증가 시 조정 필요)

3. **캐싱 추가**:
   - Redis 연동으로 자주 조회되는 데이터 캐싱

4. **이미지 호스팅 분리**:
   - 이미지를 AWS S3나 Cloudinary에 업로드
   - 애플리케이션 서버의 부하 감소

## 실무 학습 확장

1. **AWS로 배포 경험**:
   - EC2 + RDS로 직접 배포
   - 로드 밸런서, 오토 스케일링 학습

2. **Docker 컨테이너화**:
   - Dockerfile 작성
   - Docker Compose로 로컬 환경 구성

3. **Kubernetes 배포**:
   - Spring Boot 앱을 K8s로 배포
   - 실무 수준의 오케스트레이션 경험

# Reference

---

- **구현 코드**:
  - [build.gradle](https://github.com/krails0105/spring-blog/blob/main/build.gradle)
  - [application.properties](https://github.com/krails0105/spring-blog/blob/main/src/main/resources/application.properties)
  - [application-dev.properties](https://github.com/krails0105/spring-blog/blob/main/src/main/resources/application-dev.properties)
  - [application-prod.properties](https://github.com/krails0105/spring-blog/blob/main/src/main/resources/application-prod.properties)
  - [Procfile](https://github.com/krails0105/spring-blog/blob/main/Procfile)

- **외부 자료**:
  - [Spring Boot Profiles](https://docs.spring.io/spring-boot/reference/features/profiles.html)
  - [Railway Documentation](https://docs.railway.app/)
  - [Nixpacks](https://nixpacks.com/)
  - [Procfile Specification](https://devcenter.heroku.com/articles/procfile)
  - [Spring Boot External Config](https://docs.spring.io/spring-boot/reference/features/external-config.html)
