---
layout: single
title: "[SpringBlog] Spring Data JPA 페이징과 검색 - Pageable, Page, 쿼리 메서드 활용하기"
categories:
  - SpringBlog
tags:
  - [Spring Boot, Spring Data JPA, Pageable, Thymeleaf, Query Methods]
---

# Introduction

---

블로그에 글이 늘어나면 전체 글을 한 번에 보여주는 것은 비효율적입니다. 수백 개의 글을 한 페이지에 표시하면 로딩이 느리고 사용자 경험도 나빠집니다. 또한 원하는 글을 빠르게 찾기 위한 검색 기능도 필수입니다.

이번 Phase 6에서는 Spring Blog 프로젝트에 **페이징(Pagination)과 검색(Search) 기능**을 추가했습니다.

이 글에서 다루는 내용:
- Spring Data JPA의 Pageable과 Page 인터페이스를 사용한 페이징 구현
- Spring Data JPA 쿼리 메서드로 검색 기능 구현
- Thymeleaf 템플릿에서 Page 객체 사용법
- 페이징과 검색 조건을 함께 유지하는 방법

# 배경 (Problem & Context)

---

## 왜 페이징이 필요한가?

모든 데이터를 한 번에 조회하는 방식의 문제점:

| 문제 | 설명 |
|---|---|
| 성능 저하 | 수백 개의 데이터를 DB에서 한 번에 가져오면 메모리 사용량 증가 |
| 느린 렌더링 | 브라우저가 긴 HTML을 렌더링하는 데 시간이 걸림 |
| 사용자 경험 | 스크롤이 너무 길어져서 원하는 글을 찾기 어려움 |
| 네트워크 낭비 | 사용자가 보지 않을 데이터까지 전송 |

페이징을 사용하면 **한 번에 10개씩만 조회**하여 이 문제를 해결합니다. DB에 `LIMIT`와 `OFFSET`을 적용하여 필요한 데이터만 가져오는 방식입니다.

## 검색 기능의 필요성

카테고리 필터링만으로는 부족합니다. 사용자는 다음과 같은 방식으로 글을 찾고 싶어 합니다:

- "Spring Boot"가 포함된 모든 글 찾기
- 제목에 "JPA"가 들어간 글 찾기
- 내용에 "Pageable"이 언급된 글 찾기

이를 위해 **제목 또는 내용에서 키워드를 검색하는 기능**이 필요합니다.

## List vs Page 반환 타입

기존 코드와 변경된 코드를 비교해 보겠습니다.

**Phase 5까지 (페이징 없음):**
```java
// Repository
List<Post> findAll();

// Service
public List<Post> getPosts() {
    return postRepository.findAll();
}

// Controller
List<Post> posts = postService.getPosts();
model.addAttribute("posts", posts);

// Thymeleaf
th:each="post : ${posts}"
```

**Phase 6 (페이징 적용):**
```java
// Repository
Page<Post> findAll(Pageable pageable);  // List -> Page

// Service
public Page<Post> getPosts(Pageable pageable) {  // List -> Page, Pageable 추가
    return postRepository.findAll(pageable);
}

// Controller
Page<Post> posts = postService.getPosts(pageable);  // List -> Page
model.addAttribute("posts", posts);

// Thymeleaf
th:each="post : ${posts.content}"  // posts -> posts.content
```

**핵심 차이점**:

| | List | Page |
|---|---|---|
| 반환 데이터 | 글 목록만 | 글 목록 + 메타 정보 (전체 페이지 수, 현재 페이지 번호 등) |
| Repository 파라미터 | 없음 | Pageable |
| Thymeleaf 접근 | `${posts}` | `${posts.content}` (실제 목록), `${posts.totalPages}` (전체 페이지 수) |

# 접근 방법 (Approach)

---

## Pageable과 Page 인터페이스

Spring Data JPA는 페이징을 위한 두 가지 핵심 인터페이스를 제공합니다.

