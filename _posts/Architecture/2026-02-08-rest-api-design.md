---
title: "[Architecture] REST API 설계 원칙 - URL, HTTP 메서드, 상태 코드, 버전 관리"
categories:
  - Architecture
tags:
  - [REST, API, HTTP, Architecture, WebService]
---

# Introduction

---

REST API는 웹 서비스의 표준 인터페이스입니다. 잘 설계된 API는 직관적이고, 일관되며, 확장하기 쉽습니다. 반면 잘못 설계된 API는 클라이언트 개발자를 혼란스럽게 하고 유지보수를 어렵게 만듭니다.

이 글은 실무에서 적용할 수 있는 REST API 설계 원칙을 정리합니다.

# 1. REST 기본 원칙

---

## REST란?

**RE**presentational **S**tate **T**ransfer의 약자로, 리소스를 URI로 표현하고 HTTP 메서드로 조작하는 아키텍처 스타일입니다.

```text
핵심 개념:
- 리소스(Resource): 서버의 데이터/기능 (사용자, 주문, 상품)
- 표현(Representation): 리소스의 현재 상태 (JSON, XML)
- 상태 전이(State Transfer): HTTP 메서드로 리소스 상태 변경
```

## REST 제약 조건

| 제약 | 설명 |
|------|------|
| **Client-Server** | 클라이언트와 서버 분리 |
| **Stateless** | 서버가 클라이언트 상태 저장 안 함 |
| **Cacheable** | 응답은 캐시 가능 여부 명시 |
| **Uniform Interface** | 일관된 인터페이스 |
| **Layered System** | 계층화된 시스템 구조 |

# 2. URL 설계

---

## 리소스 중심

URL은 **리소스(명사)**를 표현합니다. 동사는 HTTP 메서드가 담당합니다.

```text
좋은 예:
GET    /users           - 사용자 목록
GET    /users/123       - 사용자 123 조회
POST   /users           - 사용자 생성
PUT    /users/123       - 사용자 123 수정
DELETE /users/123       - 사용자 123 삭제

나쁜 예:
GET    /getUsers
GET    /getUserById?id=123
POST   /createUser
POST   /deleteUser
```

## 복수형 사용

```text
권장: /users, /orders, /products
비권장: /user, /order, /product

일관성이 중요. 하나를 선택하면 전체에 적용.
```

## 계층 관계

```text
/users/123/orders           - 사용자 123의 주문 목록
/users/123/orders/456       - 사용자 123의 주문 456
/orders/456/items           - 주문 456의 항목들
/orders/456/items/789       - 주문 456의 항목 789

주의: 깊이 3단계 이하 권장
```

## 필터링, 정렬, 페이징

Query String을 사용합니다.

```text
필터링:
GET /orders?status=PAID
GET /orders?status=PAID&userId=123
GET /products?category=electronics&minPrice=10000

정렬:
GET /products?sort=price         (오름차순)
GET /products?sort=-price        (내림차순)
GET /products?sort=category,-price

페이징:
GET /products?page=1&size=20
GET /products?offset=0&limit=20
GET /products?cursor=abc123&limit=20  (커서 기반)
```

## 검색

```text
간단한 검색:
GET /products?q=노트북

복잡한 검색 (전용 엔드포인트):
POST /products/search
{
  "query": "노트북",
  "filters": {
    "category": "electronics",
    "priceRange": {"min": 500000, "max": 2000000}
  }
}
```

## URL 작성 규칙

```text
- 소문자 사용: /users (O), /Users (X)
- 하이픈(-) 사용: /user-profiles (O), /user_profiles (X)
- 마지막 슬래시 없음: /users (O), /users/ (X)
- 확장자 없음: /users (O), /users.json (X)
- 행위 동사 지양: /users (O), /getUsers (X)
```

# 3. HTTP 메서드

---

## CRUD 매핑

| 메서드 | 용도 | 멱등성 | 안전 |
|--------|------|--------|------|
| **GET** | 조회 | O | O |
| **POST** | 생성 | X | X |
| **PUT** | 전체 수정 | O | X |
| **PATCH** | 부분 수정 | X | X |
| **DELETE** | 삭제 | O | X |

```text
멱등성(Idempotent): 같은 요청을 여러 번 해도 결과 동일
안전(Safe): 서버 상태 변경 없음
```

## GET

리소스를 조회합니다. 캐시 가능하고, 요청 본문이 없습니다.

```text
GET /users/123

응답:
200 OK
{
  "id": 123,
  "name": "홍길동",
  "email": "hong@example.com"
}
```

## POST

