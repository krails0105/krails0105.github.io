---
title: "[SpringBlog] Spring MVC + JPA CRUD 구현하기"
categories:
  - SpringBlog
tags:
  - [SpringBoot, JPA, Thymeleaf, CRUD, SpringMVC, Hibernate]
---

# Introduction

---

Spring Boot 프로젝트를 생성하고 기본 구조를 이해했다면, 이제 실제로 동작하는 기능을 만들 차례입니다. 블로그의 핵심 기능인 게시글 CRUD(Create, Read, Update, Delete)를 구현하면서 Spring MVC의 계층 구조와 JPA의 동작 원리를 체득할 수 있습니다.

이 글은 Post 엔티티 설계부터 Controller, Service, Repository 구현, 그리고 Thymeleaf 템플릿까지 전체 과정을 다룹니다. 또한 초기 구현 후 진행한 코드 리뷰를 통해 JPA 관례, 데이터 바인딩, PRG 패턴 등 실무 필수 개념을 함께 정리합니다.

**이 글에서 다루는 내용:**
- JPA 엔티티 설계 (`@Entity`, `@Id`, `@GeneratedValue`, `@Lob`)
- Repository 인터페이스와 JpaRepository의 동작 원리
- Service 계층의 역할과 비즈니스 로직
- Controller에서의 데이터 흐름 (Model, `@PathVariable`, 폼 바인딩)
- Thymeleaf 템플릿과 POST/Redirect/GET 패턴
- 코드 리뷰에서 나온 개선 포인트와 이유

**전제 조건:**
- [Spring Boot 프로젝트 생성과 구조 이해](/springblog/spring-boot-프로젝트-생성과-구조-이해/) 글의 내용을 따라 프로젝트가 생성되어 있어야 합니다.
- Spring Boot 3.x, Java 17, H2 Database 환경을 기준으로 합니다.

# 1. 전체 구조 미리보기

---

CRUD 구현에 필요한 파일과 각 계층의 역할을 먼저 파악하고 시작합니다.

```text
src/main/java/com/example/blog/
├── entity/
│   └── Post.java              # JPA 엔티티 - DB 테이블과 매핑
├── repository/
│   └── PostRepository.java    # Repository - DB 접근 (CRUD 메서드)
├── service/
│   └── PostService.java       # Service - 비즈니스 로직
└── controller/
    └── PostController.java    # Controller - HTTP 요청/응답 처리

src/main/resources/templates/posts/
├── list.html                  # 글 목록 페이지
├── detail.html                # 글 상세 페이지
├── create.html                # 글 작성 폼
└── edit.html                  # 글 수정 폼
```

각 계층의 요청 처리 흐름은 다음과 같습니다.

```text
사용자 요청 (HTTP)
       ↓
  Controller  →  요청/응답 처리 (HTTP 계층)
       ↓
  Service     →  비즈니스 로직 (도메인 계층)
       ↓
  Repository  →  데이터베이스 접근 (영속성 계층)
       ↓
  Database
```

Controller는 HTTP 요청을 받아 Service를 호출하고, Service는 비즈니스 규칙을 적용한 뒤 Repository를 통해 DB에 접근합니다. 이렇게 계층을 분리하면 각 계층의 책임이 명확해지고, 코드 재사용과 테스트가 용이해집니다.

# 2. 엔티티 설계 (Entity)

---

## Post 엔티티

JPA(Java Persistence API)는 **객체와 테이블을 매핑**하는 기술입니다. `@Entity`가 붙은 클래스는 데이터베이스 테이블과 1:1로 대응되며, 클래스의 필드는 테이블의 컬럼이 됩니다.

```java
// src/main/java/com/example/blog/entity/Post.java
package com.example.blog.entity;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import java.time.LocalDateTime;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

// @Entity: JPA가 이 클래스를 DB 테이블과 매핑. 클래스명 Post → 테이블명 post
// @Getter/@Setter: Lombok이 모든 필드의 getter/setter를 자동 생성
// @NoArgsConstructor: JPA가 엔티티를 생성할 때 기본 생성자가 필요
@Entity
@Getter
@Setter
@NoArgsConstructor
public class Post {

    // @Id: 이 필드가 테이블의 기본 키(Primary Key)
    // @GeneratedValue(IDENTITY): DB가 자동으로 1, 2, 3... 증가시킴 (auto_increment)
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String title;

    // @Lob: 긴 텍스트를 저장할 수 있도록 대용량 컬럼 타입(CLOB) 사용
    // 없으면 기본 VARCHAR(255)라서 글 내용이 잘릴 수 있음
    @Lob
    private String content;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
```

## 핵심 어노테이션 정리

