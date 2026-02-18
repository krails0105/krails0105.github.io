---
title: "[SpringBlog] JPA 연관관계 - 카테고리(ManyToOne)와 태그(ManyToMany) 구현하기"
categories:
  - SpringBlog
tags:
  - [SpringBoot, JPA, ManyToOne, ManyToMany, Thymeleaf, Hibernate]
---

# Introduction

---

블로그 게시글에 **카테고리**와 **태그** 기능을 추가하면서, JPA의 연관관계 매핑을 실습합니다. 카테고리는 하나의 글이 하나의 카테고리에만 속하는 **ManyToOne**(N:1) 관계이고, 태그는 하나의 글에 여러 태그가 달릴 수 있고 하나의 태그도 여러 글에 사용될 수 있는 **ManyToMany**(N:N) 관계입니다.

관계형 데이터베이스에서 테이블 간 연관관계를 어떻게 설계하는지, JPA에서는 이를 어떻게 엔티티로 표현하는지, 그리고 구현 과정에서 만난 문제들과 해결 방법을 함께 다룹니다.

**이 글에서 다루는 내용:**
- ManyToOne과 ManyToMany 연관관계의 차이와 DB 설계
- `@JoinColumn`과 `@JoinTable`의 역할
- Spring Data JPA의 쿼리 메서드 자동 생성
- Service 계층에서 연관 엔티티 처리 (태그 파싱, 카테고리 조회)
- Thymeleaf 템플릿에서 카테고리 드롭다운, 태그 입력 처리
- 구현 중 발생한 문제 4가지와 해결법 (TransientObjectException, 파라미터 바인딩 충돌, createdAt null, isBlank 조건 반전)
- JPA Cascade를 ManyToMany에 사용하면 안 되는 이유

**전제 조건:**
- [Spring Boot 프로젝트 생성과 구조 이해](/springblog/spring-boot-프로젝트-생성과-구조-이해/) 글의 프로젝트 구조를 이해하고 있어야 합니다.
- [Spring MVC + JPA CRUD 구현하기](/springblog/spring-mvc-jpa-crud-구현하기/) 글에서 구현한 Post 엔티티, PostRepository, PostService, PostController가 준비되어 있어야 합니다.
- Spring Boot 3.x, Java 17, H2 Database 환경을 기준으로 합니다.

# 1. 연관관계 설계 이해

---

블로그 글을 작성할 때 카테고리와 태그를 사용하면 글을 체계적으로 분류하고 검색할 수 있습니다.

- **카테고리**: 글의 주제를 대분류로 구분 (예: "Spring", "JPA", "Frontend")
- **태그**: 글의 세부 주제를 작은 단위로 표시 (예: "ManyToOne", "Thymeleaf", "Bug Fix")

이런 기능을 구현하려면 데이터베이스에서 **테이블 간 연관관계**를 설정해야 합니다. 관계형 DB는 외래키(Foreign Key)로 테이블을 연결하는데, JPA를 사용하면 이를 Java 객체로 자연스럽게 표현할 수 있습니다.

## 카테고리: ManyToOne (N:1)

- 하나의 글은 하나의 카테고리에만 속함 (N:1 관계)
- Post 테이블에 `category_id` 외래키 컬럼 하나만 추가하면 해결
- 예: 글 10개가 모두 "Spring" 카테고리에 속할 수 있음

```text
Post 테이블                     Category 테이블
+----+--------+-------------+  +----+--------+
| id | title  | category_id |  | id | name   |
+----+--------+-------------+  +----+--------+
| 1  | 글A    | 1           |  | 1  | Spring |
| 2  | 글B    | 1           |  | 2  | JPA    |
| 3  | 글C    | 2           |  +----+--------+
+----+--------+-------------+
```

## 태그: ManyToMany (N:N)

- 하나의 글에 여러 태그가 달릴 수 있고, 하나의 태그도 여러 글에 사용될 수 있음 (N:N 관계)
- 관계형 DB에서 N:N 관계는 **중간 테이블(Join Table)**이 필수
- Post와 Tag 사이에 `post_tags` 테이블을 두어 관계를 관리

