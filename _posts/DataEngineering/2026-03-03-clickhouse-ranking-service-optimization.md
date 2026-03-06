---
layout: post
title: "[ClickHouse] 실시간 랭킹 서비스를 위한 ClickHouse 도입기 -- 테이블 엔진과 Materialized View 활용"
categories:
  - DataEngineering
tags:
  - ClickHouse
  - OLAP
  - Kafka
  - MaterializedView
  - ReplacingMergeTree
  - AggregatingMergeTree
  - RealTime
  - DataEngineering
  - CDC
date: 2026-03-03
toc: true
toc_sticky: true
---

## 개요

토스증권 데이터 엔지니어 정채문 님의 발표 'ClickHouse로 토스증권 랭킹 서비스 구조 개선하기'를 정리한 글입니다.

이 글에서는 실시간 집계가 필요한 랭킹 서비스를 ClickHouse로 전환하면서 **어떤 문제를 해결했고, 왜 특정 테이블 엔진과 파이프라인 패턴을 선택했는지**를 중심으로 다룹니다. 글을 끝까지 읽으면 다음 내용을 이해할 수 있습니다.

- ClickHouse의 ReplacingMergeTree와 AggregatingMergeTree가 어떤 문제를 풀기 위해 존재하는지
- Materialized View가 실시간 집계 파이프라인에서 어떤 역할을 하는지
- Kafka 엔진과 MaterializedMySQL을 통한 데이터 입수 패턴의 차이

---

## 배경: 기존 랭킹 서비스의 세 가지 문제

토스증권의 랭킹 서비스는 단순한 인기 종목 목록이 아닙니다. 실시간 차트 랭킹, 거래 랭킹, 인기 급상승/급하락, ETF, 채권 등 다양한 종류의 랭킹을 제공하며, 각각의 집계 기준과 주기가 다릅니다. 기존 구조는 세 가지 문제를 안고 있었습니다.

### 1. 실시간성 부족

기존에는 1분 단위 배치로 랭킹을 집계했는데, 비즈니스 요구사항이 초 단위 업데이트로 높아졌습니다. 평균 10~20초가 걸리는 집계 시간이 병목이 되어, 1분 주기 배치로는 초 단위 실시간 랭킹을 만들 수 없었습니다.

### 2. 비즈니스 로직 증가에 따른 Job 선형 증가

새로운 랭킹이 추가될 때마다 집계 Job도 하나씩 늘어나는 구조였습니다. 랭킹 종류가 많아질수록 관리해야 할 Job 수가 선형으로 증가해, 개발과 운영 모두 복잡해졌습니다.

### 3. DW 파이프라인 리소스 경합

분석가들이 데이터 웨어하우스(DW)에서 무거운 집계 쿼리를 실행하면, 랭킹 집계 Job과 리소스를 공유하는 구조였습니다. 분석 쿼리가 몰리는 시간대에는 랭킹 업데이트가 지연되거나 실패하는 문제가 발생했습니다.

---

## ClickHouse를 선택한 이유

ClickHouse는 OLAP(Online Analytical Processing) 특화 **컬럼 기반 데이터베이스**입니다. 행(row) 단위로 저장하는 OLTP DB와 달리, 컬럼 단위로 데이터를 저장하기 때문에 특정 컬럼의 합계/평균/최대값 같은 집계 연산에서 압도적인 읽기 성능을 발휘합니다.

랭킹 서비스에 ClickHouse가 선택된 핵심 이유는 두 가지입니다.

1. **대용량 집계에 특화된 성능**: 수억 건의 로그 데이터에서 그룹별 집계를 수백 밀리초 내에 처리합니다.
2. **다양한 테이블 엔진과 Materialized View**: 실시간 파이프라인을 DB 레이어에서 직접 구성할 수 있습니다. Kafka로부터 데이터를 받고, 집계하고, 최신 상태를 유지하는 로직을 SQL로 선언적으로 정의할 수 있다는 점이 기존 배치 Job 방식의 대안이 되었습니다.

---

## 실시간 데이터 입수 패턴

랭킹 서비스의 핵심은 데이터를 얼마나 빠르게 ClickHouse에 넣느냐입니다. 데이터 원본의 성격에 따라 두 가지 경로가 사용됩니다.

### 패턴 1: Kafka 엔진을 통한 스트림 데이터 입수

ClickHouse는 **Kafka 엔진 테이블**을 제공합니다. Kafka 토픽을 ClickHouse 테이블처럼 정의해두면, ClickHouse가 내부적으로 Kafka Consumer를 실행하여 메시지를 소비합니다. 여기에 Materialized View를 연결하면, 소비한 메시지를 실제 저장 테이블(예: MergeTree)로 자동 INSERT하는 파이프라인이 완성됩니다.

