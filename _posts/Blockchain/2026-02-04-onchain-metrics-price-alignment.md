---
title: "[Blockchain] On-chain 지표와 가격 데이터 정렬 - 시간 동기화"
categories:
  - Blockchain
tags:
  - [Blockchain, OnChain, DataEngineering, TimeAlignment, Analytics]
---

# Introduction

---

On-chain 데이터와 가격 데이터를 결합할 때 **시간 정렬**이 핵심입니다.

```
문제:
- 블록 시간: 불규칙 (비트코인 ~10분, 이더리움 ~12초)
- 가격 데이터: 규칙적 (1분봉, 1시간봉)
→ 두 데이터의 시간을 어떻게 맞출까?
```

# 1. 시간 데이터 특성

---

## 블록체인 시간

```
block_timestamp: 블록 채굴 시점
- 채굴자가 설정 (약간의 조작 가능)
- 이전 블록보다 미래여야 함
- 비트코인: ~10분 간격 (변동 큼)
- 이더리움: ~12초 간격 (비교적 안정)
```

## 거래소 가격 시간

```
OHLCV 데이터:
- open_time: 봉 시작 시각
- close_time: 봉 종료 시각
- 보통 UTC 기준
- 1분/5분/1시간/1일 등
```

## 시간 불일치 예시

```
블록 12345: 2024-01-01 10:15:37
가격 데이터: 10:00, 10:15, 10:30 (15분봉)

→ 블록 시점의 가격 = 10:15봉? 10:30봉?
```

# 2. 정렬 전략

---

## 전략 1: 직전 봉 사용

```sql
-- 블록 시점 직전의 완료된 봉
SELECT
    b.block_number,
    b.block_timestamp,
    p.close as price
FROM blocks b
LEFT JOIN prices p
ON p.close_time <= b.block_timestamp
   AND p.close_time > b.block_timestamp - INTERVAL 1 HOUR
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY b.block_number
    ORDER BY p.close_time DESC
) = 1;
```

## 전략 2: 가장 가까운 봉

```sql
-- 시간 차이가 가장 작은 봉
SELECT
    b.block_number,
    b.block_timestamp,
    p.close as price,
    ABS(UNIX_TIMESTAMP(b.block_timestamp) - UNIX_TIMESTAMP(p.close_time)) as time_diff
FROM blocks b
CROSS JOIN prices p
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY b.block_number
    ORDER BY ABS(UNIX_TIMESTAMP(b.block_timestamp) - UNIX_TIMESTAMP(p.close_time))
) = 1;
```

## 전략 3: 보간 (Interpolation)

```python
import pandas as pd

# 가격 데이터를 블록 시간에 맞춰 보간
prices_df = prices_df.set_index('close_time')
blocks_df['interpolated_price'] = blocks_df['block_timestamp'].apply(
    lambda ts: prices_df['close'].asof(ts)
)
```

## 전략 선택 가이드

| 전략 | 적합한 경우 |
|------|-----------|
| 직전 봉 | 분석 시점에 알 수 있는 정보만 사용 |
| 가장 가까운 봉 | 사후 분석, 정확도 중시 |
| 보간 | 고빈도 데이터, 연속적 가격 필요 |

# 3. 시간 단위 집계

---

## 블록 → 시간 단위

```sql
-- 1시간 단위로 집계
SELECT
    DATE_TRUNC('hour', block_timestamp) as hour,
    COUNT(*) as block_count,
    SUM(tx_count) as total_txs,
    SUM(total_fees) as total_fees
FROM blocks
GROUP BY DATE_TRUNC('hour', block_timestamp);
```

## 시간 기준 조인

```sql
-- 시간 단위로 집계 후 조인
WITH hourly_onchain AS (
    SELECT
        DATE_TRUNC('hour', block_timestamp) as hour,
        SUM(total_fees) as fees
    FROM blocks
    GROUP BY 1
),
hourly_prices AS (
    SELECT
        DATE_TRUNC('hour', close_time) as hour,
        AVG(close) as avg_price,
        SUM(volume) as total_volume
    FROM prices
    GROUP BY 1
)
SELECT
    o.hour,
    o.fees,
    p.avg_price,
    p.total_volume
FROM hourly_onchain o
JOIN hourly_prices p ON o.hour = p.hour;
```

# 4. 타임존 처리

---

## UTC 통일

```python
import pytz

# 모든 시간을 UTC로 통일
def to_utc(ts, tz_name='Asia/Seoul'):
    local_tz = pytz.timezone(tz_name)
    if ts.tzinfo is None:
        ts = local_tz.localize(ts)
    return ts.astimezone(pytz.UTC)
```

## SQL에서 타임존

