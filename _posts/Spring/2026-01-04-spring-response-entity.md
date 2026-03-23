---
layout: single
title: "[Spring] ResponseEntity vs 직접 반환 - HTTP 상태 코드 제어하기"
date: 2026-02-22
categories:
  - Spring
tags: [Spring Boot, REST API, ResponseEntity, HTTP Status Code]
---

## Introduction

---

Spring MVC로 REST API를 만들다 보면 컨트롤러 메서드의 반환 타입을 두 가지 방식으로 작성할 수 있다는 걸 알게 됩니다.

```java
// 방식 1: 객체 직접 반환
public Page<CommentResponse> listComments(...) { ... }

// 방식 2: ResponseEntity로 감싸서 반환
public ResponseEntity<CommentResponse> createComment(...) { ... }
```

"어차피 JSON으로 변환되는 거 아닌가? 뭐가 다른 거지?" 라는 의문이 들 수 있습니다. 이 포스트에서는 두 방식의 차이와 언제 어떤 방식을 써야 하는지를 정리합니다.

이 글을 읽고 나면 다음을 알게 됩니다.

- HTTP 응답의 구성 요소 (상태 코드, 헤더, 본문)
- 객체 직접 반환과 `ResponseEntity` 반환의 차이
- 상황별로 어떤 방식을 선택해야 하는지
- 실무에서 주의해야 할 함정들

## HTTP 응답의 구성 요소

---

`ResponseEntity`가 왜 필요한지 이해하려면 먼저 HTTP 응답이 어떻게 구성되는지 알아야 합니다. HTTP 응답에는 세 가지 핵심 요소가 있습니다.

| 구성 요소 | 역할 | 예시 |
|-----------|------|------|
| **상태 코드(Status Code)** | 요청 처리 결과를 나타내는 숫자 | `200`, `201`, `404` |
| **헤더(Headers)** | 응답에 대한 메타 정보 | `Content-Type: application/json` |
| **본문(Body)** | 실제 데이터 | `{"id": 1, "content": "댓글 내용"}` |

Spring의 `@RestController`에서 객체를 반환하면 **본문(Body)의 JSON 직렬화는 자동으로 처리**됩니다. 그런데 **상태 코드는 어떻게 될까요?** 기본값은 항상 `200 OK`입니다.

REST API에서 올바른 상태 코드를 반환하는 것은 단순히 "형식 맞추기"가 아닙니다. 클라이언트(브라우저, 앱 등)는 상태 코드를 보고 **"요청이 어떻게 처리됐는지"**를 판단하기 때문입니다. 예를 들어, 프론트엔드에서 `201 Created`를 받으면 "새 데이터가 만들어졌구나"라고 판단하고, `404 Not Found`를 받으면 에러 메시지를 표시합니다.

#### 자주 사용하는 HTTP 상태 코드

| 상태 코드 | 의미 | 언제 쓰는가 |
|-----------|------|-------------|
| `200 OK` | 성공 | 조회, 수정 완료 |
| `201 Created` | 새 리소스 생성 성공 | POST로 데이터 추가 |
| `204 No Content` | 성공, 반환 데이터 없음 | DELETE 성공 |
| `400 Bad Request` | 잘못된 요청 | 유효성 검증 실패 |
| `404 Not Found` | 리소스 없음 | 존재하지 않는 ID 조회 |

## ResponseEntity란?

---

`ResponseEntity`는 Spring이 제공하는 클래스로, **HTTP 응답 전체(상태 코드 + 헤더 + 본문)를 하나의 객체로 표현**합니다. Spring 공식 문서에서는 `ResponseEntity`를 "`@ResponseBody`와 동일하지만, 상태 코드와 헤더를 추가로 제어할 수 있는 것"이라고 설명합니다.

```
ResponseEntity = 상태 코드 + 헤더 + 본문
```

`ResponseEntity`는 빌더 패턴으로 다양한 팩토리 메서드를 제공합니다.

