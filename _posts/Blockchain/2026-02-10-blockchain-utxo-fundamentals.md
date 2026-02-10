---
title: "[Blockchain] UTXO 모델 기본 개념 - 비트코인 데이터 구조 이해"
categories:
  - Blockchain
tags:
  - [Bitcoin, UTXO, OP_RETURN, nulldata, OnChain]
---

# Introduction

---

비트코인 온체인 데이터를 다룰 때 반드시 알아야 하는 UTXO 모델과 관련 개념들을 정리합니다.

# 1. UTXO란?

---

**UTXO (Unspent Transaction Output)** = 아직 소비되지 않은 트랜잭션 출력.

비트코인에는 "잔고"라는 개념이 없습니다. 대신, 지갑이 보유한 UTXO들의 합이 잔고입니다.

```text
Transaction A:
  Input:  (이전 TX의 output 10 BTC 사용)
  Output: → Alice 7 BTC (UTXO 생성)
          → Bob 3 BTC   (UTXO 생성)

Alice의 잔고 = Alice가 소유한 모든 UTXO의 value 합계
```

## UTXO 생명주기

```text
1. 생성 (created): 트랜잭션 output으로 생성됨
   → created_block_height, value, created_price 기록

2. 미소비 (unspent): UTXO set에 존재
   → 다른 트랜잭션의 input으로 사용될 때까지 대기

3. 소비 (spent): 다른 트랜잭션의 input으로 사용됨
   → spent_block_height, spent_price 기록
   → UTXO set에서 제거
```

## UTXO set

특정 블록 높이 시점에서 **아직 소비되지 않은 모든 UTXO의 집합**입니다.

```text
UTXO set at block N:
  = 모든 output 중
    created_block_height <= N
    AND (spent_block_height IS NULL OR spent_block_height > N)
```

비트코인 네트워크의 `utxo_count`는 이 집합의 크기입니다 (약 1.1억 개, 2023년 기준).

# 2. Transaction 구조

---

```text
Transaction:
  ┌─ Inputs (vin) ────────────────────┐
  │  input[0]: 이전 TX의 output 참조   │  ← 기존 UTXO 소비
  │  input[1]: ...                     │
  │  (coinbase TX는 input 없음)        │
  └────────────────────────────────────┘
  ┌─ Outputs (vout) ──────────────────┐
  │  output[0]: 7 BTC → address_A     │  ← 새 UTXO 생성
  │  output[1]: 3 BTC → address_B     │  ← 새 UTXO 생성
  │  output[2]: 0 BTC → OP_RETURN ... │  ← UTXO 아님 (unspendable)
  └────────────────────────────────────┘
```

### Coinbase Transaction

각 블록의 첫 번째 트랜잭션. 채굴 보상을 생성합니다.
- Input이 없음 (이전 UTXO를 소비하지 않음)
- UTXO 계산 시 input에서 `is_coinbase = false` 필터가 필요한 이유

# 3. OP_RETURN (nulldata)

---

**OP_RETURN**은 비트코인 스크립트에서 **증명 가능하게 소비 불가능한(provably unspendable)** output을 만드는 명령어입니다.

```text
output: 0 BTC → OP_RETURN <arbitrary data>
```

### 특징
- **value = 0**: 관례적으로 0 BTC (프로토콜상 non-zero도 가능하나, 소비 불가하므로 BTC가 영구 소각됨)
- **소비 불가**: 어떤 트랜잭션도 이 output을 input으로 사용할 수 없음
- **데이터 저장용**: 최대 80 bytes 임의 데이터 삽입 가능
- `address_type = 'nulldata'`로 분류됨

### 용도
- 타임스탬프 증명 (OpenTimestamps)
- 토큰 프로토콜 메타데이터 (Omni Layer, Counterparty)
- 기타 임의 데이터 기록

### UTXO set과의 관계

