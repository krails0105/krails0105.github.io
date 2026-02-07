---
title: "[NoSQL] MongoDB 기초 - Document DB와 Spring Data MongoDB"
categories:
  - NoSQL
tags:
  - [NoSQL, MongoDB, DocumentDB, SpringDataMongoDB]
---

# Introduction

---

관계형 데이터베이스(RDBMS)는 정규화된 테이블과 JOIN으로 데이터를 관리합니다. 하지만 스키마 변경이 어렵고, 대규모 분산 환경에서 성능 한계가 있습니다. **MongoDB**는 **Document DB**로, JSON과 유사한 **BSON** 형식으로 데이터를 저장합니다. 스키마가 유연하고, 수평 확장이 용이합니다.

이 글은 MongoDB의 핵심 개념과 Spring Data MongoDB 사용법을 정리합니다.

# 1. MongoDB 개념

---

## Document DB란?

```text
RDBMS:
┌─────────────────────────────────────────────────────────┐
│ users 테이블                                             │
├────┬──────────┬─────────────────────┬──────────────────┤
│ id │ name     │ email               │ address_id (FK) │
├────┼──────────┼─────────────────────┼──────────────────┤
│ 1  │ 홍길동    │ hong@example.com   │ 101             │
└────┴──────────┴─────────────────────┴──────────────────┘

│ addresses 테이블                                         │
├────┬────────────────┬────────────────────────────────────┤
│ id │ city           │ street                              │
├────┼────────────────┼────────────────────────────────────┤
│ 101│ 서울           │ 강남대로 123                        │
└────┴────────────────┴────────────────────────────────────┘

→ JOIN이 필요

MongoDB:
{
  "_id": ObjectId("..."),
  "name": "홍길동",
  "email": "hong@example.com",
  "address": {
    "city": "서울",
    "street": "강남대로 123"
  }
}

→ 하나의 Document에 모든 정보 (Embedded)
```

## 용어 비교

| RDBMS | MongoDB |
|-------|---------|
| Database | Database |
| Table | Collection |
| Row | Document |
| Column | Field |
| Primary Key | _id |
| JOIN | Embedding / Reference |

## 특징

```text
장점:
- 스키마 유연성: 필드 추가/삭제 자유
- 수평 확장: 샤딩으로 대용량 처리
- 성능: 관련 데이터를 하나의 Document에 (JOIN 없음)
- 개발 생산성: JSON 구조로 직관적

단점:
- JOIN 지원 약함 ($lookup으로 가능하지만 성능 저하)
- 트랜잭션 제한 (4.0부터 멀티 도큐먼트 트랜잭션 지원, 하지만 RDBMS보다 느림)
- 데이터 중복 가능성 (정규화 안 함)
```

# 2. 기본 CRUD

---

## MongoDB Shell (mongosh)

```javascript
// 데이터베이스 선택
use mydb

// 컬렉션에 Document 삽입
db.users.insertOne({
  name: "홍길동",
  email: "hong@example.com",
  age: 30,
  tags: ["developer", "backend"],
  address: {
    city: "서울",
    street: "강남대로 123"
  }
})

// 여러 개 삽입
db.users.insertMany([
  { name: "김철수", email: "kim@example.com", age: 25 },
  { name: "이영희", email: "lee@example.com", age: 28 }
])
```

## 조회 (Find)

```javascript
// 전체 조회
db.users.find()

// 조건 조회
db.users.find({ age: 30 })
db.users.find({ age: { $gte: 25 } })  // age >= 25
db.users.find({ name: /홍/ })          // 정규식

// 복합 조건
db.users.find({
  $and: [
    { age: { $gte: 25 } },
    { "address.city": "서울" }
  ]
})

// 프로젝션 (필드 선택)
db.users.find({}, { name: 1, email: 1, _id: 0 })

// 정렬, 페이징
db.users.find().sort({ age: -1 }).skip(0).limit(10)
```

## 수정 (Update)

```javascript
// 하나 수정
db.users.updateOne(
  { email: "hong@example.com" },
  { $set: { age: 31 } }
)

// 여러 개 수정
db.users.updateMany(
  { age: { $lt: 30 } },
  { $inc: { age: 1 } }  // age += 1
)

// 필드 삭제
db.users.updateOne(
  { email: "hong@example.com" },
  { $unset: { tags: "" } }
)

// 배열에 추가
db.users.updateOne(
  { email: "hong@example.com" },
  { $push: { tags: "fullstack" } }
)
```

## 삭제 (Delete)

```javascript
db.users.deleteOne({ email: "hong@example.com" })
db.users.deleteMany({ age: { $lt: 20 } })
```

## 쿼리 연산자

