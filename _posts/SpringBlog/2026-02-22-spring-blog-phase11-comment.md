---
layout: single
title: "[SpringBlog] Phase 11 - 댓글 기능 구현 (JPA 연관관계 + 비밀번호 인증)"
categories:
  - SpringBlog
tags:
  - [Spring Boot, JPA, ManyToOne, PrePersist, React, REST API, Spring Security]
---

# Introduction

---

블로그에 글을 작성하고 읽는 기능은 완성했지만, 방문자와 소통할 수 있는 댓글 기능이 없었습니다. 이번 Phase 11에서는 **비로그인 사용자도 닉네임과 비밀번호만으로 댓글을 작성하고 삭제할 수 있는 댓글 시스템**을 구현했습니다. 백엔드는 Spring Boot + JPA, 프론트엔드는 React로 구현했으며, JPA 연관관계 매핑과 라이프사이클 콜백 같은 중요한 개념들을 실습했습니다.

**이 글에서 다루는 내용:**
- `@ManyToOne` / `@JoinColumn`으로 Comment-Post 연관관계 매핑
- `@PrePersist` / `@PreUpdate` JPA 라이프사이클 콜백으로 생성/수정 시간 자동 관리
- Spring Data JPA 쿼리 메서드로 게시글별 댓글 페이징 조회
- DTO 3종 설계 (Request / DeleteRequest / Response)와 보안 고려
- 비밀번호 기반 댓글 삭제 로직과 Spring Security URL 접근 권한 설정
- React `CommentSection` 컴포넌트로 댓글 CRUD UI 구현

**사전 준비:**
- Spring Boot 3.x 프로젝트 (Spring Security + JWT 인증 구현 완료)
- React 프론트엔드 (Vite + React Router)
- 이전 Phase의 게시글 CRUD, 인증 기능이 동작하는 상태

# 1. 배경 - 어떤 댓글 시스템을 만들 것인가?

---

기존 블로그에는 글을 작성하고 읽는 기능만 있었습니다. 방문자와 소통하려면 댓글 기능이 필요한데, 몇 가지 설계 선택이 필요했습니다.

| 방식 | 장점 | 단점 |
|------|------|------|
| 회원 가입 기반 댓글 | 스팸 방지에 유리 | 방문자 입장에서 불편 |
| OAuth 로그인(Google, GitHub) | 신뢰도 높은 사용자 | 구현이 복잡 |
| **닉네임 + 비밀번호 방식** | **간단하고 익숙한 방식** | **보안 수준이 상대적으로 낮음** |

1인 블로그 특성상 간편함이 중요하므로 닉네임 + 비밀번호 방식을 선택했습니다.

**최종 설계:**

| 사용자 | 할 수 있는 것 |
|--------|-------------|
| 비로그인 방문자 | 댓글 조회, 작성, 본인 댓글 삭제/수정 (비밀번호 확인) |
| 관리자 (로그인) | 모든 댓글 삭제 |

기술적으로는 `Comment` 엔티티가 `Post` 엔티티와 **다대일(N:1) 관계**를 가집니다. 여러 댓글이 하나의 게시글에 속하기 때문입니다.

**API 엔드포인트:**

| Method | Endpoint | 설명 | 인증 |
|--------|----------|------|------|
| GET | `/api/posts/{postId}/comments?page=0` | 댓글 목록 조회 (페이징) | 불필요 |
| POST | `/api/posts/{postId}/comments` | 댓글 작성 | 불필요 |
| PUT | `/api/comments/{id}` | 댓글 수정 | 비밀번호 확인 |
| DELETE | `/api/comments/{id}` | 댓글 삭제 | 비밀번호 확인 |

# 2. Comment 엔티티 - JPA 연관관계 매핑

---

```java
// backend/src/main/java/com/example/blog/entity/Comment.java

@Getter
@Setter
@Entity
@NoArgsConstructor
public class Comment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String content;   // 댓글 내용
    private String author;    // 작성자 닉네임
    private String password;  // 삭제/수정 시 본인 확인용 비밀번호

    // @ManyToOne: Comment(N) → Post(1). 여러 댓글이 하나의 게시글에 속함
    // @JoinColumn: comment 테이블에 post_id 외래키 컬럼 생성
    @ManyToOne
    @JoinColumn(name = "post_id")
    private Post post;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    // @PrePersist: JPA가 save()로 처음 저장하기 직전에 자동 호출
    @PrePersist
    public void prePersist() {
        this.createdAt = LocalDateTime.now();
        this.updatedAt = LocalDateTime.now();
    }

    // @PreUpdate: 이미 있는 엔티티를 수정하기 직전에 자동 호출
    @PreUpdate
    public void preUpdate() {
        this.updatedAt = LocalDateTime.now();
    }
}
```