새 리소스를 생성합니다.

```text
POST /users
Content-Type: application/json

{
  "name": "홍길동",
  "email": "hong@example.com"
}

응답:
201 Created
Location: /users/123
{
  "id": 123,
  "name": "홍길동",
  "email": "hong@example.com"
}
```

## PUT

리소스를 **전체** 교체합니다. 없으면 생성할 수도 있습니다.

```text
PUT /users/123
Content-Type: application/json

{
  "name": "김길동",
  "email": "kim@example.com",
  "phone": "010-1234-5678"
}

응답:
200 OK
{
  "id": 123,
  "name": "김길동",
  "email": "kim@example.com",
  "phone": "010-1234-5678"
}

주의: 요청에 없는 필드는 null/삭제됨
```

## PATCH

리소스를 **부분** 수정합니다.

```text
PATCH /users/123
Content-Type: application/json

{
  "phone": "010-9999-8888"
}

응답:
200 OK
{
  "id": 123,
  "name": "김길동",
  "email": "kim@example.com",
  "phone": "010-9999-8888"  // 이것만 변경
}
```

## DELETE

리소스를 삭제합니다.

```text
DELETE /users/123

응답:
204 No Content

또는:
200 OK
{
  "message": "삭제되었습니다"
}
```

# 4. HTTP 상태 코드

---

## 2xx 성공

| 코드 | 의미 | 사용 |
|------|------|------|
| **200** | OK | 조회/수정 성공 |
| **201** | Created | 생성 성공 |
| **204** | No Content | 삭제 성공, 응답 본문 없음 |

## 3xx 리다이렉션

| 코드 | 의미 | 사용 |
|------|------|------|
| **301** | Moved Permanently | URL 영구 변경 |
| **302** | Found | 일시적 리다이렉트 |
| **304** | Not Modified | 캐시 사용 |

## 4xx 클라이언트 오류

| 코드 | 의미 | 사용 |
|------|------|------|
| **400** | Bad Request | 잘못된 요청 (검증 실패) |
| **401** | Unauthorized | 인증 필요 |
| **403** | Forbidden | 권한 없음 |
| **404** | Not Found | 리소스 없음 |
| **405** | Method Not Allowed | 허용되지 않은 메서드 |
| **409** | Conflict | 충돌 (중복 등) |
| **422** | Unprocessable Entity | 검증 실패 (400 대신 사용 가능) |
| **429** | Too Many Requests | Rate Limit 초과 |

## 5xx 서버 오류

| 코드 | 의미 | 사용 |
|------|------|------|
| **500** | Internal Server Error | 서버 오류 |
| **502** | Bad Gateway | 게이트웨이 오류 |
| **503** | Service Unavailable | 서비스 일시 중단 |
| **504** | Gateway Timeout | 게이트웨이 타임아웃 |

## 상태 코드 선택 가이드

```text
조회 성공: 200
생성 성공: 201 + Location 헤더
삭제 성공: 204 (본문 없음) 또는 200 (본문 있음)

요청 잘못: 400 (형식 오류, 검증 실패)
인증 필요: 401 (로그인 필요)
권한 없음: 403 (로그인했지만 권한 없음)
없는 리소스: 404
서버 오류: 500 (예상치 못한 오류)
```

# 5. 응답 형식

---

## 성공 응답

```json
// 단일 리소스
{
  "id": 123,
  "name": "홍길동",
  "email": "hong@example.com",
  "createdAt": "2024-01-15T10:00:00Z"
}

// 목록
{
  "data": [
    {"id": 1, "name": "홍길동"},
    {"id": 2, "name": "김철수"}
  ],
  "pagination": {
    "page": 1,
    "size": 20,
    "totalElements": 100,
    "totalPages": 5
  }
}
```

## 오류 응답

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "입력값이 올바르지 않습니다.",
    "details": [
      {
        "field": "email",
        "message": "올바른 이메일 형식이 아닙니다."
      },
      {
        "field": "age",
        "message": "0보다 커야 합니다."
      }
    ]
  },
  "timestamp": "2024-01-15T10:00:00Z",
  "path": "/users"
}
```

## 날짜/시간 형식

```text
ISO 8601 형식 사용:
  2024-01-15T10:30:00Z        (UTC)
  2024-01-15T19:30:00+09:00   (타임존 포함)

Unix Timestamp도 가능:
  1705312200 (초)
  1705312200000 (밀리초)

권장: ISO 8601 (UTC) - 읽기 쉽고 표준화됨
```

# 6. 버전 관리

---

## URL Path

가장 명확한 방식입니다.

```text
GET /v1/users
GET /v2/users

