---
title: "[Database] SQL vs NoSQL -- 개념부터 실무 선택 가이드까지"
categories:
  - Backend
tags:
  - [Database, SQL, NoSQL, PostgreSQL, MongoDB, Redis, CAP, ACID, BASE, Polyglot Persistence]
---

# Introduction

---

데이터베이스를 선택할 때 가장 먼저 마주하는 질문이 있습니다. "SQL을 쓸까, NoSQL을 쓸까?"

단순해 보이지만, 이 결정은 프로젝트의 성능, 확장성, 유지보수성에 직접적인 영향을 미칩니다. 그런데 실무에서는 "둘 중 하나만 선택"하는 경우보다 **둘을 조합**하는 경우가 훨씬 많습니다.

이번 포스트에서는 다음 내용을 다룹니다.

1. SQL과 NoSQL의 핵심 철학 (ACID vs BASE)
2. 각각의 구조적 특징과 한계
3. 분산 시스템의 기본 원리 (CAP 정리)
4. SQL과 NoSQL의 경계가 흐려지는 최근 흐름
5. 실무에서 데이터베이스를 선택하고 조합하는 전략

# 1. SQL (관계형 데이터베이스)

---

## 정의

SQL(Structured Query Language)은 **관계형 데이터베이스(RDBMS)에서 사용되는 표준 쿼리 언어**입니다. 관계형 데이터베이스는 데이터를 **테이블(표)** 형태로 저장하고, 테이블 간의 관계를 정의하여 데이터를 관리합니다. SQL 데이터베이스를 이해하려면 먼저 핵심 철학인 **ACID**를 알아야 합니다.

## ACID -- 데이터 안전의 네 가지 원칙

ACID는 데이터베이스 트랜잭션이 안전하게 수행되기 위한 네 가지 속성입니다. 은행 계좌 이체를 예시로 각 속성을 살펴보겠습니다.

| 속성 | 의미 | 예시 |
|------|------|------|
| **Atomicity (원자성)** | 트랜잭션의 모든 작업이 전부 성공하거나, 전부 실패해야 한다 | A계좌 출금 + B계좌 입금이 하나의 단위. 중간 오류 시 모두 취소 |
| **Consistency (일관성)** | 트랜잭션 전후로 데이터가 항상 규칙을 만족해야 한다 | "잔액 >= 0" 제약 조건을 위반하는 트랜잭션은 거부 |
| **Isolation (고립성)** | 동시에 실행되는 트랜잭션이 서로 간섭하지 않아야 한다 | A와 B가 동시에 같은 상품을 구매해도 재고가 정확히 차감 |
| **Durability (지속성)** | 커밋된 트랜잭션의 결과는 영구적으로 보존된다 | 커밋 후 서버가 꺼져도 데이터 유지 |

```sql
-- Atomicity 예시: 계좌 이체
BEGIN TRANSACTION;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;  -- A계좌 출금
UPDATE accounts SET balance = balance + 100 WHERE id = 2;  -- B계좌 입금
COMMIT;  -- 두 작업이 모두 성공해야 커밋
-- 중간에 오류 발생 시 → ROLLBACK으로 두 작업 모두 취소
```

핵심은 **"데이터 정확성을 최우선으로 보장한다"**는 것입니다. 금융, 결제, 재고 관리처럼 숫자 하나가 틀리면 안 되는 도메인에서 SQL이 선택되는 이유입니다.

## 주요 특징

### 1. 고정 스키마 (Predefined Schema)

테이블을 생성할 때 컬럼의 자료형, 제약 조건 등을 **미리 정의**해야 합니다. 이 구조 정의를 **스키마(Schema)**라고 합니다.

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,           -- 자동 증가 정수, 기본 키
    name VARCHAR(100) NOT NULL,      -- 최대 100자, 필수 입력
    email VARCHAR(255) UNIQUE NOT NULL,  -- 유일해야 함, 필수 입력
    age INTEGER CHECK (age >= 0),    -- 0 이상만 허용
    created_at TIMESTAMP DEFAULT NOW()  -- 기본값: 현재 시각
);
```

스키마가 고정되어 있다는 것은, 모든 행(row)이 같은 컬럼 구조를 가진다는 뜻입니다. 덕분에 데이터의 형태가 예측 가능하고, 잘못된 데이터가 들어오는 것을 DB 레벨에서 방지할 수 있습니다.

### 2. 복잡한 조인 연산에 최적화

여러 테이블을 연결(JOIN)하여 복잡한 관계를 한 번에 조회할 수 있습니다.

```sql
-- 사용자의 주문 내역과 상품 정보를 한 번에 조회
SELECT
    u.name AS user_name,
    o.order_date,
    p.product_name,
    oi.quantity
