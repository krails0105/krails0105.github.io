---
layout: post
title: "[ClickHouse] ClickHouse 기초 완전 정리 — 아키텍처, 테이블 엔진, Materialized View"
categories:
  - DataEngineering
tags:
  - ClickHouse
  - OLAP
  - MergeTree
  - MaterializedView
  - DataEngineering
  - 컬럼기반DB
date: 2026-03-03
toc: true
toc_sticky: true
---

## 개요

ClickHouse를 처음 접하는 데이터 엔지니어와 백엔드 개발자를 위한 기초 정리 글입니다. "왜 ClickHouse인가?"라는 질문에서 시작하여 핵심 아키텍처, 테이블 엔진 선택 기준, Materialized View 활용 패턴까지 실무에서 필요한 개념을 중심으로 다룹니다.

---

## 1. ClickHouse란?

ClickHouse는 **OLAP(Online Analytical Processing) 용도로 설계된 컬럼 지향(Column-oriented) SQL DBMS**입니다. 오픈소스와 클라우드 버전 모두 제공되며, 수십억 행 규모의 집계 쿼리를 밀리초 단위로 처리하는 것이 목표입니다.

공식 문서의 벤치마크에 따르면 1억 행 집계를 약 92밀리초(초당 약 10억 행)에 처리합니다.

### OLTP vs OLAP — MySQL/PostgreSQL과 무엇이 다른가?

ClickHouse를 이해하는 가장 빠른 방법은 익숙한 RDB와 비교하는 것입니다.

| 구분 | OLTP (MySQL, PostgreSQL) | OLAP (ClickHouse) |
|---|---|---|
| 주요 워크로드 | 단건 트랜잭션 (INSERT/UPDATE/DELETE) | 대규모 집계, 분석 쿼리 |
| 스토리지 구조 | 행(Row) 기반 | 컬럼(Column) 기반 |
| 읽기 단위 | 행 전체 | 필요한 컬럼만 |
| 쓰기 성능 | 빠름 (트랜잭션 지원) | 배치 INSERT에 최적화 |
| UPDATE/DELETE | 효율적 | 느림 (Mutation) |
| 트랜잭션 | ACID 지원 | 제한적 (롤백 불가) |
| JOIN | 효율적 (B-Tree 인덱스) | 큰 테이블 JOIN은 비효율적 |
| 인덱스 방식 | Dense B-Tree | Sparse Index (그래뉼 단위) |

### 컬럼 기반 스토리지가 빠른 이유

행 기반 DB는 `(id, name, age, price, ...)` 형태로 한 행씩 연속으로 저장합니다. `SELECT sum(price) FROM orders`를 실행하면 `price`만 필요한데도 모든 컬럼을 디스크에서 읽어야 합니다.

컬럼 기반은 `price` 컬럼의 값들이 디스크에 연속으로 배치되어 있습니다. 같은 쿼리를 실행하면 `price` 컬럼 데이터만 로드하면 됩니다. 또한 같은 타입의 데이터가 연속으로 있으면 압축률도 훨씬 높아집니다.

```
행 기반:  [id=1, name=A, price=100], [id=2, name=B, price=200], ...
컬럼 기반: [id: 1,2,3,...], [name: A,B,C,...], [price: 100,200,300,...]
```

### ClickHouse가 적합한 워크로드

- 대용량 로그 분석 (웹 액세스 로그, 앱 이벤트 로그)
- 시계열 데이터 집계 (모니터링 메트릭, 금융 데이터)
- 실시간 대시보드 및 리포팅
- 사용자 행동 분석, 퍼널 분석

### ClickHouse가 부적합한 워크로드

- 빈번한 단건 UPDATE/DELETE (회원 정보 변경 등)
- ACID 트랜잭션이 필요한 결제, 재고 관리
- 복잡한 다중 테이블 JOIN 쿼리
- 소규모 데이터 (수만 건 이하)

---

## 2. 핵심 아키텍처 — MergeTree 엔진 패밀리