장점: 명확, 캐시 분리
단점: URL 변경
```

## Query Parameter

```text
GET /users?version=1
GET /users?api-version=2024-01-15

장점: URL 구조 유지
단점: 파라미터 누락 가능
```

## Header

```text
GET /users
Accept: application/vnd.myapp.v1+json

또는:
X-API-Version: 1

장점: URL 깔끔
단점: 테스트 불편, 가시성 낮음
```

## 권장 전략

```text
1. URL Path (/v1/) 사용 - 가장 명확
2. 메이저 버전만 URL에 표시 (v1, v2)
3. 마이너 변경은 하위 호환 유지
4. 이전 버전 일정 기간 지원 후 폐기 공지
```

# 7. 인증

---

## Bearer Token

```text
GET /users
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## API Key

```text
GET /users
X-API-Key: my-api-key-12345

또는 Query Parameter:
GET /users?api_key=my-api-key-12345
```

# 8. 실무 패턴

---

## 대량 작업 (Bulk Operations)

```text
POST /users/bulk
{
  "users": [
    {"name": "홍길동", "email": "hong@example.com"},
    {"name": "김철수", "email": "kim@example.com"}
  ]
}

응답:
{
  "success": 2,
  "failed": 0,
  "results": [
    {"index": 0, "id": 123, "status": "created"},
    {"index": 1, "id": 124, "status": "created"}
  ]
}
```

## 비동기 작업

```text
POST /reports/generate
{
  "type": "monthly-sales",
  "month": "2024-01"
}

응답:
202 Accepted
{
  "jobId": "job-123",
  "status": "PENDING",
  "statusUrl": "/jobs/job-123"
}

상태 확인:
GET /jobs/job-123
{
  "jobId": "job-123",
  "status": "COMPLETED",
  "resultUrl": "/reports/report-456"
}
```

## 복잡한 작업 (RPC 스타일)

REST 원칙을 벗어나지만 실용적입니다.

```text
// 비밀번호 변경
POST /users/123/change-password
{
  "currentPassword": "...",
  "newPassword": "..."
}

// 이메일 발송
POST /users/123/send-verification-email

// 주문 취소
POST /orders/456/cancel
```

# 9. Spring 구현 예시

---

```java
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @GetMapping
    public ResponseEntity<Page<UserDto>> getUsers(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status) {
        return ResponseEntity.ok(userService.findAll(page, size, status));
    }

    @GetMapping("/{id}")
    public ResponseEntity<UserDto> getUser(@PathVariable Long id) {
        return userService.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<UserDto> createUser(@Valid @RequestBody CreateUserRequest request) {
        UserDto created = userService.create(request);
        URI location = URI.create("/api/v1/users/" + created.getId());
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public ResponseEntity<UserDto> updateUser(
            @PathVariable Long id,
            @Valid @RequestBody UpdateUserRequest request) {
        return ResponseEntity.ok(userService.update(id, request));
    }

    @PatchMapping("/{id}")
    public ResponseEntity<UserDto> patchUser(
            @PathVariable Long id,
            @RequestBody Map<String, Object> updates) {
        return ResponseEntity.ok(userService.patch(id, updates));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteUser(@PathVariable Long id) {
        userService.delete(id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/{id}/orders")
    public ResponseEntity<List<OrderDto>> getUserOrders(@PathVariable Long id) {
        return ResponseEntity.ok(userService.findOrders(id));
    }
}
```

# 10. 정리

---

| 항목 | 권장 |
|------|------|
| **URL** | 명사, 복수형, 소문자 |
| **메서드** | GET(조회), POST(생성), PUT(전체수정), PATCH(부분수정), DELETE(삭제) |
| **상태코드** | 200(성공), 201(생성), 204(삭제), 400(잘못된요청), 401(인증필요), 404(없음) |
| **버전** | URL Path (/v1/) |
| **날짜** | ISO 8601 (UTC) |

```text
핵심:
  REST = 리소스 중심, HTTP 메서드로 행위 표현.
  URL은 명사(리소스), 동사는 HTTP 메서드.
  상태 코드로 결과 명확히 전달.
  일관성이 가장 중요 - 하나의 규칙을 전체에 적용.
```

# Reference

---

- [REST API Design Best Practices](https://www.freecodecamp.org/news/rest-api-design-best-practices-build-a-rest-api/)
- [Microsoft REST API Guidelines](https://github.com/microsoft/api-guidelines)
- [Google API Design Guide](https://cloud.google.com/apis/design)
- [HTTP Status Codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status)