```text
Post 테이블     post_tags (중간 테이블)    Tag 테이블
+----+--------+ +---------+--------+      +----+----------+
| id | title  | | post_id | tag_id |      | id | name     |
+----+--------+ +---------+--------+      +----+----------+
| 1  | 글A    | | 1       | 1      |      | 1  | Spring   |
| 2  | 글B    | | 1       | 2      |      | 2  | JPA      |
+----+--------+ | 2       | 1      |      | 3  | ManyToOne|
                | 2       | 3      |      +----+----------+
                +---------+--------+
```

## @JoinColumn vs @JoinTable 비교

| 연관관계 | 사용 어노테이션 | DB 결과 | 사용 이유 |
|---------|--------------|---------|----------|
| ManyToOne (N:1) | `@JoinColumn` | Post 테이블에 외래키 컬럼 1개 추가 | 외래키 하나로 관계 표현 가능 |
| ManyToMany (N:N) | `@JoinTable` | 별도의 중간 테이블 생성 (post_tags) | 양쪽 다 여러 개이므로 외래키 하나로 불가능 |

ManyToOne은 외래키 하나로 해결되지만, ManyToMany는 관계형 DB 구조상 중간 테이블이 필수입니다.

# 2. 엔티티 설계

---

## Category 엔티티

```java
// src/main/java/com/example/blog/entity/Category.java
package com.example.blog.entity;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Getter
@Setter
@NoArgsConstructor
public class Category {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
}
```

카테고리는 id와 name만 가진 독립적인 엔티티입니다.

## Tag 엔티티

```java
// src/main/java/com/example/blog/entity/Tag.java
package com.example.blog.entity;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Getter
@Setter
@NoArgsConstructor
public class Tag {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
}
```

태그도 Category와 동일한 구조입니다. 차이는 Post와의 연관관계 설정 방식에 있습니다.

## Post 엔티티 확장

기존 Post 엔티티에 카테고리와 태그 필드를 추가합니다.

```java
// src/main/java/com/example/blog/entity/Post.java
package com.example.blog.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;
import java.util.List;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

@Entity
@Getter
@Setter
@NoArgsConstructor
public class Post {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String title;

    @Lob
    private String content;

    // ManyToOne: Post(N) -> Category(1)
    // @JoinColumn: post 테이블에 category_id 외래키 컬럼을 생성
    @ManyToOne
    @JoinColumn(name = "category_id")
    private Category category;

    // ManyToMany: Post(N) <-> Tag(N)
    // @JoinTable: 중간 테이블 post_tags를 생성하여 관계를 관리
    @ManyToMany
    @JoinTable(
        name = "post_tags",                                    // 중간 테이블 이름
        joinColumns = @JoinColumn(name = "post_id"),           // Post 쪽 외래키
        inverseJoinColumns = @JoinColumn(name = "tag_id")      // Tag 쪽 외래키
    )
    private List<Tag> tags;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
}
```

**핵심 포인트:**
- `@ManyToOne` + `@JoinColumn(name = "category_id")`: Post 테이블에 `category_id` 외래키 컬럼이 추가됩니다. 이 컬럼이 Category 테이블의 `id`를 참조합니다.
- `@ManyToMany` + `@JoinTable(...)`: `post_tags`라는 중간 테이블이 자동 생성됩니다. 이 테이블은 `post_id`와 `tag_id` 두 개의 외래키 컬럼을 가집니다.
- `joinColumns`는 현재 엔티티(Post) 쪽의 외래키, `inverseJoinColumns`는 반대쪽 엔티티(Tag)의 외래키를 지정합니다.

# 3. Repository 계층

---

Spring Data JPA의 강력한 기능 중 하나는 **메서드 이름만으로 쿼리가 자동 생성**된다는 것입니다. 이전 글에서 사용한 `findAll()`, `findById()` 같은 기본 메서드 외에, 커스텀 쿼리 메서드를 추가합니다.

```java
// src/main/java/com/example/blog/repository/CategoryRepository.java
package com.example.blog.repository;

import com.example.blog.entity.Category;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CategoryRepository extends JpaRepository<Category, Long> {

    // Spring Data JPA가 메서드 이름을 분석하여 자동으로 쿼리 생성:
    // SELECT * FROM category WHERE name = ?
    Optional<Category> findByName(String name);
}
```

```java
// src/main/java/com/example/blog/repository/TagRepository.java
package com.example.blog.repository;

import com.example.blog.entity.Tag;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface TagRepository extends JpaRepository<Tag, Long> {

    // SELECT * FROM tag WHERE name = ?
    Optional<Tag> findByName(String name);
}
```

