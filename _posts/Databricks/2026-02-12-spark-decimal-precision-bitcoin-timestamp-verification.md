---
title: "[Databricks] Spark DECIMAL 정밀도 손실과 Bitcoin 타임스탬프 역전 -- 두 가지 버그의 데이터 검증기"
categories:
  - Databricks
tags:
  - Spark
  - Databricks
  - UTXO
  - Bitcoin
  - Decimal
  - Precision
  - Data Validation
---

## 들어가며

Bitcoin UTXO 메트릭을 Spark/Databricks로 마이그레이션하는 과정에서 두 가지 치명적인 버그를 발견하고 수정했습니다.

1. **Spark DECIMAL 나눗셈 정밀도 손실** -- 소수점 8자리를 기대했으나 4~6자리만 저장
2. **Bitcoin 타임스탬프 역전으로 인한 UTXO 누락** -- 음수 age 발생으로 JOIN 실패

이 글은 **버그 수정이 실제 데이터에 어떤 영향을 미쳤는지** 4개 CSV 파일 쌍(수정 전/후)을 비교 분석하여 검증한 과정을 다룹니다. 실무 데이터 파이프라인에서 정밀도 손실과 블록체인의 비직관적인 특성이 어떻게 버그로 이어지는지, 구체적인 수치와 함께 살펴봅니다.

이 글을 읽고 나면 다음을 이해할 수 있습니다:

- Spark SQL에서 DECIMAL 나눗셈의 precision/scale 산출 규칙과 precision 38 cap이 왜 문제가 되는지
- Bitcoin 블록 타임스탬프의 비단조성(non-monotonicity)이 데이터 파이프라인에 미치는 영향
- 여러 버그를 동시에 수정했을 때, 컬럼별로 영향을 분리 검증하는 체계적 방법

---

## 배경: Bitcoin UTXO 메트릭 파이프라인

### 마이그레이션 개요

CryptoQuant의 Bitcoin UTXO 메트릭 파이프라인을 Python/RocksDB 기반(처리 시간 ~100시간)에서 Spark/Databricks로 이관하는 프로젝트를 진행 중입니다. 목표는 10시간 이내 처리입니다.

약 **2.5B(25억) 개의 개별 UTXO**를 집계하여 10개의 output 테이블을 생성합니다:

| 그룹 | 테이블 | 설명 |
|------|--------|------|
| A-1 | `utxo_block_metrics` | 블록별 집계 (supply, realized, SCA, profit/loss 등 22컬럼) |
| A-2 ~ A-7 | age distribution 6종 | Age 버킷별 supply/realized/count 피벗 (각 13~39 컬럼) |
| B-1 ~ B-3 | supply/realized distribution | Supply/Realized 버킷별 분포 (32+16+24 컬럼) |

### 파이프라인 구조

```
Phase 0: utxo_base(2.5B) --> utxo_events_block(~200M, 사전 집계)
Phase 1: 스냅샷 생성 (unspent_utxo_snapshot, supply/realized)
Phase 2: 2-Process 병렬
         |- Process A: unspent_age_v --> age_agg_v --> A-1~A-7
         |- Process B: batch_utxo_v --> supply/realized --> B-1~B-3
```

이 글에서 다루는 두 버그는 모두 **Process A** (age 기반 메트릭)에서 발생했습니다.

---

## 버그 #1: Spark DECIMAL 나눗셈 정밀도 손실

### 증상

A-1 테이블의 `supply_profit_percent`, `supply_loss_percent` 컬럼이 소수점 8자리를 기대했으나 실제로는 4~6자리만 유효했습니다.

```sql
-- 기대: 43.76926296 (소수점 8자리)
-- 실제: 43.769200   (소수점 4자리 수준, 나머지는 0 패딩)
```

### 근본 원인: Spark의 DECIMAL precision/scale 산출 규칙

Spark SQL은 SQL 표준(Hive/MS SQL 기반)에 따라 DECIMAL 연산의 결과 타입을 계산합니다. 나눗셈의 경우:

```
DECIMAL(p1, s1) / DECIMAL(p2, s2) 결과:
  precision = p1 - s1 + s2 + max(6, s1 + p2 + 1)
  scale     = max(6, s1 + p2 + 1)
```

그런데 Spark의 DECIMAL **최대 precision은 38**입니다. 계산된 precision이 38을 초과하면 scale이 강제로 축소됩니다.

