---
title: "[Brainstorm] Railway 무료 플랜에서 Spring Boot 앱이 계속 죽는 이유"
categories:
  - Brainstorm
tags: [Railway, Spring Boot, HikariCP, JVM, OOM, Actuator, 배포, 디버깅]
date: 2026-04-05
---

## Introduction

---

brainstorm-api를 Railway 무료 플랜에 배포했는데 앱이 계속 죽었다. 처음에는 DB 연결 문제로 의심했지만, 알고 보니 JVM 메모리 초과(OOM)가 진짜 원인이었다.

이 글에서는 Railway 배포 환경에서 Spring Boot 앱이 크래시하는 **세 가지 문제**와 각각의 해결 방법을 정리한다.

1. HikariCP 커넥션 풀 연결 끊김
2. JVM OOM 크래시 (진짜 원인)
3. 헬스체크 미설정으로 자동 복구 불가

**이 글을 읽고 나면** Railway 같은 저사양 클라우드 환경에서 Spring Boot 앱을 안정적으로 운영하기 위한 HikariCP 튜닝, JVM 메모리 제한, Actuator 헬스체크 설정을 직접 적용할 수 있다.

## 사전 준비 (Prerequisites)

---

이 글의 내용을 이해하려면 아래 항목에 대한 기본 지식이 필요하다.

- **Spring Boot 3.x** 프로젝트 생성 및 실행 경험
- **Spring Data JPA** 기본 개념 (DB 연결이 어떻게 동작하는지 대략적으로 이해)
- **Railway** 또는 유사한 PaaS 플랫폼에 앱을 배포해본 경험 (없어도 따라올 수 있다)

| 구분 | 기술 |
|------|------|
| Framework | Spring Boot 3.x, Java 17 |
| DB | PostgreSQL (Railway 제공) |
| 커넥션 풀 | HikariCP (Spring Boot 기본 내장) |
| 모니터링 | Spring Boot Actuator |
| 배포 | Railway (무료 플랜, 메모리 512MB) |

## 배경: Railway 무료 플랜의 제약

---

Railway 무료 플랜은 메모리 상한이 **512MB**다. Spring Boot + JPA + WebSocket 조합은 JVM 기본 설정으로 실행하면 이 한계를 쉽게 초과한다.

또한 Railway는 PostgreSQL에 **직접 접속하지 않고 프록시를 거친다.** 이 프록시는 일정 시간 사용하지 않은 커넥션을 강제로 끊는다.

```
클라이언트 → Spring Boot 앱 → Railway DB Proxy → PostgreSQL
```

이 두 가지 특성(메모리 제한 + DB 프록시)을 모르고 기본 설정으로 배포하면 앱이 예고 없이 죽는다. 아래에서 각 문제를 만난 순서대로 정리한다.

## Issue 1: HikariCP 커넥션 끊김

---

### 증상

Railway 로그에서 아래 메시지가 반복적으로 등장했다.

```
Failed to validate connection... This connection has been closed.
Possibly consider using a shorter maxLifetime value.
```

### 원인

Spring Boot가 사용하는 커넥션 풀 라이브러리인 **HikariCP**는 기본적으로 커넥션을 30분(`maxLifetime=1800000ms`) 동안 유지한다. 하지만 Railway 프록시는 그보다 훨씬 이른 시점에 유휴 커넥션을 끊어버린다.

HikariCP는 이미 끊긴 커넥션을 풀에서 꺼내 쿼리를 실행하려다 실패한다. HikariCP 공식 문서에서도 `maxLifetime`은 "DB나 인프라가 강제하는 연결 시간 제한보다 몇 초 짧게 설정하라"고 권장한다.

> **커넥션 풀이란?** DB 연결(커넥션)을 매번 새로 만들면 느리기 때문에, 미리 여러 개를 만들어두고 재사용하는 구조다. HikariCP는 Spring Boot가 기본으로 사용하는 커넥션 풀 라이브러리다.

### 해결

`application-prod.properties`에 HikariCP 설정을 추가해서 커넥션 수명을 줄이고, 주기적으로 ping을 보내도록 했다.

