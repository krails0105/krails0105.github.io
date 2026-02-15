---
title: "[Spark] 복잡한 금융 메트릭 파이프라인의 CTE 레이어 분리 전략"
categories:
  - StockInfo
tags:
  - [Spark, SQL, CTE, Databricks, 리팩토링]
---

# Introduction

---

Bitcoin Market Metrics Spark 노트북 3개를 리팩토링하면서 SQL CTE(Common Table Expression) 레이어 간 관심사 분리 원칙을 적용한 경험을 공유합니다. 복잡한 금융 지표 계산 파이프라인을 어떻게 명확한 계층으로 구조화할 수 있는지, 실전 코드를 통해 살펴봅니다.

# 배경 (Problem & Context)

---

## 대규모 블록체인 메트릭 계산

비트코인 온체인 분석에는 다양한 금융 지표가 필요합니다:
- **SOPR** (Spent Output Profit Ratio): 실현 손익 비율
- **CDD** (Coin Days Destroyed): 코인 보유 기간 가중치
- **MVRV** (Market Value to Realized Value): 시장가치 대비 실현가치 배율
- **NRPL** (Net Realized Profit/Loss): 순실현손익

이런 지표들을 계산하려면 여러 데이터 소스를 결합해야 합니다:
```
utxo_events_block (UTXO 생성/소비 이벤트) ─┐
price_df (블록별 가격/타임스탬프)          ├─→ 32개 메트릭 산출
btc_utxo_block_metrics (공급량/미실현 손익) ─┤
network_block (네트워크 데이터)            ─┘
```

기존 Python 코드는 블록을 순차적으로 처리하며 누적값을 유지했지만, 이를 Spark SQL로 전환하면서 **Window Function 기반 prefix sum**으로 재설계했습니다. 그 과정에서 SQL 쿼리가 5개의 CTE와 복잡한 final SELECT로 구성되었고, 로직의 명확한 계층화가 필요해졌습니다.

## 초기 구조의 문제점

리팩토링 전에는 다음과 같은 혼란이 있었습니다:
1. **타입 변환이 여러 곳에 흩어짐**: STXO 컬럼을 `block_base`에서 COALESCE만 하고, `final SELECT`에서 CAST
2. **파생 비율 계산 위치 불명확**: NRPL을 `block_base`에서 계산할지, `final SELECT`에서 할지 일관성 없음
3. **테이블/View 참조 혼재**: `{EVENTS_TABLE}` 같은 placeholder와 실제 temp view 이름 혼용

# 접근 방법 (Approach)

---

## 설계 원칙: SQL CTE 레이어별 역할 분리

복잡한 SQL을 다룰 때는 각 CTE가 **단일 책임**을 가져야 코드를 이해하고 수정하기 쉽습니다. 다음과 같은 5단계 레이어로 구조화했습니다:

```sql
spent_metrics CTE       → 원시 이벤트 집계 (UTXO 소비)
    ↓
realized_delta CTE      → 원시 이벤트 집계 (realized_cap 변화량)
    ↓
block_base CTE          → 모든 소스 JOIN + 원시값 준비 (COALESCE, CAST 완료)
    ↓
with_cumulative CTE     → Window Function으로 prefix sum 계산
    ↓
final SELECT            → 파생 비율 계산 (MVRV, SOPR, NRPL 등)
```

각 레이어의 **명확한 역할 정의**:
- **CTE 1-2**: 원시 데이터를 블록별로 집계 (GROUP BY)
- **CTE 3 (block_base)**: 데이터 조합 + 타입 변환 완료 (NULL 처리, CAST)
- **CTE 4 (with_cumulative)**: 수학적 누적 계산 (window functions)
- **final SELECT**: 비율/파생 지표만 계산

## 관심사 분리의 구체적 적용

### 1. 원시 데이터 타입 변환은 block_base에서 완료

