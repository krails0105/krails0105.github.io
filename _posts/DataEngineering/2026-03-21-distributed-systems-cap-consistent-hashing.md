---
title: "[DataEngineering] 분산 시스템 기초 -- CAP 정리, Consistent Hashing, SCD Type 4"
categories:
  - DataEngineering
tags:
  - 분산시스템
  - CAP
  - Consistent Hashing
  - SCD
  - Data Warehouse
date: 2026-03-21
---

### 개요

분산 시스템을 설계하거나 기술 면접을 준비할 때 반드시 등장하는 개념 세 가지가 있다. 데이터베이스가 네트워크 장애에서 어떻게 행동해야 하는지를 설명하는 **CAP 정리**, 서버를 수평 확장할 때 데이터를 균등하게 분산하는 **Consistent Hashing**, 그리고 데이터 웨어하우스에서 변경 이력을 효율적으로 관리하는 **SCD Type 4**다.

이 글을 읽고 나면 다음을 이해할 수 있다.

- CAP 정리에서 실질적인 선택지가 CP vs AP인 이유
- Consistent Hashing이 일반 해싱 대비 서버 증설 시 데이터 재배치를 최소화하는 원리
- SCD Type 4가 Type 2 대비 현재값 조회 성능에서 유리한 구조적 이유

---

### 사전 지식

- 분산 시스템에서 노드(Node)와 네트워크 파티션(Network Partition)의 기본 개념
- 해시 함수(Hash Function)의 역할 (입력값을 고정 길이 값으로 변환)
- 데이터 웨어하우스에서 팩트 테이블(Fact Table)과 차원 테이블(Dimension Table)의 관계

---

### 1. CAP 정리

#### 개념

CAP 정리는 분산 시스템이 다음 세 가지 속성을 **동시에 모두 보장할 수 없다**는 이론이다. 2000년 Eric Brewer가 제안하고 2002년 Seth Gilbert와 Nancy Lynch가 증명했다.

| 속성 | 설명 |
|------|------|
| **C -- Consistency (일관성)** | 모든 노드가 항상 동일한 최신 데이터를 반환한다 |
| **A -- Availability (가용성)** | 장애가 발생해도 모든 요청에 응답을 반환한다 |
| **P -- Partition Tolerance (분할 허용성)** | 네트워크가 분리되어도 시스템이 계속 동작한다 |

세 속성 중 최대 두 개만 동시에 만족할 수 있다.

#### P는 사실상 필수

실제 분산 시스템에서 네트워크 단절은 피할 수 없다. 서버 간 케이블 장애, 데이터센터 간 네트워크 지연 등은 반드시 발생한다. 따라서 P(분할 허용성)는 포기할 수 없는 조건이고, 실질적인 선택은 **CP vs AP**다.

이 점이 CAP 정리를 이해하는 핵심이다. "세 가지 중 두 개를 고르는 문제"라기보다 **"네트워크 파티션이 발생했을 때 일관성과 가용성 중 무엇을 우선하는가"**의 문제다.

**CP 시스템 -- 일관성 우선**

네트워크가 분리되면 일관성을 지키기 위해 서비스를 거부한다. 데이터 정합성이 최우선인 금융 거래, 재고 관리 시스템에 적합하다.

```
서울 노드와 부산 노드의 네트워크가 끊김
→ 부산 노드: "현재 데이터가 최신인지 확인 불가 → 요청 거부"
→ 일관성은 보장, 가용성은 포기
```

**AP 시스템 -- 가용성 우선**

네트워크가 분리되어도 일단 응답한다. 나중에 데이터를 동기화해서 맞춘다(Eventual Consistency). SNS 피드, 장바구니, 검색 랭킹처럼 잠시 오래된 데이터를 보여줘도 괜찮은 서비스에 적합하다.

```
서울 노드와 부산 노드의 네트워크가 끊김
→ 부산 노드: "일단 응답은 함 (오래된 데이터일 수 있음)"
→ 네트워크 복구 후 데이터 동기화
→ 가용성은 보장, 일관성은 일시적으로 포기
```

