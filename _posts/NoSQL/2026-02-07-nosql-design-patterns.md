---
title: "[NoSQL] 데이터 모델링 패턴 - Embedding, Referencing, 비정규화"
categories:
  - NoSQL
tags:
  - [NoSQL, MongoDB, DataModeling, Embedding, Denormalization]
---

# Introduction

---

RDBMS에서는 **정규화**를 통해 중복을 제거하고 데이터 무결성을 보장합니다. 하지만 NoSQL(특히 Document DB)에서는 **비정규화(Denormalization)**와 **임베딩(Embedding)**이 일반적입니다. JOIN이 없거나 비효율적이기 때문에, 자주 함께 조회되는 데이터를 하나의 Document에 저장합니다.

이 글은 NoSQL 데이터 모델링의 핵심 패턴을 정리합니다.

# 1. 정규화 vs 비정규화

---

## RDBMS 정규화

```text
장점:
- 데이터 중복 없음
- 업데이트가 한 곳에서만 발생
- 저장 공간 효율적

단점:
- 조회 시 JOIN 필요
- 분산 환경에서 JOIN 성능 저하
- 쿼리가 복잡해짐
```

## NoSQL 비정규화

```text
장점:
- 하나의 쿼리로 모든 데이터 조회
- JOIN 없어 빠름
- 수평 확장 용이

단점:
- 데이터 중복
- 업데이트 시 여러 곳 수정 필요
- 일관성 유지 어려움
```

## 예시 비교

```text
RDBMS (정규화):
┌─────────────────────────────────────────────────────┐
│ orders                                               │
├────┬─────────┬─────────┬───────────────────────────┤
│ id │ user_id │ total   │ created_at                │
├────┼─────────┼─────────┼───────────────────────────┤
│ 1  │ 100     │ 50000   │ 2024-01-15                │
└────┴─────────┴─────────┴───────────────────────────┘

│ users                                                │
├────┬──────────┬─────────────────────────────────────┤
│ id │ name     │ email                               │
├────┼──────────┼─────────────────────────────────────┤
│100 │ 홍길동   │ hong@example.com                    │
└────┴──────────┴─────────────────────────────────────┘

→ 주문 조회 시 JOIN 필요

NoSQL (비정규화):
{
  "_id": 1,
  "total": 50000,
  "created_at": "2024-01-15",
  "user": {
    "id": 100,
    "name": "홍길동",
    "email": "hong@example.com"
  }
}

→ 하나의 Document에서 모두 조회
```

# 2. Embedding (임베딩)

---

## 개념

관련 데이터를 하나의 Document 안에 중첩하여 저장합니다.

```javascript
// Embedded Document
{
  "_id": "order123",
  "status": "PAID",
  "items": [
    { "productId": 1, "name": "노트북", "price": 1500000, "qty": 1 },
    { "productId": 2, "name": "마우스", "price": 50000, "qty": 2 }
  ],
  "shipping": {
    "address": "서울시 강남구",
    "phone": "010-1234-5678"
  },
  "user": {
    "id": "user100",
    "name": "홍길동"
  }
}
```

## 언제 사용하나?

```text
✅ 1:1 관계
   - 사용자 ↔ 프로필
   - 주문 ↔ 배송 정보

✅ 1:N 관계 (N이 작을 때)
   - 블로그 포스트 ↔ 댓글 (수십 개)
   - 주문 ↔ 주문 항목

✅ 항상 함께 조회되는 데이터
   - 조회 패턴이 "주문과 항목을 함께"라면 임베딩

✅ 자식 데이터가 부모 없이 의미 없음
   - 주문 항목은 주문 없이 존재하지 않음
```

## 장단점

```text
장점:
- 단일 쿼리로 모든 데이터 조회
- 원자적 업데이트 (하나의 Document)
- 데이터 지역성 (디스크 I/O 최적화)

단점:
- Document 크기 제한 (MongoDB: 16MB)
- 중첩 데이터 개별 조회 어려움
- 중첩이 깊어지면 복잡
```

## 코드 예시

```java
@Document(collection = "orders")
public class Order {
    @Id
    private String id;
    private String status;
    private List<OrderItem> items;      // Embedded
    private ShippingInfo shipping;       // Embedded
    private UserInfo user;               // Embedded (일부 필드만)
}

public class OrderItem {
    private Long productId;
    private String name;
    private int price;
    private int qty;
}

public class ShippingInfo {
    private String address;
    private String phone;
}

public class UserInfo {
    private String id;
    private String name;
    // email 등은 User Document에서 참조
}
```

# 3. Referencing (참조)

---

## 개념

다른 Document를 ID로 참조합니다. RDBMS의 Foreign Key와 유사합니다.

```javascript
// Order Document
{
  "_id": "order123",
  "userId": "user100",  // 참조
  "productIds": ["prod1", "prod2"],  // 참조 배열
  "status": "PAID"
}

// User Document (별도)
{
  "_id": "user100",
  "name": "홍길동",
  "email": "hong@example.com"
}
```

## 언제 사용하나?

