---
title: "[Brainstorm] Phase 1 - 도메인 설계부터 REST API 구현까지"
categories: [Backend]
tags: [Spring Boot, JPA, REST API, Brainstorm, Lombok, 예외 처리]
date: 2026-03-19
---

## Introduction

---

이 글에서는 **브레인스토밍 웹 앱**의 백엔드 API를 Spring Boot로 구현한 Phase 1 과정을 정리합니다.

Phase 1에서 다루는 내용은 다음과 같습니다.

- 도메인 모델(User, Room, RoomMember, Favorite) 설계 및 엔티티 관계 매핑
- Controller / Service / Repository 계층 구조 구현
- REST API 경로 설계와 PathVariable 활용
- 글로벌 예외 처리(`@RestControllerAdvice`)
- 통합 테스트 작성

이 글을 읽고 나면, Spring Boot + JPA 기반으로 다대다 관계를 가진 도메인을 설계하고, 계층형 REST API를 구현하는 전체 흐름을 이해할 수 있습니다.

## 사전 준비 (Prerequisites)

---

이 글의 내용을 따라가려면 다음 환경이 필요합니다.

- **Java 17** 이상
- **Spring Boot 3.x** (Spring Initializr에서 Spring Web, Spring Data JPA, H2 Database, Lombok 의존성 추가)
- **IDE**: IntelliJ IDEA 또는 VS Code (Lombok 플러그인 설치 필요)
- Spring MVC의 기본 개념(Controller, Service, Repository 패턴)에 대한 기초적인 이해

## 배경 (Problem & Context)

---

브레인스토밍 앱의 핵심 기능은 다음 세 가지입니다.

- 사용자가 **Room**을 만들어 주제(topic)를 설정하고 함께 브레인스토밍
- Room에 **멤버**를 초대하고 인원 제한 관리
- 마음에 드는 Room을 **즐겨찾기**로 저장

이 기능들을 구현하려면 **User, Room, RoomMember, Favorite** 네 개의 도메인 모델이 필요합니다. Phase 1에서는 이 모델들의 관계를 설계하고, 각각에 대한 CRUD API를 만드는 것이 목표였습니다.

도메인 간의 관계를 그림으로 표현하면 다음과 같습니다.

```
User (1) ──── (N) Room          : 한 유저가 여러 룸을 소유할 수 있음
User (N) ──── (N) Room          : 한 유저가 여러 룸에 참여 가능 (RoomMember 중간 테이블)
User (N) ──── (N) Room          : 한 유저가 여러 룸을 즐겨찾기 가능 (Favorite 중간 테이블)
```

## 접근 방법 (Approach)

---

### 기술 선택

| 기술 | 선택 이유 |
|------|----------|
| Spring Boot 3.x + JPA | 표준적인 Spring 생태계로 빠른 개발 |
| Lombok | `@Getter`, `@Setter`, `@NoArgsConstructor` 등으로 보일러플레이트 코드 제거 |
| H2 (개발) / PostgreSQL (운영) | 로컬에서는 인메모리 DB로 빠른 테스트, 운영에서는 안정적인 PostgreSQL |

### 설계 결정: currentUserCount를 필드로 저장하지 않는다

룸의 "현재 참여 인원"을 별도 필드로 저장하면, 멤버를 추가하거나 삭제할 때마다 Room 테이블과 RoomMember 테이블을 항상 동기화해야 합니다. 동기화를 빠트리면 데이터 정합성이 깨집니다.

대신 **RoomMember 테이블의 COUNT 쿼리로 실시간 계산**하는 방식을 선택했습니다. 이 방식은 정합성 문제가 없고 코드도 단순합니다. 대규모 트래픽 환경에서는 성능 이슈가 있을 수 있지만, 현재 규모에서는 가장 안전한 접근입니다.

### REST API 경로 설계

하위 리소스 관계를 URL에 명확히 표현하는 방향으로 설계했습니다.

