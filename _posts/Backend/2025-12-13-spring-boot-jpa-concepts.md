---
layout: single
title: "[Spring Boot] JPA와 REST API 핵심 개념 정리 - 동시성, 트랜잭션, 예외 처리, CORS"
date: 2026-03-19
categories:
  - Backend
tags: [Spring Boot, JPA, REST API, Transaction, CORS, Spring Security]
---

## Introduction

---

Spring Boot로 REST API를 개발하다 보면 JPA 엔티티 설계, 트랜잭션 관리, 예외 처리, CORS 설정 등 다양한 개념들이 동시에 등장합니다. 각 개념을 개별적으로 공부하면 이해할 수 있지만, 실제 프로젝트에서 이것들이 어떻게 **함께 맞물려 돌아가는지**는 직접 만들어봐야 감이 옵니다.

이 포스트에서는 브레인스토밍 룸 서비스(`brainstorm-api`)를 개발하면서 실제로 마주쳤던 핵심 개념들을 정리합니다. 각 개념이 **왜 필요한지**, 그리고 **어떻게 구현했는지**를 초보자 관점에서 설명합니다.

### 이 글에서 다루는 내용

- 동시성 이슈와 해결 방법 (COUNT 쿼리 vs 필드 저장)
- JPA 복합 유니크 제약조건 (`@UniqueConstraint`)
- 엔티티 관계 어노테이션 선택 (`@ManyToOne` vs `@OneToOne`)
- Spring Data JPA 메서드 네이밍 규칙
- `@Transactional`의 역할과 주의사항
- 커스텀 예외와 `@RestControllerAdvice`를 활용한 전역 예외 처리
- CORS와 Spring Security 동시 설정

### 사전 준비

- Java 17 이상
- Spring Boot 3.x
- Spring Data JPA, Spring Security 의존성
- JPA와 엔티티 개념에 대한 기본적인 이해

## 동시성 이슈 - 현재 인원 수를 어떻게 저장할까?

---

룸에 현재 몇 명이 접속해 있는지 알려주는 `currentUserCount` 필드를 Room 엔티티에 추가한다고 가정해 봅시다. 언뜻 보면 간단해 보이지만, 여러 사용자가 동시에 입장/퇴장할 경우 **race condition(경쟁 조건)**이 발생합니다.

```
사용자 A가 읽음: count = 5
사용자 B가 읽음: count = 5
사용자 A가 씀: count = 6 (5 + 1)
사용자 B가 씀: count = 6 (5 + 1)  <-- 실제로는 7이어야 하는데!
```

두 사용자가 거의 동시에 같은 값(5)을 읽어간 후 각각 +1을 했기 때문에, 하나의 입장이 누락된 것입니다. 이 문제를 해결하는 방법은 크게 4가지입니다.

| 방법 | 어노테이션/방식 | 특징 |
|------|----------------|------|
| 비관적 락 | `@Lock(PESSIMISTIC_WRITE)` | 조회 시 row를 잠금, 안전하지만 느림 |
| 낙관적 락 | `@Version` 필드 | 충돌 감지 후 재시도, 트래픽 적을 때 유리 |
| 원자적 쿼리 | `UPDATE room SET count = count + 1` | DB가 직접 계산, 가장 실용적 |
| 메시지 큐 | Kafka, RabbitMQ 등 | 대규모 서비스용, 소규모에서는 오버엔지니어링 |

### 더 좋은 대안: 저장하지 않고 매번 세기

**하지만 더 좋은 대안이 있습니다.** `currentUserCount`를 필드로 저장하지 않고, 실제 멤버 테이블(`room_member`)을 COUNT 쿼리로 집계하면 동시성 문제 자체가 없어집니다.

```java
// RoomMemberRepository.java

@Repository
public interface RoomMemberRepository extends JpaRepository<RoomMember, Long> {

    // 메서드 이름만으로 COUNT 쿼리가 자동 생성됨
    // -> SELECT COUNT(*) FROM room_member WHERE room_id = ?
    long countByRoomId(Long roomId);
}
```

```java
// RoomMemberService.java

public long getRoomMembersCount(Long roomId) {
    // 숫자를 필드에 저장하는 대신, 매번 DB에서 직접 카운트
    return roomMemberRepository.countByRoomId(roomId);
}
```