```sql
-- 1) Kafka 엔진 테이블: Kafka 토픽을 ClickHouse 테이블로 매핑
CREATE TABLE kafka_stock_events
(
    stock_code String,
    price      Float64,
    volume     UInt64,
    event_time DateTime
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list = 'broker:9092',
    kafka_topic_list = 'stock-events',
    kafka_group_name = 'clickhouse-consumer',
    kafka_format = 'JSONEachRow';

-- 2) 저장 테이블: 실제 데이터가 쌓이는 MergeTree 테이블
CREATE TABLE stock_events
(
    stock_code String,
    price      Float64,
    volume     UInt64,
    event_time DateTime
)
ENGINE = MergeTree()
ORDER BY (stock_code, event_time);

-- 3) Materialized View: Kafka 테이블 → 저장 테이블 자동 연결
CREATE MATERIALIZED VIEW kafka_to_stock_events TO stock_events AS
SELECT *
FROM kafka_stock_events;
```

발표에서는 Kafka 엔진으로 초당 60만 건 입수를 확인했다고 합니다.

다만 Kafka 엔진 방식은 ClickHouse 내부에서 Consumer를 관리하기 때문에, Consumer의 리소스 격리나 독립 관리가 어려웠습니다. 이를 해결하기 위해 토스증권에서는 **ClickHouse Sync Connect**라는 별도 컴포넌트를 자체 개발하여, Kafka Consumer를 ClickHouse 바깥에서 독립적으로 운영했습니다.

```
[Kafka 엔진 방식]
Kafka Topic → ClickHouse Kafka 엔진 (내부 Consumer) → Materialized View → MergeTree

[자체 개발 방식]
Kafka Topic → ClickHouse Sync Connect (외부 Consumer) → INSERT → MergeTree
```

### 패턴 2: MaterializedMySQL을 통한 CDC 실시간 복제

주식 메타정보나 관심 종목 랭킹처럼 MySQL에 원본이 있는 데이터는, ClickHouse의 **MaterializedMySQL 엔진**을 사용하여 실시간 복제했습니다.

MaterializedMySQL은 **데이터베이스 레벨 엔진**입니다. 테이블 단위가 아니라 MySQL 데이터베이스 전체를 ClickHouse 데이터베이스로 복제합니다. MySQL의 binlog를 읽어 INSERT/UPDATE/DELETE를 ClickHouse 쪽에 자동으로 반영합니다.

```sql
-- MaterializedMySQL: MySQL DB 전체를 ClickHouse로 실시간 복제
CREATE DATABASE mysql_replica
ENGINE = MaterializedMySQL('mysql_host:3306', 'source_db', 'user', 'password');
```

> **참고**: MaterializedMySQL은 현재(2026년 3월 기준) Experimental 기능입니다. 프로덕션 도입 시 안정성과 제약 사항을 반드시 확인해야 합니다.

---

## 테이블 엔진과 Materialized View: 랭킹 집계의 핵심

데이터가 ClickHouse에 들어왔다면, 다음은 집계입니다. ClickHouse에서 랭킹 집계를 빠르게 만드는 두 가지 핵심 테이블 엔진을 살펴봅니다.

### ReplacingMergeTree: 최신 상태만 유지하기

**ReplacingMergeTree**는 같은 정렬 키(`ORDER BY` 컬럼)를 가진 중복 행을 백그라운드 병합(merge) 시 자동으로 제거하여, 최신 버전만 남기는 엔진입니다.

> **정렬 키와 Primary Key의 관계**: ClickHouse에서 `ORDER BY`는 데이터의 물리적 정렬 순서를 정의하며, ReplacingMergeTree에서는 이 정렬 키가 중복 판별 기준이 됩니다. `PRIMARY KEY`를 별도로 지정하지 않으면 `ORDER BY`와 동일하게 설정됩니다. 두 개념이 같아 보이지만, `PRIMARY KEY`는 `ORDER BY`의 접두사(prefix)만 될 수 있다는 차이가 있습니다.

**사용 사례 -- 급상승/급하락 랭킹**: 종목별로 최신 시세만 필요하고 이전 시세는 불필요합니다. `ORDER BY`에 종목 코드를 두고, `version` 컬럼으로 최신 행을 판별하면 됩니다.

```sql
-- ReplacingMergeTree: version 컬럼이 가장 큰 행만 최종적으로 남음
CREATE TABLE stock_latest_price
(
    stock_code String,
    price      Float64,
    updated_at DateTime,
    version    UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY stock_code;
```

**왜 빠른가**: 물리적으로 저장된 데이터 양이 줄어듭니다. 전체 이력에서 중복 제거 후 집계하는 것보다, 처음부터 최신 행만 유지하면 집계 시 읽어야 할 데이터 양 자체가 줄어듭니다.

**주의: 비동기 병합과 FINAL 키워드**

