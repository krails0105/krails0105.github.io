---
layout: single
title: "[SpringBlog] REST API 전환 - @RestController와 DTO 패턴"
categories:
  - SpringBlog
tags:
  - [Spring Boot, REST API, DTO, RestController, ResponseEntity, Jackson]
---

# Introduction

---

블로그에 글을 작성하고 조회하는 기능이 Thymeleaf 기반으로 동작하고 있지만, 모바일 앱이나 React 같은 SPA 프론트엔드에서 이 데이터를 사용하려면 **JSON 기반의 REST API**가 필요합니다.

이번 Phase 8에서는 기존 Thymeleaf 컨트롤러(`@Controller`)를 유지하면서, **REST API 컨트롤러를 별도로 추가**하여 두 방식을 공존시켰습니다. 이 과정에서 `@RestController`, `DTO 패턴`, `ResponseEntity`, `@RequestBody` 등 REST API 개발의 핵심 개념을 다룹니다.

**이 글에서 다루는 내용:**
- `@Controller`와 `@RestController`의 차이와 선택 기준
- DTO(Data Transfer Object) 패턴으로 API 요청/응답 설계
- `ResponseEntity`를 사용한 HTTP 상태 코드 제어
- `@RequestBody`와 Jackson의 JSON 역직렬화 동작 원리
- `Page<DTO>`를 활용한 페이징 API 응답

**전제 조건:**
- [Spring Data JPA 페이징과 검색 구현하기](/springblog/spring-data-jpa-페이징과-검색-구현하기/) 글의 내용이 완료되어 있어야 합니다.
- Spring Boot 3.x, Java 17 환경을 기준으로 합니다.

# 1. 배경 - 왜 REST API가 필요한가?

---

## 기존 Thymeleaf 컨트롤러의 한계

지금까지 구현한 `PostController`는 HTML 페이지를 반환하는 전통적인 MVC 컨트롤러였습니다.

```java
// 기존 PostController.java
@Controller
@RequestMapping("/posts")
public class PostController {

    @GetMapping("/{id}")
    public String viewPost(@PathVariable Long id, Model model) {
        Post post = postService.getPost(id);
        model.addAttribute("post", post);
        return "posts/view";  // Thymeleaf 템플릿 이름 반환
    }
}
```

**문제점**:
- 반환값이 HTML 페이지 이름(String)이므로, JavaScript에서 동적으로 데이터를 로드하거나 모바일 앱에서 사용할 수 없음
- Entity를 직접 JSON으로 반환하면 순환 참조, 불필요한 데이터 노출 등의 문제가 발생

## REST API의 특징

현대 웹 개발에서는 백엔드(API 서버)와 프론트엔드(React, Vue 등)를 분리하는 것이 일반적입니다.

| 특징 | 설명 |
|---|---|
| JSON 형식 | 데이터를 JSON으로 주고받음 |
| HTTP 메서드 | URL + HTTP 메서드로 리소스 조작 (GET=조회, POST=생성, PUT=수정, DELETE=삭제) |
| Stateless | 서버가 클라이언트 상태를 저장하지 않음 |

# 2. 핵심 개념

---

## @Controller vs @RestController

Spring에서는 두 종류의 컨트롤러 어노테이션을 제공합니다.

| 어노테이션 | 반환값 | 용도 | 내부 동작 |
|---|---|---|---|
| `@Controller` | HTML 템플릿 이름 (String) | Thymeleaf, JSP 등 서버 사이드 렌더링 | ViewResolver가 뷰를 찾아 렌더링 |
| `@RestController` | JSON 데이터 (객체) | REST API 서버 | HttpMessageConverter가 객체를 JSON으로 변환 |

`@RestController`는 `@Controller`와 `@ResponseBody`를 합친 것입니다.

```java
// 이 두 코드는 동일하게 동작합니다
@RestController
public class PostApiController { ... }

@Controller
@ResponseBody  // 모든 메서드의 반환값을 HTTP 응답 본문에 직접 작성
public class PostApiController { ... }
```

`@ResponseBody`가 적용되면 반환값을 뷰 이름으로 해석하지 않고, Jackson 라이브러리를 통해 **Java 객체를 JSON으로 직렬화**하여 HTTP 응답 본문(body)에 담습니다. Spring Boot는 `spring-boot-starter-web` 의존성에 Jackson을 기본 포함하고 있으므로 별도 설정 없이 바로 사용할 수 있습니다.