```java
// src/main/java/com/example/blog/repository/PostRepository.java
package com.example.blog.repository;

import com.example.blog.entity.Category;
import com.example.blog.entity.Post;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PostRepository extends JpaRepository<Post, Long> {

    // 파라미터 타입이 Category 엔티티이면, JPA가 자동으로 category_id로 비교:
    // SELECT * FROM post WHERE category_id = ?
    List<Post> findByCategory(Category category);
}
```

**쿼리 메서드 자동 생성 규칙:**

Spring Data JPA 공식 문서에 따르면, `findBy` 뒤에 오는 이름(프로퍼티명)을 분석하여 JPQL 쿼리를 자동 생성합니다. `findByName(String name)`이면 `WHERE name = ?1`으로, `findByCategory(Category category)`이면 엔티티의 `category` 필드(외래키)를 기준으로 조회합니다.

# 4. Service 계층

---

## CategoryService와 TagService

```java
// src/main/java/com/example/blog/service/CategoryService.java
package com.example.blog.service;

import com.example.blog.entity.Category;
import com.example.blog.repository.CategoryRepository;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class CategoryService {
    private final CategoryRepository categoryRepository;

    // 전체 카테고리 목록 (작성 폼의 드롭다운에 사용)
    public List<Category> getCategories() {
        return categoryRepository.findAll();
    }

    // 이름으로 카테고리 조회
    public Optional<Category> getCategory(String name) {
        return categoryRepository.findByName(name);
    }

    // ID로 카테고리 조회 (폼에서 넘어온 category.id로 실제 엔티티 조회 시 사용)
    public Optional<Category> getCategoryById(Long id) {
        return categoryRepository.findById(id);
    }
}
```

TagService도 동일한 구조입니다. 각 도메인(Category, Tag)의 조회/저장 로직을 담당합니다.

```java
// src/main/java/com/example/blog/service/TagService.java
package com.example.blog.service;

import com.example.blog.entity.Tag;
import com.example.blog.repository.TagRepository;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TagService {
    private final TagRepository tagRepository;

    public Optional<Tag> getTag(String name) {
        return tagRepository.findByName(name);
    }

    public Tag save(Tag tag) {
        return tagRepository.save(tag);
    }
}
```

## PostService 확장

PostService는 CategoryService와 TagService를 주입받아 사용합니다. 이전 글에서 구현한 `savePost()` 메서드에 카테고리와 태그 처리 로직을 추가합니다.

```java
// src/main/java/com/example/blog/service/PostService.java
package com.example.blog.service;

import com.example.blog.entity.Category;
import com.example.blog.entity.Post;
import com.example.blog.entity.Tag;
import com.example.blog.repository.PostRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class PostService {
    private final PostRepository postRepository;
    private final CategoryService categoryService;  // Service -> Service 의존
    private final TagService tagService;

    public List<Post> getPosts() {
        return postRepository.findAll();
    }

    public Optional<Post> getPost(Long id) {
        return postRepository.findById(id);
    }

    // 카테고리별 글 조회
    public List<Post> getPostsByCategory(String categoryName) {
        Category category = categoryService.getCategory(categoryName)
                .orElseThrow();  // 카테고리가 없으면 NoSuchElementException
        return postRepository.findByCategory(category);
    }

    // 글 저장 (카테고리 + 태그 처리 포함)
    public Post savePost(Post post, String tagInput) {
        // 1단계: 카테고리 처리 - 폼에서 넘어온 빈 껍데기를 DB의 관리 상태 엔티티로 교체
        if (post.getCategory() != null && post.getCategory().getId() != null) {
            Category category = categoryService.getCategoryById(post.getCategory().getId())
                    .orElse(null);
            post.setCategory(category);
        }

        // 2단계: 태그 처리 - 쉼표 구분 문자열을 Tag 엔티티 리스트로 변환
        if (tagInput != null && !tagInput.isBlank()) {
            String[] tags = tagInput.split(",");
            List<Tag> parsedTags = new ArrayList<>();

            for (String tag : tags) {
                String name = tag.trim();
                Optional<Tag> existingTag = tagService.getTag(name);

                if (existingTag.isEmpty()) {
                    // DB에 없는 태그면 새로 생성하여 저장
                    Tag newTag = new Tag();
                    newTag.setName(name);
                    parsedTags.add(tagService.save(newTag));
                } else {
                    // DB에 이미 있는 태그면 재사용
                    parsedTags.add(existingTag.get());
                }
            }
            post.setTags(parsedTags);
        }

        // 3단계: 시간 처리 - 새 글이면 createdAt 설정, 수정이면 기존 createdAt 보존
        if (post.getId() == null) {
            post.setCreatedAt(LocalDateTime.now());
        } else {
            Post existPost = postRepository.findById(post.getId()).orElseThrow();
            post.setCreatedAt(existPost.getCreatedAt());
        }
        post.setUpdatedAt(LocalDateTime.now());

        return postRepository.save(post);
    }

    public void deletePost(Long id) {
        postRepository.deleteById(id);
    }
}
```

