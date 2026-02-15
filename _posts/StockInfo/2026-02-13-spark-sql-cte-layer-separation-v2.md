---
title: "[Spark] 복잡한 금융 메트릭 파이프라인의 CTE 레이어 분리 전략"
date: 2026-02-13
categories:
  - StockInfo
tags:
  - Spark
  - SQL
  - CTE
  - Databricks
  - Delta Lake
  - Data Engineering
  - Refactoring
---

## 들어가며

Bitcoin Market Metrics를 계산하는 Spark SQL 쿼리가 5개의 CTE와 32개 컬럼으로 이루어진 final SELECT로 구성되어 있었다. 처음에는 "동작하면 되지"라는 생각이었지만, 타입 변환이 두 곳에 흩어지고, 파생 비율 계산의 위치가 CTE마다 제각각이 되면서 유지보수가 어려워졌다.

이 글에서는 **SQL CTE(Common Table Expression) 레이어별 관심사 분리** 원칙을 적용하여 파이프라인을 재구조화한 과정을 공유한다. 구체적으로 다음 내용을 다룬다:

1. CTE 레이어를 5단계로 나누고 각 단계의 책임을 명확히 정의하는 방법
2. 타입 변환, 파생 비율 계산 등의 관심사를 어느 레이어에 배치할지 결정하는 기준
3. Databricks multi-task job과 standalone 실행 양쪽에서 동작하는 temp view 전략
4. 비트코인 타임스탬프의 비단조성(non-monotonic) 등 금융 데이터 특유의 주의점

글을 마치면 복잡한 SQL 파이프라인을 읽기 쉽고 수정하기 쉬운 구조로 정리하는 실용적인 패턴을 얻을 수 있을 것이다.

## 사전 지식

이 글을 따라가려면 다음 개념에 익숙하면 좋다:

- **SQL CTE (WITH 절)**: 서브쿼리에 이름을 붙여 재사용하는 문법. Spark SQL에서 완전히 지원된다.
- **Window Function**: `SUM(...) OVER (ORDER BY ... ROWS UNBOUNDED PRECEDING)` 형태의 누적합 패턴
- **Spark SQL `createOrReplaceTempView`**: DataFrame을 SQL에서 조회할 수 있는 임시 뷰로 등록하는 PySpark API
- **Delta Lake 기본 개념**: `replaceWhere` 옵션을 사용한 선택적 덮어쓰기
- **비트코인 UTXO 모델**: 트랜잭션이 이전 output을 소비(spend)하고 새 output을 생성하는 구조 (깊이 알 필요는 없다)

## 배경: 대규모 블록체인 메트릭 계산

비트코인 온체인 분석에는 다양한 금융 지표가 필요하다:

| 지표 | 설명 |
|------|------|
| **SOPR** (Spent Output Profit Ratio) | 실현 손익 비율 |
| **CDD** (Coin Days Destroyed) | 코인 보유 기간 가중치 |
| **MVRV** (Market Value to Realized Value) | 시장가치 대비 실현가치 배율 |
| **NRPL** (Net Realized Profit/Loss) | 순실현손익 |

이 지표들을 계산하려면 여러 데이터 소스를 결합해야 한다:

```
utxo_events_block (UTXO 생성/소비 이벤트)    ─┐
price_df (블록별 가격/타임스탬프)               ├─→ 32개 메트릭 산출
btc_utxo_block_metrics (공급량/미실현 손익)    ─┤
network_block (네트워크 데이터)                ─┘
```

기존 Python 코드는 블록을 순차적으로 처리하며 누적값을 유지했지만, Spark SQL로 전환하면서 **Window Function 기반 prefix sum**으로 재설계했다. 그 과정에서 SQL 쿼리가 5개의 CTE와 복잡한 final SELECT로 구성되었고, 로직의 명확한 계층화가 필요해졌다.

### 초기 구조의 문제점

리팩토링 전에는 다음과 같은 혼란이 있었다:

1. **타입 변환이 여러 곳에 흩어짐**: STXO 컬럼을 `block_base`에서 `COALESCE`만 하고, `final SELECT`에서 `CAST` 하는 식으로 두 단계에 걸쳐 처리
2. **파생 비율 계산 위치 불명확**: NRPL을 `block_base`에서 계산할지, `final SELECT`에서 할지 일관성 없음
3. **테이블/View 참조 혼재**: `{EVENTS_TABLE}` 같은 Python f-string placeholder와 실제 temp view 이름이 혼용

이 문제들을 CTE 레이어별 역할 분리 원칙으로 해결한 과정을 단계별로 살펴보자.

## 설계 원칙: CTE 레이어별 역할 분리

복잡한 SQL을 다룰 때는 각 CTE가 **단일 책임**을 가져야 코드를 이해하고 수정하기 쉽다. 이 파이프라인을 다음과 같은 5단계 레이어로 구조화했다:

```
Layer 1: spent_metrics CTE       → 원시 이벤트 집계 (UTXO 소비)
             ↓
Layer 2: realized_delta CTE      → 원시 이벤트 집계 (realized_cap 변화량)
             ↓
Layer 3: block_base CTE          → 모든 소스 JOIN + 원시값 준비 (COALESCE, CAST 완료)
             ↓
Layer 4: with_cumulative CTE     → Window Function으로 prefix sum 계산
             ↓
Layer 5: final SELECT            → 파생 비율 계산 (MVRV, SOPR, NRPL 등)
```

각 레이어의 역할을 정리하면 이렇다:

| 레이어 | 역할 | 포함되는 연산 |
|--------|------|---------------|
| CTE 1-2 | 원시 데이터를 블록별로 집계 | `GROUP BY`, `SUM`, `GREATEST` |
| CTE 3 (block_base) | 데이터 조합 + 타입 변환 완료 | `JOIN`, `COALESCE`, `CAST`, NULL 처리 |
| CTE 4 (with_cumulative) | 수학적 누적 계산 | `SUM(...) OVER w`, `WINDOW` 절 |
| final SELECT | 비율/파생 지표만 계산 | 나눗셈, `CASE WHEN`, `NULLIF` |

핵심 규칙은 간단하다: **상위 레이어는 하위 레이어가 생성한 값을 신뢰하고 그대로 사용한다.** `block_base`에서 `CAST`까지 끝냈으면 `final SELECT`에서 다시 `CAST`하지 않는다.

## 관심사 분리의 구체적 적용

### 적용 1: 타입 변환은 block_base에서 완료한다

**Before** -- 타입 변환이 2곳에 분산:

```sql
-- block_base: COALESCE만 적용, CAST 없음
block_base AS (
    SELECT
        COALESCE(s.stxo_sum_at_created_price, 0) AS stxo_sum_at_created_price,
        -- 6개 더...
    FROM ...
)

-- final SELECT: 여기서 뒤늦게 CAST
SELECT
    CAST(stxo_sum_at_created_price AS DECIMAL(22,8)),
    CAST(stxo_sum_at_spent_price AS DECIMAL(22,8)),
    -- 6개 더...
```

**After** -- 타입 변환을 데이터 준비 단계에 통합:

```sql
-- block_base: COALESCE + CAST를 한 번에 완료
block_base AS (
    SELECT
        CAST(COALESCE(s.stxo_sum_at_created_price, 0) AS DECIMAL(22,8))
            AS stxo_sum_at_created_price,
        CAST(COALESCE(s.stxo_sum_at_spent_price, 0) AS DECIMAL(22,8))
            AS stxo_sum_at_spent_price,
        -- 6개 더...
    FROM ...
)

-- final SELECT: 이미 올바른 타입이므로 단순 passthrough
SELECT
    stxo_sum_at_created_price,
    stxo_sum_at_spent_price,
    ...
```