```text
✅ 1:N 관계 (N이 클 때)
   - 사용자 ↔ 주문 (수천 개)
   - 카테고리 ↔ 상품 (수만 개)

✅ N:M 관계
   - 태그 ↔ 게시물
   - 사용자 ↔ 그룹

✅ 자주 개별 조회되는 데이터
   - 사용자 정보만 조회하는 경우가 많음

✅ 데이터 크기가 클 때
   - 16MB 제한 우회

✅ 자주 변경되는 데이터
   - 참조하면 한 곳만 수정
```

## 장단점

```text
장점:
- Document 크기 제한 걱정 없음
- 데이터 중복 없음
- 개별 업데이트 용이

단점:
- 여러 쿼리 필요 ($lookup 또는 애플리케이션 조인)
- 조회 성능 저하
- 참조 무결성 보장 안 됨
```

## 코드 예시

```java
@Document(collection = "orders")
public class Order {
    @Id
    private String id;

    @DBRef  // MongoDB 참조
    private User user;

    // 또는 ID만 저장
    private String userId;
    private List<String> productIds;
}

// 서비스에서 조인
public OrderDto findOrderWithDetails(String orderId) {
    Order order = orderRepository.findById(orderId).orElseThrow();
    User user = userRepository.findById(order.getUserId()).orElseThrow();
    List<Product> products = productRepository.findAllById(order.getProductIds());

    return new OrderDto(order, user, products);
}
```

## $lookup (MongoDB JOIN)

```javascript
db.orders.aggregate([
  {
    $lookup: {
      from: "users",
      localField: "userId",
      foreignField: "_id",
      as: "user"
    }
  },
  { $unwind: "$user" }
])
```

```java
// Spring Data MongoDB Aggregation
Aggregation aggregation = Aggregation.newAggregation(
    Aggregation.lookup("users", "userId", "_id", "user"),
    Aggregation.unwind("user")
);

List<OrderWithUser> results = mongoTemplate.aggregate(
    aggregation, "orders", OrderWithUser.class
).getMappedResults();
```

# 4. 하이브리드 패턴

---

## Extended Reference (확장 참조)

자주 사용하는 필드는 임베딩, 나머지는 참조합니다.

```javascript
{
  "_id": "order123",
  "user": {
    "id": "user100",
    "name": "홍길동"  // 자주 표시되는 필드만 임베딩
    // email, phone 등은 User Document 참조
  },
  "items": [...]
}
```

```text
조회 시:
  - 주문 목록 표시: user.name 바로 사용 (추가 쿼리 없음)
  - 사용자 상세: userId로 User Document 조회
```

## Subset Pattern (부분집합)

최신 N개만 임베딩, 전체는 별도 Collection에 저장합니다.

```javascript
// Product Document
{
  "_id": "prod1",
  "name": "노트북",
  "recentReviews": [  // 최신 5개만
    { "userId": "u1", "rating": 5, "comment": "좋아요" },
    { "userId": "u2", "rating": 4, "comment": "괜찮음" }
  ],
  "reviewCount": 1234
}

// Reviews Collection (전체)
{
  "_id": "review123",
  "productId": "prod1",
  "userId": "u1",
  "rating": 5,
  "comment": "좋아요",
  "createdAt": "2024-01-15"
}
```

## Bucket Pattern (버킷)

시계열 데이터를 시간 단위로 그룹화합니다.

```javascript
// 기존: 센서 데이터 1개당 1 Document
{ "sensorId": "s1", "value": 23.5, "timestamp": "2024-01-15T10:00:00" }
{ "sensorId": "s1", "value": 23.6, "timestamp": "2024-01-15T10:00:01" }
...

// Bucket Pattern: 1시간 단위로 묶기
{
  "_id": "s1_2024-01-15T10",
  "sensorId": "s1",
  "date": "2024-01-15",
  "hour": 10,
  "measurements": [
    { "minute": 0, "second": 0, "value": 23.5 },
    { "minute": 0, "second": 1, "value": 23.6 },
    ...
  ],
  "count": 3600,
  "avg": 23.55
}
```

```text
장점:
- Document 수 대폭 감소 (1/3600)
- 인덱스 크기 감소
- 집계 미리 계산 (avg, min, max)
```

# 5. 패턴 선택 가이드

---

## 결정 기준

```text
1. 함께 조회되는가?
   → Yes: Embedding
   → No: Referencing

2. 관계 카디널리티는?
   → 1:Few (1~수십): Embedding
   → 1:Many (수백~): Extended Reference
   → 1:Squillions (수천~): Referencing

3. 데이터 변경 빈도는?
   → 자주 변경: Referencing (한 곳만 수정)
   → 거의 안 변함: Embedding

4. Document 크기는?
   → 16MB 초과 가능: Referencing

5. 읽기/쓰기 비율은?
   → 읽기 많음: Embedding (조회 최적화)
   → 쓰기 많음: Referencing (업데이트 최소화)
```

## 요약표

| 패턴 | 적합한 경우 |
|------|-----------|
| **Embedding** | 1:1, 1:Few, 항상 함께 조회 |
| **Referencing** | 1:Many, N:M, 개별 조회 빈번 |
| **Extended Reference** | 일부 필드는 자주, 나머지는 가끔 |
| **Subset Pattern** | 최신 N개만 자주 조회 |
| **Bucket Pattern** | 시계열, 로그 데이터 |