FROM users u
INNER JOIN orders o ON u.id = o.user_id
INNER JOIN order_items oi ON o.id = oi.order_id
INNER JOIN products p ON oi.product_id = p.id
WHERE u.id = 1;
```

사용자, 주문, 주문 상세, 상품이라는 4개의 테이블을 하나의 쿼리로 연결할 수 있습니다. 이것이 관계형 데이터베이스의 가장 큰 강점입니다.

## 한계

### 1. 스키마 변경 비용이 높음

서비스 운영 중에 테이블 구조를 변경하려면, 기존 데이터를 모두 마이그레이션해야 합니다. 데이터가 많을수록 시간과 위험이 증가합니다.

```sql
-- 수백만 건의 기존 데이터가 있는 테이블에 컬럼을 추가하면
-- 테이블 잠금, 마이그레이션 시간 등을 고려해야 한다
ALTER TABLE users ADD COLUMN phone VARCHAR(20);
```

### 2. 수직 확장(Scale-up) 위주

트래픽이 증가하면 CPU, 메모리, 디스크를 더 좋은 사양으로 교체해야 합니다. 여러 서버로 분산하는 수평 확장(Scale-out)은 기술적으로 복잡하고, RDBMS의 ACID 보장과 충돌하는 경우가 많습니다.

## 대표 제품

| 제품 | 특징 | 주요 사용 사례 |
|------|------|----------------|
| **PostgreSQL** | 오픈소스, JSONB 지원, 확장성 우수 | 스타트업, SaaS, 금융 시스템 |
| **MySQL** | 가볍고 빠름, 웹 애플리케이션에 최적화 | WordPress, 중소규모 웹 서비스 |
| **Oracle** | 엔터프라이즈급 기능, 고성능 | 대기업, 은행, 공공기관 |
| **SQL Server** | Windows/Azure 환경 최적화, BI 도구 통합 | .NET 기반 애플리케이션 |

# 2. NoSQL (비관계형 데이터 저장소)

---

## 정의

NoSQL(Not Only SQL)은 **대규모 분산 환경과 수평 확장을 위해 등장한 비관계형 데이터 저장소**를 총칭합니다. 고정된 스키마를 요구하지 않으며, 데이터 모델도 문서, 키-값, 컬럼, 그래프 등 다양합니다.

NoSQL의 핵심 철학은 **BASE**입니다. ACID가 "정확성 우선"이라면, BASE는 "가용성 우선"입니다.

## BASE -- 가용성과 확장성의 철학

| 속성 | 의미 | 예시 |
|------|------|------|
| **Basically Available** | 일부 노드가 실패해도 시스템 전체는 동작한다 | 서버 3대 중 1대가 다운되어도 나머지 2대가 요청 처리 |
| **Soft state** | 시스템 상태가 시간에 따라 변할 수 있다 (외부 입력 없이도) | 캐시 데이터가 TTL 만료로 자동 삭제 |
| **Eventually consistent** | 즉시 동기화되지 않아도, 시간이 지나면 결국 일관된 상태가 된다 | SNS 좋아요 수가 모든 사용자에게 몇 초 뒤에 동기화 |

핵심은 **"즉각적인 완벽한 일관성을 포기하는 대신, 시스템이 항상 응답하고 확장 가능하도록 설계한다"**는 것입니다.

## 주요 특징

### 1. 동적 스키마 (Schema-less)

데이터를 저장할 때 미리 구조를 정의할 필요가 없습니다. 같은 컬렉션 안에서도 문서마다 다른 필드를 가질 수 있습니다.

```javascript
// MongoDB 예시 - 같은 컬렉션 내에서 구조가 다른 문서들
db.users.insertMany([
    {
        name: "Alice",
        email: "alice@example.com",
        age: 25
    },
    {
        name: "Bob",
        email: "bob@example.com",
        age: 30,
        phone: "010-1234-5678",   // Alice에는 없는 필드
        address: {                 // 중첩 객체도 자유롭게 저장
            city: "Seoul",
            zipcode: "12345"
        }
    }
]);
```

이런 유연성 덕분에 서비스 초기 단계에서 스키마가 자주 바뀌는 상황에 적합합니다. 다만 스키마 검증이 없으면 잘못된 데이터가 들어와도 DB가 막아주지 않으므로, 애플리케이션 레벨에서 검증 로직을 직접 관리해야 합니다.

### 2. 수평 확장(Scale-out)이 용이

데이터를 여러 서버에 분산 저장(샤딩)하기 쉽습니다. 트래픽이 증가하면 서버를 추가하는 방식으로 대응할 수 있습니다.

## NoSQL의 4가지 유형

NoSQL은 데이터를 저장하는 방식에 따라 크게 네 가지로 분류됩니다.

### 1. 문서형 (Document Store)

JSON/BSON 형태로 데이터를 저장합니다. 중첩된 구조를 자연스럽게 표현할 수 있어 애플리케이션 객체와 매핑이 직관적입니다.

- **대표 제품**: MongoDB, CouchDB
- **사용 사례**: CMS(콘텐츠 관리), 카탈로그, 사용자 프로필

```javascript
// MongoDB 문서 예시 - 하나의 문서에 관련 데이터를 모두 포함
{
    "_id": ObjectId("507f1f77bcf86cd799439011"),
    "title": "NoSQL 가이드",
    "author": "홍길동",
    "tags": ["database", "nosql", "mongodb"],
    "comments": [
        { "user": "김철수", "text": "유익한 글이네요!" },
        { "user": "이영희", "text": "감사합니다." }
    ]
}
```

SQL이라면 `posts`, `tags`, `comments` 세 개의 테이블과 JOIN이 필요하지만, 문서형 DB에서는 하나의 문서에 모든 정보를 담을 수 있습니다.

### 2. 키-값 저장소 (Key-Value Store)

단순한 키-값 쌍으로 데이터를 저장합니다. 구조가 단순한 만큼 **가장 빠른 읽기/쓰기 성능**을 제공합니다.

- **대표 제품**: Redis, Memcached, DynamoDB
- **사용 사례**: 캐싱, 세션 관리, 실시간 리더보드

```bash
# Redis 기본 명령어
SET user:1000:name "Alice"       # 키에 값 저장
GET user:1000:name               # 키로 값 조회
# 결과: "Alice"

