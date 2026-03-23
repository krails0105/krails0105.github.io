---
layout: single
title: "[Spring] Jackson JSON 역직렬화 - Request DTO에 @Setter가 필요한 이유"
categories:
  - Spring
tags: [Spring Boot, Jackson, JSON, DTO, Lombok, Deserialization]
---

## Introduction

---

Spring Boot로 REST API를 개발하다 보면 자연스럽게 DTO(Data Transfer Object)를 만들게 됩니다. 그런데 Request DTO와 Response DTO를 비교해 보면 붙는 어노테이션이 다릅니다.

```java
// Request DTO - 어노테이션 3개
@Getter @Setter @NoArgsConstructor
public class CommentRequest { ... }

// Response DTO - 어노테이션 1개
@Getter
public class CommentResponse { ... }
```

왜 Request DTO에만 `@Setter`와 `@NoArgsConstructor`가 필요할까요? 이 포스트에서는 Jackson이 JSON을 Java 객체로 변환하는 **역직렬화(Deserialization)** 과정을 따라가며 그 이유를 설명합니다. 이 과정을 이해하면 "@Setter를 빠뜨려서 값이 전부 null이 되는" 흔한 버그를 사전에 예방할 수 있습니다.

## 1. Jackson이란

---

Spring Boot에서 클라이언트가 JSON을 보내면, 그 JSON 문자열을 Java 객체로 변환하는 작업이 필요합니다. 이 변환을 담당하는 라이브러리가 **Jackson**입니다.

Spring Boot는 `spring-boot-starter-web` 의존성에 Jackson(`jackson-databind`)을 기본으로 포함하고 있어서 별도 설정이나 의존성 추가 없이 바로 사용할 수 있습니다.

Jackson이 하는 일은 크게 두 가지입니다.

| 방향 | 용어 | 예시 |
|------|------|------|
| Java 객체 --> JSON 문자열 | **직렬화** (Serialization) | 응답 DTO를 JSON으로 변환해서 클라이언트에 전송 |
| JSON 문자열 --> Java 객체 | **역직렬화** (Deserialization) | 클라이언트가 보낸 JSON을 Request DTO로 변환 |

컨트롤러에서 `@RequestBody` 어노테이션이 붙은 파라미터를 보면, Spring이 내부적으로 Jackson의 `ObjectMapper`를 사용해 역직렬화를 수행합니다.

```java
// Jackson이 JSON --> CommentRequest 객체로 변환해줌
@PostMapping("/api/posts/{postId}/comments")
public ResponseEntity<CommentResponse> createComment(
        @PathVariable Long postId,
        @RequestBody CommentRequest request) { ... }
//      ^^^^^^^^^^^^
//      이 어노테이션이 있으면 Spring이 Jackson을 호출해서
//      HTTP 요청 본문(JSON)을 CommentRequest 객체로 자동 변환
```

## 2. 역직렬화 2단계 과정

---

Jackson이 JSON을 Java 객체로 변환할 때, 기본적으로 **두 단계**를 거칩니다.

### 1단계: 기본 생성자로 빈 객체 생성

Jackson은 가장 먼저 **아무 인자도 없는 기본 생성자(no-args constructor)**를 호출해서 빈 객체를 만듭니다.

```java
// Jackson이 내부적으로 이렇게 호출함
CommentRequest request = new CommentRequest();
// 이 시점에서 content, author, password는 모두 null
```

이 단계가 가능하려면 클래스에 **기본 생성자가 반드시 있어야** 합니다. Lombok의 `@NoArgsConstructor`가 이 기본 생성자를 자동으로 생성해줍니다.

```java
// @NoArgsConstructor가 생성해주는 코드
public CommentRequest() {
    // 빈 생성자 - 아무 일도 하지 않음
}
```

