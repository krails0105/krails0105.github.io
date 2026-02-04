---
title: "[Blockchain] UTXO와 As-Of Join - 특정 시점 잔액 조회"
categories:
  - Blockchain
tags:
  - [Blockchain, UTXO, Bitcoin, SparkSQL, DataEngineering]
---

# Introduction

---

비트코인의 UTXO(Unspent Transaction Output) 모델에서 **특정 시점의 잔액**을 구하는 것은 일반적인 SQL로는 어렵습니다.

```
문제: "2024년 1월 1일 00:00 기준 지갑 A의 잔액은?"
→ 해당 시점까지의 모든 입금/출금 이력을 추적해야 함
```

# 1. UTXO 모델 이해

---

## UTXO란?

```
UTXO = 아직 사용되지 않은 트랜잭션 출력

지갑 A의 잔액 = A가 가진 모든 UTXO의 합
```

## 예시

```
TX1: 채굴 보상 → A에게 50 BTC (UTXO #1 생성)
TX2: A → B에게 10 BTC
     - UTXO #1 소비 (50 BTC)
     - UTXO #2 생성 (B에게 10 BTC)
     - UTXO #3 생성 (A에게 40 BTC, 거스름돈)

A의 현재 잔액 = UTXO #3 = 40 BTC
```

## 테이블 구조

```sql
-- UTXO 테이블
CREATE TABLE utxos (
    txid STRING,           -- 트랜잭션 ID
    vout INT,              -- 출력 인덱스
    address STRING,        -- 소유 주소
    value DECIMAL(20,8),   -- BTC 금액
    created_at TIMESTAMP,  -- 생성 시점 (블록 타임)
    spent_at TIMESTAMP,    -- 소비 시점 (NULL이면 미소비)
    spent_txid STRING      -- 소비한 트랜잭션 ID
);
```

# 2. 특정 시점 잔액 조회

---

## 기본 쿼리

```sql
-- 현재 잔액 (간단)
SELECT address, SUM(value) as balance
FROM utxos
WHERE spent_at IS NULL
GROUP BY address;

-- 특정 시점 잔액 (복잡)
SELECT address, SUM(value) as balance
FROM utxos
WHERE created_at <= '2024-01-01 00:00:00'
  AND (spent_at IS NULL OR spent_at > '2024-01-01 00:00:00')
GROUP BY address;
```

## 조건 설명

```
특정 시점 T의 UTXO:
1. T 이전에 생성됨 (created_at <= T)
2. T 시점에 아직 소비 안 됨 (spent_at IS NULL OR spent_at > T)
```

# 3. As-Of Join (Spark)

---

## 문제: 가격 데이터 결합

```
UTXO 테이블: 트랜잭션 시점의 BTC 수량
Price 테이블: 분/시간별 BTC 가격

→ 각 UTXO 생성 시점의 USD 가치는?
```

## As-Of Join 개념

```
UTXO 생성: 2024-01-01 10:15:30
Price 데이터: 10:00, 10:15, 10:30에 존재

→ 10:15:30 이전 가장 가까운 가격 = 10:15 가격 사용
```

## Spark SQL 구현

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, max as spark_max

spark = SparkSession.builder.getOrCreate()

# 윈도우 기반 As-Of Join
utxos_with_price = spark.sql("""
    SELECT
        u.*,
        p.price,
        u.value * p.price as usd_value
    FROM utxos u
    LEFT JOIN (
        SELECT
            timestamp,
            price,
            LEAD(timestamp) OVER (ORDER BY timestamp) as next_timestamp
        FROM prices
    ) p
    ON u.created_at >= p.timestamp
       AND (u.created_at < p.next_timestamp OR p.next_timestamp IS NULL)
""")
```

## 최적화된 방법

```python
from pyspark.sql.window import Window
from pyspark.sql.functions import last

# Union + Last Value 방식
combined = utxos.select("created_at").union(
    prices.select("timestamp").alias("created_at")
).distinct()

# 가격을 앞으로 채우기 (forward fill)
window = Window.orderBy("created_at").rowsBetween(
    Window.unboundedPreceding, Window.currentRow
)