### Pageable - 페이징 요청 정보

**역할**: "몇 번째 페이지를 몇 개씩 보여줄까?"라는 **요청 정보**를 담는 객체입니다.

**생성 방법**:
```java
// 기본 형태: 페이지 번호, 페이지 크기
Pageable pageable = PageRequest.of(0, 10);  // 첫 페이지(0), 10개씩

// 정렬 포함
Pageable pageable = PageRequest.of(0, 10, Sort.by("createdAt").descending());

// 여러 기준으로 정렬
Sort multiSort = Sort.by("createdAt").descending()
                     .and(Sort.by("title").ascending());
Pageable pageable = PageRequest.of(0, 10, multiSort);
```

**파라미터 설명**:

| 파라미터 | 타입 | 설명 | 예시 |
|---|---|---|---|
| page | int | 페이지 번호 (0부터 시작) | 0 = 첫 페이지, 1 = 두 번째 페이지 |
| size | int | 한 페이지에 보여줄 항목 개수 | 10 = 10개씩 표시 |
| sort | Sort | 정렬 기준 (선택) | `Sort.by("createdAt").descending()` |

**주의**: 페이지 번호는 **0부터 시작**합니다. 첫 페이지가 0, 두 번째 페이지가 1입니다.

### Page - 페이징 결과 정보

**역할**: "조회된 데이터 + 페이징 메타 정보"를 담는 **응답 객체**입니다.

**주요 메서드**:

| 메서드 | 반환 타입 | 설명 | 예시 |
|---|---|---|---|
| `getContent()` | `List<T>` | 현재 페이지의 실제 데이터 목록 | 1~10번째 글 |
| `getTotalElements()` | long | 전체 데이터 개수 | 전체 글 개수 (예: 95개) |
| `getTotalPages()` | int | 전체 페이지 수 | 전체 페이지 수 (예: 10페이지) |
| `getNumber()` | int | 현재 페이지 번호 (0부터 시작) | 3 (4번째 페이지) |
| `getSize()` | int | 페이지 크기 | 10 |
| `hasNext()` | boolean | 다음 페이지가 있는지 여부 | true/false |
| `hasPrevious()` | boolean | 이전 페이지가 있는지 여부 | true/false |
| `isFirst()` | boolean | 첫 페이지인지 여부 | true/false |
| `isLast()` | boolean | 마지막 페이지인지 여부 | true/false |

**예시**:
```java
Page<Post> posts = postRepository.findAll(pageable);

posts.getContent();          // [Post1, Post2, ..., Post10]
posts.getTotalElements();    // 95L (전체 글 개수)
posts.getTotalPages();       // 10 (95개 / 10개 = 10페이지)
posts.getNumber();           // 0 (현재 첫 페이지)
posts.hasNext();             // true (다음 페이지 있음)
posts.hasPrevious();         // false (이전 페이지 없음)
posts.isFirst();             // true (첫 페이지)
posts.isLast();              // false (마지막 페이지 아님)
```

### Page vs Slice

Spring Data JPA는 `Page` 외에 `Slice`라는 반환 타입도 제공합니다.

| | Page | Slice |
|---|---|---|
| 전체 개수 조회 | O (`getTotalElements()`, `getTotalPages()`) | X |
| 추가 COUNT 쿼리 | 자동 실행 | 실행하지 않음 |
| 성능 | 느림 (COUNT 쿼리 추가 비용) | 빠름 |
| 적합한 상황 | 전체 페이지 수를 보여줘야 할 때 | "더 보기" 버튼만 필요할 때 |

`Page`를 사용하면 `SELECT COUNT(*)` 쿼리가 자동으로 추가 실행됩니다. 전체 페이지 수를 표시할 필요가 없다면 `Slice`가 더 효율적입니다. **이 프로젝트에서는 "1 / 10" 형태로 전체 페이지 수를 보여주므로 `Page`를 사용했습니다.**