# TTL(만료 시간) 설정 - 캐싱에 자주 사용
SET session:abc123 "user_data" EX 3600   # 3600초(1시간) 후 자동 삭제
TTL session:abc123                        # 남은 TTL 확인
# 결과: (integer) 3599

# 리스트 자료구조
LPUSH recent_searches "NoSQL"    # 리스트 왼쪽에 추가
LPUSH recent_searches "Redis"    # 리스트 왼쪽에 추가
LRANGE recent_searches 0 -1      # 전체 리스트 조회
# 결과: 1) "Redis"  2) "NoSQL"
```

### 3. 컬럼형 (Column-Family Store)

데이터를 행(row)이 아닌 **컬럼 단위로 저장**합니다. 특정 컬럼만 읽으면 되는 대량 데이터 분석에 유리합니다.

- **대표 제품**: Cassandra, HBase
- **사용 사례**: 시계열 데이터, 로그 분석, IoT 센서 데이터

### 4. 그래프형 (Graph Database)

노드(Node)와 관계(Edge)로 데이터를 저장합니다. 데이터 간의 **관계 자체를 탐색**하는 쿼리에 최적화되어 있습니다.

- **대표 제품**: Neo4j, ArangoDB
- **사용 사례**: 소셜 네트워크, 추천 시스템, 사기 탐지

## 한계

### 1. 복잡한 관계 표현이 어려움

여러 컬렉션에 걸친 복잡한 관계를 조회하려면, SQL처럼 단순한 JOIN 대신 애플리케이션 코드에서 여러 번 쿼리를 실행하고 결과를 조합해야 합니다.

### 2. 데이터 정합성을 애플리케이션이 관리

ACID를 완벽하게 지원하지 않는 경우가 많아서, "데이터가 규칙을 지키고 있는가?"를 애플리케이션 코드에서 직접 검증해야 합니다.

## 대표 제품 비교

| 제품 | 유형 | 특징 | 주요 사용 사례 |
|------|------|------|----------------|
| **MongoDB** | 문서형 | ACID 트랜잭션 지원 (4.0+), 풍부한 쿼리 기능 | CMS, 실시간 분석 |
| **Redis** | 키-값 | 인메모리, 초고속 읽기/쓰기 | 캐싱, 세션, 실시간 순위 |
| **Cassandra** | 컬럼형 | 고가용성, 대규모 쓰기에 강함 | 시계열 데이터, 로그 |
| **DynamoDB** | 키-값/문서 | AWS 관리형, 자동 스케일링 | 서버리스 앱, 게임 |

# 3. SQL vs NoSQL 비교표

---

| 비교 항목 | SQL (관계형) | NoSQL (비관계형) |
|-----------|-------------|-----------------|
| **핵심 철학** | ACID (데이터 정확성 우선) | BASE (가용성, 확장성 우선) |
| **스키마** | 고정 (Predefined Schema) | 동적 (Schema-less) |
| **데이터 모델** | 테이블 (행과 열) | 문서, 키-값, 컬럼, 그래프 |
| **확장 방식** | 수직 확장 (Scale-up) 위주 | 수평 확장 (Scale-out) 용이 |
| **트랜잭션** | 강력한 ACID 보장 | 최종 일관성 기본 (일부 제품은 ACID 지원) |
| **관계 표현** | JOIN으로 강력한 관계 표현 | 제한적 (애플리케이션 레벨 처리) |
| **쿼리 언어** | SQL (표준화) | 제품마다 다름 (MQL, Redis CLI 등) |
| **스키마 변경** | 마이그레이션 필요 (비용 높음) | 즉시 필드 추가 가능 (비용 낮음) |
| **적합한 사례** | 은행, 결제, ERP, 재고 관리 | 소셜 미디어, 로그, 캐싱, 실시간 분석 |

# 4. CAP 정리 (CAP Theorem)

---

분산 시스템에서 데이터베이스를 선택할 때 꼭 알아야 하는 이론이 **CAP 정리**입니다.

## 세 가지 속성

| 속성 | 의미 | 쉬운 설명 |
|------|------|-----------|
| **C (Consistency)** | 모든 노드가 동시에 같은 데이터를 보여준다 | 어느 서버에 물어봐도 같은 답 |
| **A (Availability)** | 모든 요청이 항상 응답을 받는다 | 서버가 멈추지 않고 항상 대답 |
| **P (Partition Tolerance)** | 네트워크 장애가 발생해도 시스템이 동작한다 | 서버 간 통신이 끊겨도 작동 |

## CAP 정리의 핵심

> 분산 시스템에서는 네트워크 파티션(P)은 반드시 발생한다. 따라서 실질적으로 **CP(일관성 우선)와 AP(가용성 우선) 중 하나를 선택**해야 한다.

"세 가지 중 두 가지를 선택"이라고 흔히 설명되지만, 실무적으로 P(네트워크 장애 허용)는 분산 시스템에서 선택이 아닌 필수입니다. 따라서 실제 선택은 **C(일관성)와 A(가용성) 사이의 트레이드오프**입니다.

```
          Consistency (C)
               /\
              /  \
             / CP \
            /______\
           /        \
          /    CA    \
         / (단일노드  \
        /   RDBMS)    \
       /_______________\
      /                 \
  Partition          Availability
  Tolerance (P)         (A)

  CP: MongoDB, HBase     AP: Cassandra, DynamoDB
  → 네트워크 장애 시      → 네트워크 장애 시
    일관성 유지,             가용성 유지,
    일부 요청 거부 가능      데이터 불일치 허용