| 기능 | HTTP 메서드 | 경로 |
|------|------------|------|
| 룸 목록 조회 | GET | `/api/rooms` |
| 룸 생성 | POST | `/api/rooms` |
| 룸 멤버 목록 | GET | `/api/rooms/{roomId}/members` |
| 룸 멤버 추가 | POST | `/api/rooms/{roomId}/members/{userId}` |
| 룸 멤버 제거 | DELETE | `/api/rooms/{roomId}/members/{userId}` |
| 즐겨찾기 목록 | GET | `/api/users/{userId}/favorites` |
| 즐겨찾기 추가 | POST | `/api/users/{userId}/favorites/{roomId}` |
| 즐겨찾기 제거 | DELETE | `/api/users/{userId}/favorites/{roomId}` |

멤버와 즐겨찾기를 각각 **룸과 유저의 하위 리소스**로 표현했기 때문에, 별도의 Request DTO 없이 PathVariable만으로 필요한 ID를 전달할 수 있습니다.

## 구현 (Key Code & Commands)

---

### 1. 도메인 엔티티 설계

#### User 엔티티

```java
// src/main/java/com/brainstorm/brainstorm_api/entity/User.java

@Entity
@Getter
@Setter
@Table(name = "users")  // "user"는 SQL 예약어이므로 테이블 이름을 명시적으로 지정
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    private String password;
}
```

`user`는 H2, PostgreSQL 등 여러 데이터베이스에서 SQL 예약어로 사용됩니다. 그대로 테이블 이름으로 쓰면 DB에 따라 쿼리 오류가 발생할 수 있습니다. `@Table(name = "users")`로 명시적으로 테이블 이름을 지정하면 이 문제를 피할 수 있습니다.

> `@GeneratedValue(strategy = GenerationType.IDENTITY)`는 데이터베이스의 AUTO_INCREMENT(MySQL) 또는 SERIAL(PostgreSQL) 기능을 사용해 기본키를 자동 생성합니다. 별도로 ID 값을 넣지 않아도 DB가 알아서 순번을 매겨줍니다.

#### Room 엔티티

```java
// src/main/java/com/brainstorm/brainstorm_api/entity/Room.java

@Entity
@Getter @Setter
@NoArgsConstructor
public class Room {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne
    @JoinColumn(name = "owner_id")  // room 테이블에 owner_id FK 컬럼이 생긴다
    private User owner;

    private String name;
    private String topic;
    private Integer totalUserCount;  // 최대 참여 가능 인원
    private Boolean isPublic;
    private LocalDateTime createdAt;

    @PrePersist
    protected void onCreate() {
        // DB에 저장되기 직전에 자동으로 현재 시간을 세팅
        if (this.createdAt == null) {
            this.createdAt = LocalDateTime.now();
        }
    }
}
```

여기서 두 가지 JPA 기능이 핵심입니다.

**`@ManyToOne` + `@JoinColumn`**: Room과 User의 관계를 표현합니다. "여러 개의 Room이 하나의 User(owner)에 속한다"는 다대일 관계이므로 `@ManyToOne`을 사용합니다. `@JoinColumn(name = "owner_id")`은 room 테이블에 `owner_id`라는 외래키(FK) 컬럼을 만들어줍니다.

**`@PrePersist`**: JPA 생명주기 콜백(Lifecycle Callback) 어노테이션입니다. 엔티티가 처음 INSERT되기 직전에 자동으로 호출됩니다. `createdAt`을 직접 세팅하지 않아도 자동으로 현재 시간이 저장되므로, 생성 시간을 빠트릴 걱정이 없습니다.

#### Favorite / RoomMember 엔티티 - 중복 방지 제약

Favorite과 RoomMember 엔티티에는 **복합 유니크 제약조건**을 설정했습니다.

```java
// src/main/java/com/brainstorm/brainstorm_api/entity/Favorite.java

@Entity
@Getter @Setter
@NoArgsConstructor
@Table(uniqueConstraints = {
    @UniqueConstraint(columnNames = {"user_id", "room_id"})
    // 같은 유저가 같은 룸을 두 번 즐겨찾기 할 수 없음
})
public class Favorite {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne
    @JoinColumn(name = "user_id")
    private User user;

    @ManyToOne
    @JoinColumn(name = "room_id")
    private Room room;

    private LocalDateTime createdAt;

    @PrePersist
    protected void onCreate() {
        if (this.createdAt == null) {
            this.createdAt = LocalDateTime.now();
        }
    }
}
```