여기서 두 가지 핵심 개념이 등장합니다.

## 2-1. `@ManyToOne` + `@JoinColumn`

JPA에서 두 테이블 사이의 관계를 코드로 표현하는 방법입니다.

- `@ManyToOne`: "이 엔티티(Comment) 여러 개가 저 엔티티(Post) 하나에 속한다"는 의미
- `@JoinColumn(name = "post_id")`: comment 테이블에 `post_id`라는 외래키 컬럼을 만들어서 Post와 연결

DB 테이블로 보면 이렇게 됩니다:

```
comment 테이블
+----+---------+--------+----------+---------+
| id | content | author | password | post_id |  ← post_id가 외래키
+----+---------+--------+----------+---------+
|  1 | 좋은 글 | 홍길동 | 1234     |    5    |
|  2 | 감사합니다| 이순신 | 5678    |    5    |
+----+---------+--------+----------+---------+
```

`@ManyToOne`은 기본적으로 **즉시 로딩(EAGER)**입니다. 댓글을 조회하면 연결된 Post도 함께 조회됩니다. 만약 Post 정보가 필요 없는 경우에는 `@ManyToOne(fetch = FetchType.LAZY)`로 지연 로딩을 설정할 수 있습니다.

## 2-2. `@PrePersist` / `@PreUpdate` - JPA 라이프사이클 콜백

엔티티가 저장/수정될 때 JPA가 자동으로 호출해주는 메서드입니다. 덕분에 `comment.setCreatedAt(LocalDateTime.now())`를 매번 수동으로 호출하지 않아도 됩니다.

```text
save() 호출 (새 엔티티)
    ↓
@PrePersist 메서드 실행  ← createdAt, updatedAt 세팅
    ↓
실제 INSERT 쿼리 실행

save() 호출 (기존 엔티티)
    ↓
@PreUpdate 메서드 실행   ← updatedAt만 갱신
    ↓
실제 UPDATE 쿼리 실행
```

> JPA의 `save()` 메서드는 엔티티의 ID가 `null`이면 INSERT(새로 생성), `null`이 아니면 UPDATE(기존 수정)로 동작합니다. 이것이 ID 타입으로 `Long`(null 가능)을 사용하는 이유 중 하나입니다.

## 2-3. `int` vs `Long` - JPA ID 타입

처음에 `id`를 `int`로 선언했다가 `Long`으로 수정했습니다. JPA에서 기본 키 타입은 `Long`을 사용하는 것이 관례입니다.

| 타입 | null 표현 | JPA 판단 |
|------|----------|----------|
| `int` (원시 타입) | 불가능 (기본값 0) | 저장 전에도 id=0이라 "이미 저장됨"으로 오판 가능 |
| `Long` (래퍼 타입) | 가능 (기본값 null) | 저장 전 id=null → 저장 후 id=숫자로 명확히 구분 |

# 3. CommentRepository - 쿼리 메서드

---

```java
// backend/src/main/java/com/example/blog/repository/CommentRepository.java

public interface CommentRepository extends JpaRepository<Comment, Long> {

    // Spring Data JPA 쿼리 메서드: 메서드 이름만으로 SQL을 자동 생성
    // findBy + PostId → WHERE post_id = ?
    // OrderBy + CreatedAt + Desc → ORDER BY created_at DESC (최신순)
    // Pageable 파라미터 → LIMIT/OFFSET 페이징 처리
    // 반환 타입 Page<Comment> → 페이징 정보(총 개수, 총 페이지 수 등) 포함
    Page<Comment> findByPostIdOrderByCreatedAtDesc(Long postId, Pageable pageable);
}
```

Spring Data JPA의 **쿼리 메서드** 기능입니다. 메서드 이름 규칙을 따르면 SQL을 직접 작성하지 않아도 됩니다. Spring Data JPA가 이름을 분석해서 자동으로 쿼리를 만들어줍니다.

**쿼리 메서드 이름 분석:**