| 어노테이션 | 역할 | 필수 여부 |
|------------|------|-----------|
| `@Entity` | 클래스를 JPA 엔티티(DB 테이블)로 선언 | 필수 |
| `@Id` | 필드를 기본 키(Primary Key)로 지정 | 필수 (엔티티당 하나) |
| `@GeneratedValue` | 기본 키 값 자동 생성 전략 지정 | 선택 (없으면 수동 할당) |
| `@Lob` | 대용량 데이터 매핑 (String → CLOB, byte[] → BLOB) | 선택 |
| `@NoArgsConstructor` | 기본 생성자 자동 생성 (Lombok) | JPA 스펙상 필수 |

### `@Id` - 기본 키 지정

JPA에서 `@Id`는 **테이블의 기본 키(Primary Key)**를 표시하는 어노테이션입니다. 모든 엔티티는 반드시 하나의 `@Id` 필드를 가져야 하며, JPA는 이 필드를 기준으로 엔티티를 식별하고 영속성 컨텍스트에서 관리합니다.

- `@Id`만 붙이면 개발자가 직접 id 값을 설정해야 함
- `@GeneratedValue`를 함께 사용하면 DB가 자동으로 값을 생성

### `@GeneratedValue` - 키 생성 전략

| 전략 | 설명 | 사용 DB |
|------|------|---------|
| `IDENTITY` | DB의 auto_increment 기능 사용 | MySQL, H2, SQL Server |
| `SEQUENCE` | DB 시퀀스 객체를 사용하여 값 생성 | Oracle, PostgreSQL |
| `TABLE` | 별도 키 생성 테이블을 사용 | 모든 DB (성능 낮음) |
| `AUTO` | JPA 구현체(Hibernate)가 DB에 맞는 전략을 자동 선택 | 기본값 |

strategy를 생략하면 기본값은 `GenerationType.AUTO`이며, Hibernate가 DB 방언(Dialect)에 따라 적절한 전략을 선택합니다. 다만 명시적으로 지정하는 것이 코드의 의도를 분명히 하고, DB 전환 시 예상치 못한 동작을 방지할 수 있습니다.

### `@Lob` vs `@Column(columnDefinition = "TEXT")`

| 방식 | 설명 | DB 이식성 | 사용 사례 |
|------|------|-----------|-----------|
| `@Lob` | JPA가 DB에 맞는 대용량 타입 자동 선택 | 높음 (DB 독립적) | H2 → MySQL 전환 계획이 있을 때 |
| `@Column(columnDefinition = "TEXT")` | DB 컬럼 타입을 TEXT로 직접 지정 | 낮음 (특정 DB 종속) | DB를 바꿀 계획이 없을 때 |

`@Lob` 없이 `String` 필드를 매핑하면 기본값 `VARCHAR(255)` 컬럼이 생성됩니다. 블로그 글 내용은 255자를 초과할 가능성이 높으므로 대용량 타입이 필요합니다. `@Lob`은 JPA 표준으로, DB에 맞는 대용량 타입을 자동 선택합니다(H2/MySQL → TEXT/LONGTEXT, Oracle → CLOB). 이 프로젝트는 H2 → MySQL 전환을 염두에 두고 있으므로 `@Lob`이 적합합니다.

## 코드 리뷰에서 나온 개선 포인트

### 1. id 타입: `int` → `Long`

**변경 전:**
```java
@Id
private int id;
```

**변경 후:**
```java
@Id
private Long id;
```

**이유:**
- `int`는 기본값이 0이므로, id가 없는 새 엔티티를 null로 표현할 수 없음
- Spring Data JPA는 **id가 null이면 새 엔티티(persist), 값이 있으면 기존 엔티티(merge)**로 판단 (공식 문서: "If the identifier property is `null`, then the entity is assumed to be new")
- `Long`은 null 표현 가능 → 새 엔티티 판별이 명확함
- JPA/Hibernate 공식 문서에서도 wrapper 타입(`Long`, `Integer`) 사용을 권장

### 2. 필드 접근 제어자: default → `private`

**변경 전:**
```java
Long id;
String title;
```

**변경 후:**
```java
private Long id;
private String title;
```

**이유:**
- 캡슐화(Encapsulation) 원칙: 필드는 `private`으로 선언하고 getter/setter로 접근
- Lombok이 getter/setter를 자동 생성하므로 외부 접근은 메서드를 통해 이루어짐

# 3. Repository 계층

---

```java
// src/main/java/com/example/blog/repository/PostRepository.java
package com.example.blog.repository;

import com.example.blog.entity.Post;
import org.springframework.data.jpa.repository.JpaRepository;

// JpaRepository<Post, Long>을 상속하면 구현체 없이 기본 CRUD 메서드를 사용 가능:
// findAll(), findById(), save(), deleteById() 등
// 제네릭: 첫 번째 = 엔티티 타입(Post), 두 번째 = 기본 키 타입(Long)
public interface PostRepository extends JpaRepository<Post, Long> {

}
```