```

| 조합 | 설명 | 대표 제품 |
|------|------|-----------|
| **CA** | 일관성 + 가용성 (단일 노드 또는 동기식 복제) | 전통적 RDBMS (단일 서버) |
| **CP** | 일관성 + 분산 허용 (장애 시 일부 요청 거부 가능) | MongoDB, HBase |
| **AP** | 가용성 + 분산 허용 (장애 시 일시적 데이터 불일치 허용) | Cassandra, DynamoDB |

**주의**: CA는 "네트워크 파티션이 발생하지 않는다"는 전제이므로, 실질적으로 분산 시스템에서는 존재하기 어렵습니다. 전통적인 단일 노드 RDBMS가 여기에 해당합니다.

# 5. SQL과 NoSQL의 경계 허물기

---

최근에는 SQL과 NoSQL의 경계가 점점 흐려지고 있습니다. 각각 상대의 장점을 흡수하면서 진화하고 있기 때문입니다.

## SQL의 진화: PostgreSQL JSONB

PostgreSQL은 `JSONB` 자료형을 통해 NoSQL처럼 유연한 비정형 데이터를 관계형 DB 안에서 다룰 수 있습니다.

```sql
-- 1. JSONB 컬럼을 가진 테이블 생성
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255),
    metadata JSONB  -- 동적 속성을 JSON으로 저장
);

