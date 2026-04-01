---
title: "[Brainstorm] WebSocket + STOMP로 실시간 채팅 구현하기"
categories:
  - Brainstorm
tags: [Spring Boot, WebSocket, STOMP, SockJS, 실시간채팅]
date: 2026-04-02
---

## Introduction

---

brainstorm-api v2.0에서 브레인스토밍 룸에 실시간 채팅 기능을 추가했다. 기존 REST API 방식으로는 실시간 통신이 불가능하기 때문에 WebSocket과 STOMP 프로토콜을 도입했다. 이 포스트에서는 WebSocket/STOMP의 핵심 개념을 먼저 정리하고, Brainstorm 프로젝트에서 실제로 구현한 코드를 분석하며, 작업 중 겪은 실수들을 공유한다.

**이 글을 읽고 나면** WebSocket과 STOMP의 관계, Spring Boot에서의 설정 방법, 채팅 메시지 저장/조회 흐름, 그리고 REST API와 WebSocket을 함께 사용하는 패턴을 직접 프로젝트에 적용할 수 있다.

## 사전 준비 (Prerequisites)

---

이 글의 코드를 이해하려면 아래 항목에 대한 기본 지식이 필요하다.

- **Java 17** 이상
- **Spring Boot 3.x** 프로젝트 생성 및 실행 경험
- **Spring Data JPA** 기본 개념 (Entity, Repository)
- **REST API** 개념 (GET/POST, Controller, Service 패턴)
- **Lombok** 기본 어노테이션 (`@Getter`, `@Setter`, `@RequiredArgsConstructor`)

**사용 의존성**

```groovy
// build.gradle
implementation 'org.springframework.boot:spring-boot-starter-websocket'
```

Spring Boot의 WebSocket 스타터를 추가하면 STOMP, SockJS 관련 클래스가 모두 포함된다. 별도의 STOMP 라이브러리를 추가할 필요는 없다.

## 핵심 개념: HTTP vs WebSocket vs STOMP

---

구현에 들어가기 전에, 세 가지 프로토콜의 관계를 이해하면 코드가 훨씬 자연스럽게 읽힌다.

### HTTP의 한계

HTTP는 클라이언트가 요청을 보내야만 서버가 응답하는 단방향 통신이다. 채팅처럼 다른 사용자가 메시지를 보낼 때 즉시 받아야 하는 상황에서는 이 방식이 맞지 않는다.

```
HTTP 통신:
  클라이언트 → 요청 → 서버 → 응답 → 연결 종료
  (매번 새로 연결해야 함)

WebSocket 통신:
  클라이언트 ↔ 서버 (한 번 연결하면 양방향 메시지 자유롭게 교환)
```

### WebSocket

**WebSocket**은 최초 연결(handshake) 이후 서버와 클라이언트가 양방향으로 자유롭게 메시지를 주고받을 수 있는 프로토콜이다. 채팅, 알림, 실시간 대시보드 등에 적합하다. 다만 WebSocket 자체는 메시지 형식이나 라우팅 규칙을 정의하지 않는다. "어떤 채팅방에 보내는 메시지인지"를 WebSocket만으로는 구분하기 어렵다.

### STOMP (Simple Text Oriented Messaging Protocol)

**STOMP**는 WebSocket 위에서 동작하는 메시징 프로토콜이다. "구독(Subscribe)/발행(Publish)" 패턴을 제공해서 채팅방 단위 메시지 라우팅을 쉽게 구현할 수 있다.

- 클라이언트가 `/topic/rooms/1`을 구독하면, 룸 1에 발행된 메시지만 수신한다.
- 클라이언트가 `/topic/rooms/2`를 구독하면, 룸 2의 메시지만 수신한다.

즉, WebSocket이 "도로"라면 STOMP는 그 위를 달리는 "우편 시스템"이다. 주소(destination)를 기반으로 메시지를 적절한 수신자에게 배달해준다.

### SockJS

