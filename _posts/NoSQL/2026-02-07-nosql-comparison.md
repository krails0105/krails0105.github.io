---
title: "[NoSQL] Document vs Key-Value vs Wide Column - NoSQL 유형별 비교"
categories:
  - NoSQL
tags:
  - [NoSQL, MongoDB, Redis, Cassandra, DocumentDB, KeyValue, WideColumn]
---

# Introduction

---

NoSQL은 "Not Only SQL"의 약자로, RDBMS가 아닌 데이터베이스를 통칭합니다. NoSQL은 **데이터 모델**에 따라 크게 4가지 유형으로 나뉩니다: **Document, Key-Value, Wide Column, Graph**. 각 유형은 특정 사용 사례에 최적화되어 있어, 요구사항에 맞는 DB를 선택하는 것이 중요합니다.

이 글은 NoSQL의 주요 유형과 대표 데이터베이스를 비교합니다.

# 1. NoSQL 등장 배경

---

## RDBMS의 한계

```text
수직 확장 (Scale-Up)의 한계:
  - 서버 성능에 물리적 한계
  - 고성능 서버는 비용 급증

스키마 변경의 어려움:
  - ALTER TABLE은 테이블 락
  - 대용량 테이블 변경 시 다운타임

JOIN의 성능 저하:
  - 데이터 분산 시 크로스 노드 JOIN
  - 복잡한 JOIN은 성능 병목
```

## NoSQL의 특징

```text
수평 확장 (Scale-Out):
  - 노드 추가로 처리량 증가
  - 샤딩으로 데이터 분산

스키마 유연성:
  - 고정 스키마 없음
  - 필드 추가/삭제 자유

CAP 트레이드오프:
  - Consistency (일관성)
  - Availability (가용성)
  - Partition Tolerance (분산 내성)
  → 세 가지를 모두 만족할 수 없음 (2개 선택)
```

# 2. Key-Value Store

---

## 개념

```text
가장 단순한 형태: Key → Value

┌─────────────────────────────────────────────┐
│ Key                  │ Value                │
├──────────────────────┼──────────────────────┤
│ user:1:session      │ "abc123token..."     │
│ cache:product:100   │ "{\"name\":\"...\"}" │
│ rate:user:1         │ "42"                 │
└──────────────────────┴──────────────────────┘

- Value는 문자열, 숫자, JSON, 이진 데이터 등 무엇이든 가능
- Key로만 조회 (Value 내부 검색 불가)
```

## 대표 DB

| DB | 특징 |
|-----|------|
| **Redis** | 인메모리, 다양한 자료구조 (String, Hash, List, Set, Sorted Set) |
| **Memcached** | 순수 인메모리 캐시, 단순 Key-Value |
| **Amazon DynamoDB** | 완전 관리형, 서버리스, Key-Value + Document |
| **etcd** | 분산 설정 저장소, Kubernetes 사용 |

## 적합한 사용 사례

```text
✅ 캐싱
   - DB 조회 결과 캐시
   - 세션 저장

✅ 세션 관리
   - 사용자 세션 데이터
   - JWT 토큰 저장

✅ Rate Limiting
   - API 호출 횟수 제한

✅ 순위/카운터
   - 조회수, 좋아요 수
   - 리더보드 (Redis Sorted Set)

✅ 분산 락
   - Redis SETNX
```

## 코드 예시 (Redis)

```java
// Spring Data Redis
@Autowired
private RedisTemplate<String, Object> redisTemplate;

// 저장
redisTemplate.opsForValue().set("user:1:session", sessionData, Duration.ofHours(1));

// 조회
Object session = redisTemplate.opsForValue().get("user:1:session");

// 삭제
redisTemplate.delete("user:1:session");
```

# 3. Document Store

---

## 개념

```text
JSON 형태의 Document 저장

{
  "_id": "user123",
  "name": "홍길동",
  "email": "hong@example.com",
  "orders": [
    { "id": 1, "product": "노트북", "price": 1500000 },
    { "id": 2, "product": "마우스", "price": 50000 }
  ],
  "address": {
    "city": "서울",
    "street": "강남대로"
  }
}

- Key-Value와 달리 Value(Document) 내부 필드로 검색 가능
- 중첩된 구조 지원 (Embedded Document)
- 스키마 유연
```

## 대표 DB

| DB | 특징 |
|-----|------|
| **MongoDB** | 가장 인기, BSON 형식, 강력한 쿼리/집계 |
| **Couchbase** | JSON 문서 + 분산 캐시, SQL 유사 쿼리(N1QL) |
| **Amazon DocumentDB** | MongoDB 호환 관리형 서비스 |
| **Elasticsearch** | 검색 엔진, 역인덱스 기반 전문 검색 |

## 적합한 사용 사례