## JpaRepository의 동작 원리

`PostRepository`는 **인터페이스**일 뿐인데, 어떻게 메서드를 호출할 수 있을까요?

Spring Data JPA가 **런타임에 이 인터페이스의 구현체(Proxy)를 자동 생성**합니다. `@Repository` 어노테이션 없이도 Spring Boot의 `@EnableJpaRepositories`(자동 활성화)가 `JpaRepository`를 상속한 인터페이스를 스캔하여 Bean으로 등록합니다.

### JpaRepository가 제공하는 기본 메서드

| 메서드 | 설명 | 대응 SQL |
|--------|------|----------|
| `findAll()` | 모든 엔티티 조회 | `SELECT * FROM post` |
| `findById(Long id)` | id로 단건 조회 (반환: `Optional<Post>`) | `SELECT * FROM post WHERE id = ?` |
| `save(Post post)` | 엔티티 저장 또는 수정 (반환: 저장된 엔티티) | INSERT 또는 UPDATE |
| `deleteById(Long id)` | id로 삭제 | `DELETE FROM post WHERE id = ?` |
| `count()` | 전체 개수 | `SELECT COUNT(*) FROM post` |
| `existsById(Long id)` | id 존재 여부 확인 | `SELECT COUNT(*) > 0` |

코드 한 줄 작성하지 않아도 이 모든 메서드를 사용할 수 있습니다.

### `save()` 메서드의 동작 방식

`save()` 메서드는 내부적으로 엔티티의 상태를 판별하여 INSERT 또는 UPDATE를 결정합니다.

```text
save(entity) 호출
      ↓
id가 null인가? ──── Yes → entityManager.persist() → INSERT
      │
      No
      ↓
entityManager.merge() → UPDATE
```

Spring Data JPA 공식 문서에 따르면: "`CrudRepository.save()`는 엔티티가 아직 영속화되지 않았으면 `entityManager.persist()`를 호출하고, 그렇지 않으면 `entityManager.merge()`를 호출합니다." 이 동작이 가능한 이유가 바로 id 타입을 `Long`(null 가능)으로 선언해야 하는 이유와 연결됩니다.

### 커스텀 쿼리 메서드

필요하면 메서드명 규칙에 따라 커스텀 메서드도 추가 가능합니다. Spring Data JPA가 메서드 이름을 분석하여 자동으로 쿼리를 생성합니다.

```java
public interface PostRepository extends JpaRepository<Post, Long> {

    // SELECT * FROM post WHERE title = ?
    List<Post> findByTitle(String title);

    // SELECT * FROM post WHERE title LIKE ?
    List<Post> findByTitleContaining(String keyword);

    // SELECT * FROM post ORDER BY created_at DESC
    List<Post> findAllByOrderByCreatedAtDesc();
}
```

# 4. Service 계층

---

```java
// src/main/java/com/example/blog/service/PostService.java
package com.example.blog.service;

import com.example.blog.entity.Post;
import com.example.blog.repository.PostRepository;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

// @Service: 비즈니스 로직 담당. Controller와 Repository 사이에서 로직을 처리
// @RequiredArgsConstructor: final 필드를 파라미터로 받는 생성자를 자동 생성 (생성자 주입)
@Service
@RequiredArgsConstructor
public class PostService {

    // Spring이 PostRepository 구현체를 자동으로 주입 (Dependency Injection)
    private final PostRepository postRepository;

    // 전체 글 목록 조회
    public List<Post> getPosts() {
        return postRepository.findAll();
    }

    // ID로 단건 조회. Optional로 반환 → 값이 없을 수도 있음을 명시
    public Optional<Post> getPost(Long id) {
        return postRepository.findById(id);
    }

    // 글 저장 (생성 + 수정 모두 처리)
    // id가 null이면 새 글 → createdAt/updatedAt 모두 설정
    // id가 있으면 수정 → updatedAt만 갱신
    public Post savePost(Post post) {
        if (post.getId() == null) {
            post.setCreatedAt(LocalDateTime.now());
            post.setUpdatedAt(LocalDateTime.now());
        }
        else {
            post.setUpdatedAt(LocalDateTime.now());
        }
        return postRepository.save(post);
    }

    public void deletePost(Long id) {
        postRepository.deleteById(id);
    }

}
```

## Service 계층이 필요한 이유

**Service 계층이 없다면?**
- Controller가 비즈니스 로직과 데이터베이스 접근을 모두 처리 → 코드 비대화
- 같은 로직이 여러 Controller에 중복 → 유지보수 어려움
- 트랜잭션 관리, 권한 검증 등 공통 관심사를 처리할 곳이 없음