**Before** (타입 변환이 2곳에 분산):
```sql
block_base AS (
    SELECT
        COALESCE(s.stxo_sum_at_created_price, 0) AS stxo_sum_at_created_price,
        -- 6개 더...
    FROM ...
)

-- Final SELECT에서 다시 CAST
SELECT
    CAST(stxo_sum_at_created_price AS DECIMAL(22,8)),
    CAST(stxo_sum_at_spent_price AS DECIMAL(22,8)),
    -- 6개 더...
```

**After** (타입 변환을 데이터 준비 단계에 통합):
```sql
block_base AS (
    SELECT
        -- COALESCE + CAST를 한 번에 완료
        CAST(COALESCE(s.stxo_sum_at_created_price, 0) AS DECIMAL(22,8)) AS stxo_sum_at_created_price,
        CAST(COALESCE(s.stxo_sum_at_spent_price, 0) AS DECIMAL(22,8)) AS stxo_sum_at_spent_price,
        -- 6개 더...
    FROM ...
)

-- Final SELECT는 단순 passthrough
SELECT
    stxo_sum_at_created_price,  -- 이미 올바른 타입
    stxo_sum_at_spent_price,
    ...
```

**왜 이렇게?** STXO는 **원시 데이터**입니다. "데이터 준비" 단계인 `block_base`에서 타입까지 확정하면, 이후 단계에서는 이 값들을 신뢰하고 사용만 하면 됩니다.

### 2. NRPL을 final SELECT로 이동

**Before** (원시값 조합 단계에서 파생 비율 계산):
```sql
block_base AS (
    SELECT
        ...,
        -- NRPL = (1 - 1/sopr) * tx_volume_usd
        CASE WHEN s.stxo_sum_at_created_price > 0
            THEN (1 - DOUBLE(s.stxo_sum_at_created_price) / s.stxo_sum_at_spent_price)
                 * n.tokens_transferred_total * p.price
            ELSE NULL END AS nrpl
    FROM ...
)
```

**After** (파생 비율 계산을 final SELECT로):
```sql
block_base AS (
    SELECT
        ...,
        -- 원시값만: tokens_transferred_total, price
        n.tokens_transferred_total,
        p.price
    FROM ...
)

-- Final SELECT에서 파생 비율 계산
SELECT
    ...,
    /* ---- NRPL: (1 - 1/sopr) * tx_volume_usd ---- */
    CAST(CASE WHEN stxo_sum_at_created_price > 0 AND stxo_sum_at_spent_price > 0
        THEN (1.0 - DOUBLE(stxo_sum_at_created_price) / DOUBLE(stxo_sum_at_spent_price))
             * DOUBLE(tokens_transferred_total) * price
        ELSE NULL END AS DECIMAL(22,8)) AS nrpl
FROM with_cumulative
```

**왜 이렇게?** NRPL은 **STXO에서 파생된 지표**입니다. SOPR(= stxo_spent / stxo_created)를 변형한 값이므로, SOPR, MVRV, NVT 같은 다른 비율 지표와 **동일한 레이어**에 있어야 논리적입니다. `block_base`는 "원시 데이터 조합"이고, `final SELECT`는 "파생 지표 계산"이라는 역할 분리가 명확해집니다.

### 3. NVT를 block 단위에서도 계산

**Before**:
```sql
SELECT
    NULL AS nvt,  -- block level에서는 항상 NULL
```

**After**:
```sql
SELECT
    CAST(market_cap / NULLIF(DOUBLE(tokens_transferred_total) * price, 0)
         AS DECIMAL(20,8)) AS nvt,
```

**왜 이렇게?** 기존 Python 로직은 day/hour 단위에서만 NVT를 계산했습니다(노이즈가 크기 때문). 하지만 Spark에서는 **raw data로서 block 단위 NVT도 계산**하는 것이 합리적입니다:
- 저장 비용이 거의 없고
- 향후 연구자가 block-level NVT를 분석할 수 있으며
- 계산 자체는 단순 나눗셈이라 부담 없음

