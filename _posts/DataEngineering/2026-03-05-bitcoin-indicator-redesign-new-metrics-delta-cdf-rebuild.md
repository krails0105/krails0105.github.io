---
layout: post
title: "Bitcoin Indicator 테이블 Redesign: 신규 지표 6개 추가와 Delta CDF 재생성 삽질기"
categories: [DataEngineering]
tags: [Databricks, DeltaLake, PySpark, Bitcoin, OnChain, CDF, UnityCatalog, PSQL, ETL]
---

## 들어가며

Bitcoin on-chain ETL 파이프라인에서 `indicator_block` 테이블에 신규 지표 6개를 추가하는 작업을 진행했다. 단순한 컬럼 추가처럼 보이지만, 실제로는 **공식 정합성 검증, Delta Lake CDF(Change Data Feed) 테이블 재생성, rollup 로직 재설계, PSQL Ingestion 초기화, Databricks Job DAG 통합**까지 이어지는 작업이었다.

이 글에서는 각 단계에서 마주친 문제와 해결 방법을 기록한다. 특히 Delta Lake CDF를 테이블 생성 이후에 활성화했을 때 발생하는 함정, 그리고 block-level 지표를 rollup할 때 단순 `max_by`로는 안 되는 지표가 있다는 점이 핵심이다.

### 이 글에서 다루는 내용

- 테이블 설계 원칙 (network vs indicator 분류)
- 신규 지표 6개의 블록/롤업 레벨 구현
- Delta Lake CDF가 version 0부터 필요한 이유와 테이블 재생성 방법
- Unity Catalog `RENAME TO`의 3-part path 함정
- PySpark Window function을 활용한 rolling 집계
- PSQL Ingestion 초기화 및 Job DAG 통합

### 사전 지식

- Delta Lake 기본 개념 (versioning, table properties)
- PySpark DataFrame/SQL 기본 사용법
- Databricks Unity Catalog 3-level namespace (`catalog.schema.table`)

---

## 배경: 테이블 설계 원칙 정립

기존에는 `market_indicator_block`이라는 이름으로 시장 지표를 저장하고 있었다. 이번 작업에서 테이블 이름 변경과 신규 지표 추가를 함께 정리했다.

### 테이블 분류 기준

두 테이블의 경계를 명확히 하는 것이 중요하다.

| 테이블 | 성격 | 예시 |
|---|---|---|
| `network_block` | raw 블록체인 사실 | hashrate, fee, tx count, 채굴 보상 등 |
| `indicator_block` | 파생 지표 | network + price + UTXO를 결합해 계산한 값 |

`stock_to_flow`나 `puell_multiple`은 1년치 rolling window를 사용하는 파생값이므로, raw 데이터 테이블인 `network_block`보다 `indicator_block`에 있는 것이 의미상 더 정확하다. 이 분류 기준은 "데이터의 의미적 정확성"을 최우선으로 둔 결과다.

### 추가할 지표 6개

| 컬럼 | 공식 | 카테고리 |
|---|---|---|
| `dormancy` | `cdd / tokens_transferred_total` | Activity |
| `mca` | `market_cap / addresses_count_active` | Valuation |
| `nvm` | `market_cap / addresses_count_active^2` | Valuation |
| `sopr_ratio` | `sth_sopr / lth_sopr` | Profit/Loss |
| `stock_to_flow` | `supply_total / supply_new` | Valuation |
| `puell_multiple` | `blockreward_usd / AVG(blockreward_usd) OVER 1year` | Activity |

<!-- TODO: sopr_ratio 공식 확인 — sth_sopr/lth_sopr vs lth_sopr/sth_sopr. API 서버 코드 기준으로 정확한 분자/분모 재검증 필요 -->

---

## 구현 1: 블록 레벨 지표 계산

> 관련 노트북: `src/bitcoin_etl_job/indicator_history.ipynb`