## Spring Data JPA 쿼리 메서드

Spring Data JPA는 **메서드 이름만으로 쿼리를 자동 생성**합니다. SQL을 직접 작성하지 않아도 됩니다.

### 기본 규칙

메서드 이름을 다음 패턴으로 작성하면 자동으로 쿼리가 생성됩니다:

```
findBy + 필드명 + 조건키워드
```

**예시**:

| 메서드 이름 | 생성되는 SQL | 설명 |
|---|---|---|
| `findByTitle(String title)` | `WHERE title = ?` | 제목이 정확히 일치 |
| `findByTitleContaining(String keyword)` | `WHERE title LIKE '%keyword%'` | 제목에 키워드 포함 |
| `findByCategory(Category category)` | `WHERE category = ?` | 카테고리가 일치 |
| `findByTitleOrContent(String t, String c)` | `WHERE title = ? OR content = ?` | 제목 또는 내용이 일치 |

### 주요 조건 키워드

| 키워드 | SQL | 예시 |
|---|---|---|
| (없음) | `= ?` | `findByTitle` -> `WHERE title = ?` |
| `Containing` | `LIKE '%?%'` | `findByTitleContaining` -> `WHERE title LIKE '%?%'` |
| `StartingWith` | `LIKE '?%'` | `findByTitleStartingWith` -> `WHERE title LIKE '?%'` |
| `EndingWith` | `LIKE '%?'` | `findByTitleEndingWith` -> `WHERE title LIKE '%?'` |
| `Or` | `OR` | `findByTitleOrContent` -> `WHERE title = ? OR content = ?` |
| `And` | `AND` | `findByTitleAndCategory` -> `WHERE title = ? AND category = ?` |
| `IgnoreCase` | `UPPER(?) = UPPER(?)` | `findByTitleIgnoreCase` -> 대소문자 무시 |

> `Containing`, `StartingWith`, `EndingWith` 키워드는 각각 `Contains`/`IsContaining`, `StartsWith`/`IsStartingWith`, `EndsWith`/`IsEndingWith`로도 사용할 수 있습니다. 공식 문서에서는 `Containing`, `StartingWith`, `EndingWith` 형태를 사용합니다. 또한 이 키워드들은 인자에 포함된 LIKE 와일드카드 문자(`%`, `_`)를 자동으로 이스케이프 처리하므로, 사용자 입력을 안전하게 검색할 수 있습니다.

### Or 조건에서 파라미터 규칙

**중요**: `Or`를 사용할 때는 **각 조건마다 별도 파라미터가 필요**합니다.

```java
// 제목 또는 내용에 키워드가 포함된 글 검색
Page<Post> findByTitleContainingOrContentContaining(
    String titleKeyword,   // 제목 검색용 키워드
    String contentKeyword, // 내용 검색용 키워드
    Pageable pageable
);
```

**잘못된 방식 (파라미터 부족)**:
```java
// 파라미터가 2개 필요한데 1개만 선언 -> Spring Data JPA가 메서드 파싱에 실패하여 애플리케이션 시작 시 에러 발생
Page<Post> findByTitleContainingOrContentContaining(String keyword, Pageable pageable);
```

**올바른 방식**:
```java
// 같은 keyword를 두 번 넘김
postRepository.findByTitleContainingOrContentContaining(keyword, keyword, pageable);
```

### Pageable 파라미터 위치 관례

Spring Data JPA에서 `Pageable`과 `Sort` 같은 특수 파라미터는 항상 **마지막 파라미터**로 넣습니다. Spring Data JPA가 이 파라미터들을 자동으로 인식하여 페이징/정렬 처리에 사용합니다.

```java
// 올바른 순서: 검색 조건 파라미터 뒤에 Pageable
Page<Post> findByCategory(Category category, Pageable pageable);
Page<Post> findByTitleContaining(String keyword, Pageable pageable);
```