```properties
# src/main/resources/application-prod.properties

# 커넥션 최대 유지 시간을 10분으로 단축 (기본값: 30분)
# Railway 프록시가 그 전에 끊기 때문에 짧게 설정
spring.datasource.hikari.max-lifetime=600000

# DB에서 커넥션을 얻을 때까지 최대 20초 대기 (기본값: 30초)
spring.datasource.hikari.connection-timeout=20000

# 5분마다 유휴 커넥션에 ping을 보내 연결 유지
spring.datasource.hikari.keepalive-time=300000

# 항상 최소 2개의 커넥션을 미리 유지
spring.datasource.hikari.minimum-idle=2

# Railway 무료 플랜 환경을 고려해 최대 5개로 제한 (기본값: 10)
spring.datasource.hikari.maximum-pool-size=5
```

각 설정값의 의미를 정리하면 다음과 같다.

| 설정 | 기본값 | 변경값 | 변경 이유 |
|------|--------|--------|-----------|
| `max-lifetime` | 1800000ms (30분) | 600000ms (10분) | Railway 프록시 타임아웃보다 짧게 |
| `connection-timeout` | 30000ms (30초) | 20000ms (20초) | 느린 연결을 빨리 감지 |
| `keepalive-time` | 0 (비활성) | 300000ms (5분) | 유휴 커넥션이 프록시에 끊기지 않도록 |
| `minimum-idle` | maximumPoolSize와 동일 | 2 | 메모리 절약 |
| `maximum-pool-size` | 10 | 5 | 무료 플랜 리소스에 맞게 축소 |

### 주의: .properties 파일에 한글 주석 금지

Railway는 `.properties` 파일을 ISO-8859-1 인코딩으로 읽기 때문에, 한글 주석이 있으면 인코딩이 깨져서 앱 시작 자체가 실패한다. 주석은 반드시 영어로 작성해야 한다. (위 예제의 한글 주석은 설명을 위한 것이고, 실제 파일에는 영어 주석만 사용했다.)

## Issue 2: OOM 크래시 (진짜 원인)

---

커넥션 풀 설정을 고쳐도 앱은 계속 죽었다. Railway의 메모리 메트릭을 확인하니 **500MB/500MB에 도달하고 있었다.**

### 증상 분석

HTTP 로그를 보면 패턴이 명확하다.

```
21:45:40  → POST /api/...  200 OK   # 정상 응답
21:45:41  → GET  /api/...  200 OK   # 정상 응답
21:46:12  → GET  /api/...  502      # 갑자기 모든 요청이 502로 전환
21:46:13  → POST /api/...  502
```

앱이 시작하고 약 25~32초 뒤에 모든 응답이 502로 바뀐다. 이 시점에 Railway 대시보드에서 PostgreSQL 서비스도 "Sleeping" 상태로 전환된다.

처음에는 "Postgres가 먼저 죽어서 앱도 죽은 것"이라고 오해했다. 하지만 순서가 반대였다.

```
실제 순서:
JVM 메모리 초과 → 앱 크래시 → DB 연결 없어짐 → Postgres "Sleeping"
(원인)                          (결과)
```

Postgres가 죽은 게 아니라, 앱이 죽으면서 DB 커넥션이 사라졌고 Railway가 Postgres를 유휴 상태로 표시한 것이다.

### 원인

JVM은 기본적으로 사용 가능한 메모리를 자동으로 감지해서 힙 크기를 설정한다. 문제는 컨테이너 환경에서 이 감지가 정확하지 않을 수 있다는 점이다. JVM이 컨테이너의 전체 메모리를 사용할 수 있다고 판단해서 힙을 크게 잡으면, JVM 힙 외에도 메모리를 사용하는 영역(메타스페이스, 스레드 스택, GC 등)까지 합쳐서 512MB를 초과한다.

Spring Boot + JPA + WebSocket 조합은 기동 시에도 상당한 메모리를 소비하기 때문에 512MB 환경에서 금방 한계에 도달한다.

### 해결

`Procfile`에 JVM 메모리 플래그를 직접 지정했다.