# 구현 (Key Code & Commands)

---

## 1. 변수명 통일: Databricks 실행 환경 맞춤

Databricks multi-task job에서는 upstream task가 생성한 temp view를 downstream task가 재사용합니다. Standalone 실행에서는 직접 테이블을 읽어 view를 등록해야 합니다.

```python
# notebooks/market_metrics.py

# Widget에서 테이블 경로 읽기
EVENTS_TABLE = f"{catalog}.{schema}.utxo_events_block"
METRICS_TABLE = f"{catalog}.{schema}.btc_utxo_block_metrics"
NETWORK_TABLE = f"{catalog}.{schema}.network_block"

# Register source views section (모든 노트북에 추가)
# Multi-task job: upstream이 이미 생성한 view 재사용
# Standalone: 직접 테이블에서 view 생성
spark.read.table(EVENTS_TABLE).createOrReplaceTempView("utxo_event_df")
spark.read.table(METRICS_TABLE).createOrReplaceTempView("utxo_statistics_df")
spark.read.table(NETWORK_TABLE).createOrReplaceTempView("network_df")
```

SQL 쿼리에서는 **고정된 view 이름** 사용:
```sql
FROM utxo_event_df e
LEFT JOIN utxo_statistics_df a1 ON p.block_height = a1.block_height
LEFT JOIN network_df n ON p.block_height = n.block_height
```

**장점**:
- Multi-task job에서 `createOrReplaceTempView()`는 이미 존재하는 view를 덮어쓰므로 idempotent
- Standalone 실행도 동일한 코드로 작동
- 테스트/프로덕션 전환이 widget 파라미터만으로 가능

## 2. CTE 레이어 구조화

전체 쿼리를 Python 함수로 생성하여 history/incremental 모드 양쪽 지원:

```python
# notebooks/market_metrics.py

def build_market_query(events_table, price_table, metrics_table, network_table,
                       start_block, end_block, seed_values=None):
    """Build the full market metrics SQL query.

    Args:
        seed_values: dict with keys {realized_cap, thermo_cap, mc_sum, sa_cdd_sum}
                     for incremental mode. None for history build.
    """

    # Incremental mode: 이전 블록의 누적값을 seed로 주입
    if seed_values:
        rc  = seed_values["realized_cap"]
        tc  = seed_values["thermo_cap"]
        mcs = seed_values["mc_sum"]
        scs = seed_values["sa_cdd_sum"]
        cumulative_cte = f"""
    with_cumulative AS (
        SELECT *,
            DOUBLE({rc})  + SUM(delta_realized_cap) OVER w  AS realized_cap,
            (DOUBLE({mcs}) + SUM(market_cap) OVER w) / DOUBLE(block_height + 1) AS average_cap,
            DOUBLE({tc})  + SUM(COALESCE(block_reward_usd, 0)) OVER w AS thermo_cap,
            (DOUBLE({scs}) + SUM(supply_adjusted_cdd) OVER w) / DOUBLE(block_height + 1) AS average_sa_cdd
        FROM block_base
        WINDOW w AS (ORDER BY block_height ROWS UNBOUNDED PRECEDING)
    )"""
    else:
        # History mode: 처음부터 계산
        cumulative_cte = """
    with_cumulative AS (
        SELECT *,
            SUM(delta_realized_cap) OVER w AS realized_cap,
            SUM(market_cap) OVER w / DOUBLE(block_height + 1) AS average_cap,
            SUM(COALESCE(block_reward_usd, 0)) OVER w AS thermo_cap,
            SUM(supply_adjusted_cdd) OVER w / DOUBLE(block_height + 1) AS average_sa_cdd
        FROM block_base
        WINDOW w AS (ORDER BY block_height ROWS UNBOUNDED PRECEDING)
    )"""

    query = f"""
    WITH
    -- CTE 1: spent_metrics (UTXO 소비 이벤트 집계)
    spent_metrics AS (
        SELECT
            e.event_block_height AS block_height,
            CAST(SUM(-e.delta_value * GREATEST(p.timestamp - e.created_timestamp, 0) / 86400.0)
                AS DECIMAL(22,8)) AS cdd,
            CAST(SUM(-e.delta_realized) AS DECIMAL(22,8)) AS stxo_sum_at_created_price,
            CAST(SUM(-e.delta_value * p.price) AS DECIMAL(22,8)) AS stxo_sum_at_spent_price,
            -- adjusted (>= 1h = 3600s), short (1h~155d), long (>=155d) ...
        FROM {events_table} e
        JOIN {price_table} p ON e.event_block_height = p.block_height
        WHERE e.delta_count < 0  -- spent events only
          AND e.event_block_height BETWEEN {start_block} AND {end_block}
        GROUP BY e.event_block_height
    ),

    -- CTE 2: realized_delta (realized_cap 변화량)
    realized_delta AS (
        SELECT
            event_block_height AS block_height,
            SUM(delta_realized) AS delta_realized_cap
        FROM {events_table}
        WHERE event_block_height BETWEEN {start_block} AND {end_block}
        GROUP BY event_block_height
    ),

    -- CTE 3: block_base (모든 소스 JOIN + 원시값 준비)
    block_base AS (
        SELECT
            p.block_height,
            p.datetime,
            p.price,

            -- A-1 테이블 (공급량 + 미실현 손익)
            a1.unspent_utxo_total_supply AS supply_total,
            a1.unrealized_profit_total,
            a1.unrealized_loss_total,

            -- Network 테이블
            n.block_reward_usd,
            n.tokens_transferred_total,

            -- 파생 원시값
            DOUBLE(a1.unspent_utxo_total_supply) * p.price AS market_cap,
            COALESCE(s.cdd, 0) AS cdd,
            COALESCE(DOUBLE(s.cdd), 0) / NULLIF(DOUBLE(a1.unspent_utxo_total_supply), 0) AS supply_adjusted_cdd,
            COALESCE(r.delta_realized_cap, 0) AS delta_realized_cap,

            -- STXO 8컬럼 (COALESCE + CAST 완료)
            CAST(COALESCE(s.stxo_sum_at_created_price, 0) AS DECIMAL(22,8)) AS stxo_sum_at_created_price,
            CAST(COALESCE(s.stxo_sum_at_spent_price, 0) AS DECIMAL(22,8)) AS stxo_sum_at_spent_price,
            -- ... 6개 더

        FROM {price_table} p
        LEFT JOIN spent_metrics s ON p.block_height = s.block_height
        LEFT JOIN realized_delta r ON p.block_height = r.block_height
        LEFT JOIN {metrics_table} a1 ON p.block_height = a1.block_height
        LEFT JOIN {network_table} n ON p.block_height = n.block_height
        WHERE p.block_height BETWEEN {start_block} AND {end_block}
    ),

    -- CTE 4: with_cumulative (prefix sum window functions)
    {cumulative_cte}

    -- Final SELECT: 파생 비율 계산
    SELECT
        block_height,
        datetime,

        /* ---- Cap metrics (누적값 사용) ---- */
        CAST(market_cap   AS DECIMAL(22,8)) AS market_cap,
        CAST(realized_cap AS DECIMAL(22,8)) AS realized_cap,
        CAST(average_cap  AS DECIMAL(22,8)) AS average_cap,
        CAST(thermo_cap   AS DECIMAL(22,8)) AS thermo_cap,

        /* ---- 파생 비율 (MVRV, realized_price, delta_cap) ---- */
        CAST(market_cap / NULLIF(realized_cap, 0) AS DECIMAL(20,8)) AS mvrv,
        CAST(realized_cap / NULLIF(DOUBLE(supply_total), 0) AS DECIMAL(22,8)) AS realized_price,
        CAST(realized_cap - average_cap AS DECIMAL(22,8)) AS delta_cap,

        /* ---- NUPL/NUP/NUL ---- */
        CAST(CASE WHEN market_cap != 0
            THEN (market_cap - realized_cap) / market_cap
            ELSE NULL END AS DECIMAL(10,8)) AS nupl,
        CAST(CASE WHEN market_cap != 0
            THEN DOUBLE(unrealized_profit_total) / market_cap
            ELSE NULL END AS DECIMAL(10,8)) AS nup,
        CAST(CASE WHEN market_cap != 0
            THEN DOUBLE(unrealized_loss_total) / market_cap
            ELSE NULL END AS DECIMAL(10,8)) AS nul,

        /* ---- NVT (block level에서도 계산) ---- */
        CAST(market_cap / NULLIF(DOUBLE(tokens_transferred_total) * price, 0)
             AS DECIMAL(20,8)) AS nvt,

        /* ---- CDD family ---- */
        CAST(cdd AS DECIMAL(22,8)) AS cdd,
        CAST(supply_adjusted_cdd AS DECIMAL(22,8)) AS supply_adjusted_cdd,
        CAST(average_sa_cdd AS DECIMAL(22,8)) AS average_sa_cdd,
        CASE WHEN supply_adjusted_cdd > average_sa_cdd THEN 1 ELSE 0 END AS binary_cdd,

        /* ---- STXO sums (block_base에서 CAST 완료) ---- */
        stxo_sum_at_created_price,
        stxo_sum_at_spent_price,
        -- ... 6개 더 (단순 passthrough)

        /* ---- SOPR family ---- */
        CAST(DOUBLE(stxo_sum_at_spent_price) / NULLIF(DOUBLE(stxo_sum_at_created_price), 0)
             AS DECIMAL(22,8)) AS sopr,
        -- asopr, sth_sopr, lth_sopr ...

        /* ---- NRPL: (1 - 1/sopr) * tx_volume_usd ---- */
        CAST(CASE WHEN stxo_sum_at_created_price > 0 AND stxo_sum_at_spent_price > 0
            THEN (1.0 - DOUBLE(stxo_sum_at_created_price) / DOUBLE(stxo_sum_at_spent_price))
                 * DOUBLE(tokens_transferred_total) * price
            ELSE NULL END AS DECIMAL(22,8)) AS nrpl,

        CURRENT_TIMESTAMP() AS updated_at

    FROM with_cumulative
    """

    return query
```