`@UniqueConstraint(columnNames = {"user_id", "room_id"})`는 `user_id`와 `room_id` 조합이 테이블 내에서 유일해야 한다는 제약입니다. 같은 유저가 같은 룸을 두 번 즐겨찾기 하거나, 같은 룸에 같은 멤버가 두 번 추가되는 상황을 **데이터베이스 레벨**에서 원천 차단합니다.

왜 애플리케이션 코드가 아닌 DB 제약으로 처리할까요? 동시에 두 개의 요청이 들어오는 경우, 애플리케이션에서 "이미 존재하는지" 확인한 뒤 삽입하는 로직은 체크와 삽입 사이에 시간차가 있어서 중복이 발생할 수 있습니다. DB 유니크 제약은 이런 동시성 문제를 확실하게 방지합니다.

> RoomMember 엔티티도 동일한 구조로 `@UniqueConstraint`를 적용했습니다.

### 2. 룸 생성 시 Owner 자동 멤버 추가

룸을 만든 사람(owner)은 자동으로 해당 룸의 멤버가 되어야 합니다. `RoomService.save()`에서 룸 저장 직후 `RoomMemberService`를 호출해 처리했습니다.

```java
// src/main/java/com/brainstorm/brainstorm_api/service/RoomService.java

@Transactional  // Room 저장과 RoomMember 저장이 하나의 트랜잭션으로 묶인다
public Room save(RoomRequest roomRequest) {
    Room newRoom = new Room();
    newRoom.setName(roomRequest.getName());
    newRoom.setOwner(roomRequest.getOwner());
    newRoom.setTopic(roomRequest.getTopic());
    newRoom.setTotalUserCount(10);  // 기본 최대 인원: 10명
    newRoom.setIsPublic(roomRequest.getIsPublic());
    Room savedRoom = roomRepository.save(newRoom);

    // 룸 생성자를 자동으로 멤버에 추가
    roomMemberService.save(savedRoom.getId(), savedRoom.getOwner().getId());
    return savedRoom;
}
```

여기서 `@Transactional`이 핵심입니다. 이 어노테이션이 없으면 `roomRepository.save()`와 `roomMemberService.save()`가 **별도의 트랜잭션**으로 실행됩니다. Room 저장은 성공했는데 RoomMember 저장에서 실패하면, Room만 생기고 멤버가 없는 불완전한 상태가 됩니다.

`@Transactional`을 붙이면 메서드 전체가 하나의 트랜잭션으로 묶이므로, 둘 중 하나라도 실패하면 **전부 롤백**됩니다. 데이터 정합성을 지키는 데 필수적인 설정입니다.

> Spring의 `@Transactional`은 `org.springframework.transaction.annotation.Transactional`을 사용합니다. JakartaEE의 `jakarta.transaction.Transactional`과 혼동하지 않도록 주의하세요.

### 3. 인원 초과 처리 (커스텀 예외)

```java
// src/main/java/com/brainstorm/brainstorm_api/service/RoomMemberService.java

public RoomMember save(Long roomId, Long userId) {
    Room room = roomRepository.findById(roomId).orElseThrow();
    long roomMembersCount = getRoomMembersCount(room.getId());

    // currentUserCount 필드 없이 COUNT 쿼리로 현재 인원 파악
    if (roomMembersCount >= room.getTotalUserCount()) {
        throw new RoomFullException("Max Member Exceed!");
    }

    User user = userRepository.findById(userId).orElseThrow();
    RoomMember roomMember = new RoomMember();
    roomMember.setRoom(room);
    roomMember.setUser(user);
    return roomMemberRepository.save(roomMember);
}
```

`getRoomMembersCount()`는 내부적으로 `roomMemberRepository.countByRoomId(roomId)`를 호출합니다. **Spring Data JPA의 쿼리 메서드 네이밍 규칙**에 따라, `countByRoomId`라고 이름을 짓기만 하면 자동으로 `SELECT COUNT(*) FROM room_member WHERE room_id = ?` 쿼리가 만들어집니다. 별도의 SQL을 작성할 필요가 없습니다.