| 연산자 | 설명 | 예시 |
|--------|------|------|
| `$eq` | 같음 | `{ age: { $eq: 30 } }` |
| `$ne` | 같지 않음 | `{ age: { $ne: 30 } }` |
| `$gt` / `$gte` | 초과 / 이상 | `{ age: { $gte: 25 } }` |
| `$lt` / `$lte` | 미만 / 이하 | `{ age: { $lt: 30 } }` |
| `$in` | 배열 내 포함 | `{ status: { $in: ["A", "B"] } }` |
| `$or` | OR 조건 | `{ $or: [{a: 1}, {b: 2}] }` |
| `$and` | AND 조건 | `{ $and: [{a: 1}, {b: 2}] }` |
| `$regex` | 정규식 | `{ name: { $regex: /홍/ } }` |

# 3. Spring Data MongoDB 설정

---

## 의존성

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-mongodb</artifactId>
</dependency>
```

## application.yml

```yaml
spring:
  data:
    mongodb:
      uri: mongodb://localhost:27017/mydb
      # 또는 개별 설정
      # host: localhost
      # port: 27017
      # database: mydb
      # username: user
      # password: pass
```

## Document 클래스

```java
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

@Document(collection = "users")  // 컬렉션 이름
@Getter @Setter
public class User {

    @Id
    private String id;  // MongoDB ObjectId

    private String name;

    @Field("email_address")  // 필드 이름 매핑
    private String email;

    private int age;

    private List<String> tags;

    private Address address;  // Embedded Document
}

@Getter @Setter
public class Address {
    private String city;
    private String street;
}
```

# 4. Repository 패턴

---

## MongoRepository

```java
public interface UserRepository extends MongoRepository<User, String> {

    // 메서드 이름으로 쿼리 생성
    List<User> findByName(String name);

    List<User> findByAgeGreaterThan(int age);

    List<User> findByAddressCity(String city);  // Embedded Document 접근

    List<User> findByTagsContaining(String tag);  // 배열에 포함

    // 정렬
    List<User> findByAgeBetweenOrderByAgeDesc(int start, int end);

    // 페이징
    Page<User> findByAgeGreaterThan(int age, Pageable pageable);

    // 존재 확인
    boolean existsByEmail(String email);

    // 삭제
    void deleteByEmail(String email);
}
```

## @Query 어노테이션

```java
public interface UserRepository extends MongoRepository<User, String> {

    // JSON 쿼리
    @Query("{ 'age': { $gte: ?0 }, 'address.city': ?1 }")
    List<User> findByAgeAndCity(int age, String city);

    // 프로젝션 (특정 필드만)
    @Query(value = "{ 'age': { $gte: ?0 } }", fields = "{ 'name': 1, 'email': 1 }")
    List<User> findNamesAndEmailsByAge(int age);

    // 정규식
    @Query("{ 'name': { $regex: ?0 } }")
    List<User> findByNameRegex(String pattern);
}
```

## 사용 예시

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;

    public User save(User user) {
        return userRepository.save(user);
    }

    public User findById(String id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new NotFoundException("User not found: " + id));
    }

    public List<User> findByCity(String city) {
        return userRepository.findByAddressCity(city);
    }

    public Page<User> findByAge(int minAge, int page, int size) {
        Pageable pageable = PageRequest.of(page, size, Sort.by("age").descending());
        return userRepository.findByAgeGreaterThan(minAge, pageable);
    }
}
```

# 5. MongoTemplate

---

복잡한 쿼리나 동적 쿼리는 `MongoTemplate`을 사용합니다.

## 기본 CRUD

```java
@Service
@RequiredArgsConstructor
public class UserService {

    private final MongoTemplate mongoTemplate;

    // 저장
    public User save(User user) {
        return mongoTemplate.save(user);
    }

    // ID로 조회
    public User findById(String id) {
        return mongoTemplate.findById(id, User.class);
    }

    // 조건 조회
    public List<User> findByAge(int minAge) {
        Query query = new Query(Criteria.where("age").gte(minAge));
        return mongoTemplate.find(query, User.class);
    }

    // 삭제
    public void delete(String id) {
        Query query = new Query(Criteria.where("_id").is(id));
        mongoTemplate.remove(query, User.class);
    }
}
```

## 복잡한 쿼리

```java
public List<User> findByComplexCondition(String city, int minAge, List<String> tags) {
    Criteria criteria = new Criteria();

    // 동적 조건
    if (city != null) {
        criteria.and("address.city").is(city);
    }
    if (minAge > 0) {
        criteria.and("age").gte(minAge);
    }
    if (tags != null && !tags.isEmpty()) {
        criteria.and("tags").in(tags);
    }

    Query query = new Query(criteria)
        .with(Sort.by(Sort.Direction.DESC, "age"))
        .skip(0)
        .limit(10);

    return mongoTemplate.find(query, User.class);
}
```