**SockJS**는 WebSocket을 지원하지 않는 오래된 브라우저에서도 동일하게 동작하도록 폴백(fallback)을 제공하는 라이브러리다. WebSocket이 안 되면 HTTP Long Polling 등으로 자동 전환한다. Spring에서는 `.withSockJS()`를 한 줄만 추가하면 활성화된다.

## 구현: 핵심 파일 분석

---

이제 실제 Brainstorm 프로젝트의 코드를 하나씩 살펴보자. 전체 흐름은 다음과 같다.

```
설정(WebSocketConfig) → 엔티티(ChatMessage) → DTO → Repository → Service → Controller
```

### 1. WebSocket 설정 (WebSocketConfig)

```java
// WebSocketConfig.java
@Configuration
@EnableWebSocketMessageBroker  // STOMP 메시지 브로커 기능 활성화
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // 서버 → 클라이언트 메시지 전달 경로 prefix
        // 클라이언트가 이 prefix로 시작하는 경로를 구독(SUBSCRIBE)한다
        registry.enableSimpleBroker("/topic");

        // 클라이언트 → 서버 메시지 전달 경로 prefix
        // 클라이언트가 이 prefix로 시작하는 경로에 메시지를 보내면(SEND),
        // @MessageMapping 핸들러로 라우팅된다
        registry.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // 클라이언트가 WebSocket 연결 시 접속하는 엔드포인트
        registry.addEndpoint("/ws")
            .setAllowedOriginPatterns("*")  // CORS 허용 (개발 환경)
            .withSockJS();                  // SockJS 폴백 활성화
    }
}
```

**`/app`과 `/topic`의 차이가 가장 혼동하기 쉬운 부분이다.** 간단히 정리하면:

| 경로 | 방향 | 용도 | 예시 |
|------|------|------|------|
| `/app/rooms/{roomId}/chat` | 클라이언트 → 서버 | 메시지 **전송** | 채팅 메시지 보내기 |
| `/topic/rooms/{roomId}` | 서버 → 클라이언트 | 메시지 **수신** (구독) | 채팅 메시지 받기 |

`@EnableWebSocketMessageBroker`는 Spring의 STOMP 메시지 브로커를 활성화하는 핵심 어노테이션이다. 이것을 붙여야 `@MessageMapping`, `@SendTo` 등의 어노테이션이 동작한다.

### 2. ChatMessage 엔티티

```java
// ChatMessage.java
@Table
@Entity   // JPA가 이 클래스를 DB 테이블과 매핑하도록 지정
@Getter
@Setter
public class ChatMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne                       // 여러 메시지가 하나의 유저에 속함
    @JoinColumn(name = "user_id")
    private User user;

    @ManyToOne                       // 여러 메시지가 하나의 룸에 속함
    @JoinColumn(name = "room_id")
    private Room room;

    private String content;

    private LocalDateTime createdAt;

    @PrePersist
    void onCreate() {
        // DB에 처음 저장되는 시점에 자동으로 현재 시간을 세팅
        this.createdAt = LocalDateTime.now();
    }
}
```

하나의 채팅 메시지는 **특정 룸**과 **특정 사용자**에 속한다. `@ManyToOne`으로 각각 연관관계를 맺는다. `@PrePersist`를 사용하면 `save()` 호출 시 자동으로 `createdAt`이 설정되므로, 서비스 코드에서 시간을 수동으로 넣지 않아도 된다.

### 3. DTO 설계

요청(Request)과 응답(Response)을 분리해서 DTO를 설계한다.

**요청 DTO - ChatMessageRequest**

```java
// ChatMessageRequest.java
@Getter
@Setter
public class ChatMessageRequest {

    private UUID userId;    // 메시지를 보낸 사용자의 ID
    private String content; // 메시지 내용
}
```

STOMP 메시지의 본문(body)이 이 DTO로 자동 역직렬화된다. REST API와 달리 `@RequestBody`를 붙이지 않아도 된다.

**응답 DTO - ChatMessageResponse**