-- 2. 서로 다른 구조의 데이터 삽입 (NoSQL처럼 유연)
INSERT INTO products (name, metadata) VALUES
('노트북', '{"brand": "Apple", "specs": {"cpu": "M1", "ram": "16GB"}}'),
('키보드', '{"brand": "Logitech", "color": "black", "wireless": true}');

-- 3. JSONB 쿼리 - 다양한 연산자 지원
-- @> : 포함(containment) 연산자. 왼쪽 JSON이 오른쪽 JSON을 포함하는지 검사
SELECT * FROM products WHERE metadata @> '{"brand": "Apple"}';

-- -> : JSON 객체에서 키로 값을 추출 (결과: jsonb 타입)
-- ->> : JSON 객체에서 키로 값을 추출 (결과: text 타입)
SELECT * FROM products WHERE metadata->'specs'->>'cpu' = 'M1';

-- 4. GIN 인덱스로 JSONB 쿼리 성능 최적화
-- 기본 GIN: @>, ?, ?|, ?&, @?, @@ 연산자 지원
CREATE INDEX idx_metadata ON products USING GIN (metadata);

-- jsonb_path_ops GIN: @> 연산자에 특화, 더 작은 인덱스 크기
CREATE INDEX idx_metadata_path ON products USING GIN (metadata jsonb_path_ops);
```

**JSONB 인덱스 비교:**

| GIN 옵션 | 지원 연산자 | 인덱스 크기 | 사용 시점 |
|-----------|-------------|-------------|-----------|
| 기본 GIN | `@>`, `?`, `?&`, `?|`, `@?`, `@@` | 상대적으로 큼 | 다양한 쿼리 패턴 필요 시 |
| `jsonb_path_ops` | `@>`, `@?`, `@@` | 상대적으로 작음 | 포함(containment) 쿼리 위주 |

> PostgreSQL JSONB를 사용하면 "핵심 데이터는 정규화된 컬럼으로, 유연한 부가 정보는 JSONB로" 저장하는 하이브리드 설계가 가능합니다.

## NoSQL의 진화 1: MongoDB ACID 트랜잭션

MongoDB는 4.0(레플리카 셋)과 4.2(샤드 클러스터) 버전부터 멀티 도큐먼트 ACID 트랜잭션을 지원합니다. 이를 통해 여러 문서/컬렉션에 걸친 원자적 작업이 가능합니다.

```javascript
// MongoDB Node.js 드라이버 - 멀티 도큐먼트 트랜잭션 예시
const session = client.startSession();