```text
findByPostIdOrderByCreatedAtDesc
  │    │       │      │         │
  │    │       │      │         └─ Desc: 내림차순
  │    │       │      └──────────── CreatedAt: 정렬 기준 필드
  │    │       └─────────────────── OrderBy: 정렬 시작
  │    └─────────────────────────── PostId: WHERE 조건 (post_id = ?)
  └──────────────────────────────── findBy: SELECT 시작
```

Spring Data JPA 공식 문서에서 지원하는 주요 키워드는 `And`, `Or`, `Between`, `LessThan`, `GreaterThan`, `Like`, `OrderBy`, `In`, `Not`, `True`, `False`, `IgnoreCase` 등이 있습니다.

# 4. DTO 설계 - 요청과 응답 분리

---

댓글 기능에서는 DTO를 3개로 분리했습니다. 각 DTO가 담당하는 역할이 다르기 때문입니다.

```java
// backend/.../dto/CommentRequest.java (작성/수정 요청)
@Getter
@Setter
@NoArgsConstructor
public class CommentRequest {
    private String content;   // 댓글 내용
    private String author;    // 작성자 닉네임
    private String password;  // 댓글 비밀번호 (수정/삭제 시 본인 확인용)
}

// backend/.../dto/CommentDeleteRequest.java (삭제 요청)
@Getter
@Setter
@NoArgsConstructor
public class CommentDeleteRequest {
    private String password;  // 삭제는 비밀번호만 필요
}

// backend/.../dto/CommentResponse.java (응답)
@Getter
public class CommentResponse {
    private final Long id;
    private final String content;
    private final String author;
    private final LocalDateTime createdAt;
    private final LocalDateTime updatedAt;
    // password 필드 없음 - 절대 응답에 포함하면 안 됨

    // Comment 엔티티 → CommentResponse DTO 변환 생성자
    public CommentResponse(Comment comment) {
        this.id = comment.getId();
        this.content = comment.getContent();
        this.author = comment.getAuthor();
        this.createdAt = comment.getCreatedAt();
        this.updatedAt = comment.getUpdatedAt();
    }
}
```

**DTO를 3개로 나눈 이유:**

| DTO | 용도 | 포함 필드 |
|-----|------|-----------|
| `CommentRequest` | 작성/수정 요청 | content, author, password |
| `CommentDeleteRequest` | 삭제 요청 | password만 |
| `CommentResponse` | 서버 응답 | id, content, author, createdAt, updatedAt (**password 제외**) |

`CommentDeleteRequest`를 별도로 분리한 이유는 의도를 명확히 하기 위해서입니다. `CommentRequest`를 그대로 쓸 수도 있지만, 그러면 삭제 시에도 `content`와 `author` 필드를 불필요하게 전송해야 합니다. `CommentResponse`에서 `password`를 제외하는 것은 보안의 기본 원칙입니다. 비밀번호가 JSON 응답에 포함되면 브라우저 개발자 도구에서 누구나 볼 수 있습니다.

# 5. CommentService - 비즈니스 로직과 비밀번호 검증

---

```java
// backend/src/main/java/com/example/blog/service/CommentService.java

@Service
@RequiredArgsConstructor
public class CommentService {

    private final CommentRepository commentRepository;
    private final PostRepository postRepository;

    // 특정 게시글의 댓글 목록을 페이징하여 조회
    public Page<Comment> getComments(Long postId, Pageable pageable) {
        return commentRepository.findByPostIdOrderByCreatedAtDesc(postId, pageable);
    }

    // 댓글 작성: 게시글 ID로 Post를 찾고, Comment에 연결하여 저장
    public Comment saveComment(Long postId, CommentRequest commentRequest) {
        // 게시글이 존재하는지 확인 (없으면 NoSuchElementException 발생)
        Post post = postRepository.findById(postId).orElseThrow();

        // DTO → 엔티티 변환: Request에서 받은 값을 Comment 엔티티에 세팅
        Comment comment = new Comment();
        comment.setContent(commentRequest.getContent());
        comment.setAuthor(commentRequest.getAuthor());
        comment.setPassword(commentRequest.getPassword());
        comment.setPost(post);  // Comment ↔ Post 연관관계 설정
        // save() 호출 시 @PrePersist에 의해 createdAt/updatedAt이 자동 설정됨
        return commentRepository.save(comment);
    }

    // 댓글 수정: 비밀번호 확인 후 내용 변경
    public Comment updateComment(Long id, CommentRequest commentRequest) {
        Comment comment = commentRepository.findById(id).orElseThrow();

        // 비밀번호가 일치하지 않으면 예외 발생 → 수정 불가
        if (!comment.getPassword().equals(commentRequest.getPassword())) {
            throw new IllegalArgumentException("비밀번호가 일치하지 않습니다.");
        }

        // 비밀번호 확인 후 내용만 수정 (author, password는 변경하지 않음)
        comment.setContent(commentRequest.getContent());
        // save() 호출 시 @PreUpdate에 의해 updatedAt이 자동 갱신됨
        return commentRepository.save(comment);
    }

    // 댓글 삭제: 비밀번호 확인 후 삭제
    public void deleteComment(Long id, String password) {
        Comment comment = commentRepository.findById(id).orElseThrow();

        // 비밀번호가 일치하지 않으면 예외 발생 → 삭제 불가
        if (!comment.getPassword().equals(password)) {
            throw new IllegalArgumentException("비밀번호가 일치하지 않습니다.");
        }

        commentRepository.deleteById(id);
    }
}
```