ClickHouse의 핵심은 **MergeTree 엔진 패밀리**입니다. 대부분의 실무 테이블은 이 엔진 중 하나를 사용합니다.

### 파트(Part)와 백그라운드 머지(Merge)

MergeTree를 이해하려면 먼저 데이터가 어떻게 저장되는지 알아야 합니다.

1. INSERT가 실행되면 데이터는 **파트(Part)** 단위로 디스크에 기록됩니다. 각 파트는 내부적으로 ORDER BY 기준으로 정렬된 상태입니다.
2. 파트가 쌓이면 ClickHouse는 **백그라운드에서 파트들을 머지(Merge)** 합니다. 머지 시점에 중복 제거, 합산, 집계 등 엔진별 처리가 일어납니다.
3. 머지는 ClickHouse가 자율적으로 수행하므로 **언제 일어날지 보장할 수 없습니다**.

이 비동기 머지 특성이 ClickHouse 특유의 동작 방식을 만들어냅니다.

### 그래뉼(Granule)과 Sparse Index

ClickHouse는 B-Tree 인덱스 대신 **Sparse Index(희소 인덱스)** 를 사용합니다. 모든 행을 인덱싱하는 B-Tree와 달리, 기본 8,192행마다 인덱스 엔트리 하나를 생성합니다. 이 8,192행 단위를 **그래뉼(Granule)** 이라고 합니다.

```
행 0~8191     → 인덱스 엔트리 1
행 8192~16383 → 인덱스 엔트리 2
행 16384~...  → 인덱스 엔트리 3
...
```

수십억 행 테이블도 인덱스 크기는 수 MB에 불과하여 메모리에 상주시킬 수 있습니다. 쿼리 실행 시 이진 탐색으로 관련 그래뉼만 읽기 때문에 빠릅니다.

### PRIMARY KEY vs ORDER BY — ClickHouse에서는 다릅니다

MySQL에서는 PRIMARY KEY가 곧 정렬 순서이자 인덱스입니다. ClickHouse에서는 이 둘이 분리되어 있습니다.

| 구분 | 역할 |
|---|---|
| `ORDER BY` | 데이터의 물리적 정렬 순서를 결정. 반드시 지정해야 함 |
| `PRIMARY KEY` | 어떤 컬럼에 인덱스를 생성할지 결정. 생략하면 ORDER BY와 동일 |

`PRIMARY KEY`는 `ORDER BY`의 prefix여야 합니다. 예를 들어 `ORDER BY (user_id, event_date)`이면 `PRIMARY KEY (user_id)`는 유효하지만 `PRIMARY KEY (event_date)`는 유효하지 않습니다.

실무에서 이 둘을 분리하는 이유는 **SummingMergeTree, AggregatingMergeTree처럼 ORDER BY에 많은 컬럼을 두되, 실제 인덱스는 일부 컬럼에만 생성하고 싶을 때**입니다.

---

## 3. MergeTree 엔진 종류와 선택 기준

### MergeTree (기본)

가장 기본 엔진입니다. 특별한 자동 처리 없이 삽입된 데이터를 ORDER BY 순으로 정렬하여 저장합니다.

```sql
-- stock-info 예시: 종목별 일별 가격 데이터
CREATE TABLE stock_prices (
    symbol   String,
    trade_date Date,
    close    Float64,
    volume   UInt64
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(trade_date)
ORDER BY (symbol, trade_date);
```

### ReplacingMergeTree (중복 제거)

ORDER BY 키가 동일한 중복 행을 머지 시점에 제거합니다. 최신 상태만 유지하고 싶을 때 사용합니다. `ver` 파라미터로 어떤 행을 "최신"으로 볼지 기준 컬럼을 지정할 수 있습니다.

```sql
-- 사용자의 최신 프로필 상태 유지
CREATE TABLE user_profiles (
    user_id  UInt64,
    name     String,
    updated_at DateTime
) ENGINE = ReplacingMergeTree(updated_at)  -- updated_at이 가장 큰 행 유지
ORDER BY user_id;
```