```java
// ChatMessageResponse.java
@Getter
@Setter
public class ChatMessageResponse {

    private Long id;
    private String nickname;      // User 엔티티의 nickname만 꺼내서 담음
    private String content;
    private LocalDateTime createdAt;

    // 엔티티 → DTO 변환을 담당하는 정적 팩토리 메서드
    public static ChatMessageResponse ofChatMessage(ChatMessage chatMessage) {
        ChatMessageResponse messageResponse = new ChatMessageResponse();
        messageResponse.setId(chatMessage.getId());
        messageResponse.setNickname(chatMessage.getUser().getNickname());
        messageResponse.setContent(chatMessage.getContent());
        messageResponse.setCreatedAt(chatMessage.getCreatedAt());
        return messageResponse;
    }
}
```

응답 DTO에 `User` 엔티티 전체를 담지 않고 `nickname` 필드만 꺼내서 담는 이유:
- **보안**: 이메일, 비밀번호 등 민감 정보가 WebSocket으로 브로드캐스트되는 것을 방지
- **성능**: 응답 크기를 줄여 네트워크 부담 감소

### 4. Repository

```java
// ChatMessageRepository.java
public interface ChatMessageRepository extends JpaRepository<ChatMessage, Long> {

    // 메서드 이름으로 쿼리 자동 생성:
    // "roomId가 일치하는 메시지를 createdAt 오름차순으로 조회"
    List<ChatMessage> findByRoomIdOrderByCreatedAtAsc(Long roomId);
}
```

Spring Data JPA의 메서드 이름 기반 쿼리 생성을 활용한다. 여러 건을 조회하므로 반환 타입은 `List`다. (`Optional`은 단건 조회에만 사용한다 -- 이 부분은 뒤의 "주의할 점"에서 다시 다룬다.)

### 5. ChatService

```java
// ChatService.java
@Service
@RequiredArgsConstructor
public class ChatService {

    private final ChatMessageRepository chatMessageRepository;
    private final RoomRepository roomRepository;
    private final UserRepository userRepository;

    @Transactional
    public ChatMessageResponse save(Long roomId, UUID userId, String content) {
        // roomId, userId로 실제 엔티티를 조회해서 연관관계 설정
        Room room = roomRepository.findById(roomId)
            .orElseThrow(() -> new NoSuchElementException("Not Found Room"));
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new NoSuchElementException("Not Found User"));

        ChatMessage chatMessage = new ChatMessage();
        chatMessage.setRoom(room);
        chatMessage.setUser(user);
        chatMessage.setContent(content);

        chatMessageRepository.save(chatMessage);
        return ChatMessageResponse.ofChatMessage(chatMessage);
    }

    public List<ChatMessageResponse> getChatMessagesByRoomId(Long roomId) {
        List<ChatMessage> chatMessages =
            chatMessageRepository.findByRoomIdOrderByCreatedAtAsc(roomId);
        // 엔티티 리스트를 DTO 리스트로 변환
        return chatMessages.stream().map(ChatMessageResponse::ofChatMessage).toList();
    }
}
```

`save` 메서드에서 `roomId`와 `userId`를 바로 사용하지 않고, 실제 엔티티를 조회해서 연관관계를 설정하는 이유는 JPA가 영속성 컨텍스트에서 관리하는 엔티티 객체를 통해 외래키(FK)를 올바르게 매핑하기 때문이다. 존재하지 않는 룸이나 유저로 메시지를 보내는 경우 `NoSuchElementException`이 발생한다.

### 6. WebSocket 컨트롤러 (ChatController)

```java
// ChatController.java
@Controller                       // @RestController가 아닌 @Controller 사용
@RequiredArgsConstructor
public class ChatController {

    private final ChatService chatService;

    @MessageMapping("/rooms/{roomId}/chat")        // /app/rooms/{roomId}/chat 으로 수신
    @SendTo("/topic/rooms/{roomId}")               // 해당 룸 구독자 전체에게 브로드캐스트
    public ChatMessageResponse sendChatMessages(
        @DestinationVariable Long roomId,          // WebSocket 경로 변수
        ChatMessageRequest chatMessageRequest      // STOMP 본문이 자동 역직렬화됨
    ) {
        return chatService.save(
            roomId,
            chatMessageRequest.getUserId(),
            chatMessageRequest.getContent()
        );
    }
}
```