**비밀번호 검증을 Service 레이어에 두는 이유:**

비즈니스 규칙("본인만 수정/삭제 가능")은 Controller가 아닌 Service에 두는 것이 Spring의 계층 분리 원칙에 맞습니다.

```text
Controller → 요청/응답 처리 (HTTP 관련)
Service    → 비즈니스 로직 (비밀번호 검증, 권한 확인 등)
Repository → 데이터 접근 (DB 조회/저장)
```

만약 Controller에서 비밀번호를 검증하면, 나중에 같은 로직이 필요한 다른 Controller가 생겼을 때 코드가 중복됩니다. Service에 두면 어디서든 `commentService.deleteComment(id, password)`만 호출하면 됩니다.

# 6. CommentApiController - RESTful URL 설계

---

```java
// backend/src/main/java/com/example/blog/controller/CommentApiController.java

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class CommentApiController {

    private final CommentService commentService;

    // 댓글 목록 조회: GET /api/posts/{postId}/comments?page=0
    // ResponseEntity 없이 직접 반환 → Spring이 자동으로 200 OK 처리
    @GetMapping("/posts/{postId}/comments")
    public Page<CommentResponse> listComments(
            @PathVariable Long postId,
            @RequestParam(defaultValue = "0") int page) {
        int pageSize = 5;
        Pageable pageable = PageRequest.of(page, pageSize, Sort.by("createdAt").descending());
        Page<Comment> comments = commentService.getComments(postId, pageable);
        // .map(CommentResponse::new): Page 안의 각 Comment 엔티티를 DTO로 변환
        return comments.map(CommentResponse::new);
    }

    // 댓글 작성: POST /api/posts/{postId}/comments
    // 인증 불필요 - 닉네임/비밀번호를 요청 본문에 포함
    @PostMapping("/posts/{postId}/comments")
    public ResponseEntity<CommentResponse> createComment(
            @PathVariable Long postId,
            @RequestBody CommentRequest commentRequest) {
        Comment comment = commentService.saveComment(postId, commentRequest);
        // 새 리소스 생성이므로 201 Created 반환
        return ResponseEntity.status(HttpStatus.CREATED).body(new CommentResponse(comment));
    }

    // 댓글 수정: PUT /api/comments/{id}
    // 비밀번호 확인 후 내용 수정 (Service에서 비밀번호 검증)
    @PutMapping("/comments/{id}")
    public ResponseEntity<CommentResponse> updateComment(
            @PathVariable Long id,
            @RequestBody CommentRequest commentRequest) {
        Comment comment = commentService.updateComment(id, commentRequest);
        return ResponseEntity.ok(new CommentResponse(comment));
    }

    // 댓글 삭제: DELETE /api/comments/{id}
    // 비밀번호 확인 후 삭제 (Service에서 비밀번호 검증)
    @DeleteMapping("/comments/{id}")
    public ResponseEntity<Void> deleteComment(
            @PathVariable Long id,
            @RequestBody CommentDeleteRequest commentDeleteRequest) {
        commentService.deleteComment(id, commentDeleteRequest.getPassword());
        // 204 No Content: 삭제 성공, 반환할 내용 없음
        return ResponseEntity.noContent().build();
    }
}
```