백그라운드 병합은 비동기로 이루어지기 때문에, **병합이 완료되기 전에는 동일 정렬 키를 가진 중복 행이 존재할 수 있습니다**. 이는 ReplacingMergeTree가 "최종적 일관성(eventual correctness)"을 보장한다는 의미입니다.

따라서 정확한 결과가 필요한 쿼리에서는 다음 두 가지 방법 중 하나를 사용해야 합니다.

```sql
-- 방법 1: FINAL 키워드 — 쿼리 시점에 논리적 병합을 강제 실행
-- 정확하지만 대용량 데이터에서는 성능 비용이 있음
SELECT stock_code, price
FROM stock_latest_price
FINAL
ORDER BY price DESC
LIMIT 10;

-- 방법 2: argMax 함수 — version이 가장 큰 행의 값을 직접 추출
-- FINAL보다 유연하게 사용 가능
SELECT
    stock_code,
    argMax(price, version) AS latest_price
FROM stock_latest_price
GROUP BY stock_code
ORDER BY latest_price DESC
LIMIT 10;
```

> **Replicated 접두사**: 복수 노드 클러스터 환경에서는 `ReplicatedReplacingMergeTree`를 사용하여 노드 간 데이터 복제를 추가합니다. 단일 노드라면 `ReplacingMergeTree`만으로 충분합니다.

### AggregatingMergeTree + Materialized View: 쿼리 비용을 INSERT 시점에 선불 처리

**AggregatingMergeTree**는 집계 함수의 **중간 상태(Intermediate State)**를 저장하는 엔진입니다. `sum`, `count`, `avg`, `uniqExact` 같은 집계 연산의 최종 결과가 아니라, 나중에 다른 중간 상태와 병합(merge)할 수 있는 형태로 저장합니다.

왜 중간 상태가 필요할까요? 새로운 데이터가 들어올 때마다 전체 원시 데이터를 처음부터 다시 집계하는 대신, **기존 중간 상태에 새 데이터의 중간 상태를 합치기만 하면 되기 때문**입니다.

**Materialized View**는 원본 테이블에 데이터가 INSERT될 때 자동으로 실행되는 **트리거 역할**을 합니다. 원본 테이블 INSERT --> Materialized View의 SELECT 쿼리 실행 --> 결과를 대상 테이블(AggregatingMergeTree)에 INSERT하는 파이프라인이 선언적으로 정의됩니다.

**사용 사례 -- 거래 랭킹, 인기 랭킹**: 수억 건의 로그 데이터에서 집계해야 합니다. 매 랭킹 조회마다 전체 로그를 스캔하면 너무 느립니다. 대신 로그가 들어올 때마다 Materialized View가 중간 집계 상태를 AggregatingMergeTree에 누적합니다.

```sql
-- 1) 집계 결과를 저장할 AggregatingMergeTree 테이블
--    컬럼 타입에 AggregateFunction을 사용하여 중간 상태를 저장
CREATE TABLE trade_ranking_daily
(
    trade_date  Date,
    stock_code  String,
    total_volume AggregateFunction(sum, UInt64),
    trade_count  AggregateFunction(count, UInt64)
)
ENGINE = AggregatingMergeTree()
ORDER BY (trade_date, stock_code);

-- 2) Materialized View: 원시 로그 INSERT 시 자동으로 집계 상태 누적
--    -State 접미사 함수를 사용하여 중간 상태를 생성
CREATE MATERIALIZED VIEW trade_ranking_mv TO trade_ranking_daily AS
SELECT
    toDate(event_time) AS trade_date,
    stock_code,
    sumState(volume)   AS total_volume,
    countState()       AS trade_count
FROM stock_events
GROUP BY trade_date, stock_code;

-- 3) 랭킹 조회: -Merge 접미사 함수로 중간 상태를 최종 결과로 변환
SELECT
    stock_code,
    sumMerge(total_volume)  AS total_volume,
    countMerge(trade_count) AS trade_count
FROM trade_ranking_daily
WHERE trade_date = today()
GROUP BY stock_code
ORDER BY total_volume DESC
LIMIT 20;
```

> **`-State`와 `-Merge` 패턴**: AggregatingMergeTree를 사용할 때는 반드시 이 쌍을 기억해야 합니다. INSERT 시에는 `sumState()`, `countState()` 등 `-State` 접미사 함수로 중간 상태를 생성하고, 조회 시에는 `sumMerge()`, `countMerge()` 등 `-Merge` 접미사 함수로 최종 결과를 추출합니다.

이 구조의 핵심은 **쿼리 비용의 시점 이동**입니다. 무거운 집계 연산을 조회 시점이 아니라 INSERT 시점에 미리 수행해두기 때문에, 랭킹 조회 쿼리는 이미 사전 집계된 작은 테이블만 읽으면 됩니다.