> **참고**: Java에서는 아무 생성자도 작성하지 않으면 컴파일러가 기본 생성자를 자동으로 만들어줍니다. 그런데 다른 생성자(예: `@AllArgsConstructor`)를 추가하면 기본 생성자가 사라집니다. 이때 `@NoArgsConstructor`를 명시해야 Jackson이 정상 동작합니다.

### 2단계: setter로 JSON 필드값 주입

빈 객체를 만든 뒤, JSON의 각 키에 해당하는 **setter 메서드**를 찾아 값을 하나씩 채워 넣습니다.

클라이언트가 아래 JSON을 전송했다면:

```json
{
  "content": "좋은 글이네요",
  "author": "방문자",
  "password": "1234"
}
```

Jackson은 내부적으로 다음과 같이 동작합니다.

```java
// JSON 키 "content" → setContent() 호출
request.setContent("좋은 글이네요");

// JSON 키 "author" → setAuthor() 호출
request.setAuthor("방문자");

// JSON 키 "password" → setPassword() 호출
request.setPassword("1234");
```

Lombok의 `@Setter`가 이 setter 메서드들을 자동으로 생성해줍니다.

```java
// @Setter가 생성해주는 코드 (각 필드마다 하나씩)
public void setContent(String content) { this.content = content; }
public void setAuthor(String author) { this.author = author; }
public void setPassword(String password) { this.password = password; }
```

전체 흐름을 그림으로 정리하면 다음과 같습니다.

```
클라이언트가 보낸 JSON
{"content":"좋은 글이네요", "author":"방문자", "password":"1234"}
           │
           ▼
  ┌─────────────────────────┐
  │ 1단계: new CommentRequest()  │  ← @NoArgsConstructor
  │    (빈 객체 생성)             │
  └─────────────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │ 2단계: setContent(...)       │  ← @Setter
  │        setAuthor(...)        │
  │        setPassword(...)      │
  │    (JSON 값 하나씩 주입)      │
  └─────────────────────────┘
           │
           ▼
  CommentRequest 객체 완성!
```

### @Setter가 없으면?

`@Setter`를 빠뜨리면 Jackson이 값을 주입할 setter 메서드를 찾지 못합니다. 이때 Jackson은 에러를 던지지 않고 **조용히 건너뛰기 때문에**, 모든 필드가 `null`로 남습니다. 컴파일 에러도 없고 런타임 예외도 없어서 디버깅하기 까다로운 버그가 됩니다.

```java
// @Setter가 없는 경우의 동작
@Getter
@NoArgsConstructor
public class CommentRequest {    // @Setter 누락!
    private String content;
    private String author;
    private String password;
}

// 클라이언트가 {"content":"좋은 글이네요"}를 보내도...
CommentRequest request = ...;  // Jackson이 역직렬화한 객체
System.out.println(request.getContent());  // null  <-- 값이 들어오지 않음!
System.out.println(request.getAuthor());   // null
```

## 3. Request DTO vs Response DTO 어노테이션 비교

---

역직렬화(JSON --> Java)와 직렬화(Java --> JSON)의 동작 방식이 다르기 때문에, Request DTO와 Response DTO에 필요한 어노테이션도 달라집니다.

### Request DTO (클라이언트 --> 서버)

```java
// com/example/blog/dto/CommentRequest.java

// @NoArgsConstructor: Jackson이 기본 생성자로 빈 객체를 만들기 위해 필요
// @Setter: Jackson이 setter로 JSON 값을 주입하기 위해 필요
// @Getter: Service/Controller에서 값을 읽기 위해 필요
@Getter
@Setter
@NoArgsConstructor
public class CommentRequest {

    private String content;   // 댓글 내용
    private String author;    // 작성자 닉네임
    private String password;  // 댓글 비밀번호
}
```

역직렬화에는 `@NoArgsConstructor`(빈 객체 생성)와 `@Setter`(값 주입)가 필수입니다. `@Getter`는 Jackson이 아니라 서비스 계층에서 값을 꺼내 읽기 위해 필요합니다.

### Response DTO (서버 --> 클라이언트)