**왜 이렇게 하는가?** STXO는 원시 데이터다. "데이터 준비" 단계인 `block_base`에서 타입까지 확정하면, 이후 레이어에서는 이 값들의 타입을 의심할 필요 없이 그대로 사용하면 된다. 타입 변환이 2곳에 흩어지면 한쪽만 수정하고 다른 쪽을 빠뜨리는 실수가 생긴다.

### 적용 2: NRPL을 final SELECT로 이동한다

**Before** -- 원시값 조합 단계에서 파생 비율 계산:

```sql
block_base AS (
    SELECT
        ...,
        -- NRPL = (1 - 1/sopr) * tx_volume_usd
        CASE WHEN s.stxo_sum_at_created_price > 0
            THEN (1 - DOUBLE(s.stxo_sum_at_created_price)
                      / s.stxo_sum_at_spent_price)
                 * n.tokens_transferred_total * p.price
            ELSE NULL END AS nrpl
    FROM ...
)
```

**After** -- 파생 비율 계산을 final SELECT로:

```sql
-- block_base: 원시값만 전달
block_base AS (
    SELECT
        ...,
        n.tokens_transferred_total,
        p.price
    FROM ...
)

-- final SELECT: 파생 비율 계산을 다른 비율 지표들과 함께 배치
SELECT
    ...,
    /* ---- NRPL: (1 - 1/sopr) * tx_volume_usd ---- */
    CAST(
        CASE WHEN stxo_sum_at_created_price > 0
                  AND stxo_sum_at_spent_price > 0
            THEN (1.0 - DOUBLE(stxo_sum_at_created_price)
                        / DOUBLE(stxo_sum_at_spent_price))
                 * DOUBLE(tokens_transferred_total) * price
            ELSE NULL END
    AS DECIMAL(22,8)) AS nrpl
FROM with_cumulative
```

**왜 이렇게 하는가?** NRPL은 STXO에서 파생된 비율 지표다. 수식으로 보면 `(1 - 1/SOPR) * tx_volume_usd`이므로 SOPR의 변형이다. SOPR, MVRV, NVT 같은 다른 비율 지표와 같은 레이어에 있어야 논리적으로 일관된다. `block_base`는 "데이터를 모으고 정리하는 곳"이고, `final SELECT`는 "정리된 데이터로 지표를 계산하는 곳"이라는 구분이 명확해진다.

> 참고: `DOUBLE()` 함수는 Spark SQL에서 `CAST(expr AS DOUBLE)`의 축약 문법이다. 나눗셈 정밀도를 보장하기 위해 `DECIMAL` 값을 `DOUBLE`로 변환한 후 연산하고, 최종 결과를 다시 `DECIMAL(22,8)`로 캐스팅하는 패턴을 사용한다.

### 적용 3: NVT를 block 단위에서도 계산한다

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

**왜 이렇게 하는가?** 기존 Python 로직은 day/hour 단위에서만 NVT를 계산했다 (block 단위는 노이즈가 크기 때문). 하지만 Spark에서는 raw data로서 block 단위 NVT도 계산하는 것이 합리적이다:

- Delta Lake 저장 비용이 거의 없고
- 향후 연구자가 block-level NVT를 분석할 수 있으며
- 계산 자체는 단순 나눗셈이라 성능 부담이 없음

`NULLIF`로 0-division을 방지하므로 트랜잭션이 없는 블록에서는 자연스럽게 `NULL`이 된다.

## 구현: Temp View 전략과 CTE 조립

### Temp View로 실행 환경 추상화하기

Databricks multi-task job에서는 upstream task가 생성한 **Global Temp View**를 downstream task가 재사용한다. 반면 standalone 실행(개발/테스트)에서는 직접 테이블을 읽어 view를 등록해야 한다.

이 두 환경을 하나의 코드로 지원하기 위해, 노트북 상단에서 고정된 이름의 temp view를 등록한다:

```python
# notebooks/market_metrics.py

# Widget에서 테이블 경로 읽기
EVENTS_TABLE  = f"{catalog}.{schema}.utxo_events_block"
METRICS_TABLE = f"{catalog}.{schema}.btc_utxo_block_metrics"
NETWORK_TABLE = f"{catalog}.{schema}.network_block"

# --- Source View 등록 ---
# Multi-task job: upstream이 이미 생성한 view를 덮어쓰기 (idempotent)
# Standalone:    직접 테이블에서 view 생성
spark.read.table(EVENTS_TABLE).createOrReplaceTempView("utxo_event_df")
spark.read.table(METRICS_TABLE).createOrReplaceTempView("utxo_statistics_df")
spark.read.table(NETWORK_TABLE).createOrReplaceTempView("network_df")
```

SQL 쿼리에서는 Python f-string placeholder 대신 **고정된 view 이름**을 사용한다:

```sql
FROM utxo_event_df e
LEFT JOIN utxo_statistics_df a1 ON p.block_height = a1.block_height
LEFT JOIN network_df n          ON p.block_height = n.block_height
```

이 전략의 장점은 세 가지다:

1. **Idempotent**: `createOrReplaceTempView()`는 동명 view가 이미 존재하면 덮어쓴다. 중복 호출해도 안전하다.
2. **환경 독립**: multi-task job과 standalone이 동일한 SQL 쿼리를 공유한다.
3. **테스트 용이**: widget 파라미터만 바꾸면 test 테이블로 전환된다.

> `createOrReplaceTempView`로 생성한 view는 해당 **SparkSession** 범위에서만 유효하다. Multi-task job에서 task 간 데이터를 공유하려면 `createOrReplaceGlobalTempView`와 `persist()`를 사용해야 한다 (이 노트북에서는 단일 task 내에서 사용하므로 일반 temp view로 충분하다).

### Python 함수로 CTE 레이어 조립하기

전체 쿼리를 Python 함수로 생성하여 history/incremental 모드 양쪽을 지원한다:

```python
def build_market_query(events_table, price_table, metrics_table, network_table,
                       start_block, end_block, seed_values=None):
    """Market metrics SQL 쿼리를 빌드한다.

    Args:
        events_table:  UTXO 이벤트 테이블/뷰 이름
        price_table:   블록별 가격 테이블/뷰 이름
        metrics_table: A-1 메트릭 테이블/뷰 이름
        network_table: 네트워크 테이블/뷰 이름
        start_block:   시작 블록 높이
        end_block:     종료 블록 높이
        seed_values:   incremental 모드용 이전 누적값 dict.
                       keys: {realized_cap, thermo_cap, mc_sum, sa_cdd_sum}
                       None이면 history 모드 (block 0부터 계산).
    """
    # --- CTE 4: with_cumulative ---
    # Incremental: 이전 블록의 누적값을 seed로 주입
    if seed_values:
        rc  = seed_values["realized_cap"]
        tc  = seed_values["thermo_cap"]
        mcs = seed_values["mc_sum"]
        scs = seed_values["sa_cdd_sum"]
        cumulative_cte = f"""
    with_cumulative AS (
        SELECT *,
            DOUBLE({rc})  + SUM(delta_realized_cap) OVER w   AS realized_cap,
            (DOUBLE({mcs}) + SUM(market_cap) OVER w)
                / DOUBLE(block_height + 1)                   AS average_cap,
            DOUBLE({tc})  + SUM(COALESCE(block_reward_usd, 0)) OVER w
                                                             AS thermo_cap,
            (DOUBLE({scs}) + SUM(supply_adjusted_cdd) OVER w)
                / DOUBLE(block_height + 1)                   AS average_sa_cdd
        FROM block_base
        WINDOW w AS (ORDER BY block_height ROWS UNBOUNDED PRECEDING)
    )"""
    else:
        # History: 처음부터 계산
        cumulative_cte = """
    with_cumulative AS (
        SELECT *,
            SUM(delta_realized_cap) OVER w                   AS realized_cap,
            SUM(market_cap) OVER w
                / DOUBLE(block_height + 1)                   AS average_cap,
            SUM(COALESCE(block_reward_usd, 0)) OVER w       AS thermo_cap,
            SUM(supply_adjusted_cdd) OVER w
                / DOUBLE(block_height + 1)                   AS average_sa_cdd
        FROM block_base
        WINDOW w AS (ORDER BY block_height ROWS UNBOUNDED PRECEDING)
    )"""
```