실제 예를 들어보면, `profit_supply`와 `total_supply`는 `SUM(unspent_value)`의 결과입니다. `unspent_value`가 `DECIMAL(22,8)`이라면 `SUM` 결과는 `DECIMAL(32,8)`로 확장됩니다. 이 둘의 나눗셈을 계산하면:

```
DECIMAL(32,8) / DECIMAL(32,8):
  scale     = max(6, 8 + 32 + 1) = 41
  precision = 32 - 8 + 8 + 41    = 73

  73 > 38이므로 precision cap 적용:
  precision = 38
  scale     = max(6, 38 - (73 - 41)) = max(6, 6) = 6
```

결과 타입은 **`DECIMAL(38, 6)`** -- 소수점 6자리까지만 보존됩니다. 이 값을 다시 `CAST(... AS DECIMAL(12,8))`로 저장해도, **중간 계산에서 이미 잘린 값**이므로 복구할 수 없습니다.

### 수정: DOUBLE() wrapping

```sql
-- [수정 전] DECIMAL / DECIMAL --> precision cap --> scale 축소
CAST(profit_supply / NULLIF(total_supply, 0) * 100 AS DECIMAL(12,8))
-- 결과: 43.769200 (유효 4~6자리)

-- [수정 후] DOUBLE 변환 후 나눗셈 --> IEEE 754 부동소수점, ~15자리 유효숫자
CAST(DOUBLE(profit_supply) / DOUBLE(total_supply) * 100 AS DECIMAL(12,8))
-- 결과: 43.76926296 (유효 8자리)
```

DOUBLE은 IEEE 754 배정밀도 부동소수점으로 약 15~17자리의 유효숫자를 제공합니다. BTC supply 수준(최대 2,100만)의 나눗셈에서 소수점 8자리는 충분히 안전합니다.

### 영향 범위

**A-1의 `supply_profit_percent`, `supply_loss_percent`만 해당.** 다른 percent 컬럼(`profit_cnt / total_count` 등)은 `BIGINT / BIGINT` 나눗셈인데, Spark는 정수끼리의 `/` 연산을 자동으로 DOUBLE로 승격하므로 이 문제가 발생하지 않습니다.

```sql
-- BIGINT / BIGINT --> Spark가 자동으로 DOUBLE 변환 (문제 없음)
SELECT profit_cnt / NULLIF(total_count, 0) * 100  -- 결과: DOUBLE

-- DECIMAL / DECIMAL --> precision cap 적용 (문제 발생!)
SELECT profit_supply / NULLIF(total_supply, 0) * 100  -- 결과: DECIMAL(38, 6)
```

---

## 버그 #2: Bitcoin 타임스탬프 역전으로 인한 UTXO 누락

### 증상

일부 블록에서 age 기반 메트릭(A-1~A-7)의 supply, count가 실제보다 적게 집계되었습니다. 특정 UTXO가 완전히 누락된 것입니다.

### 근본 원인: Bitcoin 블록 타임스탬프의 비단조성

Bitcoin 프로토콜에서 블록 타임스탬프는 **단조 증가가 아닙니다**. 유효성 조건은 다음 두 가지뿐입니다:

1. **MTP(Median Time Past) 규칙**: 직전 11개 블록의 중앙값보다 커야 함
2. **미래 제한**: 네트워크 시간 기준 2시간 이내

즉, 직전 블록보다 **이전 타임스탬프**를 가진 블록이 유효할 수 있습니다.

```
블록 100: timestamp = 1231006505
블록 101: timestamp = 1231006500  <-- 5초 이전! (유효)
```

이로 인해 UTXO의 "나이"를 계산할 때 음수가 발생합니다:

```sql
-- target_block의 timestamp가 created_block의 timestamp보다 작을 수 있음
CAST(FLOOR((target_timestamp - created_timestamp) / 86400) AS INT) AS age_day_int
-- 예: target=1231006500, created=1231006505 --> age_day_int = -1
```

`age_bins` 테이블은 `[0, 1)`, `[1, 7)`, `[7, 30)`, ... 범위만 정의합니다. 음수 `age_day_int`는 어떤 범위에도 매칭되지 않아 **INNER JOIN에서 해당 UTXO가 완전히 탈락**합니다.