| 팩토리 메서드 | 상태 코드 | 용도 |
|--------------|-----------|------|
| `ResponseEntity.ok(body)` | `200 OK` | 조회/수정 성공 |
| `ResponseEntity.status(HttpStatus.CREATED).body(body)` | `201 Created` | 새 리소스 생성 |
| `ResponseEntity.noContent().build()` | `204 No Content` | 삭제 성공 (본문 없음) |
| `ResponseEntity.notFound().build()` | `404 Not Found` | 리소스 없음 (본문 없음) |
| `ResponseEntity.badRequest().body(body)` | `400 Bad Request` | 잘못된 요청 |

## 두 가지 반환 방식

---

### 방식 1: 객체 직접 반환 - Spring이 알아서 200 OK

```java
// ResponseEntity 없이 Page<CommentResponse>를 바로 반환
// Spring이 자동으로 200 OK + JSON 변환 처리
@GetMapping("/posts/{postId}/comments")
public Page<CommentResponse> listComments(
        @PathVariable Long postId,
        @RequestParam(defaultValue = "0") int page) {

    int pageSize = 5;
    Pageable pageable = PageRequest.of(page, pageSize, Sort.by("createdAt").descending());
    Page<Comment> comments = commentService.getComments(postId, pageable);
    return comments.map(CommentResponse::new);
}
```

`listComments`는 조회 API입니다. 성공하면 항상 `200 OK`를 반환하면 됩니다. 이 경우에는 굳이 `ResponseEntity`를 쓸 필요가 없습니다. `@RestController` 안에서 객체를 반환하면 Spring이 다음 두 가지를 자동으로 처리합니다.

1. 반환 객체를 JSON으로 직렬화 (Jackson 라이브러리가 처리)
2. HTTP 상태 코드를 `200 OK`로 설정

### 방식 2: ResponseEntity 사용 - 상태 코드를 직접 지정

```java
// 댓글 작성 성공 시 200이 아닌 201 Created를 반환해야 함
@PostMapping("/posts/{postId}/comments")
public ResponseEntity<CommentResponse> createComment(
        @PathVariable Long postId,
        @RequestBody CommentRequest commentRequest) {

    Comment comment = commentService.saveComment(postId, commentRequest);
    // ResponseEntity.status(HttpStatus.CREATED): 201 상태 코드 지정
    // .body(...): 응답 본문에 데이터 담기
    return ResponseEntity.status(HttpStatus.CREATED).body(new CommentResponse(comment));
}
```

댓글 작성은 새로운 리소스를 생성하는 작업입니다. REST 관례상 이 경우에는 `200 OK`가 아닌 **`201 Created`**를 반환하는 것이 올바릅니다. 객체를 직접 반환하면 상태 코드가 `200`으로 고정되므로, `ResponseEntity`가 필요합니다.

## 실제 코드로 보는 패턴 정리

---

`CommentApiController`에서 사용된 네 가지 패턴을 정리하면 다음과 같습니다.

```java
// 패턴 1: 직접 반환 (200 OK 고정)
// 댓글 목록 조회 - 성공하면 항상 200 OK이므로 ResponseEntity 불필요
@GetMapping("/posts/{postId}/comments")
public Page<CommentResponse> listComments(...) {
    return comments.map(CommentResponse::new);
}

// 패턴 2: 201 Created (새 리소스 생성)
// 댓글 작성 - REST 관례상 생성 성공은 201
@PostMapping("/posts/{postId}/comments")
public ResponseEntity<CommentResponse> createComment(...) {
    return ResponseEntity.status(HttpStatus.CREATED).body(new CommentResponse(comment));
}

// 패턴 3: 200 OK (ResponseEntity로 명시적 표현)
// 댓글 수정 - 직접 반환과 결과는 동일하지만, 다른 메서드와 일관성 유지
@PutMapping("/comments/{id}")
public ResponseEntity<CommentResponse> updateComment(...) {
    return ResponseEntity.ok(new CommentResponse(comment));
}

// 패턴 4: 204 No Content (삭제 성공, 반환 데이터 없음)
// 댓글 삭제 - 성공했지만 클라이언트에 돌려줄 데이터가 없음
@DeleteMapping("/comments/{id}")
public ResponseEntity<Void> deleteComment(...) {
    commentService.deleteComment(id, commentDeleteRequest.getPassword());
    return ResponseEntity.noContent().build();
}
```