Spring Data JPA가 지원하는 주요 쿼리 메서드 키워드를 정리하면 다음과 같습니다.

| 키워드 | 예시 | 생성되는 쿼리 조건 |
|--------|------|-------------------|
| `findBy` | `findByName(String name)` | `WHERE name = ?` |
| `countBy` | `countByRoomId(Long roomId)` | `SELECT COUNT(*) WHERE room_id = ?` |
| `deleteBy` | `deleteByRoomIdAndUserId(...)` | `DELETE WHERE room_id = ? AND user_id = ?` |
| `And` | `findByNameAndTopic(...)` | `WHERE name = ? AND topic = ?` |
| `OrderBy` | `findByRoomIdOrderByCreatedAtDesc(...)` | `WHERE room_id = ? ORDER BY created_at DESC` |

> `findById(roomId).orElseThrow()`는 해당 ID의 엔티티가 없으면 `NoSuchElementException`을 던집니다. 이 예외는 아래 글로벌 예외 처리에서 404로 변환됩니다.

### 4. 글로벌 예외 처리

각 Controller마다 try-catch로 예외를 처리하면 코드가 반복되고 관리가 어렵습니다. Spring Boot에서는 `@RestControllerAdvice`를 사용해 **모든 Controller의 예외를 한 곳에서 처리**할 수 있습니다.

```java
// src/main/java/com/brainstorm/brainstorm_api/common/exception/GlobalExceptionHandler.java

@RestControllerAdvice  // 모든 Controller에 적용되는 예외 처리기
public class GlobalExceptionHandler {

    // 존재하지 않는 API 경로 → 404
    @ExceptionHandler(NoHandlerFoundException.class)
    public ResponseEntity<String> handlePageNotFound(NoHandlerFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not Found");
    }

    // 존재하지 않는 리소스 조회 (findById 실패 등) → 404
    @ExceptionHandler(NoSuchElementException.class)
    public ResponseEntity<String> handleNotFound(NoSuchElementException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body("Not Found Resource");
    }

    // UniqueConstraint 위반 (중복 즐겨찾기, 중복 멤버 추가 등) → 409
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<String> handleConflict(DataIntegrityViolationException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body("Duplicated Data");
    }

    // 잘못된 상태에서의 요청 → 400
    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<String> handleIllegalState(IllegalStateException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
    }

    // 룸 인원 초과 → 400
    @ExceptionHandler(RoomFullException.class)
    public ResponseEntity<String> handleRoomFullException(RoomFullException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(e.getMessage());
    }

    // 그 외 모든 예외 → 500
    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGeneral(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Internal Error");
    }
}
```

`@RestControllerAdvice`는 `@ControllerAdvice`에 `@ResponseBody`가 결합된 어노테이션입니다. 반환값이 자동으로 JSON(또는 문자열) 응답 본문으로 변환됩니다. 예외 종류별로 적절한 HTTP 상태 코드를 반환하도록 매핑하면, 클라이언트가 상태 코드만 보고도 어떤 종류의 오류인지 판단할 수 있습니다.

핸들러의 등록 순서도 중요합니다. `@ExceptionHandler(Exception.class)`처럼 가장 넓은 범위의 핸들러가 있으면, Spring은 **가장 구체적인 예외 타입에 매칭되는 핸들러를 우선** 선택합니다. 따라서 `RoomFullException` 핸들러와 `Exception` 핸들러가 동시에 있어도, `RoomFullException`이 발생하면 전용 핸들러가 호출됩니다.

### 5. REST 경로 설계 (PathVariable 활용)

멤버와 즐겨찾기 추가/삭제 API는 **Request Body DTO 없이 PathVariable만으로** 구현했습니다.