# 6. 실무 예시

---

## 이커머스: 주문

```javascript
// 주문 Document
{
  "_id": "order123",
  "orderNumber": "ORD-2024-0001",
  "status": "SHIPPED",
  "createdAt": ISODate("2024-01-15T10:00:00Z"),

  // Embedding: 주문 시점의 스냅샷
  "items": [
    {
      "productId": "prod1",
      "name": "노트북",           // 주문 당시 이름 (상품 이름 변경돼도 유지)
      "price": 1500000,           // 주문 당시 가격
      "qty": 1
    }
  ],

  // Extended Reference: 자주 표시되는 필드만
  "customer": {
    "id": "user100",
    "name": "홍길동",
    "phone": "010-1234-5678"
  },

  // Embedding: 1:1, 주문과 항상 함께
  "shipping": {
    "address": "서울시 강남구 강남대로 123",
    "trackingNumber": "CJ123456789",
    "deliveredAt": null
  },

  "totalAmount": 1500000
}
```

## 블로그: 포스트

```javascript
{
  "_id": "post123",
  "title": "MongoDB 데이터 모델링",
  "content": "...",
  "author": {
    "id": "user1",
    "name": "홍길동",
    "profileImage": "/images/hong.jpg"
  },

  // Subset: 최신 댓글 5개만
  "recentComments": [
    { "userId": "u2", "name": "김철수", "text": "좋은 글이네요", "createdAt": "..." },
    { "userId": "u3", "name": "이영희", "text": "잘 읽었습니다", "createdAt": "..." }
  ],
  "commentCount": 42,

  // Reference: 태그는 별도 관리
  "tagIds": ["tag1", "tag2"],

  "views": 1234,
  "createdAt": ISODate("2024-01-15T10:00:00Z")
}
```

## IoT: 센서 데이터

```javascript
// Bucket Pattern: 1분 단위
{
  "_id": "sensor1_2024-01-15T10:30",
  "sensorId": "sensor1",
  "date": ISODate("2024-01-15"),
  "hour": 10,
  "minute": 30,
  "readings": [
    { "second": 0, "temp": 23.5, "humidity": 45 },
    { "second": 1, "temp": 23.6, "humidity": 45 },
    ...
  ],
  "stats": {
    "tempAvg": 23.55,
    "tempMin": 23.2,
    "tempMax": 23.8,
    "count": 60
  }
}
```

# 7. 주의사항

---

## 데이터 일관성

```java
// 비정규화된 데이터 업데이트
public void updateUserName(String userId, String newName) {
    // 1. User 본체 업데이트
    userRepository.updateName(userId, newName);

    // 2. 주문에 임베딩된 사용자 이름도 업데이트
    Query query = new Query(Criteria.where("customer.id").is(userId));
    Update update = new Update().set("customer.name", newName);
    mongoTemplate.updateMulti(query, update, Order.class);

    // 3. 게시물에 임베딩된 작성자 이름도 업데이트
    mongoTemplate.updateMulti(
        new Query(Criteria.where("author.id").is(userId)),
        new Update().set("author.name", newName),
        Post.class
    );
}
```

## Document 크기

```text
MongoDB Document 크기 제한: 16MB

초과 가능한 경우:
- 배열이 무한히 커지는 경우 (댓글, 로그)
- 대용량 바이너리 임베딩

해결:
- Bucket Pattern 사용
- GridFS 사용 (대용량 파일)
- Reference로 분리
```

## 인덱스 설계

```javascript
// 쿼리 패턴에 맞는 인덱스
db.orders.createIndex({ "customer.id": 1 })
db.orders.createIndex({ "status": 1, "createdAt": -1 })
db.orders.createIndex({ "items.productId": 1 })
```

# 8. 정리

---

| 패턴 | 설명 | 사용 시기 |
|------|------|----------|
| **Embedding** | Document 안에 중첩 | 1:1, 1:Few, 함께 조회 |
| **Referencing** | ID로 다른 Document 참조 | 1:Many, 개별 조회 |
| **Extended Reference** | 일부 필드만 임베딩 + 참조 | 자주 쓰는 필드 분리 |
| **Subset** | 최신 N개만 임베딩 | 최근 데이터 빠른 조회 |
| **Bucket** | 시간 단위로 그룹화 | 시계열 데이터 |

```text
핵심:
  NoSQL은 "조회 패턴"에 맞춰 모델링.
  함께 조회되면 Embedding, 개별 조회면 Reference.
  비정규화는 조회 성능 ↑, 일관성 관리 비용 ↑.
  데이터 변경 시 모든 복사본 업데이트 필요.
```

# Reference

---

- [MongoDB Data Modeling](https://www.mongodb.com/docs/manual/core/data-modeling-introduction/)
- [Building with Patterns (MongoDB Blog)](https://www.mongodb.com/blog/post/building-with-patterns-a-summary)
- [6 Rules of Thumb for MongoDB Schema Design](https://www.mongodb.com/blog/post/6-rules-of-thumb-for-mongodb-schema-design)