**Service 계층이 있으면:**
- Controller는 HTTP 요청/응답에만 집중
- 비즈니스 로직은 Service에서 재사용 가능
- `@Transactional`로 트랜잭션 경계를 설정할 수 있음

## 코드 리뷰에서 나온 개선 포인트

### 1. `savePost` 반환 타입: `void` → `Post`

**변경 전:**
```java
public void savePost(Post post) {
    postRepository.save(post);
}
```

**변경 후:**
```java
public Post savePost(Post post) {
    // ...
    return postRepository.save(post);
}
```

**이유:**
- `save()`는 저장된 엔티티를 반환함 (id가 자동 생성된 엔티티 포함)
- 반환값을 활용하면 저장 직후 생성된 id를 사용할 수 있음
- Controller에서 `redirect:/posts/{id}`처럼 id가 필요한 경우 유용

### 2. `createdAt`/`updatedAt` 자동 설정

**변경 전:**
```java
public Post savePost(Post post) {
    return postRepository.save(post);
}
```

**변경 후:**
```java
public Post savePost(Post post) {
    if (post.getId() == null) {
        post.setCreatedAt(LocalDateTime.now());
        post.setUpdatedAt(LocalDateTime.now());
    }
    else {
        post.setUpdatedAt(LocalDateTime.now());
    }
    return postRepository.save(post);
}
```

**이유:**
- Controller에서 매번 시간을 설정하는 것보다 Service에서 자동 처리하는 것이 일관성 있음
- id가 null → 새 글 생성 → `createdAt`/`updatedAt` 모두 현재 시각
- id가 있음 → 기존 글 수정 → `updatedAt`만 갱신

> **참고**: 실무에서는 JPA의 `@PrePersist`, `@PreUpdate` 콜백이나 Spring Data JPA의 `@CreatedDate`, `@LastModifiedDate` (Auditing 기능)를 사용하면 이 로직을 엔티티에서 자동으로 처리할 수 있습니다. 이 프로젝트에서는 동작 원리를 이해하기 위해 Service에서 직접 처리합니다.

## `== null` vs `.equals(null)` - null 비교의 올바른 방법

```java
if (post.getId() == null) { ... }
```

**왜 `post.getId().equals(null)`이 아니라 `== null`을 사용할까?**

| 비교 방식 | 대상 | null 비교 시 |
|-----------|------|--------------|
| `==` | 객체의 참조(주소) 비교 | 안전함 |
| `.equals()` | 객체의 값 비교 | 호출 대상이 null이면 `NullPointerException` 발생 |

```java
// 안전 - 참조 비교이므로 null이어도 문제없음
if (post.getId() == null) { ... }

// 위험 - getId()가 null을 반환하면 null.equals()가 되어 NPE 발생
if (post.getId().equals(null)) { ... }
```

**null 비교는 반드시 `==` 연산자를 사용해야 합니다.**

# 5. Controller 계층

---

```java
// src/main/java/com/example/blog/controller/PostController.java
package com.example.blog.controller;

import com.example.blog.entity.Post;
import com.example.blog.service.PostService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;

// @Controller: 웹 요청을 처리하는 컨트롤러. 반환값은 Thymeleaf 템플릿 이름
@Controller
@RequiredArgsConstructor
public class PostController {

    private final PostService postService;

    // GET /posts → 글 목록 페이지
    // Model에 데이터를 담으면 Thymeleaf 템플릿에서 사용 가능
    @GetMapping("/posts")
    public String getPosts(Model model) {
        List<Post> posts = postService.getPosts();
        model.addAttribute("posts", posts);
        return "posts/list";
    }

    // GET /posts/{id} → 글 상세 페이지
    // @PathVariable: URL의 {id} 값을 메서드 파라미터로 받음
    // orElseThrow(): 글이 없으면 NoSuchElementException 발생
    @GetMapping("/posts/{id}")
    public String getPost(@PathVariable Long id, Model model){
        Post post = postService.getPost(id).orElseThrow();
        model.addAttribute("post", post);
        return "posts/detail";
    }

    // GET /posts/new → 작성 폼 페이지
    @GetMapping("/posts/new")
    public String getCreateForm() {
        return "posts/create";
    }

    // POST /posts/new → 작성 처리
    // Spring이 폼의 name="title", name="content"를 Post 객체의 필드에 자동 바인딩
    // 처리 후 redirect로 목록 페이지로 이동 (새로고침 시 중복 저장 방지 - PRG 패턴)
    @PostMapping("/posts/new")
    public String addForm(Post post) {
        postService.savePost(post);
        return "redirect:/posts";
    }

    // GET /posts/{id}/edit → 수정 폼 페이지 (기존 데이터를 폼에 채워서 보여줌)
    @GetMapping("/posts/{id}/edit")
    public String getEditForm(@PathVariable Long id, Model model) {
        Post post = postService.getPost(id).orElseThrow();
        model.addAttribute(post);
        return "posts/edit";
    }

    // POST /posts/{id}/edit → 수정 처리
    // 폼에서 넘어온 데이터에는 id가 없으므로, URL의 id를 직접 세팅해야 함
    @PostMapping("/posts/{id}/edit")
    public String editForm(@PathVariable Long id, Post post) {
        post.setId(id);
        postService.savePost(post);
        return "redirect:/posts";
    }

    // POST /posts/{id}/delete → 삭제 처리
    @PostMapping("/posts/{id}/delete")
    public String deletePost(@PathVariable Long id) {
        postService.deletePost(id);
        return "redirect:/posts";
    }

}
```