`PostApiController`에서는 `ResponseEntity`를 활용해 **조건에 따라 다른 상태 코드를 반환**하는 패턴도 볼 수 있습니다.

```java
// 패턴 5: 조건부 상태 코드 (200 OK 또는 404 Not Found)
// 게시글 조회: 존재하면 200, 없으면 404 반환
@GetMapping("/{id}")
public ResponseEntity<PostResponse> getPost(@PathVariable Long id) {
    Post post = postService.getPost(id).orElse(null);
    if (post == null) {
        // 404 Not Found: 리소스가 없을 때
        return ResponseEntity.notFound().build();
    }
    // 200 OK: 정상 조회
    return ResponseEntity.ok(new PostResponse(post));
}
```

조회 결과가 없을 수도 있는 경우, 객체를 직접 반환하면 `null`을 반환하거나 예외를 던지는 방식으로 처리해야 합니다. `ResponseEntity`를 사용하면 **하나의 메서드에서 상황에 따라 다른 상태 코드를 깔끔하게 반환**할 수 있습니다.

## ResponseEntity.ok() vs 직접 반환: 완전히 같은가?

---

```java
// 이 둘은 HTTP 응답 측면에서 완전히 동일합니다.

// 방법 A: 직접 반환
public CommentResponse updateComment(...) {
    return new CommentResponse(comment);  // 200 OK + JSON
}

// 방법 B: ResponseEntity.ok()
public ResponseEntity<CommentResponse> updateComment(...) {
    return ResponseEntity.ok(new CommentResponse(comment));  // 200 OK + JSON
}
```

클라이언트가 받는 HTTP 응답은 완전히 동일합니다. 상태 코드, 헤더, 본문 모두 같습니다.

**그럼 왜 `ResponseEntity.ok()`를 쓰기도 할까요?**

컨트롤러 안에서의 **일관성** 때문입니다. 한 컨트롤러 안에 `ResponseEntity`를 반환하는 메서드와 직접 반환하는 메서드가 섞여 있으면 코드 스타일이 일관적이지 않습니다. 이미 `ResponseEntity`를 쓰는 메서드가 여럿 있다면, 200을 반환하는 메서드도 `ResponseEntity.ok()`로 통일하는 것이 읽기 편합니다.

또 다른 이유로, `ResponseEntity`를 사용하면 **커스텀 헤더를 추가**할 수 있습니다. 직접 반환으로는 헤더를 제어할 수 없습니다.

```java
// ResponseEntity로만 가능한 커스텀 헤더 추가
return ResponseEntity.ok()
        .header("X-Custom-Header", "value")
        .body(new CommentResponse(comment));
```

## list vs get 네이밍 관례

---

코드를 보다 보면 `listComments`, `getPost`처럼 메서드 이름이 다른 것을 볼 수 있습니다. 이것은 Spring 커뮤니티에서 널리 쓰이는 네이밍 관례입니다.

| 접두사 | 의미 | 예시 |
|--------|------|------|
| `list` | 여러 건 조회 (컬렉션, 페이지) | `listComments`, `listPosts` |
| `get` | 단건 조회 (ID로 하나) | `getPost`, `getComment` |
| `create` | 새 리소스 생성 | `createComment`, `createPost` |
| `update` | 기존 리소스 수정 | `updateComment`, `updatePost` |
| `delete` | 리소스 삭제 | `deleteComment`, `deletePost` |

반드시 지켜야 하는 규칙은 아니지만, 코드를 읽는 사람이 "이 메서드는 목록을 반환하겠구나", "이건 단건이겠구나"를 즉시 알 수 있어서 가독성이 좋아집니다.

## 실무에서 주의할 점

---

#### 1. `ResponseEntity<Void>` 사용 시 `.body()`를 호출하지 않기

`204 No Content`를 반환할 때 실수로 `.body(null)`을 넣으면 불필요한 혼란이 생깁니다. `.build()`로 마무리하는 것이 올바른 패턴입니다.