```
# Procfile (Railway가 앱을 실행할 때 참조하는 파일)

# -Xmx256m  : JVM 힙 최대 크기를 256MB로 제한
# -Xms128m  : JVM 힙 초기 크기를 128MB로 설정
# -XX:+UseSerialGC : 메모리 오버헤드가 낮은 GC 방식 선택 (단일 CPU 환경에 적합)
web: java -Xmx256m -Xms128m -XX:+UseSerialGC -jar build/libs/brainstorm-api-0.0.1-SNAPSHOT.jar
```

각 플래그를 설명하면 다음과 같다.

| JVM 플래그 | 의미 | 설정 이유 |
|------------|------|-----------|
| `-Xmx256m` | 힙 최대 크기 256MB | 힙 + 비힙 영역 합쳐서 512MB 이내로 유지 |
| `-Xms128m` | 힙 초기 크기 128MB | 시작 시 메모리를 점진적으로 확보 (급격한 할당 방지) |
| `-XX:+UseSerialGC` | Serial GC 사용 | GC 스레드를 1개만 사용해서 메모리 오버헤드 최소화 |

`-XX:+UseSerialGC`는 GC 스레드를 하나만 사용해서 메모리 오버헤드를 최소화한다. G1GC(JDK 17 기본)는 여러 스레드로 병렬 처리해서 처리량이 높지만, 그만큼 메모리를 더 사용한다. 트래픽이 적은 개인 프로젝트에서는 Serial GC로도 처리량 손실이 거의 없다.

> **왜 256MB이고 512MB가 아닌가?** JVM은 힙 메모리 외에도 메타스페이스, 코드 캐시, 스레드 스택 등을 위한 메모리가 별도로 필요하다. 힙을 512MB로 잡으면 이 비힙 영역까지 합쳐서 512MB를 초과해 다시 OOM이 발생한다. 절반 정도인 256MB가 안전한 선이다.

## Issue 3: 헬스체크 미설정

---

OOM 크래시가 발생해도 Railway가 자동으로 재시작하려면 **헬스체크 엔드포인트**가 필요하다. 헬스체크가 없으면 Railway는 앱이 죽었는지조차 알 수 없다.

> **헬스체크란?** "너 살아있어?"를 주기적으로 물어보는 것이다. Railway가 특정 URL을 호출했을 때 200 OK가 돌아오면 "살아있음", 응답이 없으면 "죽었으니 재시작" 하는 구조다.

### Spring Boot Actuator 추가

Spring Boot Actuator는 앱의 상태를 확인할 수 있는 엔드포인트(`/actuator/health` 등)를 자동으로 만들어주는 모듈이다.

```groovy
// build.gradle
// Actuator: /actuator/health 등 앱 상태 확인 엔드포인트를 자동으로 만들어준다
implementation 'org.springframework.boot:spring-boot-starter-actuator'
```

### 프로덕션에서는 health 엔드포인트만 노출

Actuator는 다양한 엔드포인트(`/actuator/env`, `/actuator/beans` 등)를 제공하지만, 프로덕션에서는 필요한 것만 열어야 한다. Spring Boot의 기본 설정에서도 HTTP로는 `health` 엔드포인트만 노출되지만, 명시적으로 선언해두면 의도가 더 분명하다.

```properties
# src/main/resources/application-prod.properties

# health 엔드포인트만 외부에 공개 (나머지 숨김)
management.endpoints.web.exposure.include=health

# 헬스 세부 정보는 숨김 (DB 연결 상태 등 민감 정보 노출 방지)
# 옵션: never / when-authorized / always
management.endpoint.health.show-details=never
```

`show-details=never`로 설정하면 `/actuator/health` 응답이 `{"status":"UP"}` 한 줄로만 나온다. DB 연결 정보, 디스크 용량 같은 내부 세부사항이 외부에 노출되지 않는다.

### SecurityConfig에서 헬스체크 경로 허용

Spring Security가 있으면 `/actuator/health`에도 인증이 필요하다. Railway가 인증 없이 헬스체크를 호출할 수 있도록 명시적으로 허용해야 한다.

```java
// src/main/java/.../config/SecurityConfig.java

.requestMatchers("/actuator/health").permitAll()
// Railway가 인증 없이 헬스체크를 호출할 수 있도록 허용
```

### Railway 설정