```text
✅ 콘텐츠 관리 (CMS)
   - 블로그, 기사, 상품 정보
   - 유연한 스키마로 다양한 콘텐츠 타입

✅ 사용자 프로필
   - 사용자마다 다른 속성
   - 중첩된 정보 (주소, 설정 등)

✅ 실시간 분석
   - 로그, 이벤트 데이터
   - Aggregation Pipeline

✅ 카탈로그/인벤토리
   - 상품마다 다른 속성
   - 카테고리별 스키마 차이

✅ 모바일/게임 백엔드
   - 빠른 스키마 진화
   - JSON 형태 데이터 교환
```

## 코드 예시 (MongoDB)

```java
// Spring Data MongoDB
@Document(collection = "users")
public class User {
    @Id
    private String id;
    private String name;
    private List<Order> orders;  // Embedded
    private Address address;     // Embedded
}

// Repository
public interface UserRepository extends MongoRepository<User, String> {
    List<User> findByAddressCity(String city);
    List<User> findByOrdersProductContaining(String product);
}

// MongoTemplate - 복잡한 쿼리
Query query = new Query(Criteria.where("address.city").is("서울")
                                 .and("orders.price").gte(100000));
List<User> users = mongoTemplate.find(query, User.class);
```

# 4. Wide Column Store

---

## 개념

```text
Row Key + Column Family 구조

Row Key    │ Column Family: profile      │ Column Family: orders
───────────┼─────────────────────────────┼──────────────────────────
user:1     │ name: "홍길동"              │ order:1: "{...}"
           │ email: "hong@example.com"  │ order:2: "{...}"
           │ age: 30                     │
───────────┼─────────────────────────────┼──────────────────────────
user:2     │ name: "김철수"              │ order:3: "{...}"
           │ phone: "010-1234-5678"     │

- 각 Row마다 Column이 다를 수 있음
- Column Family 단위로 저장 (디스크 I/O 최적화)
- 대용량 데이터, 분산 처리에 최적화
```

## 대표 DB

| DB | 특징 |
|-----|------|
| **Apache Cassandra** | 분산, 고가용성, 쓰기 최적화, CQL (SQL 유사) |
| **Apache HBase** | Hadoop 기반, 대용량 분석, HDFS 저장 |
| **ScyllaDB** | Cassandra 호환, C++ 구현으로 10배 성능 |
| **Google Bigtable** | GCP 완전 관리형, HBase API 호환 |

## 적합한 사용 사례

```text
✅ 시계열 데이터
   - IoT 센서 데이터
   - 메트릭, 로그
   - 시간 기반 파티셔닝

✅ 대규모 쓰기 워크로드
   - 이벤트 로깅
   - 클릭스트림

✅ 메시징/채팅 이력
   - 대화 기록 저장
   - 사용자별 메시지 조회

✅ 추천 시스템
   - 사용자-아이템 매트릭스
   - 행동 이력 저장

✅ 지리적 분산
   - 멀티 데이터센터
   - 글로벌 서비스
```

## 코드 예시 (Cassandra)

```java
// Spring Data Cassandra
@Table("users")
public class User {
    @PrimaryKeyColumn(type = PrimaryKeyType.PARTITIONED)
    private String userId;

    @PrimaryKeyColumn(type = PrimaryKeyType.CLUSTERED, ordering = Ordering.DESCENDING)
    private UUID eventTime;

    private String name;
    private String email;
}

// Repository
public interface UserRepository extends CassandraRepository<User, String> {
    List<User> findByUserId(String userId);
}

// CQL 직접 사용
@Query("SELECT * FROM users WHERE user_id = ?0 AND event_time > ?1")
List<User> findRecentEvents(String userId, UUID since);
```

# 5. Graph Database

---

## 개념

```text
Node(정점)와 Edge(간선)로 관계 표현

  (User: 홍길동) ──FOLLOWS──▶ (User: 김철수)
        │                          │
        │                          │
     LIKES                      WROTE
        │                          │
        ▼                          ▼
  (Post: "Redis 소개")    (Post: "MongoDB 입문")

- 관계(Edge)도 속성을 가질 수 있음
- 그래프 순회로 복잡한 관계 탐색
- JOIN 없이 관계 탐색 (포인터로 직접 연결)
```

## 대표 DB

| DB | 특징 |
|-----|------|
| **Neo4j** | 가장 인기, Cypher 쿼리 언어, ACID |
| **Amazon Neptune** | AWS 관리형, Gremlin/SPARQL 지원 |
| **JanusGraph** | 오픈소스, 분산, Cassandra/HBase 백엔드 |
| **ArangoDB** | 멀티모델 (Document + Graph + Key-Value) |

## 적합한 사용 사례

```text
✅ 소셜 네트워크
   - 친구 관계
   - 팔로우/팔로잉
   - 친구의 친구 추천

✅ 추천 엔진
   - "이 상품을 본 사람이 본 다른 상품"
   - 유사 사용자 탐색

✅ 사기 탐지
   - 거래 관계 분석
   - 비정상 패턴 탐지

✅ 지식 그래프
   - 엔티티 간 관계
   - 의미론적 검색

✅ 네트워크/IT 인프라
   - 시스템 의존성
   - 장애 영향 분석
```

## 코드 예시 (Neo4j Cypher)