```java
// com/example/blog/dto/CommentResponse.java

// @Getter만 있으면 됨: Jackson이 getter를 읽어서 JSON으로 직렬화하기 때문
// @Setter 불필요: 서버가 직접 생성자로 값을 설정하므로 Jackson이 setter를 호출하지 않음
@Getter
public class CommentResponse {

    private final Long id;
    private final String content;
    private final String author;
    private final LocalDateTime createdAt;
    private final LocalDateTime updatedAt;

    // 서버가 직접 생성자로 값을 채워서 내보냄
    public CommentResponse(Comment comment) {
        this.id = comment.getId();
        this.content = comment.getContent();
        this.author = comment.getAuthor();
        this.createdAt = comment.getCreatedAt();
        this.updatedAt = comment.getUpdatedAt();
    }
}
```

직렬화(Java --> JSON) 시 Jackson은 **getter 메서드**를 호출해서 JSON 키와 값을 구성합니다. `getContent()`가 있으면 `"content": "값"` 형태로 JSON을 생성하는 방식입니다. 이 방향에서는 setter나 기본 생성자가 필요하지 않습니다. Response DTO 객체는 서버 코드에서 직접 생성자를 호출해서 만들기 때문입니다.

#### 비교 요약표

| 구분 | @NoArgsConstructor | @Setter | @Getter | 이유 |
|------|:-----------------:|:-------:|:-------:|------|
| Request DTO | 필요 | 필요 | 필요 | 역직렬화: 빈 객체 생성 --> setter로 값 주입 |
| Response DTO | 불필요 | 불필요 | 필요 | 직렬화: getter로 값 읽어 JSON 생성 |

## 4. PostRequest로 추가 확인

---

같은 패턴이 `PostRequest`에도 동일하게 적용되어 있습니다.

```java
// com/example/blog/dto/PostRequest.java

@Setter
@Getter
@NoArgsConstructor
public class PostRequest {

    private String title;
    private String content;
    private Long categoryId;          // 카테고리 ID
    private List<String> tagNames;    // 태그 이름 목록 (예: ["Java", "Spring"])
}
```

`List<String>` 같은 컬렉션 타입도 동일하게 동작합니다. 클라이언트가 `"tagNames": ["Java", "Spring"]`을 전송하면 Jackson이 `setTagNames()`를 호출하여 `List<String>`으로 변환합니다.

```json
{
  "title": "Spring 시작하기",
  "content": "본문 내용",
  "categoryId": 1,
  "tagNames": ["Java", "Spring"]
}
```

```java
// Jackson이 내부적으로 수행하는 동작
PostRequest request = new PostRequest();       // 1단계: 빈 객체 생성
request.setTitle("Spring 시작하기");             // 2단계: setter로 값 주입
request.setContent("본문 내용");
request.setCategoryId(1L);
request.setTagNames(List.of("Java", "Spring"));  // List도 setter로 주입
```

## 5. 주의할 점

---

### @Setter를 누락해도 컴파일 에러가 없다

가장 흔한 실수입니다. Jackson은 setter를 찾지 못하면 에러를 던지지 않고 **해당 필드를 건너뜁니다**. 그 결과 모든 필드가 `null`로 남아, `NullPointerException`이 예상치 못한 곳에서 발생할 수 있습니다.

```java
// 흔한 디버깅 시나리오
@PostMapping("/api/posts/{postId}/comments")
public ResponseEntity<CommentResponse> createComment(
        @PathVariable Long postId,
        @RequestBody CommentRequest request) {

    // request.getContent()가 null이면 여기서 NPE 발생 가능!
    Comment comment = commentService.saveComment(postId, request);
    return ResponseEntity.status(HttpStatus.CREATED)
            .body(new CommentResponse(comment));
}
```

"JSON은 제대로 보냈는데 왜 필드가 null이지?" 라는 상황이 생기면, 가장 먼저 **`@Setter`와 `@NoArgsConstructor`가 붙어 있는지** 확인해 보세요.