블록 레벨에서의 계산은 비교적 직관적이다. 각 지표는 해당 블록 시점의 값들을 조합한 단순 나눗셈이다. 0으로 나누는 경우를 방지하기 위해 모든 분모에 `NULLIF(..., 0)`을 적용한다.

```sql
-- src/bitcoin_etl_job/indicator_history.ipynb

/* ---- 신규 컬럼 7개 (velocity 포함) ---- */
CAST(DOUBLE(cdd) / NULLIF(DOUBLE(tokens_transferred_total), 0)
     AS DECIMAL(22,8)) AS dormancy,
CAST(market_cap / NULLIF(DOUBLE(addresses_count_active), 0)
     AS DECIMAL(22,8)) AS mca,
CAST(market_cap / NULLIF(DOUBLE(addresses_count_active) * DOUBLE(addresses_count_active), 0)
     AS DECIMAL(22,8)) AS nvm,
CAST(DOUBLE(sth_sopr) / NULLIF(DOUBLE(lth_sopr), 0)
     AS DECIMAL(22,8)) AS sopr_ratio,
CAST(DOUBLE(tt_sum_yearly) / NULLIF(DOUBLE(supply_total), 0)
     AS DECIMAL(16,8)) AS velocity,
CAST(DOUBLE(supply_total) / NULLIF(DOUBLE(supply_new), 0)
     AS DECIMAL(22,8)) AS stock_to_flow,
CAST(DOUBLE(blockreward_usd) / NULLIF(DOUBLE(blockreward_usd_avg_yearly), 0)
     AS DECIMAL(22,8)) AS puell_multiple,
```

`velocity`와 `puell_multiple`에 필요한 1년 rolling 데이터는 사전에 별도 뷰(`yearly_rolling_v`)로 계산한다. SQL의 `RANGE BETWEEN` window를 사용해 timestamp 기반 1년(31,536,000초) 범위를 지정한다.

```sql
-- yearly_rolling_v: RANGE BETWEEN 31536000 PRECEDING (1년 = 31,536,000초)
SELECT
    block_height,
    SUM(tokens_transferred_total) OVER (
        ORDER BY block_timestamp
        RANGE BETWEEN 31536000 PRECEDING AND CURRENT ROW
    ) AS tt_sum_yearly,
    AVG(blockreward_usd) OVER (
        ORDER BY block_timestamp
        RANGE BETWEEN 31536000 PRECEDING AND CURRENT ROW
    ) AS blockreward_usd_avg_yearly
FROM network_df
```

여기서 `RANGE BETWEEN`은 PySpark의 `rangeBetween`에 해당한다. `ROWS BETWEEN`과 달리 행 개수가 아닌 **값의 범위**로 window를 정의하므로, 블록 간격이 불규칙해도 정확히 1년치 데이터를 포함할 수 있다.

---

## 구현 2: API 공식 정합성 검증

신규 지표를 추가할 때 가장 중요한 것은 **기존 API 서버의 계산 공식과 일치하는지** 확인하는 것이다. API 서버 소스코드를 직접 확인했다.

### stock_to_flow 함정

초기 설계에서는 "1년 합산 공급량 대비"로 구현하는 방향을 검토했었다.

```
# 초기 설계안 (잘못됨)
stock_to_flow = supply_total / SUM(supply_new) OVER 1year
```

그러나 API 서버 코드 확인 결과, `supply_total / supply_new` (해당 블록의 per-block 값)을 사용하고 있었다. 초기 구현을 이 공식에 맞게 수정했다. 이 차이는 rollup 단계에서 다시 중요해진다 (후술).

### puell_multiple 확인

`blockreward_usd / AVG(blockreward_usd) OVER 1year`로 정확히 일치. daily rollup에서는 일별 발행량(`daily_issuance_usd`)을 중간 컬럼으로 생성하고 365일 이동평균을 적용한다.

### QA 결과

| 지표 | 오차율 | 판정 |
|---|---|---|
| stock_to_flow | 0.005% | PASS |
| puell_multiple | 0.03% | PASS |

---

## 구현 3: Rollup 노트북 재설계