**주의:** 중복 제거는 머지 시점에만 발생합니다. 머지가 아직 안 된 파트에는 중복이 남아 있을 수 있습니다. 정확한 결과가 필요하면 쿼리에 `FINAL` 키워드를 붙입니다.

```sql
-- FINAL: 쿼리 시점에 중복을 즉시 제거하여 정확한 결과 반환
SELECT * FROM user_profiles FINAL WHERE user_id = 12345;
```

### SummingMergeTree (자동 합산)

ORDER BY 키가 동일한 행들의 숫자 컬럼을 머지 시점에 자동으로 합산합니다. 집계 테이블에 주로 사용됩니다.

```sql
-- 종목별 일별 거래량 집계
CREATE TABLE daily_volume (
    symbol     String,
    trade_date Date,
    volume     UInt64   -- 같은 symbol+trade_date의 volume을 자동 합산
) ENGINE = SummingMergeTree()
ORDER BY (symbol, trade_date);
```

**주의:** 머지 전에는 합산이 불완전할 수 있습니다. 쿼리 시 반드시 `sum(volume) GROUP BY` 패턴으로 조회합니다.

```sql
SELECT symbol, trade_date, sum(volume) AS total_volume
FROM daily_volume
GROUP BY symbol, trade_date;
```

### AggregatingMergeTree (사전 집계)

SummingMergeTree보다 일반화된 집계 엔진입니다. `sum` 외에도 `uniq`, `avg`, `quantile` 등 다양한 집계 함수의 상태(State)를 저장하고 머지 시 합칩니다. Materialized View의 타겟 테이블로 주로 사용됩니다.

```sql
-- 종목별 일별 집계 (복수의 지표 관리)
CREATE TABLE daily_stats (
    symbol      String,
    trade_date  Date,
    volume_sum  AggregateFunction(sum, UInt64),
    price_avg   AggregateFunction(avg, Float64),
    trade_count AggregateFunction(count)
) ENGINE = AggregatingMergeTree()
ORDER BY (symbol, trade_date);

-- 삽입 시 -State 함수 사용
INSERT INTO daily_stats
SELECT symbol, trade_date,
    sumState(volume)    AS volume_sum,
    avgState(close)     AS price_avg,
    countState()        AS trade_count
FROM stock_prices
GROUP BY symbol, trade_date;

-- 조회 시 -Merge 함수 사용
SELECT symbol, trade_date,
    sumMerge(volume_sum)    AS total_volume,
    avgMerge(price_avg)     AS avg_price,
    countMerge(trade_count) AS trades
FROM daily_stats
GROUP BY symbol, trade_date;
```

### CollapsingMergeTree (상태 변경 추적)

UPDATE 없이 상태 변경을 추적하는 엔진입니다. `Sign = 1`(현재 상태)과 `Sign = -1`(이전 상태 취소) 두 행을 쌍으로 삽입하면, 머지 시 쌍이 상쇄되어 최신 상태만 남습니다.

```sql
-- 사용자 세션 상태 추적
CREATE TABLE user_sessions (
    session_id String,
    user_id    UInt64,
    page_views UInt32,
    duration   UInt32,
    Sign       Int8   -- 1: 현재 상태, -1: 취소
) ENGINE = CollapsingMergeTree(Sign)
ORDER BY session_id;

-- 초기 상태
INSERT INTO user_sessions VALUES ('s1', 101, 3, 120, 1);

-- 상태 변경: 이전 상태 취소 + 새 상태 삽입
INSERT INTO user_sessions VALUES ('s1', 101, 3, 120, -1);  -- 취소
INSERT INTO user_sessions VALUES ('s1', 101, 5, 200, 1);   -- 새 상태
```

### 엔진 선택 기준 요약

| 엔진 | 사용 목적 | 주요 특징 |
|---|---|---|
| MergeTree | 범용 저장 | 특별한 자동 처리 없음 |
| ReplacingMergeTree | 최신 상태 유지, 중복 제거 | 머지 시 중복 제거. FINAL 필요 |
| SummingMergeTree | 간단한 합산 집계 | 숫자 컬럼 자동 합산 |
| AggregatingMergeTree | 복합 집계, MV 타겟 | -State/-Merge 함수 쌍으로 사용 |
| CollapsingMergeTree | 상태 변경 추적 | Sign 컬럼으로 취소/신규 쌍 삽입 |