이 방식의 장점은 **데이터 정합성이 항상 보장**된다는 것입니다. 실제 멤버 레코드 수를 세는 것이므로 값이 어긋날 수가 없습니다. 다만 멤버 수가 수천, 수만 건이 되면 매번 COUNT 쿼리를 날리는 것이 성능에 부담이 될 수 있으므로, 그때는 캐싱이나 원자적 쿼리를 고려해야 합니다.

## @UniqueConstraint - 복합 유니크 제약조건

---

한 사용자가 같은 룸에 중복 입장하는 것을 막으려면 DB 레벨에서 유니크 제약을 걸어야 합니다. `user_id + room_id` 조합이 유일해야 하는 경우가 바로 **복합 유니크 제약조건**입니다.

```java
// RoomMember.java

@Entity
@Getter
@Setter
@NoArgsConstructor
@Table(uniqueConstraints = {
    // user_id와 room_id의 조합이 중복되면 DB에서 에러 발생
    @UniqueConstraint(columnNames = {"user_id", "room_id"})
})
public class RoomMember {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne
    @JoinColumn(name = "room_id")
    private Room room;

    @ManyToOne
    @JoinColumn(name = "user_id")
    private User user;

    private LocalDateTime createdAt;

    @PrePersist
    protected void onCreate() {
        if (this.createdAt == null) {
            this.createdAt = LocalDateTime.now();
        }
    }
}
```

#### 단일 컬럼 유니크 vs 복합 유니크

- **단일 컬럼**: `@Column(unique = true)` -- 하나의 컬럼 값이 테이블 전체에서 유일해야 할 때
- **복합 유니크**: `@Table(uniqueConstraints = ...)` -- **두 개 이상의 컬럼 조합**이 유일해야 할 때

> **주의**: 중복 데이터를 INSERT하면 `DataIntegrityViolationException`이 발생합니다. FK(외래키) 제약조건 위반도 동일한 예외가 발생하므로, 예외 처리 시 메시지를 확인하여 원인을 구분하는 것이 좋습니다.

## @ManyToOne vs @OneToOne - 관계 어노테이션 선택

---

RoomMember 엔티티를 설계할 때 User와의 관계를 어떤 어노테이션으로 표현할지 고민이 생깁니다. 핵심은 **비즈니스 요구사항**에 따라 결정하는 것입니다.

| 어노테이션 | 의미 | 예시 |
|-----------|------|------|
| `@OneToOne` | 한 유저가 **하나의 룸에만** 참여 가능 (1:1) | 유저당 프로필 이미지 1개 |
| `@ManyToOne` | 한 유저가 **여러 룸에** 참여 가능 (N:1) | 유저가 여러 채팅방에 참여 |

브레인스토밍 서비스에서는 한 유저가 여러 룸에 참여할 수 있어야 하므로 `@ManyToOne`이 올바른 선택입니다.

```java
// RoomMember.java

// 여러 RoomMember가 하나의 User를 참조할 수 있음 (N:1)
@ManyToOne
@JoinColumn(name = "user_id")
private User user;

// 여러 RoomMember가 하나의 Room을 참조할 수 있음 (N:1)
@ManyToOne
@JoinColumn(name = "room_id")
private Room room;
```

읽는 방법은 간단합니다. **"Many(RoomMember) To One(User)"** -- 즉, "여러 RoomMember가 하나의 User에 연결된다"는 뜻입니다. 어노테이션은 항상 **현재 엔티티 기준**으로 읽으면 됩니다.

## Spring Data JPA 메서드 네이밍 규칙

---

Spring Data JPA의 강점 중 하나는 **메서드 이름만으로 쿼리를 자동 생성**해주는 기능입니다. SQL을 직접 작성하지 않아도 메서드 이름의 규칙만 지키면 Spring이 알아서 적절한 쿼리를 만들어 줍니다.

```java
// RoomMemberRepository.java

public interface RoomMemberRepository extends JpaRepository<RoomMember, Long> {

    // SELECT * FROM room_member WHERE room_id = ?
    List<RoomMember> findByRoomId(Long roomId);

    // DELETE FROM room_member WHERE room_id = ? AND user_id = ?
    void deleteByRoomIdAndUserId(Long roomId, Long userId);

    // SELECT COUNT(*) FROM room_member WHERE room_id = ?
    long countByRoomId(Long roomId);
}
```

### 네이밍 규칙 요약

| 접두사 | 용도 | 예시 |
|--------|------|------|
| `findBy` | 조회 | `findByRoomId(Long roomId)` |
| `deleteBy` | 삭제 | `deleteByRoomIdAndUserId(Long roomId, Long userId)` |
| `countBy` | 카운트 | `countByRoomId(Long roomId)` |
| `existsBy` | 존재 여부 | `existsByRoomIdAndUserId(Long roomId, Long userId)` |

