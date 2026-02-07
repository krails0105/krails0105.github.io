---
title: "[Spring] WebFlux 입문 - 리액티브 프로그래밍과 Mono/Flux"
categories:
  - Spring
tags:
  - [Spring, WebFlux, Reactive, Mono, Flux, WebClient]
---

# Introduction

---

Spring MVC는 **요청 하나당 스레드 하나**를 할당하는 모델입니다. 동시 요청이 많아지면 스레드가 부족해지고, I/O 대기 중에도 스레드가 점유되어 리소스가 낭비됩니다. **Spring WebFlux**는 **Non-blocking I/O** 기반의 리액티브 프로그래밍 모델로, 적은 스레드로 많은 동시 요청을 처리할 수 있습니다.

이 글은 WebFlux의 핵심 개념인 Mono/Flux, 컨트롤러 작성법, 그리고 WebClient 사용법을 정리합니다.

# 1. MVC vs WebFlux

---

## Spring MVC (Blocking)

```text
요청 1 → Thread 1 → DB 쿼리 (대기...) → 응답
요청 2 → Thread 2 → API 호출 (대기...) → 응답
요청 3 → Thread 3 → 파일 읽기 (대기...) → 응답

→ 동시 요청 1000개면 스레드 1000개 필요
→ I/O 대기 중에도 스레드 점유 (낭비)
```

## Spring WebFlux (Non-blocking)

```text
요청 1 → Event Loop → DB 쿼리 시작 → (스레드 반환)
요청 2 → Event Loop → API 호출 시작 → (스레드 반환)
요청 3 → Event Loop → 파일 읽기 시작 → (스레드 반환)
... (다른 요청 처리)
DB 완료 콜백 → Event Loop → 응답 1 반환

→ 적은 스레드 (CPU 코어 수)로 수천 요청 처리
→ I/O 대기 중 다른 요청 처리 가능
```

## 비교

| 항목 | Spring MVC | Spring WebFlux |
|------|-----------|----------------|
| **모델** | Thread-per-request | Event Loop |
| **I/O** | Blocking | Non-blocking |
| **스레드 사용** | 많음 (요청당 1개) | 적음 (코어 수) |
| **적합한 상황** | CPU 집약적 작업 | I/O 집약적 작업 |
| **러닝 커브** | 낮음 | 높음 |
| **서버** | Tomcat (기본) | Netty (기본) |

# 2. Mono와 Flux

---

## Project Reactor

WebFlux는 **Project Reactor** 라이브러리를 기반으로 합니다. Mono와 Flux는 Reactor의 핵심 타입입니다.

```text
Mono<T>: 0 또는 1개의 요소를 비동기적으로 반환
Flux<T>: 0개 이상의 요소를 비동기적으로 반환 (스트림)
```

## Mono - 단일 값

```java
// 값이 있는 Mono
Mono<String> mono = Mono.just("Hello");

// 빈 Mono
Mono<String> empty = Mono.empty();

// 에러 Mono
Mono<String> error = Mono.error(new RuntimeException("오류 발생"));

// 비동기 작업
Mono<User> user = Mono.fromSupplier(() -> findUserById(1L));
```

## Flux - 여러 값 (스트림)

```java
// 여러 값
Flux<String> flux = Flux.just("A", "B", "C");

// 컬렉션에서
Flux<Integer> fromList = Flux.fromIterable(List.of(1, 2, 3));

// 범위
Flux<Integer> range = Flux.range(1, 10);  // 1~10

// 무한 스트림
Flux<Long> interval = Flux.interval(Duration.ofSeconds(1));  // 매초 0, 1, 2...
```

## 구독 (Subscribe)

Mono/Flux는 **구독(subscribe)**하기 전까지 실행되지 않습니다. 마치 작성된 레시피와 같아서, 요리사(구독자)가 있어야 실제로 요리가 시작됩니다.

```java
Mono<String> mono = Mono.just("Hello")
    .map(s -> s + " World");

// 아직 아무 일도 안 일어남

mono.subscribe(result -> System.out.println(result));  // "Hello World" 출력
```

# 3. 연산자

---

## 변환

```java
Mono<String> upper = Mono.just("hello")
    .map(String::toUpperCase);  // "HELLO"

Flux<Integer> doubled = Flux.just(1, 2, 3)
    .map(n -> n * 2);  // 2, 4, 6
```

## flatMap - 비동기 변환

```java
Mono<User> user = findUserById(1L)
    .flatMap(u -> findOrdersByUser(u));  // Mono<Mono<Orders>> 방지
```

`map`은 동기 변환, `flatMap`은 비동기 변환(Mono/Flux를 반환하는 함수)에 사용합니다.

## 필터

```java
Flux<Integer> even = Flux.range(1, 10)
    .filter(n -> n % 2 == 0);  // 2, 4, 6, 8, 10
```

## 에러 처리

```java
Mono<String> handled = Mono.just("data")
    .flatMap(this::riskyOperation)
    .onErrorReturn("기본값")                        // 에러 시 기본값
    .onErrorResume(e -> Mono.just("대체값"))       // 에러 시 대체 Mono
    .onErrorMap(e -> new CustomException(e));     // 에러 변환
```

## 조합

```java
// 두 Mono를 결합
Mono<String> combined = Mono.zip(mono1, mono2, (a, b) -> a + b);

// 첫 번째 결과 사용
Mono<String> first = Mono.firstWithValue(mono1, mono2);

// Flux 합치기
Flux<Integer> merged = Flux.merge(flux1, flux2);
Flux<Integer> concatenated = Flux.concat(flux1, flux2);  // 순서 보장
```