---

## 4. Materialized View

### 일반 View와의 차이

| 구분 | 일반 View | Materialized View |
|---|---|---|
| 결과 저장 | 저장 안 함 (쿼리 실행 시마다 계산) | 별도 테이블에 저장 |
| SELECT 속도 | 원본 테이블 풀스캔 | 사전 집계된 결과 조회 |
| 데이터 최신성 | 항상 최신 | 삽입 시점에만 갱신 |
| 기존 데이터 | 항상 반영 | 반영 안 됨 (INSERT 이후만) |

### INSERT 트리거로 동작하는 원리

ClickHouse의 Materialized View는 **소스 테이블에 INSERT가 발생할 때마다 실행되는 트리거**입니다. 삽입된 데이터 블록에만 정의된 쿼리를 실행하고 결과를 타겟 테이블에 저장합니다.

```
소스 테이블 INSERT
    ↓
Materialized View 트리거 실행 (삽입된 블록에만 적용)
    ↓
타겟 테이블 (SummingMergeTree / AggregatingMergeTree)에 결과 저장
    ↓
타겟 테이블 백그라운드 머지 → 최종 집계 완성
```

### 실시간 집계 활용 패턴

```sql
-- 1. 소스 테이블 (raw 데이터)
CREATE TABLE raw_events (
    user_id    UInt64,
    event_type String,
    event_time DateTime,
    value      Float64
) ENGINE = MergeTree()
ORDER BY (user_id, event_time);

-- 2. 타겟 테이블 (집계 결과 저장)
CREATE TABLE hourly_stats (
    event_hour DateTime,
    event_type String,
    cnt        AggregateFunction(count),
    total      AggregateFunction(sum, Float64)
) ENGINE = AggregatingMergeTree()
ORDER BY (event_hour, event_type);

-- 3. Materialized View (INSERT 트리거)
CREATE MATERIALIZED VIEW hourly_stats_mv TO hourly_stats AS
SELECT
    toStartOfHour(event_time) AS event_hour,
    event_type,
    countState()              AS cnt,
    sumState(value)           AS total
FROM raw_events
GROUP BY event_hour, event_type;

-- 4. 조회 (집계 완성)
SELECT
    event_hour,
    event_type,
    countMerge(cnt)   AS event_count,
    sumMerge(total)   AS total_value
FROM hourly_stats
GROUP BY event_hour, event_type
ORDER BY event_hour DESC;
```

공식 문서 기준으로 이 패턴은 2억 3천 8백만 행을 5,700개 행으로 압축하여 쿼리 속도를 **약 25배** 단축시켰습니다.

### Materialized View 주의사항

1. **기존 데이터에는 적용되지 않습니다.** MV는 생성 이후 발생하는 INSERT에만 반응합니다. 이미 소스 테이블에 있는 데이터는 타겟 테이블에 반영되지 않으므로, 기존 데이터는 수동으로 백필(backfill)해야 합니다.

    ```sql
    -- MV 생성 후 기존 데이터 백필
    INSERT INTO hourly_stats
    SELECT
        toStartOfHour(event_time) AS event_hour,
        event_type,
        countState()              AS cnt,
        sumState(value)           AS total
    FROM raw_events
    GROUP BY event_hour, event_type;
    ```

2. **타겟 테이블의 ORDER BY와 GROUP BY를 일치시켜야 합니다.** 불일치하면 머지가 제대로 집계를 합치지 못합니다.

3. **MV 자체를 `SELECT`하지 않습니다.** MV는 트리거 역할을 하는 객체이고, 실제 조회는 타겟 테이블에 합니다.

---

## 5. 데이터 입수(Ingestion) 패턴