## 3. 실행 코드

History mode (전체 블록 한 번에):
```python
if mode == "history":
    query = build_market_query(
        "utxo_event_df", PRICE_TABLE, "utxo_statistics_df", "network_df",
        start_block, end_block
    )

    result_df = spark.sql(query)

    result_df.write.format("delta") \
        .option("replaceWhere", f"block_height BETWEEN {start_block} AND {end_block}") \
        .mode("overwrite") \
        .saveAsTable(OUTPUT_TABLE)
```

Incremental mode (이전 누적값을 seed로 주입):
```python
if mode == "incremental":
    # 마지막 블록의 누적값 읽기
    prev = spark.sql(f"""
        SELECT realized_cap, thermo_cap, average_cap, average_sa_cdd, block_height
        FROM {OUTPUT_TABLE}
        WHERE block_height = {start_block - 1}
    """).first()

    prev_count = prev["block_height"] + 1
    seed_values = {
        "realized_cap": float(prev["realized_cap"]),
        "thermo_cap": float(prev["thermo_cap"]),
        "mc_sum": float(prev["average_cap"]) * prev_count,
        "sa_cdd_sum": float(prev["average_sa_cdd"]) * prev_count,
    }

    query = build_market_query(
        "utxo_event_df", PRICE_TABLE, "utxo_statistics_df", "network_df",
        start_block, end_block,
        seed_values=seed_values
    )

    result_df = spark.sql(query)
    result_df.write.format("delta") \
        .option("replaceWhere", f"block_height BETWEEN {start_block} AND {end_block}") \
        .mode("overwrite") \
        .saveAsTable(OUTPUT_TABLE)
```