```
[데이터 흐름]
원시 로그 테이블 (수억 건)
    --> INSERT 발생
    --> Materialized View 트리거 (-State 함수로 중간 상태 생성)
    --> AggregatingMergeTree 집계 테이블 (중간 상태 누적)
    --> 랭킹 쿼리 (-Merge 함수로 최종 결과 조회, 200~300ms)
```

이 구조로 쿼리 시간이 평균 **600ms에서 200~300ms**로 단축되었습니다.

---

## 최종 아키텍처와 개선 효과

두 테이블 엔진과 Materialized View를 조합한 최종 구조를 정리하면 다음과 같습니다.

```
[실시간 이벤트 소스]
  Kafka Topic / MySQL binlog
      |
      v
[데이터 입수 레이어]
  ClickHouse Sync Connect (Kafka)  |  MaterializedMySQL (CDC)
      |
      v
[원시 데이터 레이어]
  MergeTree 테이블 (로그, 시세, 메타정보)
      |
      v  (Materialized View 트리거)
[집계 레이어]
  AggregatingMergeTree (거래/인기 랭킹)  |  ReplacingMergeTree (급상승/급하락)
      |
      v
[서비스 레이어]
  실시간 랭킹 API (초 단위 업데이트)
```

수치로 정리한 개선 효과입니다.

| 항목 | 이전 | 이후 |
|------|------|------|
| 랭킹 집계 시간 | 10~20초 | 200~300ms |
| 업데이트 주기 | 1분 배치 | 초 단위 실시간 |
| Job 관리 | 랭킹별 개별 Job | Materialized View 선언 |
| 서비스 안정성 | DW 분석 쿼리와 리소스 경합 | 분리된 독립 환경 |

DW 파이프라인과 서비스용 ClickHouse를 분리한 덕분에, 분석가들의 무거운 쿼리가 랭킹 서비스에 영향을 주지 않는 안정적인 구조를 확보했습니다.

---

## 정리: ClickHouse 테이블 엔진 선택 기준

이번 사례에서 얻을 수 있는 테이블 엔진 선택 기준을 정리합니다.

| 요구사항 | 엔진 선택 | 핵심 원리 |
|----------|-----------|-----------|
| 최신 상태만 유지 | ReplacingMergeTree | 정렬 키 기준 중복 제거, version 컬럼으로 최신 행 판별 |
| 실시간 집계 누적 | AggregatingMergeTree + Materialized View | `-State`/`-Merge` 패턴으로 중간 상태 저장 및 병합 |
| Kafka 스트림 입수 | Kafka 엔진 + Materialized View (또는 외부 Consumer) | ClickHouse가 직접 Kafka Consumer 역할 수행 |
| MySQL 실시간 동기화 | MaterializedMySQL (DB 엔진) | binlog 기반 CDC, 데이터베이스 단위 복제 |

### 도입 시 주의 사항

- **ReplacingMergeTree의 비동기 병합**: 병합 전에는 중복 행이 존재합니다. 정확한 결과가 필요하면 `FINAL` 키워드 또는 `argMax` 패턴을 사용해야 합니다.
- **AggregatingMergeTree의 `-State`/`-Merge` 쌍**: INSERT와 SELECT에서 반드시 짝이 맞아야 합니다. `-State` 없이 일반 집계 함수를 쓰면 중간 상태가 아닌 최종값이 저장되어 이후 병합이 올바르게 동작하지 않습니다.
- **MaterializedMySQL의 실험적 상태**: 프로덕션 도입 전 안정성과 지원 범위를 반드시 확인해야 합니다.
- **Kafka 엔진의 리소스 관리**: ClickHouse 내부 Consumer는 ClickHouse 프로세스와 리소스를 공유합니다. 대규모 환경에서는 외부 Consumer 분리를 검토할 필요가 있습니다.

실시간 집계가 필요한 서비스에서 ClickHouse의 테이블 엔진과 Materialized View 조합은 강력한 선택지입니다. 다만 각 엔진의 동작 원리를 정확히 이해하고 사용해야 의도치 않은 결과를 피할 수 있습니다.

---

## Reference

- 발표: 'ClickHouse로 토스증권 랭킹 서비스 구조 개선하기', 정채문, 토스증권
- [ClickHouse 공식 문서 - Table Engines](https://clickhouse.com/docs/en/engines/table-engines)
- [ClickHouse - ReplacingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree)
- [ClickHouse - AggregatingMergeTree](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/aggregatingmergetree)
- [ClickHouse - Materialized Views](https://clickhouse.com/docs/en/sql-reference/statements/create/view#materialized-view)
- [ClickHouse - MaterializedMySQL](https://clickhouse.com/docs/en/engines/database-engines/materialized-mysql)
- [ClickHouse - Kafka Table Engine](https://clickhouse.com/docs/en/integrations/data-ingestion/kafka/kafka-table-engine)