| 패턴 | 기술 | 적합한 상황 | 주의사항 |
|---|---|---|---|
| 스트리밍 | Kafka 엔진 + MV | 실시간 이벤트 스트림 | Kafka 엔진은 SELECT 불가. MV와 반드시 조합 |
| CDC | MaterializedMySQL / MaterializedPostgreSQL | OLTP DB 변경사항 동기화 | 실험적 기능, 프로덕션 적용 전 검증 필요 |
| 배치 | INSERT INTO ... SELECT | 주기적 데이터 이관, 집계 | 대용량 배치에는 파티션 단위로 분할 권장 |

### Kafka 엔진 + Materialized View 패턴

Kafka 엔진 테이블은 카프카 토픽을 소비하는 인터페이스 역할만 합니다. 직접 SELECT하면 메시지가 소비되어 재조회가 불가합니다. 반드시 Materialized View와 조합하여 실제 저장 테이블로 흘려보내는 구조로 사용합니다.

```sql
-- 1. Kafka 엔진 테이블 (인터페이스 역할)
CREATE TABLE kafka_events (
    user_id    UInt64,
    event_type String,
    event_time DateTime
) ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'broker:9092',
    kafka_topic_list  = 'user-events',
    kafka_group_name  = 'clickhouse-consumer',
    kafka_format      = 'JSONEachRow';

-- 2. 실제 저장 테이블
CREATE TABLE events (
    user_id    UInt64,
    event_type String,
    event_time DateTime
) ENGINE = MergeTree()
ORDER BY (user_id, event_time);

-- 3. Kafka → 저장 테이블 연결 MV
CREATE MATERIALIZED VIEW events_mv TO events AS
SELECT user_id, event_type, event_time
FROM kafka_events;
```

---

## 6. 실무에서 자주 만나는 주의사항

### 비동기 머지와 FINAL 키워드

ReplacingMergeTree, SummingMergeTree 등은 모두 **머지 시점에 집계/중복 제거가 일어납니다.** 방금 INSERT한 데이터는 아직 머지 전 파트에 있으므로 쿼리 결과가 부정확할 수 있습니다.

- `OPTIMIZE TABLE 테이블명 FINAL` — 수동으로 머지를 강제 실행. 프로덕션에서는 사용을 삼가야 합니다.
- `SELECT ... FINAL` — 쿼리 시점에 머지 결과를 계산. 정확하지만 성능 비용이 있습니다.

### Mutation(ALTER TABLE UPDATE/DELETE)이 느린 이유

ClickHouse에서 `ALTER TABLE ... UPDATE`나 `ALTER TABLE ... DELETE`는 **Mutation**이라는 비동기 작업으로 처리됩니다. 기존 파트 전체를 재작성하기 때문에 단건 UPDATE도 전체 파트를 새로 씁니다. 이 때문에:

- **빈번한 UPDATE/DELETE는 ClickHouse에 적합하지 않습니다.**
- 최신 버전의 `DELETE FROM ... WHERE` (Lightweight Delete)는 행을 즉시 숨기는 방식으로 더 빠르지만, 완전한 물리 삭제는 역시 비동기 머지 이후입니다.
- 소프트 삭제(is_deleted 컬럼 추가)나 ReplacingMergeTree를 활용하는 패턴이 더 적합합니다.

### 분산 테이블(Distributed) 사용 시 주의점

멀티 노드 환경에서 Distributed 엔진은 쿼리를 여러 샤드에 분산하여 실행합니다.

- Distributed 테이블에 INSERT하면 ClickHouse가 sharding_key에 따라 각 샤드로 데이터를 전송합니다. 이 전송은 백그라운드 비동기로 처리되므로 장애 시 데이터 유실 가능성을 고려해야 합니다.
- 일반적으로 **각 샤드의 로컬 테이블에 직접 INSERT하고 Distributed 테이블은 조회용으로만 사용하는 패턴**이 더 안정적입니다.
- 새 샤드 추가 시 기존 데이터는 자동으로 재분산되지 않습니다.

### 적절한 파티셔닝과 ORDER BY 설계