**URL 설계 포인트:**

| URL 패턴 | 설계 이유 |
|----------|-----------|
| `GET/POST /api/posts/{postId}/comments` | 댓글은 게시글에 **속한** 리소스이므로 게시글 하위 URL |
| `PUT/DELETE /api/comments/{id}` | 특정 댓글 하나를 조작할 때는 댓글 ID로 **직접 접근** |

게시글의 하위 리소스로서 댓글을 표현하는 URL(`/posts/{postId}/comments`)과, 개별 댓글을 직접 참조하는 URL(`/comments/{id}`)을 구분한 것은 REST 설계의 일반적인 패턴입니다.

# 7. SecurityConfig - 댓글 API 접근 권한

---

댓글 기능은 비로그인 사용자도 사용할 수 있어야 하므로, Spring Security 설정에서 댓글 관련 URL을 `permitAll()`로 허용합니다.

```java
// backend/src/main/java/com/example/blog/config/SecurityConfig.java (관련 부분)

.authorizeHttpRequests(auth -> auth
    // GET 요청은 모두 허용 (글/댓글 조회는 누구나 가능)
    .requestMatchers(HttpMethod.GET, "/api/**").permitAll()
    // 인증 API는 비로그인 상태에서 호출해야 하므로 허용
    .requestMatchers(HttpMethod.POST, "/api/auth/**").permitAll()
    // 댓글 작성은 비로그인도 가능 (닉네임/비밀번호로 작성)
    .requestMatchers(HttpMethod.POST, "/api/posts/*/comments").permitAll()
    // 댓글 삭제도 비밀번호로 본인 확인하므로 허용
    .requestMatchers(HttpMethod.DELETE, "/api/comments/**").permitAll()
    // 위에 명시되지 않은 나머지 요청은 인증 필요 (글 작성/수정/삭제 등)
    .anyRequest().authenticated()
)
```

**URL 패턴에서 `*`와 `**`의 차이:**

| 패턴 | 의미 | 매칭 예시 |
|------|------|----------|
| `/api/posts/*/comments` | 경로 1단계만 매칭 | `/api/posts/5/comments` (O), `/api/posts/5/6/comments` (X) |
| `/api/comments/**` | 모든 하위 경로 매칭 | `/api/comments/1` (O), `/api/comments/1/replies` (O) |

댓글 작성 URL에서 `*`를 사용한 이유는 `{postId}` 자리에 정확히 하나의 경로 요소만 올 수 있기 때문입니다.

> 규칙은 위에서 아래로 순서대로 적용됩니다. 먼저 매칭되는 규칙이 우선하므로, 더 구체적인 규칙을 위쪽에 배치해야 합니다.

# 8. 프론트엔드 - API 호출 함수와 CommentSection 컴포넌트

---

## 8-1. commentApi.js - 댓글 API 호출 함수

```javascript
// frontend/src/api/commentApi.js

// 댓글 목록 조회 (특정 게시글의 댓글을 페이지 단위로 가져옴)
export async function listComments(postId, page = 0) {
  const response = await fetch(`/api/posts/${postId}/comments?page=${page}`)
  if (!response.ok) throw new Error('댓글을 불러오지 못했습니다')
  return response.json()
}

// 댓글 작성
export async function createComment(postId, data) {
  const response = await fetch(`/api/posts/${postId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),  // { content, author, password }
  })
  if (!response.ok) throw new Error('댓글 작성에 실패했습니다')
  return response.json()
}