```sql
-- age_bins 구조 (13개 범위)
-- min_day | max_day | age_range
--       0 |       1 | '0d_1d'
--       1 |       7 | '1d_1w'
--       7 |      30 | '1w_1m'
--     ... |     ... | ...

-- 음수 age_day_int = -1은 어디에도 매칭 안 됨 --> UTXO 누락
JOIN age_bins b ON u.age_day_int >= b.min_day AND u.age_day_int < b.max_day
```

### 수정: GREATEST()로 음수 클램핑

```sql
-- [수정 전]
(target_timestamp - created_timestamp) / 86400.0 AS age_days,
CAST(FLOOR((target_timestamp - created_timestamp) / 86400) AS INT) AS age_day_int

-- [수정 후] 음수 age를 0으로 클램핑
GREATEST((target_timestamp - created_timestamp) / 86400.0, 0) AS age_days,
CAST(GREATEST(FLOOR((target_timestamp - created_timestamp) / 86400), 0) AS INT) AS age_day_int
```

`unspent_age_v`와 `spent_age_v` 양쪽 뷰에 동일하게 적용했습니다. 클램핑된 UTXO는 최연소 버킷 `0d_1d`에 배치됩니다. 타임스탬프 역전 폭이 대부분 수 초~수 분 이내이므로, "0일차" 처리는 의미론적으로도 합리적입니다.

### 영향 범위

**A-1~A-7 (age 기반 메트릭만 해당).** B-1~B-3은 supply/realized 버킷 기반이므로 타임스탬프 계산이 관여하지 않아 영향 없습니다.

---

## 검증 전략

### 접근 방법

4개 CSV 파일 쌍(수정 전/후)을 pandas로 inner join하여 컬럼별 차이를 분석했습니다. 블록 범위를 다양하게 선정하여 두 fix의 효과를 분리 확인합니다.

| # | 파일 | 블록 범위 | 특징 |
|---|------|-----------|------|
| 1 | statistics_block | 0 ~ 20,000 | price=0, DECIMAL fix 효과 확인 불가 |
| 2 | age_distribution | 0 ~ 49,999 | age 분포, GREATEST fix 효과 집중 확인 |
| 3 | SCA age distribution | 40,000 ~ 59,999 | supply x age 가중치, 두 fix 복합 |
| 4 | statistics_block | 40,000 ~ 59,999 | price>0, DECIMAL fix 효과 확인 가능 |

**핵심 원칙**: 각 컬럼이 어느 fix의 영향을 받는지 사전에 매핑합니다.

| 컬럼 유형 | 영향받는 Fix | 검증 포인트 |
|----------|-------------|-----------|
| 값 컬럼 (supply, count) | GREATEST fix | 누락 복구 --> 값 증가 |
| percent (DECIMAL/DECIMAL 나눗셈) | DECIMAL fix | 소수점 자릿수 증가 |
| percent (BIGINT/BIGINT 나눗셈) | 영향 없음 | 차이 없어야 함 |

### 검증 코드 구조

```python
import pandas as pd
import numpy as np

# 수정 전/후 파일 로드
prev_df = pd.read_csv("statistics_block_prev.csv")
after_df = pd.read_csv("statistics_block_after.csv")

# Inner join: 공통 block_height만 비교
merged = prev_df.merge(after_df, on="block_height", suffixes=("_prev", "_after"))

# 컬럼별 차이 분석
value_cols = ["unspent_utxo_total_supply", "unspent_utxo_total_count", "sca"]
percent_cols = ["supply_profit_percent", "supply_loss_percent"]

for col in value_cols + percent_cols:
    diff = merged[f"{col}_after"] - merged[f"{col}_prev"]
    changed = diff[diff != 0]
    if len(changed) > 0:
        print(f"{col}: {len(changed)} blocks changed")
        print(f"  min diff: {changed.min():.8f}")
        print(f"  max diff: {changed.max():.8f}")
        print(f"  mean diff: {changed.mean():.8f}")
    else:
        print(f"{col}: no change (expected)")
```

---

## 검증 결과

### 1. statistics_block (블록 0~20,000, price=0)

**DECIMAL fix**: price=0이라 모든 percent가 0 --> 정밀도 차이 확인 불가. 이 구간에서는 DECIMAL fix의 효과를 분리 검증할 수 없습니다.

**GREATEST fix**: **337개 블록**에서 차이 발견

| 패턴 | 블록 수 | supply 차이 | count 차이 | 해석 |
|------|---------|------------|-----------|------|
| 코인베이스 1개 복구 | 325 | +50 BTC | +1 | 타임스탬프 역전 1회 |
| 코인베이스 2~3개 복구 | 12 | +100 BTC | +2~3 | 연속 역전 또는 다중 역전 |