```java
// src/main/java/com/brainstorm/brainstorm_api/controller/RoomMemberController.java

@RestController
@RequestMapping("/api/rooms/{roomId}/members")
@AllArgsConstructor
public class RoomMemberController {

    private final RoomMemberService roomMemberService;

    // GET /api/rooms/1/members → 룸 1의 전체 멤버 목록
    @GetMapping
    public List<RoomMember> listRoomMember(@PathVariable Long roomId) {
        return roomMemberService.getRoomMembers(roomId);
    }

    // POST /api/rooms/1/members/5 → 룸 1에 유저 5 추가
    @PostMapping("/{userId}")
    public ResponseEntity<RoomMember> addRoomMember(
        @PathVariable Long roomId,
        @PathVariable Long userId) {
        RoomMember save = roomMemberService.save(roomId, userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(save);
    }

    // DELETE /api/rooms/1/members/5 → 룸 1에서 유저 5 제거
    @DeleteMapping("/{userId}")
    public ResponseEntity<Void> deleteRoomMember(
        @PathVariable Long roomId,
        @PathVariable Long userId) {
        roomMemberService.delete(roomId, userId);
        return ResponseEntity.noContent().build();
    }
}
```

`/api/rooms/{roomId}/members/{userId}` 경로 자체에 "룸의 멤버"라는 관계가 표현됩니다. 이런 계층형 URL 설계의 장점은 다음과 같습니다.

- **직관적**: URL만 보고도 어떤 리소스에 대한 작업인지 알 수 있음
- **간결함**: 별도의 Request Body를 만들 필요 없이 PathVariable로 ID 전달
- **RESTful**: 리소스 간의 종속 관계가 URL 구조에 자연스럽게 반영됨

참고로 `ResponseEntity.status(HttpStatus.CREATED)`는 201 상태 코드를 반환하고, `ResponseEntity.noContent().build()`는 204 상태 코드를 본문 없이 반환합니다. REST API에서 생성은 201, 삭제 후 반환할 내용이 없으면 204를 사용하는 것이 관례입니다.

### 6. 통합 테스트

```java
// src/test/java/com/brainstorm/brainstorm_api/service/RoomMemberServiceTest.java

@SpringBootTest
@Transactional  // 각 테스트 종료 후 DB를 롤백해서 테스트 간 독립성 보장
class RoomMemberServiceTest {

    @Test
    void save_shouldThrowRoomFullExceptionWhenRoomIsFull() {
        // given - totalUserCount를 1로 설정해서 이미 가득 찬 상태로 만듦
        // (룸 생성 시 owner가 자동으로 1명 추가되므로 바로 만석)
        room.setTotalUserCount(1);

        // when & then - 인원 초과 시 RoomFullException 발생 확인
        assertThatThrownBy(() -> roomMemberService.save(room.getId(), member.getId()))
            .isInstanceOf(RoomFullException.class)
            .hasMessage("Max Member Exceed!");
    }
}
```

`@SpringBootTest`는 실제 Spring Application Context를 올려서 테스트합니다. 모든 Bean이 생성되고 실제 DB(H2)에 데이터를 저장하고 조회하는 **통합 테스트**입니다.

테스트 클래스에 붙인 `@Transactional`은 서비스 코드의 `@Transactional`과는 다른 목적으로 사용됩니다. 테스트에서의 `@Transactional`은 **각 `@Test` 메서드가 끝날 때 자동으로 롤백**하여, 테스트 간 데이터가 섞이지 않도록 격리해줍니다.

> `assertThatThrownBy`는 AssertJ 라이브러리의 메서드입니다. 특정 코드 실행 시 예외가 발생하는지 검증할 때 사용하며, 예외 타입(`isInstanceOf`)과 메시지(`hasMessage`)를 체이닝으로 깔끔하게 검증할 수 있습니다.

## 주의할 점 (Gotchas & Troubleshooting)

---

### 1. `user` 테이블 이름 예약어 문제

User 엔티티를 처음 만들면 H2에서는 정상 동작할 수 있지만, PostgreSQL에서 `user`는 예약어라 쿼리 오류가 발생합니다. 처음부터 `@Table(name = "users")`를 명시해두면 어떤 DB를 쓰더라도 안전합니다.

```
// PostgreSQL에서 발생하는 오류 예시
ERROR: syntax error at or near "user"
```

### 2. CORS와 Spring Security의 충돌

`WebConfig`에 CORS 설정을 추가해도, Spring Security가 요청을 **먼저 가로채면** CORS 헤더가 응답에 포함되지 않아 프론트엔드에서 CORS 오류가 발생합니다.