**왜 Repository가 아닌 Service를 주입했나?**

- Repository는 단순 데이터 접근 계층 (SQL 실행)
- Service는 비즈니스 로직 계층 (여러 Repository를 조합하거나 추가 로직 수행)
- PostService에서 카테고리 관련 로직이 필요하면 CategoryService를 통해 접근하는 것이 **계층 구조를 지키는 방법**

만약 PostService에서 CategoryRepository를 직접 사용하면, CategoryService에 있는 비즈니스 로직(예: 유효성 검증)을 우회하게 됩니다. Service 간 의존은 각 도메인의 비즈니스 규칙을 일관성 있게 적용하기 위한 설계입니다.

# 5. Controller 계층

---

기존 PostController에 카테고리 필터링과 태그 입력 처리 기능을 추가합니다.

```java
// src/main/java/com/example/blog/controller/PostController.java
package com.example.blog.controller;

import com.example.blog.entity.Post;
import com.example.blog.service.CategoryService;
import com.example.blog.service.PostService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Controller
@RequiredArgsConstructor
public class PostController {
    private final PostService postService;
    private final CategoryService categoryService;

    // 카테고리별 필터링이 가능한 글 목록
    @GetMapping("/posts")
    public String listPosts(@RequestParam(required = false) String category, Model model) {
        List<Post> posts;
        if (category == null || category.isBlank()) {
            posts = postService.getPosts();          // 전체 목록
        } else {
            posts = postService.getPostsByCategory(category);  // 카테고리별 목록
        }
        model.addAttribute("posts", posts);
        return "posts/list";
    }

    // 작성 폼 - 카테고리 드롭다운을 위해 카테고리 목록도 전달
    @GetMapping("/posts/new")
    public String createForm(Model model) {
        model.addAttribute("categories", categoryService.getCategories());
        return "posts/create";
    }

    // 작성 처리 - tagInput을 별도 파라미터로 수신
    @PostMapping("/posts/new")
    public String createPost(@RequestParam(required = false) String tagInput, Post post) {
        postService.savePost(post, tagInput);
        return "redirect:/posts";
    }
}
```

**`@RequestParam(required = false)`의 의미:**

| URL | category 값 | 결과 |
|-----|-------------|------|
| `/posts` | `null` (파라미터 없음) | 전체 글 목록 |
| `/posts?category=Spring` | `"Spring"` | Spring 카테고리 글만 |

`required = false`를 지정하면 쿼리 파라미터가 없어도 에러가 발생하지 않고, 해당 파라미터에 `null`이 전달됩니다.

**tagInput을 별도 파라미터로 받는 이유:**

Post 엔티티에는 `tagInput` 필드가 없고, `tags` 필드는 `List<Tag>` 타입입니다. HTML 폼에서 넘어오는 값은 단순 문자열이므로, `name="tags"`로 보내면 Spring이 `List<Tag>`로 바인딩을 시도하다 타입 불일치 에러가 발생합니다. 따라서 폼 필드 이름을 `tagInput`으로 설정하고, `@RequestParam`으로 별도 파라미터로 수신한 뒤 Service에서 파싱합니다.

# 6. Thymeleaf 템플릿

---

## 작성 폼 (create.html)