## DTO(Data Transfer Object) 패턴

Entity를 직접 API 응답으로 반환하면 여러 문제가 생깁니다.

**문제 예시**:
```java
// 이렇게 하면 안 됩니다!
@GetMapping("/posts/{id}")
public Post getPost(@PathVariable Long id) {
    return postService.getPost(id);  // Entity 직접 반환
}
```

**Entity 직접 반환 시 발생하는 문제**:

| 문제 | 설명 |
|---|---|
| 순환 참조 | Post -> Category -> Post -> ... 무한 루프로 JSON 직렬화 실패 (`StackOverflowError`) |
| 불필요한 데이터 노출 | Entity의 모든 필드가 JSON에 포함 (민감 정보 유출 가능) |
| API 스펙 고정 | Entity 구조가 바뀌면 API 응답 구조도 함께 바뀜 |
| 유연성 부족 | 클라이언트가 필요한 형태로 데이터를 가공할 수 없음 |

**해결책: DTO 사용**

DTO는 API 요청/응답 전용 객체로, 필요한 데이터만 선별하여 전달합니다.

```text
[클라이언트] <--> [Controller] <--> [Service] <--> [Repository] <--> [DB]
                      ^DTO                              ^Entity
```

**DTO의 두 가지 종류**:

| 종류 | 방향 | Jackson 동작 | 예시 |
|---|---|---|---|
| Request DTO | 클라이언트 -> 서버 | JSON -> Java 객체 (역직렬화) | `PostRequest` |
| Response DTO | 서버 -> 클라이언트 | Java 객체 -> JSON (직렬화) | `PostResponse` |

## REST URL 설계 관례

REST API의 URL은 **리소스 중심**으로 설계하고, **HTTP 메서드로 동작을 구분**합니다.

```text
# Thymeleaf 방식 (동작을 URL에 표현)
GET  /posts/new        -> 글 작성 폼 페이지
POST /posts/create     -> 글 생성 처리
GET  /posts/edit/{id}  -> 글 수정 폼 페이지
POST /posts/delete/{id} -> 글 삭제 처리

# REST API 방식 (HTTP 메서드로 동작 구분)
GET    /api/posts        -> 글 목록 조회
POST   /api/posts        -> 글 생성
GET    /api/posts/{id}   -> 글 상세 조회
PUT    /api/posts/{id}   -> 글 수정
DELETE /api/posts/{id}   -> 글 삭제
```

REST API 방식의 장점:
- URL이 간결하고 일관성 있음
- HTTP 메서드 자체가 의미를 전달하므로 `/new`, `/create`, `/delete` 같은 동사가 불필요
- 같은 URL(`/api/posts/{id}`)에 대해 GET/PUT/DELETE로 다른 동작을 수행

# 3. 구현

---

## 전체 구조 미리보기

이번 Phase에서 추가/변경되는 파일입니다.

```text
src/main/java/com/example/blog/
├── controller/
│   ├── PostController.java        # 기존 Thymeleaf 컨트롤러 (유지)
│   └── PostApiController.java     # [신규] REST API 컨트롤러
├── dto/
│   ├── PostRequest.java           # [신규] 요청 DTO
│   └── PostResponse.java          # [신규] 응답 DTO
├── service/
│   └── PostService.java           # 기존 Service (메서드 추가)
├── entity/
│   └── Post.java                  # 기존 Entity (변경 없음)
└── repository/
    └── PostRepository.java        # 기존 Repository (변경 없음)
```

## 3-1. Response DTO 구현

먼저 API 응답용 DTO를 만듭니다. Post 엔티티에서 **필요한 필드만** 추출하여 JSON 응답에 포함합니다.