```java
// 올바른 패턴
return ResponseEntity.noContent().build();

// 피해야 할 패턴 (동작은 하지만 의도가 불분명)
return ResponseEntity.noContent().body(null);
```

#### 2. `ResponseEntity`와 `@ResponseStatus`를 동시에 쓰지 않기

`@ResponseStatus` 어노테이션으로도 상태 코드를 지정할 수 있습니다. 하지만 `ResponseEntity`와 함께 사용하면 **`ResponseEntity`의 상태 코드가 우선 적용**되어 혼란을 줄 수 있습니다.

```java
// 주의: @ResponseStatus(201)과 ResponseEntity.ok()(200)이 충돌
// 실제로는 ResponseEntity의 200이 적용됨
@PostMapping("/posts/{postId}/comments")
@ResponseStatus(HttpStatus.CREATED)  // 이 어노테이션은 무시됨
public ResponseEntity<CommentResponse> createComment(...) {
    return ResponseEntity.ok(new CommentResponse(comment));  // 200이 적용됨
}
```

하나의 메서드에서 상태 코드를 지정하는 방법은 하나만 사용하는 것이 좋습니다.

#### 3. 예외 상황의 상태 코드는 `@ExceptionHandler`로 분리 고려하기

컨트롤러 메서드 안에서 `try-catch`로 예외를 잡아 상태 코드를 바꾸는 것보다, `@ExceptionHandler`를 사용해 예외 처리를 분리하는 것이 더 깔끔합니다. 특히 여러 컨트롤러에서 동일한 예외 처리가 반복된다면 `@ControllerAdvice`와 함께 사용하면 중복을 줄일 수 있습니다.

```java
// 피해야 할 패턴: 컨트롤러 메서드마다 try-catch 반복
@GetMapping("/{id}")
public ResponseEntity<PostResponse> getPost(@PathVariable Long id) {
    try {
        Post post = postService.getPost(id);
        return ResponseEntity.ok(new PostResponse(post));
    } catch (EntityNotFoundException e) {
        return ResponseEntity.notFound().build();
    }
}

// 개선 패턴: @ExceptionHandler로 예외 처리를 분리
// 컨트롤러 메서드는 비즈니스 로직에만 집중
@GetMapping("/{id}")
public PostResponse getPost(@PathVariable Long id) {
    return new PostResponse(postService.getPost(id));  // 없으면 예외 발생
}

// 같은 컨트롤러 또는 @ControllerAdvice 클래스에 예외 핸들러 정의
@ExceptionHandler(EntityNotFoundException.class)
public ResponseEntity<Void> handleNotFound(EntityNotFoundException e) {
    return ResponseEntity.notFound().build();
}
```

## 정리

---

| 상황 | 반환 방식 | 예시 |
|------|-----------|------|
| 항상 200 OK만 반환하면 되는 경우 | 객체 직접 반환 | `listComments`, `listPosts` |
| 200이 아닌 상태 코드가 필요한 경우 | `ResponseEntity` 사용 | `createComment` (201) |
| 상황에 따라 다른 상태 코드 반환 | `ResponseEntity` 사용 | `getPost` (200/404) |
| 응답 본문 없이 상태 코드만 반환 | `ResponseEntity<Void>` | `deleteComment` (204) |
| 커스텀 헤더를 추가해야 하는 경우 | `ResponseEntity` 사용 | ETag, Cache-Control 등 |
| 컨트롤러 내 일관성을 맞추고 싶을 때 | `ResponseEntity.ok()` 사용 | `updateComment` |

핵심은 단순합니다. **200 OK 하나만 반환하면 될 때는 직접 반환, 다른 상태 코드가 필요하거나 헤더를 제어해야 하면 `ResponseEntity`를 사용**합니다.

## Reference

---

- [Spring 공식 문서 - ResponseEntity](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-methods/responseentity.html)
- [Spring 공식 문서 - @ResponseBody](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-methods/responsebody.html)
- [MDN - HTTP 상태 코드](https://developer.mozilla.org/ko/docs/Web/HTTP/Status)