> 관련 노트북: `src/bitcoin_etl_job/indicator_rollup.ipynb`

롤업에서 가장 복잡한 문제가 발생했다. 블록 레벨 지표를 시간 단위(hour/day)로 집계할 때, **단순히 마지막 값을 가져오면 되는 지표**와 **rollup 레벨에서 재계산이 필요한 지표**를 구분해야 한다.

### 문제 1: stock_to_flow 150배 불일치

`indicator_day` 테이블을 먼저 구축하고 값을 비교해보니 block 레벨 대비 **약 150배 차이**가 났다.

**원인 분석:**

블록 레벨에서 `stock_to_flow = supply_total / supply_new`다. 하루에 약 144개 블록이 생성되므로, 개별 블록의 `supply_new`는 매우 작다(~3.125 BTC). 반면 `supply_total`은 ~1,980만 BTC다. 그래서 per-block `stock_to_flow`는 약 634만이라는 큰 숫자가 된다.

rollup에서 `max_by(stock_to_flow, block_height)` = 마지막 블록의 per-block 값을 그대로 사용하면, 하루 단위의 stock_to_flow가 아니라 **10분 단위의 stock_to_flow**를 반환하게 된다.

**해결:** rollup 레벨에서 재계산한다. 하루치 공급량의 합(`SUM(supply_new)`)으로 나누는 것이 올바른 일간 stock_to_flow다.

```sql
-- src/bitcoin_etl_job/indicator_rollup.ipynb

-- 잘못된 방식 (block-level 값을 그대로 사용)
max_by(stock_to_flow, block_height) AS stock_to_flow  -- ~6.4M (150x 오류)

-- 올바른 방식 (rollup 레벨에서 재계산)
CAST(DOUBLE(max_by(supply_total, block_height))
    / NULLIF(SUM(DOUBLE(supply_new)), 0)
    AS DECIMAL(22,8)) AS stock_to_flow                -- ~44,000 (정상)
```

이 사례는 **"어떤 지표를 last-value로 가져오고 어떤 지표를 재계산해야 하는지"**를 명확히 구분해야 한다는 교훈을 준다. 누적 상태값(realized_cap, supply_total 등)은 `max_by`로 마지막 값을 가져오면 되지만, 비율/흐름 지표(stock_to_flow, puell_multiple 등)는 rollup 레벨에서 재계산이 필수다.

### 문제 2: puell_multiple -- Window function 2단계 처리

puell_multiple도 단순 `max_by`를 쓸 수 없다. 하루 총 발행량(`daily_issuance_usd`)을 먼저 집계한 뒤, 365일 이동평균으로 나눠야 한다.

GROUP BY 단계에서 중간 컬럼을 만들고, 이후 PySpark Window function으로 처리하는 2단계 방식을 선택했다.

```python
# src/bitcoin_etl_job/indicator_rollup.ipynb

# 1단계: GROUP BY SQL에서 daily_issuance_usd 중간 컬럼 생성
# CAST(SUM(DOUBLE(blockreward_usd)) AS DECIMAL(22,8)) AS daily_issuance_usd

# 2단계: PySpark Window function으로 puell_multiple 계산
if window == "day":
    # rowsBetween(-364, 0) = 현재 행 포함 최근 365일
    w_365 = Window.orderBy("datetime").rowsBetween(-364, 0)
    combined_with_derived = combined_df \
        .withColumn(
            "puell_multiple",
            (F.col("daily_issuance_usd") / F.avg("daily_issuance_usd").over(w_365))
            .cast("decimal(22,8)")
        ) \
        .drop("daily_issuance_usd")  # 중간 컬럼 제거 후 merge
```

여기서 `rowsBetween(-364, 0)`을 사용한 이유: daily rollup이므로 1행 = 1일이 보장된다. `rangeBetween`은 값 기반이라 datetime 컬럼의 정렬 순서에 따른 예기치 않은 동작을 피하기 위해 행 기반 window를 선택했다.

### 문제 3: Timezone-aware datetime과 SQL interpolation