여러 조건을 조합할 때는 `And`, `Or` 키워드를 사용합니다. 필드명은 엔티티의 Java 필드명(카멜케이스)을 그대로 사용하면 됩니다.

> **참고**: `deleteBy` 같은 파생 삭제 쿼리(derived delete query)는 내부적으로 엔티티를 먼저 조회한 뒤 하나씩 삭제합니다. 대량 삭제가 필요한 경우에는 `@Query`와 `@Modifying`을 사용한 벌크 삭제가 더 효율적입니다.

## @Transactional - 여러 DB 작업을 하나로 묶기

---

`@Transactional`은 메서드 안의 모든 DB 작업을 하나의 트랜잭션으로 묶어줍니다. 중간에 에러가 나면 **이전 작업까지 전부 롤백**됩니다.

```java
// RoomService.java

@Transactional
public Room save(RoomRequest roomRequest) {
    // 1) 룸 저장
    Room newRoom = new Room();
    newRoom.setName(roomRequest.getName());
    newRoom.setOwner(roomRequest.getOwner());
    newRoom.setTopic(roomRequest.getTopic());
    newRoom.setTotalUserCount(10);
    newRoom.setIsPublic(roomRequest.getIsPublic());
    Room savedRoom = roomRepository.save(newRoom);

    // 2) 방장을 룸 멤버로 등록
    // 여기서 예외가 나면 1번의 룸 저장도 같이 롤백됨
    roomMemberService.save(savedRoom.getId(), savedRoom.getOwner().getId());

    return savedRoom;
}
```

### 커스텀 delete 메서드와 @Transactional

중요한 주의사항이 있습니다. Spring Data JPA에서 **파생 삭제 메서드**(`deleteBy...`)는 내부적으로 엔티티를 조회한 뒤 삭제하는 과정을 거칩니다. 이 과정에는 반드시 트랜잭션이 필요하므로 `@Transactional` 없이 호출하면 `TransactionRequiredException`이 발생합니다.

```java
// RoomMemberService.java

@Transactional  // 파생 삭제 메서드 호출 시 필수!
public void delete(Long roomId, Long userId) {
    roomMemberRepository.deleteByRoomIdAndUserId(roomId, userId);
}
```

> **왜 `deleteById()`는 `@Transactional` 없이도 되나요?** `JpaRepository`가 상속하는 `SimpleJpaRepository`에 이미 `@Transactional`이 선언되어 있기 때문입니다. 반면 `deleteByRoomIdAndUserId()`처럼 직접 정의한 파생 삭제 메서드에는 기본 트랜잭션이 적용되지 않으므로 직접 붙여야 합니다.

## 커스텀 예외 만들기

---

룸이 꽉 찼을 때 의미 있는 예외를 던지려면 커스텀 예외 클래스를 만들면 됩니다.

```java
// RoomFullException.java

// RuntimeException을 상속 -> Unchecked Exception
// 호출하는 쪽에서 try-catch를 강제하지 않음
public class RoomFullException extends RuntimeException {

    public RoomFullException(String message) {
        // Java에서 생성자는 상속되지 않으므로 super() 호출로 부모에게 메시지 전달
        super(message);
    }
}
```

#### Checked vs Unchecked Exception

| 구분 | 상속 대상 | try-catch 강제 | 사용 시점 |
|------|----------|---------------|----------|
| Checked | `Exception` | O (강제) | 파일 I/O, 네트워크 등 복구 가능한 상황 |
| Unchecked | `RuntimeException` | X (선택) | 프로그래밍 오류, 비즈니스 규칙 위반 |

비즈니스 로직에서 발생하는 예외는 대부분 `RuntimeException`을 상속하는 것이 관례입니다. 이렇게 만든 예외는 서비스에서 던지고, 다음에 나오는 `@RestControllerAdvice`에서 잡아 HTTP 응답으로 변환합니다.

## @RestControllerAdvice - 전역 예외 처리

---

예외 처리 코드를 각 컨트롤러에 분산시키면 중복이 생기고 유지보수가 어려워집니다. `@RestControllerAdvice`를 사용하면 **모든 컨트롤러의 예외를 한 곳에서** 처리할 수 있습니다.