## 코드 리뷰에서 나온 개선 포인트

### 1. Controller 메서드 반환 타입: `void` → `String`

**변경 전:**
```java
@GetMapping("/posts")
public void getPosts(Model model) {
    List<Post> posts = postService.getPosts();
    model.addAttribute("posts", posts);
}
```

**변경 후:**
```java
@GetMapping("/posts")
public String getPosts(Model model) {
    List<Post> posts = postService.getPosts();
    model.addAttribute("posts", posts);
    return "posts/list";
}
```

**이유:**
- `void` 반환 시 Spring은 요청 URL을 기준으로 뷰 이름을 추론 (`/posts` → `posts` 뷰)
- `String`을 반환하면 어떤 템플릿을 렌더링하는지 코드만 봐도 명확함
- 리다이렉트(`redirect:/posts`)는 `String` 반환만 가능

| 반환 타입 | Spring의 동작 | 리다이렉트 가능 | 가독성 |
|-----------|---------------|:---:|:---:|
| `void` | URL 경로에서 뷰 이름 추론 | X | 낮음 |
| `String` | 명시적 뷰 이름 반환 | O | 높음 |

### 2. 폼 데이터 받기: `Model.getAttribute()` → 메서드 파라미터

**변경 전:**
```java
@PostMapping("/posts/new")
public String addForm(Model model) {
    Post post = (Post) model.getAttribute("post");
    postService.savePost(post);
    return "redirect:/posts";
}
```

**변경 후:**
```java
@PostMapping("/posts/new")
public String addForm(Post post) {
    postService.savePost(post);
    return "redirect:/posts";
}
```

**이유:**
- `Model`은 **Controller → View** 방향으로 데이터를 전달하는 용도
- **View → Controller**(폼 제출) 데이터는 메서드 파라미터로 받음
- Spring이 폼의 `name="title"`, `name="content"`를 Post 객체의 setter(`setTitle()`, `setContent()`)를 호출하여 자동 바인딩

### 3. 수정 시 `@PathVariable id`를 Post에 세팅

**변경 전:**
```java
@PostMapping("/posts/{id}/edit")
public String editForm(Post post) {
    postService.savePost(post);  // id가 없어서 새 글로 저장됨!
    return "redirect:/posts";
}
```

**변경 후:**
```java
@PostMapping("/posts/{id}/edit")
public String editForm(@PathVariable Long id, Post post) {
    post.setId(id);  // URL의 id를 Post에 세팅
    postService.savePost(post);
    return "redirect:/posts";
}
```

**이유:**
- HTML 폼에서 id를 hidden input으로 보내지 않으면, Spring이 바인딩한 Post 객체의 id는 `null`
- id가 `null`이면 Service에서 새 글로 인식하여 INSERT 쿼리가 실행됨
- URL의 `{id}`를 `@PathVariable`로 받아서 Post에 직접 세팅해야 UPDATE 쿼리 실행

### 4. `Optional.orElseThrow()`로 값 꺼내기

**변경 전:**
```java
@GetMapping("/posts/{id}")
public String getPost(@PathVariable Long id, Model model){
    Optional<Post> post = postService.getPost(id);
    if (post.isPresent()) {
        model.addAttribute("post", post.get());
        return "posts/detail";
    }
    return "error";
}
```

**변경 후:**
```java
@GetMapping("/posts/{id}")
public String getPost(@PathVariable Long id, Model model){
    Post post = postService.getPost(id).orElseThrow();
    model.addAttribute("post", post);
    return "posts/detail";
}
```

**이유:**
- `orElseThrow()`는 값이 없으면 `NoSuchElementException` 발생 (500 에러)
- `isPresent()` + `get()` 방식보다 간결함
- 예외 처리는 추후 `@ControllerAdvice`에서 일괄 처리 가능
- 실무에서는 커스텀 예외(`PostNotFoundException`)를 던져 404 응답 처리

## Model의 방향성 이해하기

Spring MVC에서 데이터의 흐름 방향에 따라 사용하는 수단이 다릅니다.