```sql
-- UTC로 변환
SELECT
    block_timestamp AT TIME ZONE 'UTC' as utc_time,
    block_timestamp AT TIME ZONE 'Asia/Seoul' as kst_time
FROM blocks;

-- 타임존 제거 (naive datetime)
SELECT
    block_timestamp::timestamp as naive_time
FROM blocks;
```

# 5. 지표 계산 예제

---

## MVRV (Market Value to Realized Value)

```sql
-- 실현 가격: 각 UTXO 생성 시점 가격의 가중 평균
WITH realized_value AS (
    SELECT
        SUM(u.value * p.price) as total_realized
    FROM utxos u
    LEFT JOIN prices p
    ON DATE_TRUNC('hour', u.created_at) = DATE_TRUNC('hour', p.close_time)
    WHERE u.spent_at IS NULL
)
SELECT
    current_price * total_supply as market_value,
    total_realized as realized_value,
    (current_price * total_supply) / total_realized as mvrv
FROM realized_value, current_stats;
```

## 활성 주소와 가격 상관관계

```sql
-- 일별 활성 주소 수 vs 가격
WITH daily_active AS (
    SELECT
        DATE(block_timestamp) as date,
        COUNT(DISTINCT from_address) as active_addresses
    FROM transactions
    GROUP BY DATE(block_timestamp)
),
daily_prices AS (
    SELECT
        DATE(close_time) as date,
        AVG(close) as avg_price
    FROM prices
    GROUP BY DATE(close_time)
)
SELECT
    a.date,
    a.active_addresses,
    p.avg_price,
    CORR(a.active_addresses, p.avg_price) OVER (
        ORDER BY a.date
        ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
    ) as rolling_correlation
FROM daily_active a
JOIN daily_prices p ON a.date = p.date;
```

# 6. Spark 구현

---

## As-Of Join

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, expr
from pyspark.sql.window import Window

spark = SparkSession.builder.getOrCreate()

# 블록 데이터
blocks = spark.read.parquet("/data/blocks/")

# 가격 데이터 (정렬 필요)
prices = spark.read.parquet("/data/prices/") \
    .orderBy("close_time")

# 브로드캐스트 조인 (가격 데이터가 작을 때)
from pyspark.sql.functions import broadcast

result = blocks.join(
    broadcast(prices),
    blocks.block_timestamp >= prices.close_time,
    "left"
).groupBy("block_number").agg(
    expr("max_by(price, close_time) as price")
)
```

## Window 기반 정렬

```python
from pyspark.sql.functions import last, lit
from pyspark.sql.window import Window

# 두 데이터 합치기
combined = blocks.select(
    col("block_timestamp").alias("ts"),
    lit("block").alias("source"),
    col("block_number")
).union(
    prices.select(
        col("close_time").alias("ts"),
        lit("price").alias("source"),
        col("close").alias("price")
    )
)

# 시간순 정렬 후 가격을 forward fill
window = Window.orderBy("ts").rowsBetween(
    Window.unboundedPreceding, Window.currentRow
)

filled = combined.withColumn(
    "price_filled",
    last("price", ignorenulls=True).over(window)
)

# 블록만 필터
result = filled.filter(col("source") == "block")
```

# 7. 데이터 품질 검증

---

## 시간 갭 확인

```sql
-- 가격 데이터 갭 확인
SELECT
    close_time,
    LAG(close_time) OVER (ORDER BY close_time) as prev_time,
    TIMESTAMPDIFF(MINUTE, LAG(close_time) OVER (ORDER BY close_time), close_time) as gap_minutes
FROM prices
HAVING gap_minutes > 1  -- 1분봉 기준
ORDER BY gap_minutes DESC;
```

## 시간 범위 불일치

```sql
-- 데이터 범위 확인
SELECT
    'blocks' as source,
    MIN(block_timestamp) as min_time,
    MAX(block_timestamp) as max_time
FROM blocks
UNION ALL
SELECT
    'prices' as source,
    MIN(close_time) as min_time,
    MAX(close_time) as max_time
FROM prices;
```

# 8. 체크리스트

---

```
□ 모든 시간 데이터가 UTC로 통일되어 있는가?
□ 시간 정렬 전략을 명확히 정의했는가?
□ 가격 데이터의 갭/누락을 확인했는가?
□ 데이터 범위가 일치하는가?
□ 타임존 변환이 올바른가?
□ 집계 단위가 분석 목적에 맞는가?
```

# Reference

---

- [Time Series Alignment Strategies](https://pandas.pydata.org/docs/user_guide/timeseries.html)
- [Spark Temporal Joins](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-join.html)
- [CryptoQuant Metrics](https://cryptoquant.com/docs)
- [Glassnode Academy](https://academy.glassnode.com/)