## 검색 메서드 분리 vs 통합

검색 기능을 구현하는 방법은 두 가지가 있습니다.

### 방법 1: 별도 메서드로 분리

```java
@GetMapping("/posts")
public String listPosts(Model model) {
    List<Post> posts = postService.getPosts();
    model.addAttribute("posts", posts);
    return "posts/list";
}

@GetMapping("/posts/search")
public String searchPosts(@RequestParam String keyword, Model model) {
    List<Post> posts = postService.searchPosts(keyword);
    model.addAttribute("posts", posts);
    return "posts/list";
}
```

### 방법 2: 하나의 메서드에서 통합 처리

```java
@GetMapping("/posts")
public String listPosts(
    @RequestParam(required = false) String category,
    @RequestParam(required = false) String keyword,
    @RequestParam(defaultValue = "0") int page,
    Model model
) {
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
    model.addAttribute("posts", posts);
    return "posts/list";
}
```

**비교**:

| | 방법 1 (분리) | 방법 2 (통합) |
|---|---|---|
| URL | `/posts`, `/posts/search` | `/posts?keyword=...` |
| 코드 중복 | 높음 (model.addAttribute 반복) | 낮음 |
| 유지보수 | 어려움 (수정 시 여러 곳 변경) | 쉬움 (한 곳만 수정) |
| URL 일관성 | 낮음 (경로가 다름) | 높음 (쿼리 파라미터만 다름) |

**Phase 6에서는 방법 2를 선택했습니다.** 코드 중복이 적고 URL이 일관적이기 때문입니다.

# 구현 (Key Code & Commands)

---

## 1. PostRepository에 페이징 메서드 추가

```java
// spring-blog/src/main/java/com/example/blog/repository/PostRepository.java
package com.example.blog.repository;

import com.example.blog.entity.Category;
import com.example.blog.entity.Post;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PostRepository extends JpaRepository<Post, Long> {

    // 카테고리별 글 목록 조회 (페이징 포함)
    // Spring Data JPA 쿼리 메서드: findBy + 필드명 -> WHERE category = ? 쿼리 자동 생성
    // Pageable을 파라미터에 추가하면 페이징 처리가 자동으로 적용됨
    Page<Post> findByCategory(Category category, Pageable pageable);

    // 제목 또는 내용에 키워드가 포함된 글 검색 (페이징 포함)
    // Containing -> SQL의 LIKE '%keyword%' (부분 일치 검색)
    // Or -> 두 조건 중 하나만 맞아도 결과에 포함
    // 주의: Or 조건에서는 각 조건마다 별도 파라미터가 필요 (같은 값을 두 번 넘겨야 함)
    Page<Post> findByTitleContainingOrContentContaining(
        String titleKeyword,
        String contentKeyword,
        Pageable pageable
    );
}
```

**핵심 포인트**:
- JpaRepository의 기본 `findAll()`은 `List`를 반환하지만, `findAll(Pageable)`은 `Page`를 반환합니다.
- 쿼리 메서드에 `Pageable`을 추가하면 자동으로 `LIMIT`와 `OFFSET`이 SQL에 추가됩니다.
- `Page`를 반환하면 전체 개수를 구하기 위한 `SELECT COUNT(*)` 쿼리도 자동으로 실행됩니다.

## 2. PostService에 페이징 메서드 구현