# 주의할 점 (Gotchas)

---

## 1. GREATEST 클램핑 필수

비트코인 블록 타임스탬프는 **비단조(non-monotonic)**입니다. 마이너가 이전 블록보다 이른 타임스탬프를 설정할 수 있어, `age_seconds`가 음수가 될 수 있습니다:

```sql
-- 잘못된 코드 (음수 age)
SUM(-e.delta_value * (p.timestamp - e.created_timestamp) / 86400.0) AS cdd

-- 올바른 코드 (GREATEST로 클램핑)
SUM(-e.delta_value * GREATEST(p.timestamp - e.created_timestamp, 0) / 86400.0) AS cdd
```

영향 범위: 전체 블록의 ~0.08% (368쌍, 736블록). 클램핑 없으면 CDD 계산에서 음수 coin days가 발생하여 누적 메트릭에 오류가 전파됩니다.

## 2. DOUBLE 캐스팅으로 정밀도 보장

DECIMAL끼리 나눗셈 시 정밀도 손실이 발생할 수 있습니다. 모든 나눗셈에 DOUBLE 캐스팅 적용:

```sql
-- 정밀도 보장
CAST(DOUBLE(stxo_sum_at_spent_price) / NULLIF(DOUBLE(stxo_sum_at_created_price), 0)
     AS DECIMAL(22,8)) AS sopr
```

## 3. block_height + 1 분모

평균 계산 시 블록 개수는 `block_height + 1`입니다 (block 0부터 시작):

```sql
-- 블록 0 = 1개 블록, 블록 N = N+1개 블록
SUM(market_cap) OVER w / DOUBLE(block_height + 1) AS average_cap
```

## 4. SOPR 경계값 주의

Short-term holder (STH)와 Long-term holder (LTH) 구분 기준:
- Short: `3600s <= age_seconds < 13392000s` (1시간 ~ 155일)
- Long: `age_seconds >= 13392000s` (155일 이상)

등호 위치가 중요합니다. 기존 Python 코드 (`market/controller.py:298`)를 정확히 따라야 합니다.

# 다음 단계 (Next Steps)

---

1. **Databricks 실행 검증**: 리팩토링된 노트북을 전체 블록 범위(0~880K)에서 실행하여 결과값 교차 확인
2. **Multi-task Job 통합**: UTXO metrics (A-1) 완료 후 자동으로 market_metrics task 실행하는 Workflow 구성
3. **Hour/Day 집계**: Block-level 메트릭을 시간/일 단위로 집계하는 후속 노트북 작성 (NVT는 이 단계에서 meaningful)
4. **모니터링**: 증분 실행(incremental mode) 시 누적값 연속성 검증 로직 추가

# Reference

---

## 관련 파일

- `notebooks/market_metrics.py` — 리팩토링된 메인 노트북 (history + incremental)
- `notebooks/market_metrics_history.py` — History build 전용 (deprecated)
- `notebooks/market_metrics_incremental.py` — Incremental build 전용 (deprecated)
- `docs/spark/03_market_metrics.md` — 설계 문서 (prefix sum 원리, 수식 증명)
- `market/controller.py` — 기존 Python 구현 (순차 처리 로직)

## 핵심 개념

- **CTE Layer Separation**: 원시 집계 → 데이터 준비 → 수학적 계산 → 파생 지표 순서
- **Separation of Concerns**: 타입 변환(block_base)과 비율 계산(final SELECT) 분리
- **Prefix Sum Pattern**: 순차 루프를 window function으로 전환하여 Spark 병렬 처리 활용
- **Incremental with Seed**: 이전 누적값을 CTE에 주입하여 window function 연속성 보장