```java
// src/main/java/com/example/blog/dto/PostResponse.java
package com.example.blog.dto;

import com.example.blog.entity.Category;
import com.example.blog.entity.Post;
import com.example.blog.entity.Tag;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import lombok.Getter;

// @Getter: Jackson이 직렬화할 때 getter 메서드를 통해 필드값에 접근
// final 필드: 한번 생성되면 변경되지 않는 불변(immutable) 객체로 설계
@Getter
public class PostResponse {

    private final Long id;
    private final String title;
    private final String content;
    private final String categoryName;        // Category 객체 대신 이름만
    private final List<String> tagNames;      // Tag 객체 대신 이름 리스트만
    private final LocalDateTime createdAt;
    private final LocalDateTime updatedAt;

    // Post 엔티티 -> PostResponse DTO 변환 생성자
    public PostResponse(Post post) {
        this.id = post.getId();
        this.title = post.getTitle();
        this.content = post.getContent();

        // null 안전 처리: category가 null이면 null 반환
        this.categoryName = Optional.ofNullable(post.getCategory())
                .map(Category::getName)
                .orElse(null);

        // null 안전 처리: tags가 null이면 빈 리스트 반환
        this.tagNames = Optional.ofNullable(post.getTags())
                .orElse(List.of())
                .stream()
                .map(Tag::getName)
                .toList();

        this.createdAt = post.getCreatedAt();
        this.updatedAt = post.getUpdatedAt();
    }
}
```

**설계 포인트**:

| 특징 | 이유 |
|---|---|
| `final` 필드 + `@Getter` | 응답 DTO는 불변 객체로 설계. setter가 없으므로 생성 후 변경 불가 |
| `Optional.ofNullable` | category나 tags가 null일 수 있으므로 NullPointerException 방지 |
| Category/Tag 객체 대신 이름만 | JSON 응답을 단순하게 유지하고, 순환 참조 문제를 원천 차단 |

**Response DTO에는 setter가 없어도 됩니다.** Jackson이 JSON으로 **직렬화**(Java 객체 -> JSON)할 때는 getter 메서드만 있으면 되기 때문입니다.

## 3-2. Request DTO 구현

클라이언트에서 보내는 JSON을 받을 DTO입니다. Jackson이 JSON -> Java 객체 **역직렬화**를 담당합니다.

```java
// src/main/java/com/example/blog/dto/PostRequest.java
package com.example.blog.dto;

import java.util.List;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

// @NoArgsConstructor + @Setter: Jackson이 JSON을 역직렬화할 때 필요
// 1단계: new PostRequest() -> 기본 생성자로 빈 객체 생성
// 2단계: setTitle("제목") -> setter로 JSON 필드값 주입
@Getter
@Setter
@NoArgsConstructor
public class PostRequest {

    private String title;
    private String content;
    private Long categoryId;          // 카테고리는 ID로 받음
    private List<String> tagNames;    // 태그는 이름 리스트로 받음
}
```

**핵심 포인트 - Jackson 역직렬화 과정**:

```text
클라이언트가 보낸 JSON           Jackson 역직렬화 과정
{                               1. new PostRequest()   <- 기본 생성자
  "title": "제목",              2. setTitle("제목")    <- setter
  "content": "내용",            3. setContent("내용")  <- setter
  "categoryId": 1,              4. setCategoryId(1)    <- setter
  "tagNames": ["Java"]          5. setTagNames(["Java"]) <- setter
}
```

Jackson의 **기본 역직렬화 전략**은 기본 생성자 + setter를 사용하는 방식입니다. 따라서 `@NoArgsConstructor`와 `@Setter`가 필요합니다.

> **참고**: Jackson은 `@JsonCreator` + `@JsonProperty`를 사용한 생성자 기반 역직렬화도 지원합니다. 이 방식을 사용하면 불변 객체로 Request DTO를 설계할 수 있지만, 설정이 복잡해지므로 이 프로젝트에서는 기본 방식을 사용합니다.

**Request DTO vs Response DTO 비교**:

| | Request DTO | Response DTO |
|---|---|---|
| Jackson 동작 | 역직렬화 (JSON -> 객체) | 직렬화 (객체 -> JSON) |
| 기본 생성자 필요 | 필수 (`@NoArgsConstructor`) | 불필요 |
| setter 필요 | 필수 (`@Setter`) | 불필요 |
| getter 필요 | 선택 | 필수 (`@Getter`) |
| 필드 수정 가능 여부 | 가변 (mutable) | 불변 (immutable, `final`) |

## 3-3. REST API Controller 구현