try {
    // 트랜잭션 시작 (readConcern, writeConcern 지정 가능)
    session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" }
    });

    // 작업 1: A 계좌에서 100 차감
    await db.collection("accounts").updateOne(
        { accountId: "A" },
        { $inc: { balance: -100 } },
        { session }  // 반드시 session을 전달해야 트랜잭션에 포함
    );

    // 작업 2: B 계좌에 100 추가
    await db.collection("accounts").updateOne(
        { accountId: "B" },
        { $inc: { balance: 100 } },
        { session }
    );

    // 모든 작업 성공 → 커밋
    await session.commitTransaction();
    console.log("트랜잭션 성공");
} catch (error) {
    // 오류 발생 → 롤백 (모든 변경 취소)
    await session.abortTransaction();
    console.log("트랜잭션 실패, 롤백됨:", error.message);
} finally {
    // 세션 종료 (반드시 호출)
    session.endSession();
}
```

**주의사항:**
- 트랜잭션 내 모든 연산에 `{ session }` 옵션을 반드시 전달해야 합니다
- 트랜잭션은 레플리카 셋 또는 샤드 클러스터 환경에서만 사용 가능합니다 (standalone에서는 불가)
- 트랜잭션은 60초 기본 타임아웃이 있습니다. 장시간 트랜잭션은 성능에 영향을 줍니다
- MongoDB의 설계 철학상 트랜잭션은 **예외적인 상황**에서 사용하고, 가능하면 **단일 문서 내에서 원자적 연산**을 하는 것이 권장됩니다

## NoSQL의 진화 2: MongoDB Aggregation Pipeline

MongoDB의 Aggregation Pipeline은 SQL의 `GROUP BY`, `JOIN`, `HAVING` 등과 유사한 기능을 제공합니다. 데이터를 여러 단계(stage)를 거쳐 변환하는 파이프라인 방식입니다.

```javascript
// Aggregation Pipeline 예시 - SQL의 JOIN + GROUP BY와 유사
db.orders.aggregate([
    // Stage 1: $lookup - SQL의 LEFT JOIN과 유사
    // orders 컬렉션의 customerId와 customers 컬렉션의 _id를 매칭
    {
        $lookup: {
            from: "customers",        // 조인할 컬렉션
            localField: "customerId", // orders의 조인 키
            foreignField: "_id",      // customers의 조인 키
            as: "customer"            // 결과를 담을 배열 필드명
        }
    },
    // Stage 2: $unwind - 배열을 개별 문서로 풀기
    // $lookup 결과가 배열이므로, 단일 객체로 변환
    { $unwind: "$customer" },
    // Stage 3: $group - SQL의 GROUP BY + SUM과 유사
    {
        $group: {
            _id: "$customer.name",           // GROUP BY 기준
            totalSpent: { $sum: "$amount" },  // SUM(amount)
            orderCount: { $sum: 1 }           // COUNT(*)
        }
    },
    // Stage 4: $sort - 결과 정렬
    { $sort: { totalSpent: -1 } }
]);
```

위 파이프라인을 SQL로 표현하면 다음과 같습니다.

```sql
-- 위 Aggregation Pipeline과 동일한 SQL
SELECT
    c.name,
    SUM(o.amount) AS totalSpent,
    COUNT(*) AS orderCount