초기 블록 리워드가 50 BTC이므로, 차이가 정확히 50 BTC 배수로 나타납니다. 타임스탬프 역전으로 누락된 코인베이스 UTXO가 GREATEST 클램핑으로 복구된 것입니다.

### 2. age_distribution (블록 0~49,999)

**파일 크기 변화**:

```
수정 전: 40,000 rows
수정 후: 50,000 rows (+10,000 rows)
```

10,000 rows 증가는 이전에 출력되지 않았던 블록의 age distribution 행이 새로 생성되었음을 의미합니다.

**GREATEST fix**: **735개 블록**에서 `range_0d_1d` 버킷만 차이 발생

- 총 **901개 코인베이스 UTXO** 복구
- **45,050 BTC** 복구 (901 x 50 BTC)
- 전부 +50 BTC 배수 (이 시기 블록 리워드)

왜 `0d_1d` 버킷만 변했을까요? 음수 age가 0으로 클램핑되므로 `age_day_int = 0`이 되고, 이는 정확히 최연소 버킷 `[0, 1)`에 배치됩니다. 타임스탬프 역전 폭이 1일 미만이기 때문에 다른 버킷에는 영향이 없습니다.

**DECIMAL fix**: percent 컬럼 정밀도 대폭 향상

```
수정 전: 0.42560000 (유효 4자리, 나머지 0 패딩)
수정 후: 0.42563777 (유효 8자리)
```

percent 컬럼의 합이 100%에 얼마나 가까운지를 오차 지표로 검증합니다:

```python
# percent 컬럼 합산 오차 비교
prev_pct_cols = [c for c in prev_df.columns if 'percent' in c]
after_pct_cols = [c for c in after_df.columns if 'percent' in c]

prev_sum = prev_df[prev_pct_cols].sum(axis=1)
after_sum = after_df[after_pct_cols].sum(axis=1)

prev_error = abs(prev_sum - 100).mean()   # 0.00502
after_error = abs(after_sum - 100).mean()  # 0.0000005

print(f"수정 전 평균 오차: {prev_error:.5f}")
print(f"수정 후 평균 오차: {after_error:.7f}")
print(f"오차 개선: {prev_error / after_error:,.0f}배")  # 10,040배
```

100% 합산 오차가 **10,040배 개선**되었습니다. DECIMAL(38,6) 나눗셈에서 잘린 소수점 이하 값들이 누적되어 합산 시 유의미한 오차로 나타났던 것이, DOUBLE 변환으로 해소된 것입니다.

### 3. SCA age distribution (블록 40,000~59,999)

**DECIMAL fix**: val/pct 모두 정밀도 향상

```
val: 0.003526   --> 0.00352645 (유효 6자리 --> 8자리)
pct: 유효 ~4자리 --> 유효 8자리
```

**GREATEST fix**: SCA(Supply-weighted Coin Age)는 `supply x age_days`로 계산됩니다. 클램핑된 UTXO는 `age_days = 0`이므로, 복구되어도 SCA 기여값은 0입니다. 따라서 UTXO 복구가 SCA 값에 미치는 직접적 영향은 없습니다.

### 4. statistics_block (블록 40,000~59,999, price 있음)

이 구간에서는 price > 0이므로 DECIMAL fix의 효과를 온전히 확인할 수 있습니다.

**DECIMAL fix**: `supply_profit_percent`, `supply_loss_percent`만 영향

```
수정 전: 43.7693     (유효 4자리)
수정 후: 43.76926296 (유효 8자리)
```

다른 percent 컬럼(`cnt_profit_percent` 등)은 BIGINT/BIGINT 나눗셈이므로 차이가 없습니다. 이는 "DECIMAL/DECIMAL 나눗셈만 영향받는다"는 가설을 정확히 확인해 줍니다.

**GREATEST fix**:

| 컬럼 | 차이 블록 수 | 설명 |
|------|------------|------|
| `unspent_utxo_total_supply` | 0 | supply 합계는 age_bins를 거치지 않으므로 변함없음 |
| `sca` | 375 | age_days 가중치 변화 (0 클램핑으로 미세 차이) |
| `scda`, `unrealized_profit/loss` | 소수 | 미세한 정밀도 차이 |