해결 방법은 `SecurityConfig`에서 `.cors(Customizer.withDefaults())`를 명시적으로 추가하는 것입니다. 이렇게 하면 Spring Security가 `WebConfig`에 등록된 CORS 설정을 인식하고 적용합니다.

```java
// SecurityConfig.java 에서 CORS 활성화
@Bean
public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http
        .cors(Customizer.withDefaults())  // WebConfig의 CORS 설정을 Spring Security에 연동
        .csrf(csrf -> csrf.disable())
        // ... 나머지 설정
    ;
    return http.build();
}
```

### 3. `@Transactional` 누락 시 데이터 불일치

`RoomService.save()`에서 `@Transactional`을 빼면, Room 저장과 RoomMember 저장이 별도 트랜잭션으로 실행됩니다. Room은 생성됐는데 멤버 추가에서 실패하면 "owner 없는 Room"이 남는 불완전한 상태가 됩니다. 반드시 `@Transactional`로 두 작업을 하나의 트랜잭션으로 묶어야 합니다.

### 4. `totalUserCount` 기본값 미설정 시 NPE

룸 생성 시 `totalUserCount`를 명시적으로 설정하지 않으면 `null`이 저장됩니다. 이후 멤버 추가 시 `roomMembersCount >= room.getTotalUserCount()`에서 auto-unboxing이 일어나면서 `NullPointerException`이 발생합니다. `RoomService.save()`에서 기본값(10)을 세팅하여 이 문제를 방지했습니다.

## 다음 단계 (Next Steps)

---

Phase 1에서 기본적인 CRUD와 도메인 관계를 완성했습니다. 이후 Phase에서 추가할 기능은 다음과 같습니다.

- **인증/인가 적용**: 현재 Spring Security는 전체 허용 상태. JWT 기반 인증 추가 필요
- **Response DTO 분리**: 현재 Entity를 그대로 응답으로 반환 중. DTO로 분리해 불필요한 필드(password 등) 노출 방지
- **WebSocket 통합**: 실시간 브레인스토밍을 위한 WebSocket(STOMP) 연결
- **페이징 응답 개선**: `Page<Room>` 대신 메타데이터를 정리한 커스텀 응답 구조 도입

## 정리 (Key Takeaways)

---

이번 Phase 1에서 배운 핵심 내용을 정리합니다.

1. **도메인 설계**: 다대다 관계는 중간 테이블(RoomMember, Favorite)로 풀고, `@UniqueConstraint`로 중복을 DB 레벨에서 방지한다.
2. **파생 데이터는 저장하지 않는다**: `currentUserCount`처럼 다른 데이터에서 계산 가능한 값은 별도 필드로 저장하지 않고 쿼리로 계산한다. 정합성이 보장된다.
3. **`@Transactional`로 데이터 정합성 보장**: 여러 테이블에 걸친 작업은 반드시 하나의 트랜잭션으로 묶는다.
4. **`@RestControllerAdvice`로 예외 일원화**: 예외 처리를 한 곳에 모아두면 일관된 에러 응답을 유지할 수 있다.
5. **Spring Data JPA 쿼리 메서드**: `countByRoomId`, `findByRoomId` 같은 네이밍 규칙만 따르면 별도의 SQL 없이 쿼리가 자동 생성된다.

## Reference

---

- [Spring Boot 공식 문서 - Error Handling](https://docs.spring.io/spring-boot/reference/web/servlet.html#web.servlet.spring-mvc.error-handling)
- [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [JPA @PrePersist - Jakarta Persistence Specification](https://jakarta.ee/specifications/persistence/)
- `src/main/java/com/brainstorm/brainstorm_api/entity/` -- 전체 엔티티 코드
- `src/main/java/com/brainstorm/brainstorm_api/service/RoomService.java`
- `src/main/java/com/brainstorm/brainstorm_api/service/RoomMemberService.java`
- `src/main/java/com/brainstorm/brainstorm_api/common/exception/GlobalExceptionHandler.java`
- `src/test/java/com/brainstorm/brainstorm_api/service/RoomMemberServiceTest.java`