FROM orders o
INNER JOIN customers c ON o.customer_id = c.id
GROUP BY c.name
ORDER BY totalSpent DESC;
```

# 6. 실무 선택 가이드

---

## SQL을 선택해야 하는 경우

| 상황 | 이유 | 예시 |
|------|------|------|
| 복잡한 관계 표현 필요 | 테이블 간 JOIN 최적화 | 전자상거래 (사용자-주문-상품-배송-결제) |
| 데이터 정확성이 최우선 | ACID 트랜잭션 보장 | 은행, 결제, 재고 관리 |
| 복잡한 분석 쿼리 | 표준 SQL의 표현력 | 리포팅, BI, 데이터 분석 |
| 팀이 SQL에 익숙 | 학습 비용 최소화 | 대부분의 일반적인 웹 애플리케이션 |

## NoSQL을 선택해야 하는 경우

| 상황 | 이유 | 예시 |
|------|------|------|
| 초당 수만 건 이상의 트래픽 처리 | 수평 확장 용이 | 실시간 채팅, 게임 리더보드 |
| 스키마가 자주 변경 | 동적 스키마, 빠른 반복 개발 | MVP 단계, 프로토타이핑 |
| 대용량 비정형 데이터 | 유연한 저장 구조 | 로그, 센서 데이터, 소셜 피드 |
| 초고속 읽기/쓰기 필요 | 인메모리, 단순 구조 | 캐싱, 세션 관리 |

## 의사결정 플로우

```
시작
 │
 ├─ 데이터 정확성이 최우선인가? (결제, 은행 등)
 │   └─ Yes → SQL (PostgreSQL, MySQL)
 │
 ├─ 초당 수만 건 이상의 쓰기가 필요한가?
 │   └─ Yes → NoSQL (Cassandra, DynamoDB)
 │
 ├─ 스키마가 자주 변경되는 초기 단계인가?
 │   └─ Yes → NoSQL (MongoDB)
 │
 ├─ 복잡한 관계와 조인이 핵심인가?
 │   └─ Yes → SQL (PostgreSQL)
 │
 ├─ 캐싱이나 세션 관리가 주요 목적인가?
 │   └─ Yes → Redis
 │
 └─ 잘 모르겠다면?
     └─ SQL(PostgreSQL)로 시작하고,
        병목이 발생하는 지점에서 NoSQL 보완
```

# 7. 하이브리드 전략 (Polyglot Persistence)

---

현대의 대부분의 서비스는 단일 데이터베이스만 사용하지 않습니다. **Polyglot Persistence(다중 데이터베이스 전략)**, 즉 각 문제에 가장 적합한 데이터베이스를 조합하여 사용합니다.

## 전형적인 하이브리드 아키텍처

```
┌─────────────────────────────────────────────────┐
│              애플리케이션 레이어                    │
└──────────┬──────┬──────┬──────┬──────┬──────────┘
           │      │      │      │      │
           ▼      ▼      ▼      ▼      ▼
       PostgreSQL Redis Elastic MongoDB   S3
       (핵심 DB) (캐시) Search  (비정형) (파일)
           │      │      │      │      │
           ▼      ▼      ▼      ▼      ▼
         사용자  세션   전문    로그   이미지
         주문    임시   텍스트  활동   동영상
         결제    데이터  검색   데이터