`unspent_utxo_total_supply`에 차이가 없는 이유: 이 컬럼은 `SUM(supply)` over all age ranges이므로, UTXO가 어느 버킷에 배치되든 합계는 동일합니다. 반면 `sca = SUM(supply x age_days)`는 `age_days` 값이 바뀌므로(음수 --> 0) 미세한 차이가 발생합니다.

---

## 주의할 점

### 1. Spark DECIMAL 나눗셈의 precision cap을 이해하라

Spark의 DECIMAL 나눗셈 결과 타입은 다음 공식으로 결정됩니다:

```
DECIMAL(p1, s1) / DECIMAL(p2, s2):
  result_scale     = max(6, s1 + p2 + 1)
  result_precision = p1 - s1 + s2 + result_scale

  if result_precision > 38:
    result_precision = 38
    result_scale     = max(6, 38 - (result_precision_before_cap - result_scale))
```

<!-- TODO: verify -- Spark 4.x에서 이 공식이 변경되었는지 확인 필요 (DecimalPrecisionTypeCoercion.scala) -->

실무에서 이 공식을 외울 필요는 없습니다. **실전 규칙은 간단합니다**:

```sql
-- DECIMAL / DECIMAL: precision cap으로 scale 축소 위험
SELECT profit_supply / total_supply AS pct  -- DECIMAL(38, 6) -- 소수점 6자리만

-- DOUBLE() wrapping: IEEE 754 ~15자리 유효숫자
SELECT DOUBLE(profit_supply) / DOUBLE(total_supply) AS pct  -- ~15자리 유효
```

**판별 방법**: 나눗셈 연산의 좌/우 피연산자가 모두 DECIMAL인지, 아니면 하나라도 BIGINT/INT인지 확인합니다. Spark는 `BIGINT / BIGINT`를 자동으로 DOUBLE로 승격하므로 문제가 없지만, `DECIMAL / DECIMAL`은 DECIMAL 타입을 유지하면서 precision cap이 적용됩니다.

### 2. Bitcoin 타임스탬프는 비단조(Non-Monotonic)

Bitcoin 프로토콜의 MTP(Median Time Past) 규칙은 직전 11개 블록의 중앙값만 검증합니다. 직전 블록보다 타임스탬프가 작아도 유효합니다. 이것은 Bitcoin Core의 의도된 동작이며, 마이너의 시스템 시간 오차나 의도적 설정으로 빈번하게 발생합니다.

블록체인 데이터에서 **시간 차이(age, duration)를 계산할 때는 항상 음수 가능성을 고려**해야 합니다:

```sql
-- 방어 패턴: GREATEST()로 하한 클램핑
GREATEST(target_timestamp - created_timestamp, 0)

-- 범위 조인(range join) 전에 경계값 검증
-- age_bins가 [0, ...) 범위만 커버한다면, 입력도 >= 0이어야 함
```

### 3. 여러 수정 사항의 영향을 컬럼별로 분리 검증하라

수정 사항이 여러 개일 때는 "어느 컬럼이 어느 fix의 영향을 받는가"를 사전에 매핑하고, 검증 시 이 매핑대로 결과가 나오는지 확인해야 합니다. 예상 외의 컬럼에서 차이가 발생하면 추가 버그의 신호일 수 있습니다.

이번 검증에서의 매핑 예시:

```
DECIMAL fix --> supply_profit_percent, supply_loss_percent만 영향
GREATEST fix --> supply, count 값에 영향 (percent에도 간접 영향)
BIGINT/BIGINT percent --> 두 fix 모두 영향 없음 (대조군 역할)
```

### 4. 타임스탬프 역전 구간 식별을 통한 선별 패치

GREATEST fix는 전체 데이터를 재실행하지 않아도, 타임스탬프 역전이 발생한 배치만 선별하여 패치할 수 있습니다.

```sql
-- 타임스탬프 역전 블록 범위 식별
WITH block_ts AS (
    SELECT
        block_height,
        timestamp,
        LAG(timestamp) OVER (ORDER BY block_height) AS prev_timestamp
    FROM block_metadata
)
SELECT
    block_height,
    timestamp,
    prev_timestamp,
    prev_timestamp - timestamp AS reversal_seconds
FROM block_ts
WHERE timestamp < prev_timestamp;
```

전체 빌드 재실행 대신 **역전 구간이 포함된 배치만 패치**하면 처리 시간을 대폭 단축할 수 있습니다. A-1~A-7만 재실행하면 되고, B-1~B-3은 불필요합니다.

---

## 검증 결과 요약