```sql
-- 좋은 예: 월별 파티션 + 쿼리 필터 컬럼 순으로 ORDER BY
CREATE TABLE logs (
    service    String,
    log_time   DateTime,
    level      String,
    message    String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(log_time)   -- 월별 파티션 (파티션 단위 DROP 가능)
ORDER BY (service, log_time);     -- 주요 필터 컬럼을 앞에

-- 나쁜 예: 과도한 파티션 분할
PARTITION BY toDate(log_time)     -- 일별 파티션 → 파트 수 폭증, 머지 비용 급증
```

**ORDER BY 컬럼 순서 원칙:**
1. `WHERE`절에서 등호(`=`)로 필터링하는 컬럼을 앞에 배치합니다.
2. 낮은 카디널리티 컬럼을 높은 카디널리티 컬럼보다 앞에 배치하면 압축률이 좋아집니다.
3. 범위 필터링(`BETWEEN`, `>`, `<`)에 사용하는 컬럼은 등호 필터 컬럼 뒤에 배치합니다.

---

## 7. OLTP DB와의 핵심 차이 요약

| 항목 | OLTP (MySQL/PostgreSQL) | ClickHouse |
|---|---|---|
| INSERT 성능 | 단건 빠름 | 배치 INSERT에 최적화 (최소 1,000행 권장) |
| SELECT (집계) | 느림 (행 스캔) | 매우 빠름 (컬럼 스캔, 사전 집계) |
| UPDATE/DELETE | 효율적 | 느림 (Mutation, 파트 재작성) |
| 트랜잭션 | ACID 완전 지원 | 없음 (롤백 불가) |
| 인덱스 방식 | Dense B-Tree (행마다 인덱스) | Sparse Index (8,192행당 1개) |
| JOIN 성능 | 효율적 | 대형 테이블 JOIN은 비효율적 |
| 스키마 변경 | 빠름 | ALTER 일부는 비동기/느림 |
| 주요 사용 사례 | 트랜잭션, CRUD | 로그 분석, 집계, 대시보드 |

---

## 마치며

ClickHouse를 처음 접하면 MySQL/PostgreSQL과 겉모습(SQL 문법)이 비슷해서 같은 방식으로 사용하려다 당황하는 경우가 많습니다. 핵심은 **"ClickHouse는 쓰기 패턴보다 읽기 집계 성능을 위해 설계된 DB"** 라는 관점의 전환입니다.

- UPDATE/DELETE 대신 새로운 행 삽입 + ReplacingMergeTree/CollapsingMergeTree로 최신 상태를 관리한다
- 집계 쿼리 속도가 필요하면 Materialized View + AggregatingMergeTree로 사전 집계한다
- 실시간 스트림이 필요하면 Kafka 엔진 + Materialized View를 조합한다

이 세 가지 패턴을 익히면 ClickHouse 실무의 70%는 커버됩니다.

---

## Reference

- [ClickHouse 공식 문서 - Introduction](https://clickhouse.com/docs/en/intro)
- [ClickHouse 공식 문서 - MergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/mergetree)
- [ClickHouse 공식 문서 - ReplacingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)
- [ClickHouse 공식 문서 - SummingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/summingmergetree)
- [ClickHouse 공식 문서 - AggregatingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/aggregatingmergetree)
- [ClickHouse 공식 문서 - CollapsingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/collapsingmergetree)
- [ClickHouse 공식 문서 - Incremental Materialized View](https://clickhouse.com/docs/en/materialized-view/incremental-materialized-view)
- [ClickHouse 공식 문서 - Kafka Engine](https://clickhouse.com/docs/en/engines/table-engines/integrations/kafka)
- [ClickHouse 공식 문서 - Sparse Primary Indexes](https://clickhouse.com/docs/en/optimize/sparse-primary-indexes)
- [ClickHouse 공식 문서 - Distributed Engine](https://clickhouse.com/docs/en/engines/table-engines/special/distributed)
- [ClickHouse 공식 문서 - Mutations](https://clickhouse.com/docs/en/guides/developer/mutations)