```java
// GlobalExceptionHandler.java

@RestControllerAdvice
public class GlobalExceptionHandler {

    // 엔티티를 찾지 못했을 때 (findById().orElseThrow() 등)
    @ExceptionHandler(NoSuchElementException.class)
    public ResponseEntity<String> handleNotFound(NoSuchElementException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not Found Resource");
    }

    // 유니크/FK 제약조건 위반 시 (중복 데이터, 없는 외래키 참조 등)
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<String> handleConflict(DataIntegrityViolationException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body("Duplicated Data");
    }

    // 룸이 꽉 찼을 때 (커스텀 예외)
    @ExceptionHandler(RoomFullException.class)
    public ResponseEntity<String> handleRoomFullException(RoomFullException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
    }

    // 처리되지 않은 모든 예외 (최후의 보루)
    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGeneral(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Internal Error");
    }
}
```

#### 동작 원리

1. 컨트롤러에서 예외가 발생하면 Spring이 `@RestControllerAdvice` 클래스에서 해당 예외 타입에 매칭되는 `@ExceptionHandler`를 찾습니다.
2. **구체적인 예외 타입이 우선** 매칭됩니다. 예를 들어 `RoomFullException`이 발생하면 `handleRoomFullException()`이 호출되고, `handleGeneral()`은 호출되지 않습니다.
3. 어떤 핸들러에도 매칭되지 않는 예외는 `Exception.class`를 처리하는 핸들러가 최종적으로 잡아줍니다.

> **팁**: 실제 운영 환경에서는 `handleGeneral()`에서 에러 로그를 남기는 것이 중요합니다. 클라이언트에는 민감한 정보를 노출하지 않되, 서버 로그에는 원인을 파악할 수 있도록 기록해 두어야 합니다.

## CORS와 Spring Security - 함께 설정하기

---

프론트엔드(예: Vercel에 배포된 React 앱)에서 백엔드 API를 호출하면, 브라우저는 **출처(origin)가 다르다**는 이유로 요청을 차단합니다. 이것이 바로 CORS(Cross-Origin Resource Sharing) 정책입니다.

Spring Boot에서 CORS를 설정할 때, Spring Security를 함께 사용하고 있다면 **두 곳 모두 설정해야** 합니다. 그렇지 않으면 Spring Security가 CORS preflight 요청(OPTIONS 메서드)을 먼저 차단해버립니다.

### 1단계: WebMvcConfigurer에서 CORS 규칙 정의

```java
// WebConfig.java

@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry
            .addMapping("/api/**")
            // 주의: URL 끝에 /를 붙이면 패턴 매칭이 안 됨!
            // "https://my-app.vercel.app/" (X)
            // "https://my-app.vercel.app" (O)
            .allowedOriginPatterns("https://*.vercel.app")
            .allowedMethods("GET", "POST", "PUT", "DELETE")
            .allowedHeaders("*")
            .allowCredentials(true);
    }
}
```

### 2단계: SecurityFilterChain에서 CORS 활성화

```java
// SecurityConfig.java

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            // WebMvcConfigurer의 CORS 설정을 Spring Security 필터 체인에서도 활성화
            .cors(Customizer.withDefaults())
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());

        return http.build();
    }
}
```

### 왜 두 곳 모두 설정해야 하나?

브라우저가 CORS 요청을 보낼 때, 실제 요청 전에 **preflight 요청**(OPTIONS 메서드)을 먼저 보냅니다. 이 요청은 Spring Security의 필터 체인을 먼저 통과해야 합니다.

- `.cors(Customizer.withDefaults())`를 설정하면 Spring Security가 `WebMvcConfigurer`에 정의된 CORS 설정을 인식하고, preflight 요청을 차단하지 않고 통과시킵니다.
- 이 설정이 **빠져 있으면** Spring Security가 OPTIONS 요청을 인증되지 않은 요청으로 간주하여 403 Forbidden을 반환하고, 프론트엔드에서는 CORS 에러가 발생합니다.

> **흔한 실수**: `WebMvcConfigurer`에만 CORS를 설정하고 "왜 안 되지?"라고 헤매는 경우가 많습니다. Spring Security를 사용 중이라면 반드시 `SecurityFilterChain`에도 `.cors(Customizer.withDefaults())`를 추가해야 합니다.

## REST API 경로 설계

---

### /api prefix를 붙이는 이유

`/api/rooms`처럼 `/api` prefix를 붙이는 관행에는 실용적인 이유가 있습니다.