| 방향 | 수단 | 설명 |
|------|------|------|
| **Controller → View** | `Model.addAttribute()` | 템플릿에 데이터 전달 |
| **View → Controller** | 메서드 파라미터 (폼 바인딩) | 폼 데이터를 객체로 자동 매핑 |

```java
// Controller → View (Model 사용)
@GetMapping("/posts/{id}/edit")
public String getEditForm(@PathVariable Long id, Model model) {
    Post post = postService.getPost(id).orElseThrow();
    model.addAttribute("post", post);  // View로 데이터 전달
    return "posts/edit";
}

// View → Controller (메서드 파라미터 사용)
@PostMapping("/posts/{id}/edit")
public String editForm(@PathVariable Long id, Post post) {  // 폼 데이터 자동 바인딩
    post.setId(id);
    postService.savePost(post);
    return "redirect:/posts";
}
```

Spring MVC는 HTTP 요청 파라미터를 메서드 파라미터의 setter 메서드를 통해 자동 바인딩합니다. 이 과정에서 `@ModelAttribute`가 암묵적으로 동작하는데, 메서드 파라미터에 `@ModelAttribute`를 생략해도 Spring이 자동으로 적용합니다.

## POST 처리 후 redirect가 필요한 이유 (PRG 패턴)

**PRG (Post/Redirect/Get) 패턴**은 POST 요청 처리 후 리다이렉트하여 GET 요청으로 전환하는 웹 개발의 표준 패턴입니다.

### redirect 없이 템플릿 직접 반환 시 문제

```java
@PostMapping("/posts/new")
public String addForm(Post post, Model model) {
    postService.savePost(post);
    model.addAttribute("posts", postService.getPosts());
    return "posts/list";  // 템플릿 직접 반환
}
```

**문제점:**
1. 브라우저 주소창에는 여전히 `POST /posts/new`가 남아있음
2. 사용자가 새로고침(F5)을 누르면 브라우저가 "폼을 다시 보내시겠습니까?" 경고를 표시
3. 확인 시 같은 POST 요청이 다시 전송되어 **같은 글이 중복 저장됨**

### redirect 사용 시 (PRG 패턴)

```java
@PostMapping("/posts/new")
public String addForm(Post post) {
    postService.savePost(post);
    return "redirect:/posts";  // GET /posts로 리다이렉트
}
```

**흐름:**
```text
1. 브라우저 → POST /posts/new (글 저장 요청)
2. 서버 → 302 Redirect 응답 (Location: /posts)
3. 브라우저 → GET /posts (목록 페이지 요청)
4. 서버 → 200 OK + HTML 응답
5. 브라우저 주소창: /posts (GET 상태)
6. F5 새로고침 → GET /posts만 다시 실행 (안전함)
```

Spring MVC에서 `return "redirect:/posts"` 형식으로 반환하면, Spring의 `UrlBasedViewResolver`가 `redirect:` 접두사를 인식하여 HTTP 302 리다이렉트 응답을 생성합니다.

# 6. Thymeleaf 템플릿

---

## 글 목록 (list.html)

```html
<!-- src/main/resources/templates/posts/list.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
    <title>Posts</title>
</head>
<body>
    <h1>Posts</h1>
    <a th:href="@{/posts/new}">New Post</a>

    <ul th:if="${!posts.isEmpty()}">
        <li th:each="post : ${posts}">
            <h2><a th:href="@{/posts/{id}(id=${post.id})}" th:text="${post.title}">Title</a></h2>
            <span th:text="${#temporals.format(post.createdAt, 'yyyy-MM-dd HH:mm')}">2026-01-01</span>
        </li>
    </ul>

    <p th:if="${posts.isEmpty()}">No posts yet.</p>
</body>
</html>
```

**주요 Thymeleaf 문법:**

| 문법 | 설명 | 예시 |
|------|------|------|
| `th:href="@{...}"` | URL 생성 (컨텍스트 경로 자동 추가) | `@{/posts/new}` |
| `th:each` | 리스트 순회 | `th:each="post : ${posts}"` |
| `th:text` | 텍스트 출력 | `th:text="${post.title}"` |
| `th:if` | 조건부 렌더링 | `th:if="${!posts.isEmpty()}"` |
| `@{/path/{var}(var=${val})}` | URL 경로 변수 바인딩 | `@{/posts/{id}(id=${post.id})}` |
| `${#temporals.format(...)}` | `LocalDateTime` 포맷팅 | `yyyy-MM-dd HH:mm` |

## 글 상세 (detail.html)