# 4. WebFlux Controller

---

## 기본 구조

```java
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    // 단일 조회
    @GetMapping("/{id}")
    public Mono<User> getUser(@PathVariable Long id) {
        return userService.findById(id);
    }

    // 목록 조회
    @GetMapping
    public Flux<User> getAllUsers() {
        return userService.findAll();
    }

    // 생성
    @PostMapping
    public Mono<User> createUser(@RequestBody User user) {
        return userService.save(user);
    }
}
```

## ResponseEntity 사용

```java
@GetMapping("/{id}")
public Mono<ResponseEntity<User>> getUser(@PathVariable Long id) {
    return userService.findById(id)
        .map(user -> ResponseEntity.ok(user))
        .defaultIfEmpty(ResponseEntity.notFound().build());
}

@PostMapping
public Mono<ResponseEntity<User>> createUser(@RequestBody User user) {
    return userService.save(user)
        .map(saved -> ResponseEntity
            .created(URI.create("/api/users/" + saved.getId()))
            .body(saved));
}
```

## Server-Sent Events (SSE)

```java
@GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<String>> streamEvents() {
    return Flux.interval(Duration.ofSeconds(1))
        .map(seq -> ServerSentEvent.<String>builder()
            .id(String.valueOf(seq))
            .event("message")
            .data("Event " + seq)
            .build());
}
```

# 5. WebClient - 리액티브 HTTP 클라이언트

---

## 생성

```java
WebClient webClient = WebClient.builder()
    .baseUrl("https://api.example.com")
    .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
    .build();
```

## GET 요청

```java
Mono<User> user = webClient.get()
    .uri("/users/{id}", 1L)
    .retrieve()
    .bodyToMono(User.class);

Flux<User> users = webClient.get()
    .uri("/users")
    .retrieve()
    .bodyToFlux(User.class);
```

## POST 요청

```java
Mono<User> created = webClient.post()
    .uri("/users")
    .bodyValue(new User("홍길동", "hong@example.com"))
    .retrieve()
    .bodyToMono(User.class);
```

## 에러 처리

```java
Mono<User> user = webClient.get()
    .uri("/users/{id}", id)
    .retrieve()
    .onStatus(
        status -> status.is4xxClientError(),
        response -> Mono.error(new UserNotFoundException(id))
    )
    .onStatus(
        status -> status.is5xxServerError(),
        response -> Mono.error(new ServerException("서버 오류"))
    )
    .bodyToMono(User.class);
```

## 동기 호출 (필요시)

```java
// block()으로 결과 대기 (테스트나 마이그레이션 시에만 사용)
User user = webClient.get()
    .uri("/users/1")
    .retrieve()
    .bodyToMono(User.class)
    .block();  // 블로킹! 리액티브 환경에서는 지양
```

# 6. 언제 WebFlux를 써야 하나?

---

## WebFlux가 적합한 경우

```text
✅ I/O 집약적 작업
   - 많은 외부 API 호출
   - DB 쿼리가 많고 응답 대기 시간이 긴 경우
   - 파일 I/O가 많은 경우

✅ 높은 동시 접속
   - 동시 연결이 수천~수만인 경우
   - 채팅, 알림, 스트리밍 서비스

✅ 마이크로서비스 게이트웨이
   - 여러 서비스 호출을 조합
   - Spring Cloud Gateway
```

## MVC가 더 나은 경우

```text
✅ CPU 집약적 작업
   - 복잡한 계산, 암호화, 이미지 처리
   - 이미 CPU가 병목이면 Non-blocking 효과 없음

✅ 동기적 라이브러리 사용
   - JPA/Hibernate (R2DBC 대신)
   - 블로킹 SDK/라이브러리

✅ 팀 경험
   - 리액티브 러닝 커브가 높음
   - 디버깅이 어려움
```

## 주의사항

```text
⚠️ 혼합 사용 금지
   - WebFlux에서 block() 호출은 성능 저하
   - JPA는 블로킹이므로 R2DBC 사용 권장

⚠️ 디버깅 어려움
   - 스택 트레이스가 끊김
   - Hooks.onOperatorDebug()로 디버그 모드 활성화

⚠️ 러닝 커브
   - Mono/Flux 연산자 학습 필요
   - 오류 처리 패턴 다름
```

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **WebFlux** | Non-blocking 리액티브 웹 프레임워크 |
| **Mono** | 0 또는 1개 요소의 비동기 컨테이너 |
| **Flux** | 0~N개 요소의 비동기 스트림 |
| **WebClient** | Non-blocking HTTP 클라이언트 |
| **Subscribe** | 구독 전까지 실행 안 됨 (lazy) |
| **적합한 상황** | I/O 집약적, 높은 동시성 |

```text
핵심:
  WebFlux = 적은 스레드로 많은 동시 요청 처리.
  Mono/Flux는 구독해야 실행됨.
  I/O 대기가 많은 서비스에 적합.
  모든 상황에 좋은 건 아님 → MVC와 적절히 선택.
```

# Reference

---

- [Spring WebFlux Documentation](https://docs.spring.io/spring-framework/reference/web/webflux.html)
- [Project Reactor Reference](https://projectreactor.io/docs/core/release/reference/)
- [WebClient Guide](https://docs.spring.io/spring-framework/reference/web/webflux-webclient.html)