이제 JSON을 주고받는 API 컨트롤러를 만듭니다.

```java
// src/main/java/com/example/blog/controller/PostApiController.java
package com.example.blog.controller;

import com.example.blog.dto.PostRequest;
import com.example.blog.dto.PostResponse;
import com.example.blog.entity.Post;
import com.example.blog.service.PostService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/posts")  // 클래스 레벨에 공통 URL 접두사
@RequiredArgsConstructor
public class PostApiController {

    private final PostService postService;

    // GET /api/posts - 글 목록 조회 (페이징)
    @GetMapping
    public Page<PostResponse> listPosts(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "0") int page) {

        int pageSize = 10;
        Pageable pageable = PageRequest.of(page, pageSize, Sort.by("createdAt").descending());

        Page<Post> posts;
        if (keyword != null && !keyword.isBlank()) {
            posts = postService.searchPosts(keyword, pageable);
        } else if (category != null && !category.isBlank()) {
            posts = postService.getPostsByCategory(category, pageable);
        } else {
            posts = postService.getPosts(pageable);
        }

        // Page의 map(): 페이지 메타 정보는 유지하면서 내용물만 변환
        return posts.map(PostResponse::new);  // Post -> PostResponse 변환
    }

    // GET /api/posts/{id} - 글 상세 조회
    @GetMapping("/{id}")
    public ResponseEntity<PostResponse> getPost(@PathVariable Long id) {
        Post post = postService.getPost(id).orElse(null);
        if (post == null) {
            return ResponseEntity.notFound().build();  // 404 Not Found
        }
        return ResponseEntity.ok(new PostResponse(post));  // 200 OK
    }

    // POST /api/posts - 글 작성
    @PostMapping
    public ResponseEntity<PostResponse> createPost(@RequestBody PostRequest postRequest) {
        PostResponse postResponse = postService.createPost(postRequest);
        return ResponseEntity.status(HttpStatus.CREATED).body(postResponse);  // 201 Created
    }

    // PUT /api/posts/{id} - 글 수정
    @PutMapping("/{id}")
    public ResponseEntity<PostResponse> updatePost(
            @PathVariable Long id,
            @RequestBody PostRequest postRequest) {
        PostResponse postResponse = postService.updatePost(id, postRequest);
        return ResponseEntity.ok(postResponse);  // 200 OK
    }

    // DELETE /api/posts/{id} - 글 삭제
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deletePost(@PathVariable Long id) {
        postService.deletePost(id);
        return ResponseEntity.noContent().build();  // 204 No Content
    }
}
```

**핵심 포인트**:

| 요소 | 설명 |
|---|---|
| `@RequestMapping("/api/posts")` | 클래스 레벨에 공통 URL 접두사를 지정하여 각 메서드에서 중복 제거 |
| `@RequestBody` | HTTP 요청 본문의 JSON을 PostRequest 객체로 역직렬화 |
| `ResponseEntity` | HTTP 상태 코드를 직접 제어 (200, 201, 404, 204 등) |
| `Page<PostResponse>` | 글 목록 + 페이지 메타 정보(totalPages, totalElements 등)를 JSON에 포함 |
| `posts.map(PostResponse::new)` | `Page`의 `map()` 메서드로 내용물만 Post -> PostResponse로 변환 |

## 3-4. Service 계층 변경

Service에서 DTO -> Entity 변환을 처리합니다. **Entity가 DTO를 의존하면 안 되므로**, 변환 로직은 Service 계층에 둡니다.