위 코드에서 사용하는 `WINDOW w AS (...)` 구문은 Spark SQL이 지원하는 **Named Window** 문법이다. 같은 window 정의를 여러 컬럼에서 반복하지 않고 한 번만 선언하여 재사용할 수 있다.

이어서 전체 쿼리를 조립한다:

```python
    query = f"""
    WITH
    -- Layer 1: spent_metrics (UTXO 소비 이벤트 집계)
    spent_metrics AS (
        SELECT
            e.event_block_height AS block_height,
            CAST(SUM(-e.delta_value
                     * GREATEST(p.timestamp - e.created_timestamp, 0)
                     / 86400.0)
                AS DECIMAL(22,8)) AS cdd,
            CAST(SUM(-e.delta_realized) AS DECIMAL(22,8))
                AS stxo_sum_at_created_price,
            CAST(SUM(-e.delta_value * p.price) AS DECIMAL(22,8))
                AS stxo_sum_at_spent_price
            -- adjusted, short, long 변형도 동일 패턴...
        FROM {events_table} e
        JOIN {price_table} p ON e.event_block_height = p.block_height
        WHERE e.delta_count < 0  -- spent events only
          AND e.event_block_height BETWEEN {start_block} AND {end_block}
        GROUP BY e.event_block_height
    ),

    -- Layer 2: realized_delta (realized_cap 변화량)
    realized_delta AS (
        SELECT
            event_block_height AS block_height,
            SUM(delta_realized) AS delta_realized_cap
        FROM {events_table}
        WHERE event_block_height BETWEEN {start_block} AND {end_block}
        GROUP BY event_block_height
    ),

    -- Layer 3: block_base (모든 소스 JOIN + 원시값 준비, COALESCE/CAST 완료)
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

            -- 파생 원시값 (이 레이어에서 타입 확정)
            DOUBLE(a1.unspent_utxo_total_supply) * p.price AS market_cap,
            COALESCE(s.cdd, 0)                             AS cdd,
            COALESCE(DOUBLE(s.cdd), 0)
                / NULLIF(DOUBLE(a1.unspent_utxo_total_supply), 0)
                                                           AS supply_adjusted_cdd,
            COALESCE(r.delta_realized_cap, 0)              AS delta_realized_cap,

            -- STXO 8컬럼 (COALESCE + CAST 한 번에 완료)
            CAST(COALESCE(s.stxo_sum_at_created_price, 0)
                AS DECIMAL(22,8)) AS stxo_sum_at_created_price,
            CAST(COALESCE(s.stxo_sum_at_spent_price, 0)
                AS DECIMAL(22,8)) AS stxo_sum_at_spent_price
            -- ... 6개 더

        FROM {price_table} p
        LEFT JOIN spent_metrics s    ON p.block_height = s.block_height
        LEFT JOIN realized_delta r   ON p.block_height = r.block_height
        LEFT JOIN {metrics_table} a1 ON p.block_height = a1.block_height
        LEFT JOIN {network_table} n  ON p.block_height = n.block_height
        WHERE p.block_height BETWEEN {start_block} AND {end_block}
    ),

    -- Layer 4: with_cumulative (prefix sum window functions)
    {cumulative_cte}

    -- Layer 5: final SELECT (파생 비율 계산만 수행)
    SELECT
        block_height,
        datetime,

        /* ---- Cap metrics (누적값 사용) ---- */
        CAST(market_cap   AS DECIMAL(22,8)) AS market_cap,
        CAST(realized_cap AS DECIMAL(22,8)) AS realized_cap,
        CAST(average_cap  AS DECIMAL(22,8)) AS average_cap,
        CAST(thermo_cap   AS DECIMAL(22,8)) AS thermo_cap,

        /* ---- 파생 비율: MVRV, realized_price, delta_cap ---- */
        CAST(market_cap / NULLIF(realized_cap, 0)
             AS DECIMAL(20,8)) AS mvrv,
        CAST(realized_cap / NULLIF(DOUBLE(supply_total), 0)
             AS DECIMAL(22,8)) AS realized_price,
        CAST(realized_cap - average_cap
             AS DECIMAL(22,8)) AS delta_cap,

        /* ---- NUPL / NUP / NUL ---- */
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
        CASE WHEN supply_adjusted_cdd > average_sa_cdd THEN 1 ELSE 0 END
            AS binary_cdd,

        /* ---- STXO sums (block_base에서 CAST 완료, 단순 passthrough) ---- */
        stxo_sum_at_created_price,
        stxo_sum_at_spent_price,
        -- ... 6개 더

        /* ---- SOPR family ---- */
        CAST(DOUBLE(stxo_sum_at_spent_price)
             / NULLIF(DOUBLE(stxo_sum_at_created_price), 0)
             AS DECIMAL(22,8)) AS sopr,
        -- asopr, sth_sopr, lth_sopr ...

        /* ---- NRPL: (1 - 1/sopr) * tx_volume_usd ---- */
        CAST(CASE WHEN stxo_sum_at_created_price > 0
                       AND stxo_sum_at_spent_price > 0
            THEN (1.0 - DOUBLE(stxo_sum_at_created_price)
                        / DOUBLE(stxo_sum_at_spent_price))
                 * DOUBLE(tokens_transferred_total) * price
            ELSE NULL END AS DECIMAL(22,8)) AS nrpl,

        CURRENT_TIMESTAMP() AS updated_at

    FROM with_cumulative
    """

    return query
```