```java
// spring-blog/src/main/java/com/example/blog/service/PostService.java
@Service
@RequiredArgsConstructor
public class PostService {

    private final PostRepository postRepository;
    private final CategoryService categoryService;

    // 전체 글 목록 조회 (페이징)
    // Pageable: 몇 번째 페이지를, 몇 개씩 보여줄지 정보를 담은 객체
    // Page<Post>: 글 목록 + 전체 페이지 수, 현재 페이지 번호 등 메타 정보를 함께 반환
    public Page<Post> getPosts(Pageable pageable) {
        return postRepository.findAll(pageable);
    }

    // 카테고리별 글 목록 조회 (페이징)
    // 카테고리 이름으로 Category 엔티티를 먼저 조회한 후, 해당 카테고리의 글 목록을 반환
    public Page<Post> getPostsByCategory(String categoryName, Pageable pageable) {
        Category category = categoryService.getCategory(categoryName).orElseThrow();
        return postRepository.findByCategory(category, pageable);
    }

    // 제목 또는 내용으로 글 검색 (페이징)
    // 같은 keyword를 두 번 넘기는 이유: Repository 메서드에서 Or 조건의 각 필드마다 파라미터가 필요
    public Page<Post> searchPosts(String keyword, Pageable pageable) {
        return postRepository.findByTitleContainingOrContentContaining(keyword, keyword, pageable);
    }
}
```

**왜 keyword를 두 번 넘기나?**
- `findByTitleContainingOrContentContaining(String titleKeyword, String contentKeyword, Pageable)`
- 메서드 시그니처에 파라미터가 2개 필요하므로, 같은 값을 두 번 전달합니다.
- 만약 제목과 내용에 다른 키워드를 검색하고 싶다면 별도 파라미터로 받을 수도 있습니다.

## 3. PostController에서 페이징 처리

```java
// spring-blog/src/main/java/com/example/blog/controller/PostController.java
@Controller
@RequiredArgsConstructor
public class PostController {

    private final PostService postService;

    // GET /posts -> 글 목록 페이지 (검색 + 카테고리 필터 + 페이징 통합 처리)
    // 하나의 메서드에서 3가지 경우를 처리:
    //   /posts                -> 전체 글 목록
    //   /posts?category=Java  -> 카테고리별 필터링
    //   /posts?keyword=spring -> 키워드 검색
    // @RequestParam(defaultValue = "0"): page 파라미터가 없으면 기본값 0 (첫 페이지)
    @GetMapping("/posts")
    public String listPosts(
        @RequestParam(required = false) String category,
        @RequestParam(required = false) String keyword,
        @RequestParam(defaultValue = "0") int page,
        Model model
    ) {
        // PageRequest.of(페이지 번호, 페이지 크기, 정렬 기준)
        // 페이지 번호는 0부터 시작. Sort.by("createdAt").descending() -> 최신 글이 먼저
        Page<Post> posts;
        int pageSize = 10;
        Pageable pageable = PageRequest.of(page, pageSize, Sort.by("createdAt").descending());

        // 검색 키워드가 있으면 검색, 카테고리가 있으면 필터링, 둘 다 없으면 전체 조회
        if (keyword != null && !keyword.isBlank()) {
            posts = postService.searchPosts(keyword, pageable);
        } else if (category != null && !category.isBlank()) {
            posts = postService.getPostsByCategory(category, pageable);
        } else {
            posts = postService.getPosts(pageable);
        }

        model.addAttribute("posts", posts);
        return "posts/list";
    }
}
```

**핵심 포인트**:
- `@RequestParam(defaultValue = "0")`: URL에 `page` 파라미터가 없으면 0(첫 페이지)을 기본값으로 사용합니다.
- `if-else` 분기로 검색/필터링/전체 조회를 한 메서드에서 처리합니다.
- 정렬은 `Sort.by("createdAt").descending()`으로 최신 글이 먼저 보이도록 설정합니다.

## 4. Thymeleaf 템플릿에서 Page 객체 사용