```java
// src/main/java/com/example/blog/service/PostService.java
package com.example.blog.service;

import com.example.blog.dto.PostRequest;
import com.example.blog.dto.PostResponse;
import com.example.blog.entity.Category;
import com.example.blog.entity.Post;
import com.example.blog.repository.PostRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class PostService {

    private final PostRepository postRepository;
    private final CategoryService categoryService;
    private final TagService tagService;

    // [REST API용] 글 생성
    // PostRequest(DTO) -> Post(Entity) 변환 -> 저장 -> PostResponse(DTO) 반환
    public PostResponse createPost(PostRequest postRequest) {
        Post post = new Post();
        post.setTitle(postRequest.getTitle());
        post.setContent(postRequest.getContent());

        // 카테고리 설정
        setCategory(post, postRequest.getCategoryId());

        // 태그 리스트 -> 쉼표 구분 문자열로 변환
        String tags = postRequest.getTagNames() != null
                ? String.join(",", postRequest.getTagNames())
                : null;

        Post newPost = savePost(post, tags);
        return new PostResponse(newPost);
    }

    // [REST API용] 글 수정 (Upsert 패턴: 없으면 생성)
    public PostResponse updatePost(Long id, PostRequest postRequest) {
        Post post = postRepository.findById(id).orElse(null);
        if (post == null) {
            return createPost(postRequest);  // 글이 없으면 새로 생성
        }

        post.setTitle(postRequest.getTitle());
        post.setContent(postRequest.getContent());
        setCategory(post, postRequest.getCategoryId());

        String tags = postRequest.getTagNames() != null
                ? String.join(",", postRequest.getTagNames())
                : null;

        Post newPost = savePost(post, tags);
        return new PostResponse(newPost);
    }

    // [공통] PostRequest의 categoryId로 Post에 카테고리 설정
    private void setCategory(Post post, Long categoryId) {
        if (categoryId != null) {
            Category category = new Category();
            category.setId(categoryId);
            post.setCategory(category);
        } else {
            post.setCategory(null);
        }
    }

    // 기존 메서드들 (getPosts, searchPosts, getPostsByCategory 등) 은 그대로 유지
    // ...
}
```

**데이터 흐름 정리**:

```text
[POST /api/posts]
클라이언트 -> JSON -> @RequestBody -> PostRequest(DTO)
                                          |
                                    Controller.createPost()
                                          |
                                    Service.createPost(PostRequest)
                                          |
                               PostRequest -> Post(Entity) 변환
                                          |
                               Repository.save(Post) -> DB 저장
                                          |
                               Post(Entity) -> PostResponse(DTO) 변환
                                          |
                                    ResponseEntity<PostResponse>
                                          |
클라이언트 <- JSON <- Jackson 직렬화 <- PostResponse(DTO)
```

**설계 포인트**:

| 원칙 | 설명 |
|---|---|
| 계층 구조 | Controller -> Service -> Repository -> Entity. 안쪽 계층(Entity)이 바깥쪽(DTO)을 의존하면 안 됨 |
| 변환 위치 | DTO <-> Entity 변환은 Service 계층에서 처리 |
| 공통 로직 | `setCategory()`를 private 메서드로 분리하여 createPost/updatePost에서 재사용 |
| null 안전 | `postRequest.getTagNames() != null` 체크로 NullPointerException 방지 |

## 3-5. ResponseEntity와 HTTP 상태 코드

REST API에서는 HTTP 상태 코드로 요청 결과를 명확히 전달해야 합니다. `ResponseEntity`를 사용하면 상태 코드, 헤더, 응답 본문을 모두 제어할 수 있습니다.

**자주 사용하는 HTTP 상태 코드**:

| 상태 코드 | 의미 | 사용 예시 | ResponseEntity 코드 |
|---|---|---|---|
| 200 OK | 성공 (데이터 있음) | 조회, 수정 성공 | `ResponseEntity.ok(body)` |
| 201 Created | 리소스 생성 성공 | POST로 글 작성 | `ResponseEntity.status(HttpStatus.CREATED).body(body)` |
| 204 No Content | 성공 (데이터 없음) | DELETE로 삭제 성공 | `ResponseEntity.noContent().build()` |
| 400 Bad Request | 잘못된 요청 | 유효성 검증 실패 | `ResponseEntity.badRequest().body(error)` |
| 404 Not Found | 리소스 없음 | 존재하지 않는 글 조회 | `ResponseEntity.notFound().build()` |

`ResponseEntity`는 제네릭 타입으로 응답 본문의 타입을 지정합니다. 응답 본문이 없는 경우(204, 404 등) `Void`를 사용하고 `.build()`로 마무리합니다.

```java
// 응답 본문이 있는 경우 -> body()로 마무리
ResponseEntity.ok(postResponse);                               // 200 + body
ResponseEntity.status(HttpStatus.CREATED).body(postResponse);  // 201 + body

// 응답 본문이 없는 경우 -> build()로 마무리
ResponseEntity.notFound().build();    // 404 (body 없음)
ResponseEntity.noContent().build();   // 204 (body 없음)
```