```html
<!-- src/main/resources/templates/posts/detail.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
    <title th:text="${post.title}">Post Detail</title>
</head>
<body>
    <h1 th:text="${post.title}">Title</h1>
    <span th:text="${#temporals.format(post.createdAt, 'yyyy-MM-dd HH:mm')}">2026-01-01</span>

    <div th:text="${post.content}">Content</div>

    <div>
        <a th:href="@{/posts/{id}/edit(id=${post.id})}">Edit</a>
        <form th:action="@{/posts/{id}/delete(id=${post.id})}" method="post" style="display: inline;">
            <button type="submit" onclick="return confirm('Are you sure?')">Delete</button>
        </form>
        <a th:href="@{/posts}">Back to List</a>
    </div>
</body>
</html>
```

**주요 포인트:**
- `th:action="@{/posts/{id}/delete(id=${post.id})}"`: 폼 제출 URL을 동적으로 생성
- `method="post"`: HTML 폼은 GET/POST만 지원하므로 DELETE 동작을 POST로 처리
- `onclick="return confirm(...)"`: JavaScript 확인 대화상자로 실수 방지

## 작성 폼 (create.html)

```html
<!-- src/main/resources/templates/posts/create.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
    <title>New Post</title>
</head>
<body>
    <h1>New Post</h1>

    <form th:action="@{/posts/new}" method="post">
        <div>
            <label>Title</label>
            <input type="text" name="title" required>
        </div>
        <div>
            <label>Content</label>
            <textarea name="content" rows="10" required></textarea>
        </div>
        <button type="submit">Save</button>
        <a th:href="@{/posts}">Cancel</a>
    </form>
</body>
</html>
```

**폼 데이터 바인딩 과정:**

```text
HTML 폼 (name 속성)         →   Spring MVC (setter 호출)     →   Post 객체
──────────────────────────────────────────────────────────────────────────
name="title" (값: "제목")   →   post.setTitle("제목")        →   title = "제목"
name="content" (값: "내용") →   post.setContent("내용")      →   content = "내용"
```

폼의 `name` 속성과 객체의 필드명이 일치하면 Spring이 자동으로 setter를 호출하여 값을 바인딩합니다.

## 수정 폼 (edit.html)

```html
<!-- src/main/resources/templates/posts/edit.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
    <title>Edit Post</title>
</head>
<body>
    <h1>Edit Post</h1>

    <form th:action="@{/posts/{id}/edit(id=${post.id})}" method="post">
        <div>
            <label>Title</label>
            <input type="text" name="title" th:value="${post.title}" required>
        </div>
        <div>
            <label>Content</label>
            <textarea name="content" rows="10" required th:text="${post.content}"></textarea>
        </div>
        <button type="submit">Update</button>
        <a th:href="@{/posts}">Cancel</a>
    </form>
</body>
</html>
```

**기존 값 채우기:**
- `th:value="${post.title}"`: `<input>` 필드의 value 속성에 기존 제목 설정
- `th:text="${post.content}"`: `<textarea>`의 텍스트 콘텐츠로 기존 내용 설정 (`<textarea>`는 value 속성이 없으므로 `th:text` 사용)

# 7. 실무 함정과 주의사항

---

## 1. id 타입으로 primitive 타입 사용

```java
// 잘못된 예 - int는 null이 될 수 없어서 새 엔티티 판별 불가
@Id
private int id;  // 기본값이 0 → save() 시 merge가 호출됨

// 올바른 예 - Long은 null 가능
@Id
private Long id;  // null이면 persist(), 값이 있으면 merge()
```

Spring Data JPA는 id가 `null`인지 여부로 새 엔티티를 판별합니다. primitive 타입(`int`, `long`)은 null이 될 수 없으므로 항상 "기존 엔티티"로 인식되어 의도치 않은 동작이 발생할 수 있습니다.

## 2. 수정 폼에서 id 누락

수정 폼에서 id를 전달하지 않으면, 수정이 아닌 새 글 생성이 됩니다. 두 가지 해결 방법이 있습니다.

**방법 1: `@PathVariable`로 URL에서 id 받기 (이 프로젝트에서 사용)**
```java
@PostMapping("/posts/{id}/edit")
public String editForm(@PathVariable Long id, Post post) {
    post.setId(id);
    postService.savePost(post);
    return "redirect:/posts";
}
```

**방법 2: hidden input으로 id를 폼에 포함**
```html
<form th:action="@{/posts/{id}/edit(id=${post.id})}" method="post">
    <input type="hidden" name="id" th:value="${post.id}">
    <!-- 나머지 필드 -->
</form>
```

방법 2를 사용하면 Spring이 자동으로 `post.setId()`를 호출하므로 Controller에서 별도 세팅이 필요 없습니다.

## 3. `@Lob` 없이 긴 텍스트 저장 시도

```java
// VARCHAR(255) → 255자 초과 시 데이터 잘림 또는 에러
private String content;

// CLOB/TEXT → 대용량 텍스트 저장 가능
@Lob
private String content;
```