`get_rollup_job_args()`가 반환하는 datetime은 timezone-aware 객체다. 이를 SQL 문자열에 직접 interpolation하면 `+09:00` 같은 suffix가 붙어 오류가 발생하거나, UTC/KST 차이로 rollup 범위가 어긋난다.

```python
# timezone strip 필수
start_ts = ret["start_ts"].strftime('%Y-%m-%d %H:%M:%S')
end_ts = ret["end_ts"].strftime('%Y-%m-%d %H:%M:%S')
```

Databricks 클러스터(UTC)와 serverless 환경(KST)에서 timezone 설정이 다를 수 있으므로, SQL에 넘기기 전에 timezone 정보를 제거하는 것이 안전하다.

### 문제 4: daily_issuance_usd 스키마 불일치

history 초기 빌드 후 incremental run을 할 때, 기존 테이블에 `daily_issuance_usd` 컬럼이 없으므로 `unionByName`이 실패한다. history DataFrame에 NULL 컬럼을 먼저 추가한 뒤 select 순서를 맞춰준다.

```python
history_df = existing_df.where(f"{time_col} < '{start_ts}'")

# 기존 테이블에 중간 컬럼이 없는 경우 대비
if "daily_issuance_usd" not in history_df.columns:
    history_df = history_df.withColumn(
        "daily_issuance_usd", F.lit(None).cast("decimal(22,8)")
    )

# 컬럼 순서를 source_filtered와 동일하게 맞춘 후 union
history_df = history_df.select(source_filtered.columns)
combined_df = history_df.unionByName(source_filtered)
```

---

## 핵심 트러블슈팅: Delta Lake CDF 테이블 재생성

이번 작업에서 가장 시간을 많이 쓴 부분이다.

### 문제 발견

`indicator_block` 초기 history build 후 PSQL ingestion을 실행하니 다음 오류가 발생했다.

```
[DELTA_MISSING_CHANGE_DATA] Error getting change data for range [0, 4]
as change data was not recorded for version [0]
```

원인을 추적해보니 `indicator_history.ipynb`에서 테이블 생성이 다음과 같이 되어 있었다.

```python
# 문제: CDF 없이 생성
indicator_df.write.mode("overwrite").saveAsTable(indicator_table)
```

### 왜 이것이 문제인가

Delta Lake의 Change Data Feed(CDF)는 테이블 속성 `delta.enableChangeDataFeed = true`가 활성화된 시점 이후의 변경 사항만 기록한다. `saveAsTable()`로 테이블을 생성하면 TBLPROPERTIES를 지정할 수 없으므로, **version 0에는 CDF 기록이 존재하지 않는다.**

나중에 `ALTER TABLE SET TBLPROPERTIES`로 CDF를 활성화해도, 이미 기록된 version 0~N은 소급 적용되지 않는다. 이는 Delta Lake의 설계상 의도된 동작이다. CDF 데이터는 write 시점에 생성되므로, 과거 write를 다시 처리할 수 없기 때문이다.

PSQL ingestion은 `init=true`일 때 version 0부터 CDF를 읽으려 하므로 실패할 수밖에 없다.

```
시간 흐름:
  v0: saveAsTable() → CDF 비활성화 상태에서 데이터 기록 (CDF 데이터 없음)
  v1: ALTER TABLE SET TBLPROPERTIES('delta.enableChangeDataFeed'='true')
  v2: replaceWhere로 데이터 갱신 → CDF 데이터 존재

  readChangeFeed(startingVersion=0) → v0에 CDF 없으므로 실패!
```

### 해결: CDF 포함 테이블 재생성

테이블을 처음부터 올바른 TBLPROPERTIES로 재생성해야 한다. 절차는 다음과 같다.