## 3-6. Page<PostResponse> 응답 구조

`Page<PostResponse>`를 반환하면 Jackson이 다음과 같은 JSON을 자동으로 생성합니다.

```json
{
  "content": [
    {
      "id": 1,
      "title": "첫 번째 글",
      "content": "내용...",
      "categoryName": "Spring",
      "tagNames": ["Java", "Spring Boot"],
      "createdAt": "2026-02-16T10:00:00",
      "updatedAt": "2026-02-16T10:00:00"
    }
  ],
  "pageable": {
    "pageNumber": 0,
    "pageSize": 10,
    "sort": {
      "sorted": true,
      "direction": "DESC",
      "property": "createdAt"
    }
  },
  "totalPages": 5,
  "totalElements": 42,
  "last": false,
  "first": true,
  "number": 0,
  "size": 10,
  "numberOfElements": 10
}
```

**JSON 필드 설명**:

| 필드 | 설명 | 프론트엔드 활용 |
|---|---|---|
| `content` | 현재 페이지의 실제 데이터 목록 | 글 목록 렌더링 |
| `totalPages` | 전체 페이지 수 | 페이지네이션 UI (1 / 5) |
| `totalElements` | 전체 데이터 개수 | "총 42개의 글" 표시 |
| `first` / `last` | 첫/마지막 페이지 여부 | 이전/다음 버튼 활성화 |
| `number` | 현재 페이지 번호 (0부터 시작) | 현재 페이지 하이라이트 |
| `size` | 페이지 크기 | 페이지당 표시 개수 |

**Post -> PostResponse 변환 방법**:

```java
Page<Post> posts = postService.getPosts(pageable);
return posts.map(PostResponse::new);  // Page의 map() 메서드 활용
```

`Page.map()`은 페이지의 메타 정보(totalPages, totalElements 등)는 그대로 유지하면서 `content`의 각 요소만 변환합니다. 직접 루프를 돌며 새로운 Page를 생성할 필요가 없어 코드가 간결합니다.

## API 테스트 (curl)

구현이 완료되면 curl로 API를 테스트할 수 있습니다.

```bash
# 글 목록 조회
curl -s http://localhost:8080/api/posts | python3 -m json.tool

# 글 상세 조회
curl -s http://localhost:8080/api/posts/1 | python3 -m json.tool

# 글 작성
curl -X POST http://localhost:8080/api/posts \
  -H "Content-Type: application/json" \
  -d '{
    "title": "새 글 제목",
    "content": "글 내용입니다.",
    "categoryId": 1,
    "tagNames": ["Java", "Spring"]
  }'

# 글 수정
curl -X PUT http://localhost:8080/api/posts/1 \
  -H "Content-Type: application/json" \
  -d '{
    "title": "수정된 제목",
    "content": "수정된 내용입니다."
  }'

# 글 삭제
curl -X DELETE http://localhost:8080/api/posts/1 -v
# 204 No Content 응답 확인
```

> `-H "Content-Type: application/json"`을 빠뜨리면 Spring이 JSON으로 인식하지 못해 `415 Unsupported Media Type` 에러가 발생합니다.

# 4. 주의할 점 (Gotchas)

---

## 1. Request DTO에 기본 생성자 + Setter 필수

Jackson의 기본 역직렬화 전략은 기본 생성자로 빈 객체를 만든 뒤 setter로 필드값을 채우는 방식입니다.

```java
// 잘못된 예: Jackson 역직렬화 실패
// 에러: Cannot construct instance (no Creators, like default construct, exist)
@Getter
public class PostRequest {
    private final String title;

    public PostRequest(String title) {
        this.title = title;
    }
}

// 올바른 예: @NoArgsConstructor + @Setter
@Getter
@Setter
@NoArgsConstructor
public class PostRequest {
    private String title;
}
```

기본 생성자가 없으면 Jackson은 `InvalidDefinitionException: Cannot construct instance` 에러를 발생시킵니다.

## 2. @RequestBody에 String 타입을 사용하면 안 되는 이유