```html
<!-- src/main/resources/templates/posts/create.html -->
<form th:action="@{/posts/new}" method="post">
    <!-- 카테고리 드롭다운 -->
    <div class="form-group">
        <label for="category">Category</label>
        <select id="category" name="category.id">
            <option value="">-- Select --</option>
            <option th:each="cat : ${categories}"
                    th:value="${cat.id}"
                    th:text="${cat.name}">Category</option>
        </select>
    </div>

    <!-- 태그 입력 (쉼표로 구분하여 입력) -->
    <div class="form-group">
        <label for="tags">Tags (comma separated)</label>
        <input type="text" id="tags" name="tagInput"
               placeholder="Spring, JPA, Blog">
    </div>
</form>
```

**`name="category.id"`의 동작 원리:**

Spring MVC가 폼 데이터를 Post 객체에 바인딩할 때, `category.id`는 중첩 프로퍼티(nested property)로 인식됩니다. 내부적으로 `post.getCategory().setId(값)` 순서로 처리되어, Post 객체의 category 필드 안에 있는 id 필드에 선택한 카테고리의 id 값이 들어갑니다.

**`name="tagInput"`으로 분리한 이유:**

위 Controller 섹션에서 설명한 것처럼, Post 엔티티의 `tags` 필드는 `List<Tag>` 타입입니다. HTML 폼에서 넘어오는 값은 문자열이므로 타입 불일치가 발생합니다. 폼 필드 이름을 엔티티에 없는 `tagInput`으로 설정하면 Spring이 자동 바인딩을 시도하지 않으므로 충돌을 피할 수 있습니다.

## 수정 폼 (edit.html)

```html
<!-- src/main/resources/templates/posts/edit.html -->
<form th:action="@{/posts/{id}/edit(id=${post.id})}" method="post">
    <!-- 카테고리 드롭다운 - 기존 카테고리가 선택된 상태로 표시 -->
    <div class="form-group">
        <label for="category">Category</label>
        <select id="category" name="category.id">
            <option value="">-- Select --</option>
            <option th:each="cat : ${categories}"
                    th:value="${cat.id}"
                    th:selected="${post.category != null && post.category.id == cat.id}"
                    th:text="${cat.name}">Category</option>
        </select>
    </div>

    <!-- 태그 입력 - 기존 태그를 쉼표로 연결하여 표시 -->
    <div class="form-group">
        <label for="tags">Tags (comma separated)</label>
        <input type="text" id="tags" name="tagInput"
               th:value="${post.tags != null ? #strings.listJoin(post.tags.![name], ', ') : ''}">
    </div>
</form>
```

**`th:selected` 조건:**

현재 글의 카테고리 id와 드롭다운의 카테고리 id가 같으면 `selected` 속성이 추가됩니다. `post.category != null` 체크를 먼저 하는 이유는, 카테고리가 설정되지 않은 글일 수 있기 때문입니다.

**기존 태그 표시 로직:**

| Thymeleaf 표현식 | 설명 | 결과 예시 |
|------------------|------|----------|
| `post.tags.![name]` | Projection 문법. `List<Tag>`에서 `name` 필드만 추출 | `["Spring", "JPA"]` |
| `#strings.listJoin(..., ', ')` | 리스트를 지정한 구분자로 연결 | `"Spring, JPA"` |

## 목록 페이지 (list.html)

```html
<!-- src/main/resources/templates/posts/list.html -->
<ul class="post-list">
    <li th:each="post : ${posts}">
        <h2>
            <a th:href="@{/posts/{id}(id=${post.id})}" th:text="${post.title}">Title</a>
        </h2>
        <span th:text="${#temporals.format(post.createdAt, 'yyyy-MM-dd HH:mm')}">
            2026-01-01
        </span>

        <!-- 카테고리 표시 (하나만 있으므로 단순 출력) -->
        <span th:if="${post.category != null}"
              th:text="'| ' + ${post.category.name}">| Category</span>

        <!-- 태그 표시 (여러 개이므로 반복문으로 출력) -->
        <div th:if="${post.tags != null && !post.tags.isEmpty()}">
            <span th:each="tag : ${post.tags}"
                  class="tag-badge"
                  th:text="${tag.name}">tag</span>
        </div>
    </li>
</ul>
```

카테고리는 하나만 있으므로 단순 텍스트로 표시하고, 태그는 여러 개일 수 있으므로 `th:each`로 반복하여 표시합니다.

# 7. 주의할 점

---

## 1. TransientObjectException: 카테고리 저장 시 에러

**증상:**

```text
org.hibernate.TransientObjectException: object references an unsaved transient instance
```