```html
<!-- spring-blog/src/main/resources/templates/posts/list.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org"
      xmlns:layout="http://www.ultraq.net.nz/thymeleaf/layout"
      layout:decorate="~{layout/default}">
<head>
    <title>Posts</title>
</head>
<body>

<main layout:fragment="content">
    <h1>Posts</h1>
    <a class="btn btn-primary" th:href="@{/posts/new}">New Post</a>

    <!-- 검색 폼 -->
    <form th:action="@{/posts}" method="get" style="margin-bottom: 1rem;">
        <input type="text" name="keyword" placeholder="제목 또는 내용 검색" th:value="${param.keyword}">
        <button type="submit">검색</button>
    </form>

    <!-- 글 목록: posts.content로 실제 목록 접근 -->
    <ul class="post-list" th:if="${!posts.content.isEmpty()}">
        <li class="post-item" th:each="post : ${posts.content}">
            <h2><a th:href="@{/posts/{id}(id=${post.id})}" th:text="${post.title}">Title</a></h2>
            <span class="post-meta" th:text="${#temporals.format(post.createdAt, 'yyyy-MM-dd HH:mm')}">2026-01-01</span>
            <span class="post-meta" th:if="${post.category != null}" th:text="'| ' + ${post.category.name}">| Category</span>
        </li>
    </ul>

    <!-- 페이징 네비게이션 -->
    <div class="pagination">
        <!-- 이전 페이지 버튼: posts.hasPrevious()로 존재 여부 확인 -->
        <a th:if="${posts.hasPrevious()}"
           th:href="@{/posts(page=${posts.number - 1}, category=${param.category}, keyword=${param.keyword})}">
            &laquo; 이전
        </a>

        <!-- 현재 페이지 / 전체 페이지 표시 -->
        <span th:text="${posts.number + 1} + ' / ' + ${posts.totalPages}"></span>

        <!-- 다음 페이지 버튼: posts.hasNext()로 존재 여부 확인 -->
        <a th:if="${posts.hasNext()}"
           th:href="@{/posts(page=${posts.number + 1}, category=${param.category}, keyword=${param.keyword})}">
            다음 &raquo;
        </a>
    </div>

    <p th:if="${posts.content.isEmpty()}">No posts yet.</p>
</main>

</body>
</html>
```

**핵심 포인트**:

1. **`posts.content`로 실제 목록 접근**:
   - `posts`는 `Page` 객체입니다. `Page`는 `Iterable`을 구현하고 있어서 `th:each="post : ${posts}"`로도 반복이 가능하지만, 이 경우 페이지의 데이터만 순회하고 메타 정보에 접근할 수 없습니다. **`posts.content`를 사용하면 의도가 명확해지고**, `posts.totalPages` 등 메타 정보와 함께 사용하는 코드의 일관성이 유지됩니다.

2. **`posts.hasPrevious()`/`hasNext()`로 버튼 표시**:
   - 첫 페이지에서는 "이전" 버튼이 표시되지 않습니다.
   - 마지막 페이지에서는 "다음" 버튼이 표시되지 않습니다.

3. **페이지 번호 표시**:
   - `posts.number`는 0부터 시작하므로 `+ 1`을 해서 1부터 표시합니다.
   - `posts.totalPages`는 전체 페이지 수입니다.

4. **페이징 링크에 기존 파라미터 유지**:
   - `category=${param.category}, keyword=${param.keyword}`
   - 카테고리 필터나 검색 상태를 유지하면서 페이지만 변경합니다.
   - 예: `/posts?keyword=spring&page=2` (검색 상태 유지)

### Thymeleaf에서 Page 객체의 속성 접근 방식

Thymeleaf는 JavaBean 규약에 따라 getter 메서드를 속성처럼 접근할 수 있습니다.

| Java 메서드 | Thymeleaf 표현식 | 설명 |
|---|---|---|
| `page.getContent()` | `${posts.content}` | 현재 페이지 데이터 목록 |
| `page.getTotalPages()` | `${posts.totalPages}` | 전체 페이지 수 |
| `page.getNumber()` | `${posts.number}` | 현재 페이지 번호 (0부터) |
| `page.hasNext()` | `${posts.hasNext()}` | 다음 페이지 존재 여부 |
| `page.hasPrevious()` | `${posts.hasPrevious()}` | 이전 페이지 존재 여부 |