#### Eventual Consistency

AP 시스템에서 등장하는 개념으로, "지금 당장은 아니지만 결국에는 모든 노드가 동일한 데이터를 갖게 된다"는 보장이다. 완전한 불일관이 아니라 시간이 지나면 정합성이 맞춰진다는 의미다.

Eventual Consistency는 단순히 "언젠간 맞겠지"가 아니다. 시스템에 따라 수렴 시간(convergence time)이 수 밀리초에서 수 초 사이로 관리된다. 예를 들어 DynamoDB는 보통 1초 이내에 모든 복제본이 동기화된다.

#### 주요 시스템 분류

| 시스템 | 분류 | 이유 |
|--------|------|------|
| PostgreSQL, MySQL | CP | 트랜잭션 ACID 보장, 네트워크 단절 시 쓰기 거부 |
| Cassandra, DynamoDB | AP | 멀티 리전 분산, 가용성 우선 설계 |
| Kafka | CP | 파티션 리더 선출, 일관성 우선 |
| Redis Cluster | AP | 노드 장애 시 일단 응답, 나중에 복제 |

> **주의: 위 분류는 기본 설정 기준이다.** 실제로는 시스템 설정에 따라 달라질 수 있다. 예를 들어 Cassandra는 `consistency_level`을 `QUORUM`이나 `ALL`로 설정하면 CP에 가깝게 동작하고, PostgreSQL도 비동기 복제(async replication)를 쓰면 AP에 가까워진다. CAP 분류는 절대적이 아니라 시스템의 기본 설계 방향을 나타낸다.

#### 실무 선택 기준

- **데이터 정합성이 비즈니스 크리티컬**한 경우 → CP (금융, 결제, 재고)
- **서비스 무중단이 정합성보다 중요**한 경우 → AP (SNS, 추천, 검색)
- 두 속성이 모두 중요한 경우 → 기능별로 분리하여 적용 (예: 결제는 CP, 상품 추천은 AP)

---

### 2. Consistent Hashing

#### 일반 해싱의 문제

서버가 N대일 때 `hash(key) % N`으로 데이터를 분산하는 방식이 일반 해싱이다. 단순하지만 치명적인 단점이 있다.

```
서버 10대: hash(key) % 10 → key 1은 서버 3에 저장
서버 11대로 증가: hash(key) % 11 → key 1은 서버 7로 이동!
```

서버 1대가 추가되면 기존 키의 약 91%가 다른 서버로 재배치된다. 캐시 서버라면 대규모 Cache Miss가 발생하고(이른바 Cache Stampede), DB라면 데이터 마이그레이션 비용이 엄청나다.

#### Consistent Hashing 원리

Consistent Hashing은 1997년 David Karger 등이 제안한 알고리즘으로, 원형 링(ring) 위에 서버와 키를 함께 배치한다. 키는 **시계방향으로 가장 가까운 서버**에 저장된다.

```
           [Server A]
          /          \
   [Key 3]            [Server B]
          \                |
           [Key 1]         |
                \          |
                 [Server C]
                     |
                 [Key 2]
```

서버 D를 Server B와 Server C 사이에 추가하면, Key 2만 Server D로 이동한다. 나머지 키는 그대로다.

**일반 해싱 vs Consistent Hashing 비교 (10대 → 11대)**

| 방식 | 재배치 비율 | 키 1만 개 기준 이동 수 |
|------|------------|----------------------|
| 일반 해싱 (`hash % N`) | 약 91% | 약 9,100개 |
| Consistent Hashing | 약 9% (= `1/N`) | 약 900개 |

일반 해싱의 재배치 비율이 91%인 이유를 좀 더 구체적으로 보면, 10대에서 11대로 변경 시 `hash(key) % 10`과 `hash(key) % 11`의 결과가 동일한 키는 전체의 약 `1/11` (약 9%)뿐이기 때문이다. Consistent Hashing에서는 새 서버가 담당하게 되는 링 구간의 키만 이동하므로 평균 `K/N`개(K: 전체 키 수, N: 서버 수)만 재배치된다.