**원인:**

HTML 폼에서 넘어온 category 객체는 `id`만 있는 빈 껍데기입니다. JPA의 영속성 컨텍스트(EntityManager)가 관리하지 않는 객체(transient 상태)이기 때문에, 이 상태로 Post에 연결하여 저장하려고 하면 에러가 발생합니다.

**해결:**

```java
// 잘못된 코드 - 폼에서 넘어온 빈 껍데기를 그대로 사용
post.setCategory(post.getCategory());

// 올바른 코드 - DB에서 관리 상태(managed) 엔티티를 조회하여 교체
if (post.getCategory() != null && post.getCategory().getId() != null) {
    Category category = categoryService.getCategoryById(post.getCategory().getId())
            .orElse(null);
    post.setCategory(category);  // DB에서 조회한 관리 상태 엔티티로 교체
}
```

`findById()`로 조회한 엔티티는 JPA가 관리하는 managed 상태이므로, 이 엔티티를 Post에 연결하면 정상적으로 저장됩니다.

## 2. 태그 파라미터 이름 충돌

**증상:**

폼에서 `name="tags"`로 보내면 Spring이 Post.tags(`List<Tag>`)에 자동 바인딩을 시도합니다. HTML에서 넘어오는 값은 문자열인데 `List<Tag>` 타입과 맞지 않아 바인딩 에러가 발생합니다.

**해결:**

```html
<!-- 폼 필드 이름을 엔티티에 없는 이름으로 변경 -->
<input type="text" name="tagInput" placeholder="Spring, JPA">
```

```java
// Controller에서 @RequestParam으로 별도 수신
@PostMapping("/posts/new")
public String createPost(@RequestParam(required = false) String tagInput, Post post) {
    postService.savePost(post, tagInput);
    return "redirect:/posts";
}
```

폼 필드 이름을 `tagInput`으로 변경하면 Spring이 Post 객체에 바인딩을 시도하지 않습니다.

## 3. createdAt이 null로 덮어씌워지는 문제

**원인:**

수정 폼에는 `createdAt` 필드가 없으므로, 폼 제출 시 `createdAt`이 `null`로 넘어옵니다. 그대로 `save()`를 호출하면 기존 `createdAt` 값이 `null`로 덮어씌워집니다.

**해결:**

```java
if (post.getId() == null) {
    // 새 글 생성: createdAt 설정
    post.setCreatedAt(LocalDateTime.now());
} else {
    // 기존 글 수정: DB에서 기존 createdAt 조회하여 보존
    Post existPost = postRepository.findById(post.getId()).orElseThrow();
    post.setCreatedAt(existPost.getCreatedAt());
}
```

> **참고**: 실무에서는 JPA의 `@PrePersist`, `@PreUpdate` 콜백이나 Spring Data JPA Auditing (`@CreatedDate`, `@LastModifiedDate`)을 사용하면 이 문제를 근본적으로 해결할 수 있습니다.

## 4. isBlank() 조건 반전 실수

**잘못된 코드:**

```java
if (tagInput != null && tagInput.isBlank()) {
    // 태그 파싱 로직
}
```

이 코드는 "tagInput이 **비어있으면** 파싱한다"는 의미입니다. `isBlank()`는 문자열이 비어있거나 공백만 있으면 `true`를 반환하므로, 조건이 반대입니다.

**올바른 코드:**

```java
if (tagInput != null && !tagInput.isBlank()) {
    // tagInput이 null이 아니고, 비어있지 않을 때만 파싱
}
```

`!`(논리 부정 연산자)를 붙여야 "비어있지 않으면"이라는 의미가 됩니다. 조건문 작성 시 논리 연산자의 방향을 반드시 확인해야 합니다.

# 8. JPA Cascade와 ManyToMany

---

Cascade는 부모 엔티티의 작업(저장, 수정, 삭제)이 자식 엔티티에 **자동으로 전파**되는 기능입니다.

## Cascade 타입 종류

| CascadeType | 동작 | 예시 |
|-------------|------|------|
| `PERSIST` | 부모 저장 시 자식도 자동 저장 | 게시글 저장 시 첨부파일도 함께 저장 |
| `MERGE` | 부모 수정 시 자식도 자동 수정 | 게시글 수정 시 첨부파일도 함께 수정 |
| `REMOVE` | 부모 삭제 시 자식도 자동 삭제 | 게시글 삭제 시 첨부파일도 함께 삭제 |
| `ALL` | 위의 모든 작업을 전파 | 부모-자식이 완전한 생명주기를 공유 |