Bitcoin Core는 OP_RETURN output을 **UTXO set에 포함하지 않습니다** (소비 불가하므로 추적할 필요 없음).

```text
네트워크 utxo_count 계산:
  vout = SELECT COUNT(*) FROM outputs WHERE address_type <> 'nulldata'
  vin  = SELECT COUNT(*) - 1 FROM inputs  -- coinbase 제외
  utxo_count = cumulative(vout - vin)
```

따라서 raw 데이터로 UTXO 테이블을 구축하면 OP_RETURN output이 영원히 `spent = NULL`로 남아, 네트워크 utxo_count와 차이가 발생합니다.

```text
예시 (block 800,000 기준):
  raw 테이블 unspent count:  ~164M (OP_RETURN 포함)
  네트워크 utxo_count:       ~111M (OP_RETURN 제외)
  차이:                      ~52M  (nulldata outputs)
```

### 처리 전략

소스 테이블(utxo_base)에서 제외하기보다, **쿼리 레벨에서 필터**하는 것이 권장됩니다:
- 소스 테이블은 완전성 유지 (향후 OP_RETURN 분석 가능)
- value = 0이므로 금액 기반 메트릭(supply, realized cap, CDD 등)에는 영향 없음
- count 기반 메트릭에서만 필터 필요

# 4. 주요 온체인 메트릭 개념

---

UTXO 데이터에서 파생되는 주요 메트릭들입니다.

### 금액 기반

| 메트릭 | 계산 | 설명 |
|--------|------|------|
| Realized Cap | SUM(value * created_price) for all unspent | 각 UTXO의 "취득 원가" 합계 |
| NUPL | (Market Cap - Realized Cap) / Market Cap | 미실현 손익 비율 |

### 소비(Spent) 기반

| 메트릭 | 계산 | 설명 |
|--------|------|------|
| CDD | SUM(value * age_days) | 소비된 UTXO의 "코인 일수" 파괴량 |
| SOPR | SUM(value * spent_price) / SUM(value * created_price) | 소비 시점 손익률 |
| aSOPR | SOPR에서 1시간 미만 보유 UTXO 제외 | 단기 노이즈 제거 |

### 분포 기반

| 메트릭 | 기준 | 범위 예시 |
|--------|------|----------|
| Age Distribution | UTXO 생존 기간 | 0d-1d, 1d-1w, ..., 10y+ (13 ranges) |
| Supply Distribution | UTXO BTC 금액 | <0.01, 0.01-0.1, ..., 10k+ (8 ranges) |
| Realized Distribution | UTXO USD 가치 | <$1, $1-10, ..., $1M+ (8 ranges) |

### STH / LTH 분류

```text
Short-Term Holder (STH): 보유 기간 < 155일 (13,392,000초)
Long-Term Holder (LTH):  보유 기간 >= 155일

주의: 1시간(3600초) 미만은 very_short으로 별도 분류
  very_short: < 3600초
  short(STH): >= 3600초 AND < 13,392,000초
  long(LTH):  >= 13,392,000초
```

# 5. 데이터 파이프라인에서의 주의사항

---

### 가격 JOIN 누락
초기 블록(2010년 이전)은 거래소 가격 데이터가 없어 `LEFT JOIN` 시 NULL 발생. `COALESCE(price, 0)` 처리 필요.

### Value 단위
raw 테이블의 value는 보통 BTC 단위 (`DECIMAL(16,8)`). satoshi 단위인 경우 `/ 1e8` 변환 필요.

### SOPR 분모 0
특정 블록에서 소비된 UTXO가 모두 created_price = 0이면 분모가 0. NULL 반환 권장 (`NULLIF` 사용).

### Age 계산 정밀도
```text
age_days = (spent_timestamp - created_timestamp) / 86400.0

주의: 정수 나눗셈 방지를 위해 86400.0 (float) 사용
CDD에서는 fractional days, Age bucketing에서는 FLOOR 적용
```