```java
// 잘못된 예: JSON 전체가 하나의 문자열로 들어옴
@PostMapping
public ResponseEntity<?> createPost(@RequestBody String body) {
    System.out.println(body);
    // 출력: {"title":"제목","content":"내용"}  (JSON 문자열 자체)
}

// 올바른 예: DTO 객체로 받으면 Jackson이 JSON을 파싱
@PostMapping
public ResponseEntity<?> createPost(@RequestBody PostRequest postRequest) {
    System.out.println(postRequest.getTitle());
    // 출력: 제목  (파싱된 필드값)
}
```

`@RequestBody`에 `String`을 지정하면 Jackson이 파싱하지 않고 JSON 전체를 문자열로 받습니다. DTO 클래스를 지정해야 Jackson의 `MappingJackson2HttpMessageConverter`가 자동으로 JSON -> 객체 변환을 수행합니다.

## 3. Entity가 DTO를 의존하면 안 되는 이유

계층 구조상 Entity는 가장 안쪽에 위치하므로, 바깥쪽 계층(Controller, Service, DTO)을 알아서는 안 됩니다.

```text
[바깥] Controller -> Service -> Repository -> Entity [안쪽]
           ^DTO                                ^
           의존 방향은 바깥 -> 안쪽만 허용
```

```java
// 잘못된 예: Entity가 DTO를 import -> 계층 구조 위반
public class Post {
    public static Post of(PostRequest postRequest) {  // Entity가 DTO를 알게 됨
        Post post = new Post();
        post.setTitle(postRequest.getTitle());
        return post;
    }
}

// 올바른 예: Service에서 DTO -> Entity 변환
@Service
public class PostService {
    public PostResponse createPost(PostRequest postRequest) {
        Post post = new Post();
        post.setTitle(postRequest.getTitle());
        // ...
    }
}
```

Entity가 DTO를 의존하면 API 요청 형식이 바뀔 때마다 Entity까지 수정해야 하며, Entity의 재사용성이 떨어집니다.

## 4. REST URL에서 슬래시(/) 누락

```java
// 잘못된 예: /api/posts{id} (슬래시 누락)
@DeleteMapping("{id}")

// 올바른 예: /api/posts/{id}
@DeleteMapping("/{id}")
```

슬래시를 빼먹으면 `/api/posts{id}` 같은 잘못된 URL이 매핑됩니다. 클래스 레벨의 `@RequestMapping("/api/posts")`와 메서드 레벨의 `@DeleteMapping("/{id}")`가 합쳐져서 최종 URL이 결정되므로, 메서드 레벨 경로의 시작 슬래시를 확인해야 합니다.

## 5. Content-Type 헤더 누락

`@RequestBody`가 있는 API를 호출할 때 `Content-Type: application/json` 헤더를 포함해야 합니다.

```bash
# 에러: 415 Unsupported Media Type
curl -X POST http://localhost:8080/api/posts \
  -d '{"title":"제목"}'

# 정상: Content-Type 헤더 포함
curl -X POST http://localhost:8080/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"제목"}'
```

Spring MVC는 `Content-Type` 헤더를 보고 어떤 `HttpMessageConverter`를 사용할지 결정합니다. 헤더가 없거나 `application/json`이 아니면 Jackson이 동작하지 않습니다.

## 6. @RequestBody의 required 속성

```java
// 불필요한 코드: required = true는 기본값
@PostMapping
public ResponseEntity<?> createPost(@RequestBody(required = true) PostRequest postRequest) {
    // ...
}

// 간결한 코드: required = true 생략
@PostMapping
public ResponseEntity<?> createPost(@RequestBody PostRequest postRequest) {
    // ...
}
```

`@RequestBody`는 기본적으로 `required = true`이므로, 요청 본문이 없으면 `HttpMessageNotReadableException`이 발생합니다. 명시적으로 `required = true`를 작성할 필요는 없습니다. 만약 요청 본문이 선택적인 경우에만 `@RequestBody(required = false)`를 사용합니다.

## 7. null 안전 처리

API 응답에서 null 값이 있을 수 있으므로 안전하게 처리해야 합니다.