### History / Incremental 실행

두 가지 모드를 지원한다. History는 전체 블록을 한 번에 처리하고, Incremental은 이전 블록의 누적값을 seed로 주입하여 이어서 계산한다.

**History 모드** (전체 블록 한 번에):

```python
if mode == "history":
    query = build_market_query(
        "utxo_event_df", PRICE_TABLE, "utxo_statistics_df", "network_df",
        start_block, end_block
    )
    result_df = spark.sql(query)

    result_df.write.format("delta") \
        .option("replaceWhere",
                f"block_height BETWEEN {start_block} AND {end_block}") \
        .mode("overwrite") \
        .saveAsTable(OUTPUT_TABLE)
```

`replaceWhere`와 `mode("overwrite")`를 함께 사용하면, 지정한 조건에 해당하는 파티션/파일만 원자적(atomic)으로 교체한다. Delta Lake의 트랜잭션 로그에 기존 파일 remove + 새 파일 add가 단일 커밋으로 기록되므로 재실행해도 중복이 없다 (idempotent).

**Incremental 모드** (이전 누적값을 seed로 주입):

```python
if mode == "incremental":
    # 마지막 블록의 누적값 읽기
    prev = spark.sql(f"""
        SELECT realized_cap, thermo_cap, average_cap,
               average_sa_cdd, block_height
        FROM {OUTPUT_TABLE}
        WHERE block_height = {start_block - 1}
    """).first()

    prev_count = prev["block_height"] + 1  # block 0부터 시작이므로 +1
    seed_values = {
        "realized_cap": float(prev["realized_cap"]),
        "thermo_cap":   float(prev["thermo_cap"]),
        "mc_sum":       float(prev["average_cap"]) * prev_count,
        "sa_cdd_sum":   float(prev["average_sa_cdd"]) * prev_count,
    }

    query = build_market_query(
        "utxo_event_df", PRICE_TABLE, "utxo_statistics_df", "network_df",
        start_block, end_block,
        seed_values=seed_values
    )
    result_df = spark.sql(query)

    result_df.write.format("delta") \
        .option("replaceWhere",
                f"block_height BETWEEN {start_block} AND {end_block}") \
        .mode("overwrite") \
        .saveAsTable(OUTPUT_TABLE)
```