| 검증 항목 | 결과 | 수치 |
|-----------|------|------|
| GREATEST fix: 누락 UTXO 복구 | 확인됨 | 337~735 블록, 901 UTXO, 45,050 BTC |
| GREATEST fix: 0d_1d 버킷만 영향 | 확인됨 | 다른 age 버킷 차이 0 |
| DECIMAL fix: 소수점 정밀도 향상 | 확인됨 | 유효 4자리 --> 8자리 |
| DECIMAL fix: 100% 합산 오차 개선 | 확인됨 | 10,040배 개선 |
| DECIMAL fix: supply_profit/loss_percent만 영향 | 확인됨 | 다른 percent 컬럼 차이 0 |
| B-1~B-3 영향 없음 | 확인됨 | age 무관 (supply/realized 버킷 기반) |

---

## 다음 단계

### Databricks 결과 vs PostgreSQL 기존 데이터 비교

현재까지는 수정 전/후 Spark 결과 간 비교만 수행했습니다. 다음 단계는 기존 Python/RocksDB 파이프라인 결과(PostgreSQL에 저장)와 Spark 결과를 sampling 비교하여 전체 파이프라인의 정합성을 검증하는 것입니다. 특히 price=0에서 price>0으로 전환되는 구간(블록 ~28,000 부근)의 경계 동작이 중요합니다.

### Exchange Inflow 메트릭 검증

07 Exchange Inflow(entity 기반)은 아직 Databricks 실행 테스트 전입니다. 이벤트 기반 아키텍처(스냅샷 불필요)로 UTXO 메트릭과는 구조가 다르지만, 동일한 컬럼별 분리 검증 방법론을 적용할 예정입니다.

### Market 메트릭 (SOPR, CDD) 이관

03 Market 메트릭은 설계만 완료된 상태입니다. UTXO 메트릭 검증 완료 후 착수합니다.

---

## 참고 자료

### 프로젝트 내부 문서

- `docs/spark/06_optimized_queries.md` -- 전체 아키텍처, Phase 0/1/2
- `docs/spark/06a_process_a.md` -- Process A 쿼리 (age + metrics, A-1~A-7)
- `docs/spark/06b_process_b.md` -- Process B 쿼리 (supply + realized, B-1~B-3)
- `docs/spark/04_optimization.md` -- 검증 전략 및 마이그레이션 체크리스트

### 외부 참고 자료

- [Bitcoin Block Timestamp - Bitcoin Wiki](https://en.bitcoin.it/wiki/Block_timestamp)
- [Spark DECIMAL precision/scale 산출 규칙 (DecimalPrecision.scala)](https://github.com/apache/spark/blob/master/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/DecimalPrecision.scala)
- [Spark SQL Data Types (DECIMAL)](https://spark.apache.org/docs/latest/sql-ref-datatypes.html)
- [Databricks DECIMAL Type Documentation](https://docs.databricks.com/aws/en/sql/language-manual/data-types/decimal-type)
- [SPARK-27089: Loss of precision during decimal division (Jira)](https://issues.apache.org/jira/browse/SPARK-27089)
- [Understand Decimal precision and scale calculation in Spark](http://www.openkb.info/2021/05/understand-decimal-precision-and-scale.html)

---

## 핵심 교훈

1. **Spark DECIMAL 나눗셈은 precision 38 cap에 주의** -- `DECIMAL / DECIMAL` 나눗셈에서 scale이 6자리로 축소될 수 있습니다. percent 컬럼처럼 소수점 정밀도가 중요한 경우 `DOUBLE()` wrapping을 적용하세요.
2. **Bitcoin 타임스탬프는 비단조(non-monotonic)** -- 블록체인 데이터에서 시간 차이를 계산할 때 `GREATEST(..., 0)` 클램핑은 선택이 아닌 필수입니다. 범위 조인과 결합되면 JOIN 실패로 데이터가 조용히 누락됩니다.
3. **검증은 컬럼별로 분리** -- 여러 수정 사항을 동시에 적용했다면, 각 fix가 영향을 미치는 컬럼을 사전에 매핑하고 대조군(영향 없는 컬럼)으로 교차 검증하세요.
4. **수치로 말하기** -- "337개 블록, 901개 UTXO, 45,050 BTC 복구, 오차 10,040배 개선"처럼 구체적인 impact를 측정하면 수정의 정당성과 완전성을 객관적으로 입증할 수 있습니다.