`getXxx()` 형태의 getter는 `xxx`로 접근하고, `hasXxx()` 형태의 boolean 메서드는 `hasXxx()`로 호출합니다.

# 주의할 점 (Gotchas)

---

## 1. URL 경로 충돌 문제

검색 기능을 별도 경로로 만들 때 다음과 같은 충돌이 발생할 수 있습니다.

```java
@GetMapping("/posts/{id}")        // 글 상세
public String postDetail(@PathVariable Long id) { ... }

@GetMapping("/posts/{keyword}")   // 검색 (충돌!)
public String searchPosts(@PathVariable String keyword) { ... }
```

**문제**: `/posts/search`를 입력하면 Spring은 "search"를 숫자 id로 변환하려다 에러가 발생합니다.

**해결**: 쿼리 파라미터 방식 사용
```java
@GetMapping("/posts")
public String listPosts(@RequestParam(required = false) String keyword) { ... }

// URL: /posts?keyword=search
```

## 2. List vs Page 반환 타입 변경 시 주의

`findAll()`과 `findAll(Pageable)`은 **반환 타입이 다릅니다**.

| 메서드 | 반환 타입 |
|---|---|
| `findAll()` | `List<Post>` |
| `findAll(Pageable)` | `Page<Post>` |

**잘못된 코드**:
```java
List<Post> posts = postRepository.findAll(pageable);  // 컴파일 에러!
```

**올바른 코드**:
```java
Page<Post> posts = postRepository.findAll(pageable);
```

Thymeleaf에서도 `posts` -> `posts.content`로 변경해야 합니다.

## 3. Thymeleaf에서 Page 객체 접근 시 주의

```html
<!-- 비권장: Page 객체를 직접 반복 -->
<!-- Page는 Iterable을 구현하므로 에러는 아니지만, 의도가 불명확 -->
<li th:each="post : ${posts}">...</li>

<!-- 권장: content를 통해 명시적으로 목록에 접근 -->
<li th:each="post : ${posts.content}">...</li>
```

`Page`는 `Iterable`을 구현하고 있어서 직접 반복이 가능합니다. 하지만 `posts.content`를 사용하면 "Page 객체에서 데이터 목록을 꺼낸다"는 의도가 명확해지고, `posts.totalPages` 등 다른 메타 속성과 함께 사용할 때 코드의 일관성이 유지됩니다.

## 4. 페이징 링크에서 기존 파라미터 유지

**문제 상황**: 검색 중에 다음 페이지로 이동하면 검색 조건이 사라집니다.

```html
<!-- 잘못된 코드: keyword가 유지되지 않음 -->
<a th:href="@{/posts(page=${posts.number + 1})}">다음</a>
<!-- URL: /posts?page=1 (keyword 사라짐) -->
```

**해결**: 모든 파라미터를 함께 전달
```html
<!-- 올바른 코드: keyword와 category 유지 -->
<a th:href="@{/posts(page=${posts.number + 1}, keyword=${param.keyword}, category=${param.category})}">다음</a>
<!-- URL: /posts?page=1&keyword=spring&category=Java -->
```

## 5. @RequestParam(defaultValue) vs @RequestParam(required = false)

페이지 번호처럼 **기본값이 명확한 경우** `defaultValue`를 사용합니다.

| | `defaultValue = "0"` | `required = false` |
|---|---|---|
| 파라미터 없을 때 | 0 (기본값 사용) | null |
| 추가 null 체크 | 불필요 | 필요 (if 문으로 검사) |
| 적합한 용도 | 페이지 번호, 페이지 크기 | 검색어, 카테고리 |

**예시**:
```java
// 페이지 번호는 기본값 설정
@RequestParam(defaultValue = "0") int page

// 검색어는 optional (없을 수도 있음)
@RequestParam(required = false) String keyword
```

> `defaultValue`를 설정하면 `required`는 자동으로 `false`가 됩니다. 즉, `@RequestParam(defaultValue = "0") int page`에는 `required = false`를 추가할 필요가 없습니다.