### Response DTO에 @Setter를 달지 않는 이유

Response DTO는 서버가 데이터를 내보내는 객체이므로, 외부에서 값을 변경할 수 없도록 **`final` 필드와 생성자만 사용**하는 것이 안전합니다. 실수로 `@Setter`를 붙이면 비즈니스 로직 어딘가에서 응답값이 의도치 않게 변경될 위험이 있습니다.

```java
// 나쁜 예: Response DTO에 @Setter가 있으면 위험
@Getter @Setter  // <-- @Setter가 있으면 누군가 실수로 값을 바꿀 수 있음
public class CommentResponse {
    private String content;  // final이 아니면 setter로 변경 가능
}

// 좋은 예: final + 생성자로 불변 보장
@Getter
public class CommentResponse {
    private final String content;  // final이므로 생성 후 변경 불가
}
```

### @JsonCreator를 활용한 불변 Request DTO (대안)

`@Setter` 없이 역직렬화하는 방법도 있습니다. 생성자에 `@JsonCreator`를, 각 파라미터에 `@JsonProperty`를 붙이면 Jackson이 setter 대신 **생성자를 통해 직접 값을 주입**합니다.

```java
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;

public class CommentRequest {
    private final String content;
    private final String author;
    private final String password;

    @JsonCreator
    public CommentRequest(
            @JsonProperty("content") String content,
            @JsonProperty("author") String author,
            @JsonProperty("password") String password) {
        this.content = content;
        this.author = author;
        this.password = password;
    }

    // getter만 필요 (setter 불필요, 기본 생성자도 불필요)
    public String getContent() { return content; }
    public String getAuthor() { return author; }
    public String getPassword() { return password; }
}
```

이 방식은 필드를 `final`로 선언할 수 있어 **불변(immutable) DTO**를 만들 수 있다는 장점이 있습니다. 다만 필드가 많아질수록 생성자가 복잡해지므로, 일반적인 Request DTO에서는 `@Setter` + `@NoArgsConstructor` 조합이 더 실용적입니다.

| 방식 | 필요한 어노테이션 | 장점 | 단점 |
|------|------------------|------|------|
| setter 기반 (기본) | `@NoArgsConstructor` + `@Setter` | 코드가 간결, Lombok으로 자동 생성 | 가변(mutable) 객체 |
| 생성자 기반 | `@JsonCreator` + `@JsonProperty` | 불변 객체 가능 | 필드 많으면 생성자가 복잡 |

## 정리

---

| 질문 | 답변 |
|------|------|
| Jackson이란? | Spring Boot에서 JSON <--> Java 객체 변환을 담당하는 라이브러리 |
| 역직렬화 1단계 | `@NoArgsConstructor`로 만든 기본 생성자를 호출해 빈 객체 생성 |
| 역직렬화 2단계 | `@Setter`로 만든 setter를 호출해 JSON 필드값을 하나씩 주입 |
| @Setter 없으면? | 컴파일 에러 없이 모든 필드가 `null`로 남음 (조용한 실패) |
| Response DTO에 @Setter가 없는 이유 | 직렬화는 getter만 필요하고, `final` 필드로 불변 설계하는 것이 안전하기 때문 |
| @Setter 없이 역직렬화하려면? | `@JsonCreator` + `@JsonProperty`로 생성자 기반 역직렬화 가능 |

## Reference

---

- 실제 코드: `spring-blog/backend/src/main/java/com/example/blog/dto/CommentRequest.java`
- 실제 코드: `spring-blog/backend/src/main/java/com/example/blog/dto/CommentResponse.java`
- 실제 코드: `spring-blog/backend/src/main/java/com/example/blog/dto/PostRequest.java`
- [Jackson GitHub - jackson-databind](https://github.com/FasterXML/jackson-databind)
- [Lombok - @Getter and @Setter](https://projectlombok.org/features/GetterSetter)
- [Lombok - Constructor annotations](https://projectlombok.org/features/constructor)