```cypher
// 노드 생성
CREATE (u:User {name: '홍길동', email: 'hong@example.com'})
CREATE (p:Post {title: 'Redis 소개', content: '...'})

// 관계 생성
MATCH (u:User {name: '홍길동'}), (p:Post {title: 'Redis 소개'})
CREATE (u)-[:WROTE {createdAt: datetime()}]->(p)

// 2단계 팔로우 관계 조회 (친구의 친구)
MATCH (me:User {name: '홍길동'})-[:FOLLOWS*2]->(fof:User)
WHERE fof <> me
RETURN DISTINCT fof.name

// 추천: 내가 안 본 게시물 중 친구가 좋아한 것
MATCH (me:User {name: '홍길동'})-[:FOLLOWS]->(friend)-[:LIKES]->(post:Post)
WHERE NOT (me)-[:VIEWED]->(post)
RETURN post.title, COUNT(friend) AS likes
ORDER BY likes DESC
LIMIT 10
```

# 6. 유형별 비교

---

## 데이터 모델

| 유형 | 데이터 구조 | 쿼리 유연성 |
|------|-----------|-----------|
| **Key-Value** | Key → Value | Key로만 조회 |
| **Document** | JSON Document | 필드 기반 쿼리 |
| **Wide Column** | Row Key + Column | Row Key + Column 범위 |
| **Graph** | Node + Edge | 그래프 순회 |

## 성능 특성

| 유형 | 읽기 | 쓰기 | 확장성 |
|------|-----|-----|--------|
| **Key-Value** | 매우 빠름 (O(1)) | 매우 빠름 | 매우 높음 |
| **Document** | 빠름 (인덱스) | 빠름 | 높음 |
| **Wide Column** | 빠름 (Row Key) | 매우 빠름 | 매우 높음 |
| **Graph** | 관계 탐색 빠름 | 보통 | 보통 |

## CAP 분류

| DB | CAP 선택 | 설명 |
|----|---------|------|
| Redis | CP/AP (설정) | 단일 노드 CP, 클러스터 AP 가능 |
| MongoDB | CP | Primary 장애 시 잠시 불가용 |
| Cassandra | AP | 항상 가용, 최종 일관성 |
| Neo4j | CA (단일 노드) | 분산 시 CP |

# 7. 선택 가이드

---

## 결정 트리

```text
1. 데이터 관계가 복잡한가? (그래프 탐색 필요)
   → Yes: Graph DB (Neo4j)

2. 단순 Key-Value 조회인가?
   → Yes: Key-Value (Redis, DynamoDB)

3. 문서 구조 + 필드 검색이 필요한가?
   → Yes: Document DB (MongoDB)

4. 대용량 시계열/로그 + 분산 쓰기인가?
   → Yes: Wide Column (Cassandra)

5. 트랜잭션, 복잡한 JOIN이 많은가?
   → Yes: RDBMS 유지
```

## 사용 사례별 추천

| 사용 사례 | 추천 DB |
|----------|---------|
| **세션/캐시** | Redis |
| **사용자 프로필** | MongoDB |
| **상품 카탈로그** | MongoDB |
| **채팅 메시지** | Cassandra |
| **IoT 센서 데이터** | Cassandra, InfluxDB |
| **소셜 그래프** | Neo4j |
| **검색** | Elasticsearch |
| **설정 저장소** | etcd, Consul |

## Polyglot Persistence

```text
하나의 시스템에서 여러 DB를 함께 사용:

┌─────────────────────────────────────────────────────┐
│                    Application                       │
├─────────────────────────────────────────────────────┤
│ 주문 데이터 → PostgreSQL (트랜잭션)                   │
│ 상품 카탈로그 → MongoDB (유연한 스키마)               │
│ 세션/캐시 → Redis (빠른 조회)                        │
│ 검색 → Elasticsearch (전문 검색)                     │
│ 추천 관계 → Neo4j (그래프 탐색)                      │
└─────────────────────────────────────────────────────┘
```

# 8. 정리

---

| 유형 | 대표 DB | 적합한 사용 사례 |
|------|---------|----------------|
| **Key-Value** | Redis, DynamoDB | 캐시, 세션, Rate Limit |
| **Document** | MongoDB | 콘텐츠, 카탈로그, 프로필 |
| **Wide Column** | Cassandra | 시계열, 로그, 대규모 쓰기 |
| **Graph** | Neo4j | 소셜, 추천, 사기 탐지 |

```text
핵심:
  NoSQL은 하나가 아니라 여러 유형이 존재.
  데이터 모델과 쿼리 패턴에 맞는 DB 선택.
  RDBMS를 완전히 대체하는 것이 아님.
  Polyglot Persistence로 여러 DB 조합 활용.
```

# Reference

---

- [MongoDB vs Cassandra](https://www.mongodb.com/compare/cassandra-vs-mongodb)
- [AWS NoSQL Databases](https://aws.amazon.com/nosql/)
- [CAP Theorem](https://en.wikipedia.org/wiki/CAP_theorem)
- [Choosing the Right NoSQL Database](https://www.kdnuggets.com/2021/09/choosing-right-nosql-database.html)