```sql
-- 1단계: CDF 포함 새 테이블 생성
CREATE TABLE tech_lakehouse_prod.bitcoin.indicator_block_new (
  block_height INT,
  datetime     TIMESTAMP,
  -- ... 컬럼 정의 생략 ...
  updated_at   TIMESTAMP
)
USING DELTA
CLUSTER BY (block_height)
TBLPROPERTIES (
  'delta.enableChangeDataFeed'    = 'true',
  'delta.columnMapping.mode'      = 'name',
  'delta.enableIcebergCompatV2'   = 'true',
  'delta.universalFormat.enabledFormats' = 'iceberg'
);

-- 2단계: 기존 데이터 이관
INSERT INTO tech_lakehouse_prod.bitcoin.indicator_block_new
SELECT * FROM tech_lakehouse_prod.bitcoin.indicator_block;

-- 3단계: 테이블 교체 (반드시 full 3-part path 사용!)
ALTER TABLE tech_lakehouse_prod.bitcoin.indicator_block
  RENAME TO tech_lakehouse_prod.bitcoin.indicator_block_old;
ALTER TABLE tech_lakehouse_prod.bitcoin.indicator_block_new
  RENAME TO tech_lakehouse_prod.bitcoin.indicator_block;
```

이렇게 하면 version 0 = CREATE TABLE (CDF 활성화), version 1 = INSERT (실제 데이터, CDF 기록 포함)이 된다. PSQL ingestion의 `init=true`는 version 1부터 자연스럽게 읽어갈 수 있다.

### Unity Catalog RENAME 주의사항

3단계에서 실수하기 쉬운 함정이 있다. `RENAME TO indicator_block` (short name)으로 쓰면, Unity Catalog는 현재 세션의 default catalog/schema로 테이블을 이동시킨다.

Unity Catalog 공식 문서에 따르면:

> For Unity Catalog tables, the `to_table_name` must reside within the same catalog. If `to_table_name` is provided without a catalog or schema qualifier, it will be implicitly qualified with the current schema.

즉 `USE CATALOG`/`USE SCHEMA`를 명시적으로 설정하지 않은 상태에서 short name을 쓰면 의도하지 않은 위치로 테이블이 이동한다. **반드시 full 3-part path를 사용해야 한다.**

```sql
-- 잘못된 방식: 테이블을 잃어버릴 수 있음
ALTER TABLE tech_lakehouse_prod.bitcoin.indicator_block_new
  RENAME TO indicator_block;
  -- default_catalog.default_schema.indicator_block 로 이동!

-- 올바른 방식: 동일 catalog.schema 내에서 이름만 변경
ALTER TABLE tech_lakehouse_prod.bitcoin.indicator_block_new
  RENAME TO tech_lakehouse_prod.bitcoin.indicator_block;
```

---

## PSQL Ingestion 초기화

CDF가 올바르게 활성화된 테이블에 대해, `info_table_ingestion` 메타데이터 테이블에 3개 테이블을 등록하고, `postgres_ingestion` 노트북을 `init=true`로 실행해 초기 데이터를 적재했다.

```python
# info_table_ingestion 등록 대상
tables = [
    "tech_lakehouse_prod.bitcoin.indicator_block",
    "tech_lakehouse_prod.bitcoin.indicator_hour",
    "tech_lakehouse_prod.bitcoin.indicator_day",
]
```

3개 테이블 모두 SUCCESS. init 이후부터는 CDF 기반 incremental ingestion이 동작한다. CDF는 변경된 행만 추적하므로, 전체 테이블을 매번 읽는 것보다 훨씬 효율적이다.

---

## Databricks Job DAG 통합

`bitcoin_job` DAG에 indicator 관련 task를 추가했다. indicator_block은 network 데이터(supply_new, blockreward_usd 등)에 의존하므로 network task 이후에 배치한다.

```
기존 DAG:
  utxo_events → utxo_stat → network → (끝)

추가 후:
  utxo_events → utxo_stat → network
                                ↓
                           indicator_block
                                ↓
                    indicator_rollup_hour
                                ↓
                    indicator_rollup_day
                                ↓
                  indicator_psql_ingestion
```

rollup task는 hour -> day 순서로 실행된다. hour rollup의 결과가 day rollup에 영향을 주는 것은 아니지만, 리소스 경합을 피하기 위해 순차 실행으로 구성했다.