filled_prices = combined.join(prices, combined.created_at == prices.timestamp, "left") \
    .withColumn("price_filled", last("price", ignorenulls=True).over(window))

# UTXO와 조인
result = utxos.join(
    filled_prices,
    utxos.created_at == filled_prices.created_at
)
```

# 4. 스냅샷 테이블 패턴

---

## 매일 스냅샷 생성

```sql
-- 일별 잔액 스냅샷
CREATE TABLE daily_balances AS
SELECT
    DATE(snapshot_time) as date,
    address,
    SUM(value) as balance
FROM (
    SELECT
        address,
        value,
        created_at,
        spent_at,
        explode(sequence(
            DATE(created_at),
            COALESCE(DATE(spent_at) - INTERVAL 1 DAY, CURRENT_DATE)
        )) as snapshot_time
    FROM utxos
)
GROUP BY DATE(snapshot_time), address;
```

## 스냅샷 사용

```sql
-- 2024-01-01 잔액
SELECT address, balance
FROM daily_balances
WHERE date = '2024-01-01';
```

## 장단점

```
장점:
- 조회 속도 빠름 (사전 계산)
- 쿼리 단순화

단점:
- 저장 공간 증가
- 갱신 비용
- 실시간성 부족
```

# 5. Delta Lake 활용

---

## Time Travel

```python
# Delta Lake의 시간 여행
from delta.tables import DeltaTable

# 특정 시점 데이터 읽기
df = spark.read.format("delta") \
    .option("timestampAsOf", "2024-01-01") \
    .load("/path/to/utxos")

# 버전 기준
df = spark.read.format("delta") \
    .option("versionAsOf", 100) \
    .load("/path/to/utxos")
```

## CDF로 변경 추적

```python
# Change Data Feed 활성화 테이블
changes = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 0) \
    .option("endingVersion", 100) \
    .load("/path/to/utxos")

# _change_type: insert, update_preimage, update_postimage, delete
```

# 6. 최적화 팁

---

## 인덱싱

```sql
-- 파티셔닝 (날짜 기준)
CREATE TABLE utxos (
    ...
)
PARTITIONED BY (created_date DATE);

-- 클러스터링 (주소 기준)
CLUSTER BY address;
```

## 집계 테이블

```sql
-- 주소별 일별 집계
CREATE TABLE address_daily_summary AS
SELECT
    address,
    DATE(created_at) as date,
    COUNT(*) as utxo_count,
    SUM(value) as total_value
FROM utxos
GROUP BY address, DATE(created_at);
```

## 캐싱

```python
# 자주 조회하는 시점 캐싱
snapshot_20240101 = spark.sql("""
    SELECT address, SUM(value) as balance
    FROM utxos
    WHERE created_at <= '2024-01-01'
      AND (spent_at IS NULL OR spent_at > '2024-01-01')
    GROUP BY address
""").cache()
```

# 7. 실전 예제: 고래 추적

---

```sql
-- 특정 시점 상위 100 홀더
WITH balances AS (
    SELECT
        address,
        SUM(value) as balance
    FROM utxos
    WHERE created_at <= '2024-01-01 00:00:00'
      AND (spent_at IS NULL OR spent_at > '2024-01-01 00:00:00')
    GROUP BY address
)
SELECT
    address,
    balance,
    ROUND(balance / (SELECT SUM(balance) FROM balances) * 100, 4) as pct_supply
FROM balances
ORDER BY balance DESC
LIMIT 100;
```

# 8. 체크리스트

---

```
□ UTXO의 created_at/spent_at 시점을 정확히 이해하는가?
□ As-Of Join의 조건을 올바르게 설정했는가?
□ 자주 조회하는 시점은 스냅샷 테이블을 만들었는가?
□ 파티셔닝/클러스터링으로 쿼리를 최적화했는가?
□ Time Travel 기능을 활용할 수 있는가?
```

# Reference

---

- [Bitcoin UTXO Model](https://developer.bitcoin.org/devguide/transactions.html)
- [Spark SQL Window Functions](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-window.html)
- [Delta Lake Time Travel](https://docs.delta.io/latest/delta-batch.html#query-an-older-snapshot-of-a-table-time-travel)