```

## 실무 사례: 전자상거래 플랫폼

| 데이터베이스 | 역할 | 이유 |
|-------------|------|------|
| **PostgreSQL** | 주문, 사용자, 재고 관리 | ACID 트랜잭션으로 정확한 재고/결제 처리 |
| **Redis** | 장바구니, 세션, 재고 캐싱 | 인메모리로 빠른 읽기, TTL로 자동 만료 |
| **Elasticsearch** | 상품 검색 | 전문 검색(Full-text search) 최적화 |
| **MongoDB** | 상품 리뷰, 사용자 활동 로그 | 유연한 스키마로 다양한 형태의 데이터 저장 |
| **S3** | 상품 이미지, 동영상 | 대용량 파일 저장에 최적화된 객체 스토리지 |

## 점진적 도입 전략

대부분의 프로젝트는 **RDB 하나로 시작**하는 것이 현실적입니다. 그리고 구체적인 병목이 발생하는 시점에 NoSQL을 추가합니다.

| 단계 | 병목 상황 | 대응 | 추가할 기술 |
|------|-----------|------|------------|
| 1 | 반복 조회로 DB 부하 증가 | 자주 읽는 데이터 캐싱 | Redis |
| 2 | 텍스트 검색이 LIKE 쿼리로 한계 | 전문 검색 엔진 도입 | Elasticsearch |
| 3 | 로그/이벤트 데이터가 급증 | 쓰기 최적화 저장소 분리 | MongoDB 또는 Cassandra |
| 4 | 이미지/동영상 저장 필요 | 파일 스토리지 분리 | S3 또는 객체 스토리지 |

# 8. 자주 하는 실수와 주의사항

---

## 실수 1: "NoSQL은 스키마가 없으니까 자유롭다"

스키마가 없다는 것은 **DB가 검증하지 않는다**는 뜻이지, 스키마가 불필요하다는 뜻이 아닙니다. 오히려 애플리케이션 코드에서 더 엄격하게 데이터 형식을 관리해야 합니다. MongoDB에서는 [JSON Schema Validation](https://www.mongodb.com/docs/manual/core/schema-validation/)을 설정하여 DB 레벨에서도 검증할 수 있습니다.

## 실수 2: "트래픽이 많으면 무조건 NoSQL"

읽기 트래픽이 많은 것과 쓰기 트래픽이 많은 것은 다른 문제입니다. 읽기 부하는 Redis 캐시 레이어 추가만으로 해결되는 경우가 많고, 이때 핵심 DB를 NoSQL로 교체할 필요는 없습니다.

## 실수 3: "MongoDB에 ACID가 있으니 RDBMS 대체 가능"

MongoDB의 트랜잭션은 성능 비용이 높고, RDBMS처럼 모든 연산에 트랜잭션을 거는 것은 권장되지 않습니다. MongoDB는 **가능하면 단일 문서 내에서 원자적 연산**을 사용하고, 트랜잭션은 꼭 필요한 경우에만 사용하는 것이 설계 철학입니다.

## 실수 4: "CAP에서 세 가지 중 두 가지를 고른다"

네트워크 파티션(P)은 분산 시스템에서 선택이 아닌 현실입니다. 실제로는 **C(일관성)와 A(가용성) 사이의 트레이드오프**를 결정하는 것이며, 많은 시스템이 상황에 따라 C와 A 사이를 동적으로 조절합니다.

# 정리

---

## 핵심 요약

| 항목 | 핵심 내용 |
|------|-----------|
| **SQL** | 데이터 정확성과 복잡한 관계 표현이 중요한 도메인에 적합 (ACID) |
| **NoSQL** | 대규모 트래픽, 수평 확장, 유연한 스키마가 필요한 환경에 적합 (BASE) |
| **경계 허물기** | PostgreSQL은 JSONB로, MongoDB는 ACID 트랜잭션으로 서로의 영역을 흡수 중 |
| **CAP 정리** | 분산 시스템에서는 일관성(C)과 가용성(A) 사이의 트레이드오프를 결정해야 함 |
| **Polyglot Persistence** | 각 문제에 가장 적합한 DB를 조합하는 것이 현대적 접근법 |
| **시작 전략** | RDB(PostgreSQL)로 시작 → 병목 발생 시 NoSQL 보완이 가장 현실적 |

## 최종 조언

SQL vs NoSQL은 "어느 것이 더 좋은가"의 문제가 아니라, **"이 비즈니스 문제에 어떤 도구가 가장 적합한가"**의 문제입니다.

1. 작은 프로젝트라면 PostgreSQL 하나로 충분합니다
2. 트래픽이 증가하면 Redis를 추가하여 캐싱합니다
3. 검색이 필요하면 Elasticsearch를 추가합니다
4. 대규모 로그가 쌓이면 MongoDB나 Cassandra를 고려합니다

**점진적으로 확장**하는 것이 가장 현실적이고 안전한 전략입니다.

# Reference

---

- [PostgreSQL 공식 문서 - JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [PostgreSQL 공식 문서 - GIN Indexes](https://www.postgresql.org/docs/current/gin-intro.html)
- [MongoDB 공식 문서 - Transactions](https://www.mongodb.com/docs/manual/core/transactions/)
- [MongoDB 공식 문서 - Aggregation Pipeline](https://www.mongodb.com/docs/manual/core/aggregation-pipeline/)
- [MongoDB 공식 문서 - Schema Validation](https://www.mongodb.com/docs/manual/core/schema-validation/)
- [Redis 공식 문서 - Commands](https://redis.io/docs/latest/commands/)
- [CAP Theorem - Wikipedia](https://en.wikipedia.org/wiki/CAP_theorem)
- [Martin Fowler - Polyglot Persistence](https://martinfowler.com/bliki/PolyglotPersistence.html)