#### Virtual Node로 균등 분배

서버가 3대뿐이면 링에서 특정 서버 구간이 넓어 데이터가 편중될 수 있다. **Virtual Node**는 서버 1대를 여러 개의 가상 노드로 분산해 링에 배치하는 방식이다. 실무에서는 서버당 100~200개의 가상 노드를 사용한다.

```
Server A → A_1, A_2, A_3 ... A_150 (링에 150곳에 배치)
Server B → B_1, B_2, B_3 ... B_150
Server C → C_1, C_2, C_3 ... C_150
```

서버가 추가/제거될 때도 각 서버가 링 전체에 고르게 분산되어 있어 데이터 이동량이 균등해진다.

Virtual Node의 개수는 트레이드오프가 있다. 너무 적으면 데이터 편중이 발생하고, 너무 많으면 라우팅 테이블의 메모리 사용량이 증가한다. 일반적으로 100~200개가 균형점이다.

#### 주의사항: 핫스팟 문제

Consistent Hashing이 데이터를 균등하게 분산한다고 해서 **부하(load)까지 균등해지는 것은 아니다.** 특정 키가 극단적으로 많은 요청을 받으면(핫키), 해당 키가 배치된 서버에 부하가 집중된다. 이 경우 키 자체를 분할하거나(예: `key_1`, `key_2`로 샤딩) 별도 캐시 계층을 두는 방법이 필요하다.

#### 사용처

| 시스템 | 활용 방식 |
|--------|----------|
| Cassandra, DynamoDB | 분산 DB의 파티션 키 라우팅 |
| Redis Cluster | 16,384개의 해시 슬롯을 노드에 분배 |
| CDN | 요청을 가장 가까운 엣지 서버로 라우팅 |
| 로드밸런서 | 세션 기반 일관 라우팅 (같은 사용자는 항상 같은 서버로) |

---

### 3. SCD Type 4 (Slowly Changing Dimension)

#### SCD란?

데이터 웨어하우스에서 차원 테이블(Dimension Table)의 값이 시간이 지남에 따라 변경될 때 이를 어떻게 처리할지에 대한 전략이다. Ralph Kimball이 체계화한 개념으로, 예를 들어 고객의 주소나 등급이 바뀌면, 이전 값을 유지할지 덮어쓸지 결정해야 한다.

#### Type 1~4 비교

| 타입 | 전략 | 이력 보존 | 특징 |
|------|------|-----------|------|
| **Type 1** | 덮어쓰기 | 없음 | 단순, 이력 불필요할 때 |
| **Type 2** | 같은 테이블에 행 추가 | 전체 | `is_current`, `valid_from`, `valid_to` 컬럼 사용 |
| **Type 3** | 이전값 컬럼 추가 | 직전 1회 | 컬럼 수 증가, 한 단계 이전만 추적 |
| **Type 4** | 이력 테이블 분리 | 전체 | 현재 테이블 + 이력 테이블 분리 |

#### Type 4 구조

```sql
-- 현재 상태만 저장 (항상 1 row per customer)
-- dim_customer
CREATE TABLE dim_customer (
    customer_id   BIGINT PRIMARY KEY,
    name          VARCHAR(100),
    email         VARCHAR(200),
    tier          VARCHAR(20),   -- 'BRONZE', 'SILVER', 'GOLD'
    updated_at    TIMESTAMP
);

-- 모든 변경 이력 저장
-- dim_customer_history
CREATE TABLE dim_customer_history (
    history_id    BIGINT PRIMARY KEY,
    customer_id   BIGINT,
    name          VARCHAR(100),
    email         VARCHAR(200),
    tier          VARCHAR(20),
    valid_from    TIMESTAMP,
    valid_to      TIMESTAMP
);
```