Railway 대시보드 → 서비스 → Settings → Healthcheck Path에 `/actuator/health`를 입력한다.
이후 Railway는 주기적으로 이 엔드포인트를 호출하고, 응답이 없으면 앱을 자동으로 재시작한다.

## 디버깅 핵심: 메트릭을 먼저 봐라

---

이번 디버깅에서 가장 중요한 교훈은 **로그보다 메트릭을 먼저 확인해야 한다**는 것이다.

로그만 보면 DB 커넥션 오류가 눈에 띄기 때문에 "DB 문제다"라고 오해하기 쉽다. 하지만 메모리 차트를 보면 OOM이 원인임을 즉시 알 수 있다.

```
잘못된 디버깅 순서:
로그에서 DB 오류 발견 → DB 설정 수정 → 여전히 죽음 → 혼란

올바른 디버깅 순서:
메트릭(CPU/메모리) 확인 → 메모리 100% → JVM 플래그 추가 → 해결
```

Railway 대시보드의 Metrics 탭에서 Memory 그래프를 보면 앱 크래시 직전에 메모리가 한계치에 도달하는 패턴이 명확하게 보인다. 앱이 원인 불명으로 죽을 때는 "무슨 에러가 났는지"보다 "메모리와 CPU가 어떤 상태인지"를 먼저 확인하자.

## 자주 하는 실수와 주의사항

---

이번 디버깅 과정에서 겪었거나, 비슷한 상황에서 빠지기 쉬운 함정들을 정리한다.

| 실수 | 결과 | 해결 |
|------|------|------|
| `.properties` 파일에 한글 주석 작성 | 인코딩 깨짐으로 앱 시작 실패 | 주석을 영어로 작성 |
| `Xmx`를 컨테이너 메모리와 같게 설정 (예: `-Xmx512m`) | 비힙 영역 때문에 결국 OOM | 컨테이너 메모리의 50~60% 수준으로 설정 |
| DB 로그 오류만 보고 DB 문제로 단정 | 진짜 원인(OOM)을 놓침 | 메트릭(메모리/CPU)을 먼저 확인 |
| Actuator 추가 후 SecurityConfig 미수정 | 헬스체크 요청이 401/403으로 차단 | `permitAll()` 명시적 허용 |
| `keepalive-time` 미설정 | 유휴 커넥션이 프록시에 의해 끊김 | `max-lifetime`보다 짧은 간격으로 설정 |

## 정리

---

| 문제 | 원인 | 해결책 |
|------|------|--------|
| DB 커넥션 끊김 | HikariCP `maxLifetime`(기본 30분) > Railway 프록시 타임아웃 | `max-lifetime=600000`, `keepalive-time=300000` |
| OOM 크래시 | JVM이 메모리를 자동으로 과할당 | `Procfile`에 `-Xmx256m -Xms128m -XX:+UseSerialGC` |
| 자동 복구 불가 | 헬스체크 엔드포인트 없음 | Actuator 추가 후 Railway에서 경로 설정 |

Railway 무료 플랜처럼 메모리 제약이 있는 환경에서는 JVM 메모리 설정을 반드시 명시적으로 지정해야 한다. Spring Boot + JPA 조합은 기본 설정으로 실행하면 512MB를 가볍게 초과한다.

핵심 교훈 세 가지:
1. **메트릭 먼저** -- 앱이 죽으면 로그보다 메모리/CPU 차트를 먼저 본다.
2. **JVM 메모리는 명시적으로** -- 컨테이너 환경에서는 `-Xmx`를 반드시 지정한다.
3. **헬스체크는 배포 필수** -- 앱이 죽어도 자동 복구되려면 헬스체크 엔드포인트가 있어야 한다.

## Reference

---

- [HikariCP 공식 문서 - Configuration](https://github.com/brettwooldridge/HikariCP#gear-configuration-knobs-baby)
- [Spring Boot Actuator 공식 문서 - Endpoints](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
- [JVM Memory Settings 가이드 (Oracle)](https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html)
- `brainstorm-api/Procfile`
- `brainstorm-api/src/main/resources/application-prod.properties`
- `brainstorm-api/src/main/java/.../config/SecurityConfig.java`
- `brainstorm-api/build.gradle`