REST API와 WebSocket 컨트롤러의 차이를 비교해보면:

| REST API | WebSocket (STOMP) | 설명 |
|----------|-------------------|------|
| `@RestController` | `@Controller` | WebSocket은 HTTP 응답을 반환하지 않으므로 |
| `@GetMapping` / `@PostMapping` | `@MessageMapping` | 메시지 수신 경로 지정 |
| `@PathVariable` | `@DestinationVariable` | 경로 변수 추출 |
| `@RequestBody` | (생략) | STOMP는 본문이 자동 바인딩됨 |
| `return ResponseEntity` | `@SendTo` + `return Object` | 구독자에게 브로드캐스트 |

`@MessageMapping`의 경로에는 `@EnableWebSocketMessageBroker` 설정에서 지정한 `/app` prefix가 자동으로 앞에 붙는다. 따라서 클라이언트는 `/app/rooms/{roomId}/chat`으로 메시지를 전송한다.

`@SendTo`의 반환값은 지정된 토픽(`/topic/rooms/{roomId}`)을 구독 중인 모든 클라이언트에게 브로드캐스트된다.

### 7. 히스토리 조회 REST API (ChatRestController)

WebSocket으로 실시간 메시지를 주고받더라도, 채팅방에 늦게 입장한 사람은 이전 메시지를 볼 수 없다. 이를 위해 REST API도 함께 제공한다.

```java
// ChatRestController.java
@RestController
@RequestMapping("/api/rooms")
@RequiredArgsConstructor
public class ChatRestController {

    private final ChatService chatService;

    @GetMapping("/{roomId}/chat")
    public ResponseEntity<ApiResponse<List<ChatMessageResponse>>> listChatMessages(
        @PathVariable Long roomId
    ) {
        List<ChatMessageResponse> messages = chatService.getChatMessagesByRoomId(roomId);
        return ResponseEntity.ok(ApiResponse.success(200, messages));
    }
}
```

**일반적인 채팅 클라이언트의 접속 패턴은 다음과 같다:**

1. 채팅방 입장 시 `GET /api/rooms/{roomId}/chat`으로 이전 메시지 히스토리를 불러온다.
2. `/ws`로 WebSocket 연결을 맺는다.
3. `/topic/rooms/{roomId}`를 구독해서 실시간 메시지를 수신한다.
4. 이후부터는 WebSocket으로만 통신한다.

## 전체 흐름 정리

---

위의 코드들이 어떻게 연결되는지 시퀀스 다이어그램으로 정리하면 다음과 같다.

```
[클라이언트 A]                [Spring Server]              [클라이언트 B]
     |                              |                              |
     |-- /ws 연결 (SockJS) -------->|                              |
     |                              |<-- /ws 연결 (SockJS) --------|
     |-- SUBSCRIBE /topic/rooms/1 ->|<-- SUBSCRIBE /topic/rooms/1--|
     |                              |                              |
     |-- SEND /app/rooms/1/chat --->|                              |
     |   {"userId":"...",           |                              |
     |    "content":"안녕!"}        |                              |
     |                              |                              |
     |                        [ChatController]                     |
     |                        @MessageMapping 수신                 |
     |                              |                              |
     |                        [ChatService.save()]                 |
     |                        DB 저장 (ChatMessage)                |
     |                              |                              |
     |                        @SendTo 브로드캐스트                  |
     |<-- /topic/rooms/1 ---------->|-------- /topic/rooms/1 ----->|
     |   (ChatMessageResponse)      |      (ChatMessageResponse)  |
```

핵심 흐름을 4단계로 요약하면:

1. 클라이언트가 `/ws`로 WebSocket 연결을 맺는다.
2. `/topic/rooms/{roomId}`를 구독해서 메시지 수신 채널을 등록한다.
3. `/app/rooms/{roomId}/chat`으로 메시지를 전송한다.
4. 서버가 DB에 저장 후 `@SendTo`를 통해 `/topic/rooms/{roomId}` 구독자 전체에게 브로드캐스트한다.

## 테스트

---

Service 계층의 단위 테스트로 메시지 저장과 룸 간 격리를 검증한다.

```java
// ChatServiceTest.java
@SpringBootTest
@Transactional
class ChatServiceTest {

    @Test
    void 메시지_저장_성공() {
        ChatMessageResponse response = chatService.save(room.getId(), owner.getId(), "안녕하세요");

        assertThat(response.getId()).isNotNull();
        assertThat(response.getContent()).isEqualTo("안녕하세요");
        assertThat(response.getNickname()).isEqualTo("owner");
        assertThat(response.getCreatedAt()).isNotNull();
    }

    @Test
    void 다른_룸의_메시지는_조회되지_않음() {
        // 각 룸에 메시지 저장
        chatService.save(room.getId(), owner.getId(), "룸1 메시지");
        chatService.save(anotherRoom.getId(), owner.getId(), "룸2 메시지");

        // 룸1 히스토리 조회 시 룸2 메시지는 포함되지 않아야 함
        List<ChatMessageResponse> messages = chatService.getChatMessagesByRoomId(room.getId());

        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).getContent()).isEqualTo("룸1 메시지");
    }

    @Test
    void 메시지_없는_룸_조회_시_빈_리스트() {
        List<ChatMessageResponse> messages = chatService.getChatMessagesByRoomId(room.getId());

        assertThat(messages).isEmpty();
    }
}
```

**룸 간 메시지 격리 테스트가 특히 중요하다.** `findByRoomIdOrderByCreatedAtAsc`의 `roomId` 조건이 제대로 동작하지 않으면, 다른 룸의 메시지가 섞여서 보이는 심각한 버그가 발생한다.

## 주의할 점: 작업 중 만난 실수들

---

실제 구현하면서 겪은 실수들을 정리했다. 초보자가 자주 빠지는 함정이므로 미리 알아두면 도움이 된다.

### `@Entity` 누락

`@Table`만 붙이면 JPA가 해당 클래스를 엔티티로 인식하지 않는다. `@Entity`가 있어야 JPA가 관리하는 영속 객체로 등록된다. `@Entity`만 있어도 동작하지만, 테이블 이름을 명시적으로 지정하려면 `@Table(name = "...")`을 함께 쓴다.

### `@Getter` / `@Setter` 누락

Lombok을 쓰더라도 어노테이션을 빠뜨리면 getter/setter가 생성되지 않는다. JSON 직렬화 시 Jackson이 getter를 찾지 못해 빈 객체(`{}`)가 반환되거나, 역직렬화 시 setter를 찾지 못해 값이 바인딩되지 않는 원인이 된다.

### DTO에 JPA 어노테이션 사용

DTO는 데이터를 전달하는 순수한 Java 객체(POJO)다. `@Id`, `@PrePersist`, `@Entity` 같은 JPA 어노테이션은 엔티티에만 붙여야 한다. DTO에 이런 어노테이션을 붙이면 JPA가 불필요하게 테이블을 생성하려고 시도하거나 예상치 못한 동작이 발생한다.

### Repository 반환 타입을 `Optional`로 선언

`findByRoomId...`처럼 여러 건을 조회하는 경우 `List<ChatMessage>`를 반환해야 한다. `Optional`은 0건 또는 1건을 조회하는 단건 조회에만 적합하다.

```java
// 잘못된 예
Optional<ChatMessage> findByRoomIdOrderByCreatedAtAsc(Long roomId); // 컴파일은 되지만 여러 건이면 예외 발생

// 올바른 예
List<ChatMessage> findByRoomIdOrderByCreatedAtAsc(Long roomId);
```