Spring Data JPA 공식 문서에 따르면, Cascade는 부모 엔티티의 상태 변화를 연관된 자식 엔티티에 전이(propagation)시키는 JPA 표준 기능입니다.

## ManyToMany에 Cascade를 사용하면 안 되는 이유

Tag는 여러 Post에서 **공유**됩니다. 만약 `CascadeType.REMOVE`를 설정하면 다음과 같은 문제가 발생합니다.

```text
Post A (태그: Spring, JPA)
Post B (태그: Spring, React)

Post A를 삭제하면...
  → CascadeType.REMOVE에 의해 "Spring" 태그와 "JPA" 태그가 삭제됨
  → Post B가 참조하던 "Spring" 태그도 사라짐
  → 데이터 정합성 깨짐!
```

ManyToMany 관계에서 공유되는 엔티티에 Cascade를 설정하면, 한쪽을 삭제할 때 다른 쪽에서 참조하는 데이터까지 삭제될 수 있습니다. 따라서 Tag처럼 공유되는 엔티티는 **Service 레벨에서 수동으로 관리**하는 것이 안전합니다.

> **Cascade가 적합한 경우**: 부모와 자식이 1:1 또는 1:N 관계이고, 자식이 부모 없이는 존재할 수 없는 경우 (예: 주문-주문상세, 게시글-첨부파일)

# 9. 정리

---

## 연관관계 매핑 요약

| 구분 | 카테고리 | 태그 |
|------|---------|------|
| **관계** | ManyToOne (N:1) | ManyToMany (N:N) |
| **어노테이션** | `@ManyToOne` + `@JoinColumn` | `@ManyToMany` + `@JoinTable` |
| **DB 구조** | Post 테이블에 외래키 컬럼 추가 | 별도 중간 테이블(post_tags) 생성 |
| **Cascade** | 사용 가능 (독점적 관계) | 사용 주의 (공유 엔티티) |
| **폼 처리** | `name="category.id"` (중첩 바인딩) | `name="tagInput"` (별도 파라미터) |

## 핵심 개념 요약

| 개념 | 설명 |
|------|------|
| `@ManyToOne` + `@JoinColumn` | N:1 관계. 외래키 컬럼을 현재 테이블에 추가 |
| `@ManyToMany` + `@JoinTable` | N:N 관계. 중간 테이블을 생성하여 관계 관리 |
| 쿼리 메서드 자동 생성 | `findByName()` 같은 메서드명을 Spring Data JPA가 분석하여 쿼리 자동 생성 |
| TransientObjectException | JPA가 관리하지 않는 객체를 연관관계에 사용하면 발생. DB 조회로 해결 |
| CascadeType | 부모의 상태 변화를 자식에 전파. ManyToMany 공유 엔티티에는 사용 주의 |
| `@RequestParam(required = false)` | 쿼리 파라미터가 없어도 에러 없이 null로 전달 |
| 폼 필드 이름 분리 | 엔티티 필드와 타입이 다른 폼 입력은 별도 이름으로 분리하여 바인딩 충돌 방지 |

```text
핵심:
  ManyToOne = 외래키 하나로 해결 (@JoinColumn)
  ManyToMany = 중간 테이블 필수 (@JoinTable)
  공유 엔티티(Tag)에는 Cascade를 사용하면 안 됨
  폼 데이터 타입이 엔티티 필드와 다르면 별도 파라미터로 분리
```

# Reference

---

- [Spring Data JPA 공식 문서 - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Spring Data JPA 공식 문서 - Entity Persistence](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-persistence.html)
- [Jakarta Persistence 스펙 - @ManyToOne](https://jakarta.ee/specifications/persistence/3.1/apidocs/jakarta.persistence/jakarta/persistence/manytoone)
- [Jakarta Persistence 스펙 - @ManyToMany](https://jakarta.ee/specifications/persistence/3.1/apidocs/jakarta.persistence/jakarta/persistence/manytomany)
- [Thymeleaf 공식 문서](https://www.thymeleaf.org/documentation.html)
- [Spring MVC 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc.html)