## 6. Or 조건에서 파라미터 개수 확인

쿼리 메서드의 파라미터 개수와 호출 시 전달하는 인자 개수가 일치해야 합니다.

```java
// Repository
Page<Post> findByTitleContainingOrContentContaining(
    String titleKeyword,    // 파라미터 1
    String contentKeyword,  // 파라미터 2
    Pageable pageable
);

// Service - 올바른 호출
postRepository.findByTitleContainingOrContentContaining(keyword, keyword, pageable);

// Service - 잘못된 호출 (파라미터 부족 -> 애플리케이션 시작 시 에러)
postRepository.findByTitleContainingOrContentContaining(keyword, pageable);
```

## 7. 페이지 번호 범위 초과

사용자가 URL에 존재하지 않는 페이지 번호를 입력할 수 있습니다.

```
/posts?page=999  (실제 페이지가 10개뿐인데 999를 요청)
```

이 경우 Spring Data JPA는 에러를 발생시키지 않고 **빈 Page 객체**를 반환합니다. `content`는 빈 리스트, `totalPages`는 실제 전체 페이지 수가 됩니다. 현재 구현에서는 "No posts yet." 메시지가 표시됩니다. 더 나은 사용자 경험을 위해서는 유효하지 않은 페이지 번호를 첫 페이지로 리다이렉트하는 처리를 추가할 수 있습니다.

# 다음 단계 (Next Steps)

---

## 기능 확장

1. **페이지 번호 목록 표시**:
   - 현재: `이전 | 1 / 10 | 다음`
   - 개선: `이전 | 1 2 3 4 5 | 다음` (클릭 가능한 페이지 번호)

2. **카테고리 + 검색 동시 지원**:
   - 현재: 카테고리 또는 검색 중 하나만
   - 개선: "Java 카테고리 내에서 Spring 검색"

3. **정렬 옵션 추가**:
   - 최신순/오래된순/제목순 선택 기능
   - `@RequestParam(defaultValue = "createdAt") String sort`

4. **검색 결과 하이라이팅**:
   - 검색어를 노란색으로 강조 표시
   - JavaScript로 클라이언트 측 처리

## 성능 최적화

1. **페이지 크기 조정 가능**:
   - `@RequestParam(defaultValue = "10") int size`
   - 사용자가 10개/20개/50개 중 선택

2. **검색 쿼리 최적화**:
   - 현재: 제목과 내용 모두 `LIKE` 검색 (느림)
   - 개선: 전문 검색 엔진(Elasticsearch) 도입

3. **Page 대신 Slice 사용 검토**:
   - 전체 페이지 수가 필요하지 않은 경우 `Slice` 사용
   - COUNT 쿼리가 생략되어 성능 향상

4. **페이지네이션 캐싱**:
   - 자주 조회되는 첫 페이지를 캐싱
   - Spring Cache (`@Cacheable`) 적용

# Reference

---

- **구현 코드**:
  - [PostRepository.java](https://github.com/krails0105/spring-blog/blob/main/src/main/java/com/example/blog/repository/PostRepository.java)
  - [PostService.java](https://github.com/krails0105/spring-blog/blob/main/src/main/java/com/example/blog/service/PostService.java)
  - [PostController.java](https://github.com/krails0105/spring-blog/blob/main/src/main/java/com/example/blog/controller/PostController.java)
  - [list.html](https://github.com/krails0105/spring-blog/blob/main/src/main/resources/templates/posts/list.html)

- **외부 자료**:
  - [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
  - [Spring Data JPA - Paging and Sorting](https://docs.spring.io/spring-data/jpa/reference/repositories/query-methods-details.html#repositories.special-parameters)
  - [Thymeleaf - Iteration](https://www.thymeleaf.org/doc/tutorials/3.1/usingthymeleaf.html#iteration)