현재 고객 정보를 조회할 때는 `dim_customer`만 JOIN한다. 특정 시점의 고객 정보가 필요할 때만 `dim_customer_history`를 조회한다.

#### Type 2 vs Type 4 -- 언제 무엇을 선택하나?

**Type 2의 문제점**

현재값과 이력이 같은 테이블에 섞여 있어, 현재 고객만 조회하려면 항상 `WHERE is_current = true` 필터가 필요하다. 고객 수가 많고 변경이 자주 발생할수록 테이블 row가 기하급수적으로 증가하고, 다른 테이블과 JOIN할 때 성능이 저하된다.

```sql
-- Type 2: 현재 고객 조회 시 항상 필터 필요
SELECT * FROM dim_customer
JOIN fact_orders ON dim_customer.customer_id = fact_orders.customer_id
WHERE dim_customer.is_current = true;  -- 인덱스가 없으면 풀 스캔 위험
```

**Type 4의 장점**

`dim_customer`는 항상 1 row per entity. 현재값 조회 시 추가 필터 없이 바로 JOIN 가능하다.

```sql
-- Type 4: 현재 고객 조회 -- 깔끔한 JOIN
SELECT * FROM dim_customer
JOIN fact_orders ON dim_customer.customer_id = fact_orders.customer_id;

-- 이력 조회는 별도 테이블에서
SELECT * FROM dim_customer_history
WHERE customer_id = 1001
  AND valid_from <= '2025-06-01'
  AND valid_to > '2025-06-01';
```

**Type 4의 단점**

Type 4가 항상 정답은 아니다. 현재값과 이력을 동시에 조회해야 하는 경우 두 테이블을 JOIN해야 하므로 쿼리가 복잡해진다. 또한 데이터 변경 시 두 테이블을 모두 업데이트해야 하므로 ETL 로직이 Type 2보다 복잡해진다.

#### 선택 기준

| 상황 | 권장 타입 | 이유 |
|------|-----------|------|
| 현재값 조회가 압도적으로 많고, 이력 조회는 가끔 | Type 4 | 현재 테이블이 작아 JOIN 성능 우수 |
| 이력 조회가 현재값 조회만큼 자주 발생 | Type 2 | 단일 테이블에서 시점 조회 가능 |
| 이력 보존이 전혀 필요 없음 | Type 1 | 가장 단순, 덮어쓰기 |
| 직전 값과의 비교만 필요 | Type 3 | 컬럼 추가로 해결, 테이블 증가 없음 |

---

### 정리

| 개념 | 핵심 | 트레이드오프 |
|------|------|-------------|
| CAP 정리 | P는 필수 → 실제 선택은 CP(일관성) vs AP(가용성) | 일관성 vs 가용성 |
| Consistent Hashing | 서버 추가/제거 시 최소한의 키만 재배치, Virtual Node로 균등 분배 | Virtual Node 수 vs 메모리 사용량 |
| SCD Type 4 | 현재 테이블은 1 row per entity 유지, 이력은 분리 테이블로 관리 | 조회 성능 vs ETL 복잡도 |

세 개념 모두 **확장성(Scalability)과 일관성(Consistency) 사이의 트레이드오프**를 다루고 있다. 시스템을 설계할 때 어떤 속성이 더 중요한지 먼저 정의하고, 그에 맞는 패턴을 선택하는 것이 핵심이다.

---

### Reference

- [CAP Theorem - Wikipedia](https://en.wikipedia.org/wiki/CAP_theorem) -- Eric Brewer의 원래 정리와 Gilbert-Lynch 증명
- [Consistent Hashing - Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing) -- Karger et al. (1997) 원본 논문 기반 설명
- [Slowly Changing Dimensions - Wikipedia](https://en.wikipedia.org/wiki/Slowly_changing_dimension) -- Ralph Kimball의 SCD 분류 체계
- [Brewer's CAP Theorem (2012 revisit)](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/) -- Brewer 본인이 12년 후 CAP을 재해석한 글