- **프록시 설정**: Nginx나 API Gateway에서 `/api/**`를 백엔드로 라우팅하기 쉬움
- **필터 구분**: Spring Security나 로깅 필터에서 API 경로만 골라서 처리 가능
- **프론트/백 구분**: 같은 서버에서 정적 파일과 API를 함께 서빙할 때 명확히 구분

### 하위 리소스 경로 설계 (중첩 리소스)

멤버 목록을 조회하는 API를 설계할 때 두 가지 방식이 있습니다.

```
GET /api/members?roomId=1       # 쿼리 파라미터 방식
GET /api/rooms/1/members        # 중첩 리소스 방식 (더 RESTful)
```

`/api/rooms/{roomId}/members`처럼 **중첩 경로**를 쓰면 "룸 1번의 멤버들"이라는 의미가 URL만 보고도 직관적으로 전달됩니다. REST API에서 리소스 간의 소속 관계를 표현할 때 권장되는 방식입니다.

### PathVariable vs RequestBody

데이터를 전달하는 위치는 데이터의 성격에 따라 결정합니다.

```java
// 단순 식별자 -> URL 경로로 표현 (PathVariable)
@DeleteMapping("/{id}")
public ResponseEntity<Void> deleteRoom(@PathVariable Long id) { ... }

// 복잡한 데이터 -> Request Body로 전달 (RequestBody)
@PostMapping
public ResponseEntity<Room> createRoom(@RequestBody RoomRequest roomRequest) { ... }
```

| 방식 | 사용 시점 | 예시 |
|------|----------|------|
| `@PathVariable` | 리소스 식별자 (ID 등) | `DELETE /api/rooms/1` |
| `@RequestBody` | 생성/수정할 데이터 | `POST /api/rooms` + JSON body |
| `@RequestParam` | 필터링, 페이징 등 부가 조건 | `GET /api/rooms?page=0&size=10` |

## 흔한 실수와 트러블슈팅

---

| 증상 | 원인 | 해결 방법 |
|------|------|----------|
| `TransactionRequiredException` | `deleteBy...` 메서드에 `@Transactional` 누락 | 서비스 메서드에 `@Transactional` 추가 |
| `DataIntegrityViolationException` | 유니크 제약조건 위반 또는 FK 위반 | `GlobalExceptionHandler`에서 409 Conflict 반환 |
| 프론트에서 CORS 에러 | `SecurityFilterChain`에 `.cors()` 미설정 | `.cors(Customizer.withDefaults())` 추가 |
| `allowedOrigins`에 URL 끝 `/` 포함 | Origin 패턴 매칭 실패 | URL 끝의 `/` 제거 |
| `LazyInitializationException` | 트랜잭션 밖에서 지연 로딩 접근 | `@Transactional` 범위 확장 또는 DTO 변환 |

## 정리

---

| 개념 | 핵심 포인트 |
|------|------------|
| 동시성 이슈 | count 필드 대신 COUNT 쿼리로 계산하면 race condition 자체를 피할 수 있음 |
| 복합 유니크 | `@Table(uniqueConstraints = ...)` 사용, 위반 시 `DataIntegrityViolationException` |
| 관계 어노테이션 | `@ManyToOne` vs `@OneToOne`은 비즈니스 요구사항에 따라 결정 |
| JPA 메서드 네이밍 | `findBy`, `deleteBy`, `countBy` + 필드명으로 쿼리 자동 생성 |
| @Transactional | 파생 삭제 메서드 사용 시 필수, 중간 에러 시 전체 롤백 |
| 커스텀 예외 | `RuntimeException` 상속, 비즈니스 로직 위반을 명확하게 표현 |
| @RestControllerAdvice | 예외 처리를 한 곳에 집중, 구체적인 예외 타입이 우선 매칭 |
| CORS + Security | `WebMvcConfigurer`와 `SecurityFilterChain` 양쪽 모두 설정 필요 |

## Reference

---

- [brainstorm-api GitHub Repository](https://github.com/krails0105/brainstorm-api)
- [Spring Data JPA - Query Methods (공식 문서)](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Spring Data JPA - Transactions (공식 문서)](https://docs.spring.io/spring-data/jpa/reference/jpa/transactions.html)
- [Spring Security - CORS (공식 문서)](https://docs.spring.io/spring-security/reference/servlet/integrations/cors.html)
- [Spring Boot - Web MVC Auto-configuration (공식 문서)](https://docs.spring.io/spring-boot/reference/web/servlet.html)