### STOMP 컨트롤러에 `@RequestBody` 사용

`@MessageMapping` 핸들러에서는 STOMP 메시지 본문이 파라미터에 자동으로 바인딩된다. REST API의 습관으로 `@RequestBody`를 붙이면 역직렬화가 제대로 동작하지 않을 수 있다.

### `@RequiredArgsConstructor` 사용 시 `final` 누락

`@RequiredArgsConstructor`는 `final`로 선언된 필드만 생성자에 포함한다. `final`을 빠뜨리면 의존성 주입이 되지 않아 `NullPointerException`이 발생한다.

```java
// 잘못된 예 - chatService가 주입되지 않음
@Controller
@RequiredArgsConstructor
public class ChatController {
    private ChatService chatService;          // final 누락!
}

// 올바른 예
@Controller
@RequiredArgsConstructor
public class ChatController {
    private final ChatService chatService;    // final 필수
}
```

### `@MessageMapping` 경로 변수명 불일치

```java
// 잘못된 예 - 경로 변수명이 다름
@MessageMapping("/rooms/{roomsId}/chat")               // "roomsId"
public ChatMessageResponse send(@DestinationVariable Long roomId) {  // "roomId"
    // roomId에 null이 바인딩됨!
}
```

`@MessageMapping`의 경로 변수명과 `@DestinationVariable` 파라미터명이 반드시 일치해야 한다.

### 정적 파일 서빙 비활성화

`application.properties`에 `spring.web.resources.add-mappings=false` 설정이 있으면 `chat-test.html` 같은 정적 테스트 파일에 404가 발생한다. 개발 환경 프로파일(`application-dev.properties`)에서 `true`로 오버라이드하면 해결된다.

## 정리

---

이번 포스트에서 다룬 핵심 내용을 요약하면:

- **WebSocket**은 양방향 실시간 통신을 제공하고, **STOMP**는 그 위에 구독/발행 패턴을 추가해서 채팅방 단위 라우팅을 가능하게 한다.
- Spring Boot에서는 `spring-boot-starter-websocket` 하나만 추가하고, `WebSocketMessageBrokerConfigurer`를 구현하면 STOMP 기반 메시징이 활성화된다.
- `@MessageMapping`과 `@SendTo`를 사용하면 REST API 스타일과 유사하게 WebSocket 핸들러를 작성할 수 있다.
- 실시간 WebSocket과 히스토리 조회 REST API를 함께 제공하는 것이 일반적인 채팅 구현 패턴이다.
- `@Entity` 누락, `final` 누락, 경로 변수명 불일치 등 사소한 실수가 디버깅하기 어려운 문제를 만들 수 있으므로 주의하자.

## 다음 단계

---

- **WebSocket 인증 처리**: 현재 `userId`를 요청 본문에 직접 담아 전달하는데, JWT나 세션 기반 인증으로 교체 필요
- **아이디어/코멘트 기능**: v2.0의 나머지 기능 구현
- **AI 아이디어 도출**: v3.0에서 Python AI 서비스 연동 예정

## Reference

---

- [Spring Framework - WebSocket STOMP](https://docs.spring.io/spring-framework/reference/web/websocket/stomp.html) - 공식 레퍼런스
- [Spring Framework - @MessageMapping](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/handle-annotations.html) - 어노테이션 상세
- [Spring Framework - Message Flow](https://docs.spring.io/spring-framework/reference/web/websocket/stomp/message-flow.html) - 메시지 흐름 이해
- `brainstorm-api/src/main/java/.../config/WebSocketConfig.java`
- `brainstorm-api/src/main/java/.../controller/ChatController.java`
- `brainstorm-api/src/main/java/.../service/ChatService.java`
- `brainstorm-api/src/main/java/.../entity/ChatMessage.java`
- `brainstorm-api/src/test/java/.../service/ChatServiceTest.java`