Incremental 모드의 핵심 아이디어는 이렇다. `average_cap`은 "block 0부터 현재까지의 `market_cap` 합 / 블록 수"인데, Window Function은 `start_block`부터 새로 시작하므로 이전 블록들의 합을 알 수 없다. 그래서 이전 블록의 `average_cap * block_count`로 원래의 합(`mc_sum`)을 역산하고, 이를 `with_cumulative` CTE의 seed offset으로 주입한다.

## 주의할 점 (Gotchas)

### 1. GREATEST 클램핑 필수: 비트코인 타임스탬프는 비단조다

비트코인의 블록 타임스탬프는 **비단조(non-monotonic)**다. 마이너가 이전 블록보다 이른 타임스탬프를 설정할 수 있어, `age_seconds = current_timestamp - created_timestamp`가 음수가 될 수 있다.

```sql
-- 잘못된 코드: 음수 age_seconds가 음수 CDD를 만든다
SUM(-e.delta_value * (p.timestamp - e.created_timestamp) / 86400.0) AS cdd

-- 올바른 코드: GREATEST로 음수를 0으로 클램핑
SUM(-e.delta_value * GREATEST(p.timestamp - e.created_timestamp, 0) / 86400.0) AS cdd
```

영향 범위는 전체 블록의 약 0.08% (368쌍, 736블록)으로 적지만, 클램핑이 없으면 음수 CDD가 발생하여 `supply_adjusted_cdd`, `average_sa_cdd` 등 누적 메트릭에 오류가 전파된다. 실제로 Python 구현에서는 이 클램핑이 없어 Spark 결과와 최대 7.6%의 CDD 차이가 발생했다. 물리적으로 음수 coin days는 존재할 수 없으므로 Spark의 `GREATEST` 클램핑이 더 정확하다.

### 2. DECIMAL끼리 나눗셈 시 DOUBLE 캐스팅

Spark SQL에서 `DECIMAL(22,8) / DECIMAL(22,8)`은 결과 precision이 예상과 다를 수 있다. 특히 SOPR처럼 1에 가까운 비율을 계산할 때 정밀도가 중요하므로, 나눗셈 전에 `DOUBLE()`로 변환한다:

```sql
-- DECIMAL끼리 나눗셈 → 정밀도 문제 가능
stxo_sum_at_spent_price / NULLIF(stxo_sum_at_created_price, 0)

-- DOUBLE 변환 후 나눗셈 → 정밀도 보장, 최종 결과를 다시 DECIMAL으로
CAST(DOUBLE(stxo_sum_at_spent_price)
     / NULLIF(DOUBLE(stxo_sum_at_created_price), 0)
     AS DECIMAL(22,8)) AS sopr
```

### 3. block_height + 1 분모

평균 계산 시 블록 개수는 `block_height + 1`이다. 비트코인 블록은 0번부터 시작하므로 block 0에서 블록 수는 1개, block N에서는 N+1개다:

```sql
SUM(market_cap) OVER w / DOUBLE(block_height + 1) AS average_cap
```

이 `+ 1`을 빠뜨리면 block 0에서 0으로 나누는 오류가 발생하고, 이후 모든 블록의 평균값이 미세하게 틀어진다.

### 4. SOPR STH/LTH 경계값의 등호 위치

Short-term holder(STH)와 Long-term holder(LTH) 구분에서 등호 위치가 중요하다:

| 구분 | 조건 | 기간 |
|------|------|------|
| **Adjusted** | `age_seconds >= 3600` | 1시간 이상 |
| **Short-term** | `3600 <= age_seconds < 13392000` | 1시간 ~ 155일 미만 |
| **Long-term** | `age_seconds >= 13392000` | 155일 이상 |

기존 Python 코드(`market/controller.py:298`)에서 short은 `< 13392000`, long은 `>= 13392000`으로 처리한다. 등호 하나의 차이지만, 정확히 155일에 소비된 UTXO가 STH/LTH 어느 쪽에도 포함되지 않거나 양쪽에 중복 포함되는 버그를 만들 수 있다.

## 정리: CTE 레이어 분리의 효과

이 리팩토링으로 얻은 것을 정리하면:

| 변경 | 효과 |
|------|------|
| 타입 변환을 `block_base`에 통합 | 한 곳만 수정하면 되고, 이후 레이어에서 타입을 의심할 필요 없음 |
| 파생 비율을 `final SELECT`로 이동 | SOPR, MVRV, NRPL이 한 곳에 모여 비교/검증이 쉬움 |
| NVT를 block level에서도 계산 | raw data 완결성 확보, 비용 거의 없음 |
| Temp View로 실행 환경 추상화 | 동일 SQL이 multi-task job / standalone 양쪽에서 동작 |

핵심 원칙은 단순하다. **각 CTE가 단 하나의 역할만 수행하고, 상위 레이어는 하위 레이어의 출력을 신뢰한다.** 이 원칙만 지키면 수십 개의 컬럼으로 이루어진 복잡한 SQL도 "이 CTE는 뭘 하는 곳인가?"라는 질문에 한 문장으로 답할 수 있게 된다.

## 다음 단계

1. **Databricks 실행 검증**: 리팩토링된 노트북을 전체 블록 범위(0~880K)에서 실행하여 기존 Python 결과와 교차 확인
2. **Multi-task Job 통합**: UTXO metrics (A-1) 완료 후 자동으로 market_metrics task가 실행되는 Workflow 구성
3. **Hour/Day 집계**: block-level 메트릭을 시간/일 단위로 집계하는 후속 노트북 작성 (NVT는 이 단계에서 더 의미 있는 지표가 됨)
4. **누적값 연속성 모니터링**: incremental 실행 시 이전 블록과의 연속성을 자동으로 검증하는 로직 추가

## 참고 자료

### 관련 파일

| 파일 | 설명 |
|------|------|
| `notebooks/market_metrics.py` | 리팩토링된 메인 노트북 (history + incremental) |
| `docs/spark/03_market_metrics.md` | 설계 문서 (prefix sum 원리, 수식 증명) |
| `market/controller.py` | 기존 Python 구현 (순차 처리, SOPR 경계 기준) |

### 핵심 개념 요약

- **CTE Layer Separation**: 원시 집계 -> 데이터 준비 -> 수학적 누적 -> 파생 지표 순서로 역할 분리
- **Prefix Sum Pattern**: 순차 루프를 Window Function(`SUM ... OVER ... ROWS UNBOUNDED PRECEDING`)으로 전환하여 Spark 병렬 처리 활용
- **Incremental with Seed**: 이전 블록의 누적값을 역산하여 CTE에 offset으로 주입, Window Function 연속성 보장
- **Named Window 절**: `WINDOW w AS (ORDER BY ... ROWS ...)` 구문으로 동일한 window 정의를 여러 컬럼에서 재사용

### 외부 문서

- [Spark SQL Window Functions](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-window.html) -- WINDOW 절 및 프레임 정의 공식 문서
- [Databricks WINDOW Clause](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-qry-select-named-window) -- Named Window 문법 레퍼런스
- [Databricks `double()` function](https://docs.databricks.com/en/sql/language-manual/functions/double.html) -- `CAST(expr AS DOUBLE)`의 축약 문법
- [Delta Lake Selective Overwrite](https://docs.databricks.com/aws/en/delta/selective-overwrite) -- `replaceWhere` 옵션 공식 문서