## 4. POST 처리 후 redirect를 빠뜨리면

```java
// 위험 - 새로고침 시 중복 저장 발생
@PostMapping("/posts/new")
public String addForm(Post post) {
    postService.savePost(post);
    return "posts/list";  // 템플릿 직접 반환
}

// 안전 - PRG 패턴
@PostMapping("/posts/new")
public String addForm(Post post) {
    postService.savePost(post);
    return "redirect:/posts";  // GET으로 리다이렉트
}
```

## 5. `model.addAttribute(post)` vs `model.addAttribute("post", post)`

```java
// 키 이름을 생략하면 클래스명의 camelCase가 키가 됨
model.addAttribute(post);               // 키: "post" (Post 클래스 → "post")
model.addAttribute("post", post);       // 키: "post" (명시적)
model.addAttribute("myPost", post);     // 키: "myPost" (커스텀)
```

키 이름을 생략할 수 있지만, Thymeleaf 템플릿에서 `${post}`로 접근할 때 어떤 키 이름이 사용되는지 명확하게 하려면 명시적으로 지정하는 것이 좋습니다.

# 8. 정리

---

## 계층별 역할

| 계층 | 역할 | 주요 어노테이션 | 책임 범위 |
|------|------|----------------|-----------|
| **Entity** | DB 테이블과 매핑 | `@Entity`, `@Id`, `@Lob` | 데이터 구조 정의 |
| **Repository** | 데이터베이스 접근 | `JpaRepository` 상속 | CRUD 메서드 제공 |
| **Service** | 비즈니스 로직 | `@Service` | 도메인 규칙, 트랜잭션 |
| **Controller** | 요청/응답 처리 | `@Controller`, `@GetMapping` | HTTP 계층, 뷰 선택 |

## Spring MVC 요청 처리 흐름

```text
1. 사용자: GET /posts/1
             ↓
2. DispatcherServlet: 요청 수신, 핸들러 매핑
             ↓
3. Controller: getPost(1) → Service 호출
             ↓
4. Service: getPost(1) → Repository 호출
             ↓
5. Repository: findById(1) → DB 조회
             ↓
6. Post 엔티티 반환 (역순으로)
             ↓
7. Controller: Model에 post 담고 "posts/detail" 반환
             ↓
8. ViewResolver: templates/posts/detail.html 찾음
             ↓
9. Thymeleaf: 템플릿에 Model 데이터 주입 후 HTML 렌더링
             ↓
10. HTTP 200 OK + 완성된 HTML 응답
```

## 핵심 개념 요약

**JPA/Hibernate:**
- `@Entity`: 클래스를 DB 테이블과 매핑
- `@Id`: 기본 키 지정 (wrapper 타입 사용 권장)
- `@GeneratedValue(strategy = IDENTITY)`: DB의 auto_increment 사용
- `@Lob`: 대용량 텍스트 컬럼 (CLOB/TEXT)
- `save()`: id가 null이면 persist(INSERT), 값이 있으면 merge(UPDATE)

**Spring MVC:**
- `@Controller`: HTTP 요청 처리, ViewResolver를 통해 템플릿 렌더링
- `@GetMapping`, `@PostMapping`: HTTP 메서드 매핑
- `@PathVariable`: URL 경로 변수 바인딩
- `Model`: Controller → View 데이터 전달
- 메서드 파라미터: View → Controller 폼 데이터 자동 바인딩
- PRG 패턴: POST 후 redirect로 중복 제출 방지

**Thymeleaf:**
- `th:text`: 텍스트 출력
- `th:href`, `th:action`: URL 동적 생성 (`@{...}`)
- `th:each`: 리스트 순회
- `th:if`: 조건부 렌더링
- `th:value`: `<input>` 값 설정

# Reference

---

- 프로젝트 파일:
  - [Post.java](../../spring-blog/src/main/java/com/example/blog/entity/Post.java)
  - [PostRepository.java](../../spring-blog/src/main/java/com/example/blog/repository/PostRepository.java)
  - [PostService.java](../../spring-blog/src/main/java/com/example/blog/service/PostService.java)
  - [PostController.java](../../spring-blog/src/main/java/com/example/blog/controller/PostController.java)
  - [templates/posts/](../../spring-blog/src/main/resources/templates/posts/)
- [Spring Data JPA 공식 문서](https://docs.spring.io/spring-data/jpa/reference/jpa.html)
- [Spring Data JPA - Entity State Detection](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-persistence.html)
- [Hibernate @Lob 문서](https://docs.jboss.org/hibernate/orm/current/userguide/html_single/Hibernate_User_Guide.html#basic-lob)
- [Spring MVC 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
- [Thymeleaf 공식 문서](https://www.thymeleaf.org/documentation.html)