---

## 핵심 교훈

### 1. Delta Lake CDF는 테이블 생성 시점부터 활성화해야 한다

`saveAsTable()`이나 `CREATE TABLE AS SELECT`(CTAS)로 생성한 테이블은 version 0에 CDF가 없다. 나중에 `ALTER TABLE SET TBLPROPERTIES`로 활성화해도 기존 버전에는 소급 적용되지 않는다. **CDF가 필요한 테이블은 `CREATE TABLE` + `TBLPROPERTIES`로 처음부터 만들어야 한다.** 이미 데이터가 있다면, 새 테이블을 만들고 `INSERT INTO ... SELECT`로 이관하는 수밖에 없다.

### 2. Block-level 지표와 Rollup-level 지표는 다르다

`stock_to_flow`처럼 블록 단위에서는 단순 나눗셈이지만, 일간 rollup에서는 재계산이 필요한 지표가 있다. `max_by(metric, block_height)`를 무분별하게 쓰면 150배 오차가 발생할 수 있다. 지표를 추가할 때마다 **"이 지표는 last-value인가, 재계산 대상인가?"**를 반드시 확인해야 한다.

| 유형 | rollup 방식 | 예시 |
|---|---|---|
| 누적 상태값 | `max_by(col, block_height)` | realized_cap, supply_total, mvrv |
| 비율/흐름 지표 | rollup에서 재계산 | stock_to_flow, puell_multiple, dormancy |
| 합산 지표 | `SUM(col)` | cdd, tokens_transferred |

### 3. Unity Catalog RENAME은 반드시 full 3-part path

short name으로 RENAME하면 테이블이 default catalog/schema로 이동해 찾기 어려워진다. 이 동작은 Unity Catalog 공식 문서에 명시되어 있지만, 실수하기 매우 쉽다.

### 4. Timezone-aware datetime은 SQL interpolation 전에 strip해야 한다

Databricks 클러스터(UTC)와 serverless(KST) 환경 차이로 timezone-aware datetime을 SQL에 직접 넣으면 rollup 범위가 어긋날 수 있다. `.strftime('%Y-%m-%d %H:%M:%S')`로 naive datetime 문자열로 변환하는 것이 안전하다.

---

## 흔한 실수와 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `DELTA_MISSING_CHANGE_DATA` for version 0 | CDF 없이 `saveAsTable()`로 테이블 생성 | CDF 포함 새 테이블 생성 후 데이터 이관 |
| stock_to_flow rollup이 150x 큼 | `max_by`로 per-block 값 사용 | `supply_total / SUM(supply_new)`로 재계산 |
| `unionByName` 실패 | incremental 시 중간 컬럼 부재 | `withColumn(col, lit(None))` 추가 |
| rollup 범위 어긋남 | timezone-aware datetime의 SQL interpolation | `strftime()`으로 timezone strip |
| RENAME 후 테이블 행방불명 | short name 사용 | full 3-part path 사용 |

---

## 다음 단계

- `utxo_base_init.ipynb`의 datetime JOIN을 `block_height` JOIN으로 수정
- Process B, Market, Network incremental + rollup Databricks 테스트
- Exchange Inflow PSQL ingestion 작업
- Databricks system table 모니터링 대시보드 배포

---

## 참고 자료

- 관련 노트북:
  - `src/bitcoin_etl_job/indicator_history.ipynb` -- 블록 레벨 지표 계산
  - `src/bitcoin_etl_job/indicator.ipynb` -- incremental 블록 지표
  - `src/bitcoin_etl_job/indicator_rollup.ipynb` -- hour/day 롤업
- Job 설정: `resources/tech_databricks_workflow.job.yml`
- [Delta Lake Change Data Feed 공식 문서](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Databricks ALTER TABLE RENAME TO 문서](https://docs.databricks.com/sql/language-manual/sql-ref-syntax-ddl-alter-table.html)
- [PySpark Window Functions API Reference](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Window.html)