// 댓글 삭제 (비밀번호 확인 필요)
export async function deleteComment(id, password) {
  const response = await fetch(`/api/comments/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    // DELETE 요청이지만 비밀번호 확인을 위해 body를 포함
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    throw new Error('비밀번호가 일치하지 않습니다')
  }
}
```

댓글 API는 인증이 필요 없으므로 `Authorization` 헤더를 추가하지 않습니다. 게시글 API(`postApi.js`)에서 사용하던 `authHeaders()` 헬퍼가 필요 없습니다.

> **DELETE 요청에 body를 포함하는 것**은 HTTP 스펙상 금지되지는 않지만 일반적이지 않은 패턴입니다. 일부 HTTP 클라이언트나 프록시에서 문제가 될 수 있으므로, 실무에서는 `DELETE /api/comments/{id}?password=xxx` (쿼리 파라미터) 또는 커스텀 헤더를 사용하는 방식도 고려할 수 있습니다.

## 8-2. CommentSection 컴포넌트 (핵심 로직)

```jsx
// frontend/src/components/CommentSection.jsx

import { useState, useEffect } from 'react'
import { listComments, createComment, deleteComment } from '../api/commentApi'
import { useAuth } from '../contexts/AuthContext'
import Pagination from './Pagination'

function CommentSection({ postId }) {
  // 댓글 목록 상태
  const [comments, setComments] = useState([])
  const [currentPage, setCurrentPage] = useState(0)
  const [totalPages, setTotalPages] = useState(0)

  // 댓글 작성 폼 상태
  const [author, setAuthor] = useState('')
  const [password, setPassword] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 관리자 로그인 상태 (관리자는 비밀번호 없이 삭제 가능)
  const { user } = useAuth()

  // 댓글 목록을 서버에서 가져오는 함수
  const loadComments = (page = 0) => {
    listComments(postId, page)
      .then((data) => {
        setComments(data.content)       // 댓글 배열
        setTotalPages(data.totalPages)  // 전체 페이지 수
        setCurrentPage(data.number)     // 현재 페이지 번호
      })
      .catch(() => {})
  }

  // 컴포넌트 마운트 시 (또는 postId 변경 시) 댓글 목록 로드
  useEffect(() => {
    loadComments()
  }, [postId])

  // 댓글 작성 폼 제출
  const handleSubmit = async (e) => {
    e.preventDefault()  // form의 기본 동작(페이지 새로고침) 방지
    if (!content.trim() || !author.trim() || !password.trim()) {
      alert('닉네임, 비밀번호, 내용을 모두 입력해주세요.')
      return
    }

    setSubmitting(true)  // 중복 제출 방지
    try {
      await createComment(postId, { content, author, password })
      // 작성 성공 후 폼 초기화 & 첫 페이지로 새로고침
      setContent('')
      setAuthor('')
      setPassword('')
      loadComments(0)
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  // 댓글 삭제 처리
  const handleDelete = async (commentId) => {
    // 관리자는 비밀번호 없이 삭제 (빈 문자열 전송)
    // 일반 사용자는 비밀번호 입력 필요
    const inputPassword = user
      ? ''
      : prompt('삭제하려면 비밀번호를 입력하세요.')

    // prompt에서 취소를 누르면 null 반환 → 삭제 취소
    if (inputPassword === null) return

    try {
      await deleteComment(commentId, inputPassword)
      loadComments(currentPage)  // 현재 페이지 새로고침
    } catch (err) {
      alert(err.message)
    }
  }

  // ... (JSX 렌더링 부분)
}
```

**컴포넌트 구조 요약:**

| 상태 | 용도 |
|------|------|
| `comments`, `currentPage`, `totalPages` | 댓글 목록 + 페이징 정보 |
| `author`, `password`, `content` | 댓글 작성 폼 입력값 |
| `submitting` | 중복 제출 방지 (등록 버튼 비활성화) |
| `user` (from `useAuth()`) | 관리자 여부 판단 |

`submitting` 상태가 있는 이유는, 사용자가 "댓글 등록" 버튼을 빠르게 여러 번 클릭하면 같은 댓글이 중복 생성될 수 있기 때문입니다. `submitting`이 `true`인 동안 버튼을 `disabled` 처리하여 이 문제를 방지합니다.

## 8-3. PostDetailPage에서 CommentSection 연동

`CommentSection`은 `postId`를 props로 받아 댓글 목록 표시, 작성 폼, 삭제 기능을 모두 담당합니다. `PostDetailPage`에서는 단 한 줄로 연동됩니다:

```jsx
// frontend/src/pages/PostDetailPage.jsx

{/* 게시글 내용 하단에 댓글 영역 추가 */}
<CommentSection postId={id} />
```

컴포넌트 분리의 장점이 잘 드러나는 부분입니다. 댓글의 모든 로직이 `CommentSection` 안에 캡슐화되어 있으므로, `PostDetailPage`는 댓글의 내부 구현을 전혀 알 필요가 없습니다.

# 9. 전체 데이터 흐름

---

댓글 작성부터 화면 표시까지의 전체 흐름을 정리합니다.

## 댓글 작성 흐름

```text
1. [React] CommentSection에서 닉네임/비밀번호/내용 입력 후 제출
2. [React] commentApi.createComment() → POST /api/posts/{postId}/comments
3. [Spring] JwtAuthenticationFilter → SecurityConfig에서 permitAll 확인 → 통과
4. [Spring] CommentApiController.createComment() → @RequestBody로 JSON 파싱
5. [Spring] CommentService.saveComment() → Post 조회 → Comment 생성 → save()
6. [JPA]   @PrePersist → createdAt/updatedAt 자동 설정 → INSERT 실행
7. [Spring] CommentResponse(comment) → JSON 직렬화 → 201 Created 응답
8. [React] 폼 초기화 → loadComments(0) → 댓글 목록 새로고침
```

## 댓글 삭제 흐름

```text
1. [React] 삭제 버튼 클릭 → 관리자면 빈 비밀번호, 일반 사용자면 prompt
2. [React] commentApi.deleteComment() → DELETE /api/comments/{id}
3. [Spring] CommentService.deleteComment() → 비밀번호 검증 → 일치하면 삭제
4. [Spring] 204 No Content 응답
5. [React] loadComments(currentPage) → 현재 페이지 새로고침
```

# 10. 주의할 점

---

## 1. Service에서 잘못된 Repository 호출

`deleteComment` 메서드를 처음 작성할 때 `postRepository.deleteById(id)`를 호출하는 실수를 했습니다. 댓글을 삭제해야 하는데 게시글을 삭제하는 코드를 쓴 것입니다.

```java
// 잘못된 코드: 댓글을 삭제해야 하는데 게시글을 삭제
public void deleteComment(Long id, String password) {
    // ...
    postRepository.deleteById(id);      // 게시글 삭제 (X)
}

// 올바른 코드
public void deleteComment(Long id, String password) {
    // ...
    commentRepository.deleteById(id);   // 댓글 삭제 (O)
}
```

Service에 여러 Repository가 주입되어 있으면 비슷한 이름의 메서드를 잘못 호출할 수 있습니다. IDE의 자동완성을 사용할 때도 어떤 Repository의 메서드인지 항상 확인해야 합니다.

## 2. SecurityConfig URL 패턴 실수

댓글 작성 API를 허용하는 URL 패턴을 처음에 `/api/post/*/comments`로 작성했다가 403 에러가 발생했습니다.

```java
// 잘못된 코드: "post" (단수)
.requestMatchers(HttpMethod.POST, "/api/post/*/comments").permitAll()   // 403 에러

// 올바른 코드: "posts" (복수)
.requestMatchers(HttpMethod.POST, "/api/posts/*/comments").permitAll()  // 정상 동작
```

실제 엔드포인트 URL은 `/api/posts/{postId}/comments`인데 `posts`를 `post`로 잘못 썼기 때문입니다. Spring Security의 `permitAll()`이 적용 안 되면 `anyRequest().authenticated()`에 걸려서 **403 Forbidden**이 반환됩니다. 403 에러가 발생하면 URL 패턴이 실제 엔드포인트와 정확히 일치하는지 가장 먼저 확인해야 합니다.

## 3. 관리자 댓글 삭제 시 비밀번호 처리

현재 프론트엔드에서 관리자(`user`가 존재)는 비밀번호를 빈 문자열(`''`)로 전송합니다. 하지만 백엔드 `CommentService.deleteComment()`에서는 비밀번호를 단순 비교(`comment.getPassword().equals(password)`)하므로, 빈 문자열은 실제 비밀번호와 일치하지 않아 삭제가 실패합니다.

이 문제를 해결하려면 백엔드에서 관리자 여부를 확인하는 로직을 추가해야 합니다:

```java
// 개선 방향: SecurityContextHolder에서 인증 정보를 확인하여 관리자는 비밀번호 없이 삭제 허용
public void deleteComment(Long id, String password) {
    Comment comment = commentRepository.findById(id).orElseThrow();

    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    boolean isAdmin = auth != null && auth.isAuthenticated()
            && !"anonymousUser".equals(auth.getPrincipal());

    if (!isAdmin && !comment.getPassword().equals(password)) {
        throw new IllegalArgumentException("비밀번호가 일치하지 않습니다.");
    }

    commentRepository.deleteById(id);
}
```

## 4. 비밀번호 평문 저장 문제

현재 구현에서는 댓글 비밀번호를 평문으로 저장하고 있습니다. 댓글 비밀번호는 로그인 비밀번호만큼 민감하지 않을 수 있지만, BCrypt로 해싱하면 보안이 크게 향상됩니다.

```java
// 현재: 평문 비교
if (!comment.getPassword().equals(password)) { ... }

// 개선: BCrypt 해싱 적용 시
// 저장 시: comment.setPassword(passwordEncoder.encode(password))
// 비교 시: if (!passwordEncoder.matches(password, comment.getPassword())) { ... }
```

# 11. 정리

---

## 이번 Phase에서 구현한 구성 요소

| 구성 요소 | 역할 |
|-----------|------|
| `Comment` 엔티티 | Post와 `@ManyToOne` 관계, `@PrePersist`/`@PreUpdate`로 시간 자동 관리 |
| `CommentRepository` | 쿼리 메서드 `findByPostIdOrderByCreatedAtDesc`로 게시글별 댓글 페이징 |
| `CommentRequest` / `CommentDeleteRequest` / `CommentResponse` | 요청/삭제/응답 DTO 분리, 응답에서 password 제외 |
| `CommentService` | 비밀번호 검증 포함 CRUD 비즈니스 로직 |
| `CommentApiController` | REST API 엔드포인트 4개 (GET/POST/PUT/DELETE) |
| `SecurityConfig` | 댓글 API를 `permitAll()`로 비로그인 허용 |
| `commentApi.js` | 프론트엔드 API 호출 함수 |
| `CommentSection.jsx` | 댓글 목록/작성/삭제 UI 컴포넌트 |

## 핵심 개념 요약

| 개념 | 설명 |
|------|------|
| `@ManyToOne` + `@JoinColumn` | 다대일 관계 매핑. 외래키 컬럼을 지정하여 두 엔티티 연결 |
| `@PrePersist` / `@PreUpdate` | JPA 라이프사이클 콜백. 저장/수정 시 자동 실행되는 메서드 |
| 쿼리 메서드 | 메서드 이름 규칙으로 SQL 자동 생성 (findBy, OrderBy 등) |
| DTO 분리 | Request/Response DTO를 역할별로 분리. 보안 필드(password) 노출 방지 |
| `Page<T>` + `Pageable` | 페이징 결과와 메타 정보를 함께 반환 |

# 다음 단계 (Next Steps)

---

- **비밀번호 암호화**: BCrypt로 댓글 비밀번호를 해싱하면 보안이 크게 향상됩니다.
- **관리자 삭제 로직**: 백엔드에서 관리자 여부를 확인하여 비밀번호 없이 삭제할 수 있도록 개선합니다.
- **댓글 수정 UI**: 백엔드에 수정 API(`PUT /api/comments/{id}`)는 있지만 프론트엔드 UI가 아직 없습니다.
- **댓글 수 표시**: 게시글 목록에서 각 글의 댓글 수를 보여주면 사용자 경험이 좋아집니다.
- **입력값 검증**: `@NotBlank`, `@Size` 같은 Bean Validation 어노테이션과 `@Valid`로 서버 측 유효성 검사를 추가할 수 있습니다.

# Reference

---

**프로젝트 파일:**
- Entity: `backend/src/main/java/com/example/blog/entity/Comment.java`
- Repository: `backend/src/main/java/com/example/blog/repository/CommentRepository.java`
- DTO: `backend/src/main/java/com/example/blog/dto/CommentRequest.java`, `CommentDeleteRequest.java`, `CommentResponse.java`
- Service: `backend/src/main/java/com/example/blog/service/CommentService.java`
- Controller: `backend/src/main/java/com/example/blog/controller/CommentApiController.java`
- Security: `backend/src/main/java/com/example/blog/config/SecurityConfig.java`
- Frontend API: `frontend/src/api/commentApi.js`
- Frontend Component: `frontend/src/components/CommentSection.jsx`
- Frontend Page: `frontend/src/pages/PostDetailPage.jsx`

**관련 문서:**
- [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Spring Data JPA - Paging and Sorting](https://docs.spring.io/spring-data/jpa/reference/repositories/query-methods-details.html#repositories.special-parameters)
- [Spring Security - Authorize HTTP Requests](https://docs.spring.io/spring-security/reference/servlet/authorization/authorize-http-requests.html)
- [Jakarta Persistence - Entity Lifecycle Callbacks](https://jakarta.ee/specifications/persistence/)