```java
// Optional.ofNullable로 null 안전 처리
this.categoryName = Optional.ofNullable(post.getCategory())
        .map(Category::getName)
        .orElse(null);

// List는 null 대신 빈 리스트 반환 (프론트엔드에서 null 체크 불필요)
this.tagNames = Optional.ofNullable(post.getTags())
        .orElse(List.of())
        .stream()
        .map(Tag::getName)
        .toList();

// Service에서도 null 체크 후 변환
String tags = postRequest.getTagNames() != null
        ? String.join(",", postRequest.getTagNames())
        : null;
```

특히 List 타입의 경우, null 대신 빈 리스트(`List.of()`)를 반환하면 프론트엔드에서 별도의 null 체크 없이 바로 순회할 수 있습니다.

# 5. 정리

---

## @Controller vs @RestController 비교

| | @Controller | @RestController |
|---|---|---|
| 반환값 해석 | ViewResolver가 뷰 이름으로 해석 | HttpMessageConverter가 JSON으로 변환 |
| 내부 구성 | @Controller | @Controller + @ResponseBody |
| 응답 형식 | HTML (템플릿 렌더링) | JSON (데이터) |
| 대표 사용처 | Thymeleaf, JSP 기반 웹 페이지 | REST API, SPA 백엔드 |

## DTO 패턴 핵심

| 원칙 | 설명 |
|---|---|
| Entity 직접 반환 금지 | 순환 참조, 데이터 노출, API 스펙 고정 문제 방지 |
| Request/Response 분리 | 요청과 응답의 데이터 구조가 다를 수 있으므로 별도 DTO 설계 |
| 변환 위치 | DTO <-> Entity 변환은 Service 계층에서 처리 |
| 의존 방향 | Controller(DTO) -> Service -> Repository -> Entity (안쪽에서 바깥쪽을 알면 안 됨) |

## 이 Phase에서 사용한 주요 어노테이션/클래스

| 어노테이션/클래스 | 역할 |
|---|---|
| `@RestController` | JSON 응답을 반환하는 API 컨트롤러 선언 |
| `@RequestMapping` | 클래스/메서드 레벨 URL 매핑 |
| `@RequestBody` | HTTP 요청 본문의 JSON을 Java 객체로 역직렬화 |
| `ResponseEntity<T>` | HTTP 상태 코드 + 응답 본문을 함께 제어 |
| `@GetMapping` / `@PostMapping` / `@PutMapping` / `@DeleteMapping` | HTTP 메서드별 URL 매핑 |
| `Page<T>` | 페이징 결과 + 메타 정보 (totalPages, totalElements 등) |
| `PageRequest.of()` | Pageable 구현체 생성 (페이지 번호, 크기, 정렬) |

# 다음 단계 (Next Steps)

---

**Phase 9: 프론트엔드 분리 (React + Vite)**

이제 REST API가 준비되었으니, 다음 단계는 React로 프론트엔드를 구현하는 것입니다.

**예정 작업**:
1. React + Vite 프로젝트 세팅
2. Axios로 REST API 호출
3. 글 목록/상세/작성/수정/삭제 UI 구현
4. React Router로 라우팅 설정
5. Spring Boot + React 통합 배포

**참고사항**:
- 기존 Thymeleaf 컨트롤러는 유지 (관리자 페이지 등에 활용)
- CORS 설정 필요 (React dev server와 Spring Boot API 서버 포트가 다르므로)
- JWT 인증 추가 고려

# Reference

---

**프로젝트 파일**:
- Controller: `src/main/java/com/example/blog/controller/PostApiController.java`
- Response DTO: `src/main/java/com/example/blog/dto/PostResponse.java`
- Request DTO: `src/main/java/com/example/blog/dto/PostRequest.java`
- Service: `src/main/java/com/example/blog/service/PostService.java`

**관련 문서**:
- [Spring Boot - REST API](https://spring.io/guides/gs/rest-service/)
- [Spring Framework - @RestController](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-restcontroller.html)
- [Spring Framework - @RequestBody](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-methods/requestbody.html)
- [Spring Framework - ResponseEntity](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-methods/responseentity.html)
- [Spring Data JPA - Paging and Sorting](https://docs.spring.io/spring-data/jpa/reference/repositories/query-methods-details.html#repositories.special-parameters)
- [Jackson JSON 처리](https://www.baeldung.com/jackson)
- [DTO 패턴](https://martinfowler.com/eaaCatalog/dataTransferObject.html)