## Update

```java
public void updateAge(String id, int newAge) {
    Query query = new Query(Criteria.where("_id").is(id));
    Update update = new Update().set("age", newAge);

    mongoTemplate.updateFirst(query, update, User.class);
}

public void incrementAge(String id) {
    Query query = new Query(Criteria.where("_id").is(id));
    Update update = new Update().inc("age", 1);

    mongoTemplate.updateFirst(query, update, User.class);
}

public void addTag(String id, String tag) {
    Query query = new Query(Criteria.where("_id").is(id));
    Update update = new Update().push("tags", tag);

    mongoTemplate.updateFirst(query, update, User.class);
}
```

## Aggregation

```java
// 도시별 사용자 수 집계
public List<CityCount> countByCity() {
    Aggregation aggregation = Aggregation.newAggregation(
        Aggregation.group("address.city").count().as("count"),
        Aggregation.project("count").and("_id").as("city"),
        Aggregation.sort(Sort.Direction.DESC, "count")
    );

    AggregationResults<CityCount> results =
        mongoTemplate.aggregate(aggregation, "users", CityCount.class);

    return results.getMappedResults();
}

@Data
public class CityCount {
    private String city;
    private long count;
}
```

# 6. 인덱스

---

## @Indexed

```java
@Document(collection = "users")
public class User {

    @Id
    private String id;

    @Indexed  // 단일 인덱스
    private String email;

    @Indexed(unique = true)  // 유니크 인덱스
    private String username;

    @TextIndexed  // 텍스트 검색용 인덱스
    private String bio;
}
```

## @CompoundIndex

```java
@Document(collection = "users")
@CompoundIndex(name = "city_age_idx", def = "{'address.city': 1, 'age': -1}")
public class User {
    // ...
}
```

## MongoTemplate으로 인덱스 생성

```java
@PostConstruct
public void createIndexes() {
    IndexOperations indexOps = mongoTemplate.indexOps(User.class);

    indexOps.ensureIndex(new Index().on("email", Sort.Direction.ASC).unique());
    indexOps.ensureIndex(new Index().on("address.city", Sort.Direction.ASC)
                                    .on("age", Sort.Direction.DESC));
}
```

# 7. 실무 고려사항

---

## ObjectId vs 커스텀 ID

```java
// 기본: MongoDB가 생성하는 ObjectId
@Id
private String id;  // "65a123..."

// 커스텀 ID (직접 지정)
@Id
private Long id;  // DB에서 따로 관리

// 권장: ObjectId 사용
// - 분산 환경에서 충돌 없음
// - 시간 정보 포함 (생성 시각 추출 가능)
```

## 날짜 처리

```java
@Document
public class Event {
    @Id
    private String id;

    private LocalDateTime createdAt;  // java.time 지원

    @Field("start_time")
    private Instant startTime;  // UTC 저장 권장
}
```

## Null 필드

```java
// MongoDB는 null 필드를 저장하지 않음 (필드 자체가 없음)
// 조회 시 null 체크 필요

public List<User> findWithoutAddress() {
    Query query = new Query(Criteria.where("address").exists(false));
    return mongoTemplate.find(query, User.class);
}
```

## 트랜잭션 (4.0+)

```java
@Transactional  // Spring @Transactional 사용
public void transferMoney(String fromId, String toId, int amount) {
    Account from = accountRepository.findById(fromId).orElseThrow();
    Account to = accountRepository.findById(toId).orElseThrow();

    from.setBalance(from.getBalance() - amount);
    to.setBalance(to.getBalance() + amount);

    accountRepository.save(from);
    accountRepository.save(to);
}
```

```yaml
# Replica Set 필요 (단일 노드에서는 트랜잭션 불가)
spring:
  data:
    mongodb:
      uri: mongodb://localhost:27017/mydb?replicaSet=rs0
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Document** | JSON 형태의 데이터 단위 |
| **Collection** | Document의 집합 (Table에 해당) |
| **Embedded** | Document 안에 중첩된 Document |
| **MongoRepository** | 선언적 쿼리 인터페이스 |
| **MongoTemplate** | 프로그래밍 방식 쿼리 |

```text
핵심:
  MongoDB = 스키마 유연한 Document DB.
  관련 데이터를 하나의 Document에 임베딩 (JOIN 최소화).
  MongoRepository로 간단한 쿼리, MongoTemplate으로 복잡한 쿼리.
  인덱스 설계가 성능의 핵심.
```

# Reference

---

- [MongoDB Documentation](https://www.mongodb.com/docs/)
- [Spring Data MongoDB](https://docs.spring.io/spring-data/mongodb/docs/current/reference/html/)
- [MongoDB Query Operators](https://www.mongodb.com/docs/manual/reference/operator/query/)
