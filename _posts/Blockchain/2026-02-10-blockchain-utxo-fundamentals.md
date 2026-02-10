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

핵심은 UTXO가 **분할 불가능한 단위**라는 점입니다. 10 BTC짜리 UTXO에서 3 BTC만 꺼내 쓸 수 없고, 반드시 10 BTC 전체를 소비한 뒤 새 UTXO를 생성해야 합니다.

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

# 2. 거스름돈 (Change Output)

---

UTXO는 분할 불가능하므로, 보내려는 금액보다 UTXO가 클 때 **거스름돈**이 발생합니다.

```text
Alice가 Bob에게 3 BTC를 보내려 함
Alice가 보유한 UTXO: 10 BTC (UTXO #1)

Transaction:
  Input:  UTXO #1 (10 BTC) ← 전액 소비
  Output: → Bob 3 BTC       ← 송금액
          → Alice 6.9999 BTC ← 거스름돈 (새 UTXO)
          (차액 0.0001 BTC = 수수료, output에 포함되지 않음)
```

| 구분 | 설명 |
|------|------|
| 송금액 | 받는 사람에게 가는 output |
| 거스름돈 | 보내는 사람에게 돌아오는 output (새 UTXO) |
| 수수료 | inputs 합계 - outputs 합계 (채굴자에게 귀속) |

⚠️ **주의**: 거스름돈 output을 빠뜨리면 차액 **전부가 수수료**로 빠집니다. 실제로 이런 실수로 수십 BTC를 수수료로 날린 사례가 있습니다.

## 여러 UTXO 결합

보내려는 금액이 단일 UTXO보다 크면 여러 UTXO를 합쳐서 사용합니다.

```text
Alice의 UTXO: #1 (3 BTC), #2 (4 BTC), #3 (2 BTC)
Alice → Bob 8 BTC 전송

Transaction:
  Input:  UTXO #1 (3 BTC) + UTXO #2 (4 BTC) + UTXO #3 (2 BTC) = 9 BTC
  Output: → Bob 8 BTC
          → Alice 0.9999 BTC (거스름돈)
          수수료: 0.0001 BTC
```

이처럼 비트코인 지갑은 트랜잭션을 만들 때 **어떤 UTXO 조합을 사용할지** 결정해야 합니다. 이를 **Coin Selection**이라 하며, 수수료 최적화에 직접적인 영향을 줍니다.

# 3. Transaction 구조

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

## 트랜잭션 검증 규칙

노드가 트랜잭션을 수신하면 다음을 검증합니다:

1. **Input의 UTXO가 존재하는가?** — UTXO set에 없으면 이중 지불 시도로 거부
2. **서명이 유효한가?** — input에 포함된 서명이 해당 UTXO의 소유자 것인지 검증
3. **inputs 합 ≥ outputs 합인가?** — 없는 돈을 만들어낼 수 없음 (차액 = 수수료)

```text
검증 흐름:
  input 참조 → UTXO set에서 조회 → 존재 확인 → 서명 검증 → 금액 검증 → 승인
                                    ↓ 없으면
                                  거부 (이중 지불)
```

이 구조 덕분에 비트코인은 **별도의 잔고 관리 없이** 이중 지불을 방지합니다. UTXO는 한 번 소비되면 set에서 사라지므로, 같은 UTXO를 두 번 쓸 수 없습니다.

## Coinbase Transaction

각 블록의 첫 번째 트랜잭션. 채굴 보상을 생성합니다.
- Input이 없음 (이전 UTXO를 소비하지 않음)
- 무에서 새로운 BTC를 생성하는 유일한 방법
- UTXO 계산 시 input에서 `is_coinbase = false` 필터가 필요한 이유

# 4. OP_RETURN (nulldata)

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

# 5. UTXO 모델 vs Account 모델

---

이더리움은 비트코인과 다르게 **Account 모델**을 사용합니다. 두 모델의 차이를 비교하면 UTXO의 특징이 더 명확해집니다.

```text
UTXO 모델 (Bitcoin):
  "지갑에 10 BTC짜리 지폐 1장, 3 BTC짜리 지폐 2장이 있다"
  잔고 = 개별 UTXO의 합 (10 + 3 + 3 = 16 BTC)

Account 모델 (Ethereum):
  "은행 계좌에 잔고 16 ETH가 있다"
  잔고 = 계좌에 기록된 단일 숫자
```

| 항목 | UTXO (Bitcoin) | Account (Ethereum) |
|------|---------------|-------------------|
| 잔고 표현 | 개별 UTXO의 합계 | 계좌의 단일 값 |
| 송금 | UTXO 소비 → 새 UTXO 생성 | 잔고 값 직접 차감/증가 |
| 이중 지불 방지 | UTXO가 소비되면 set에서 제거 | nonce(순서 번호)로 순서 강제 |
| 병렬 처리 | 서로 다른 UTXO는 독립적 → 병렬 검증 가능 | 같은 계좌의 TX는 순차 처리 |
| 프라이버시 | 매 TX마다 새 주소 사용 가능 | 하나의 주소에 이력이 누적 |
| 상태 크기 | UTXO set (약 1.1억 개) | 전체 계좌 상태 트리 |
| 스마트 컨트랙트 | 제한적 (Script) | 풍부 (EVM) |

### 온체인 분석 관점에서의 차이

UTXO 모델은 각 "코인 조각"의 **생성 시점과 소비 시점**이 기록되므로, 보유 기간 기반 분석이 가능합니다:

```text
UTXO 모델:
  UTXO #1: 생성 2023-01-01, 소비 2024-06-15 → 보유 531일 (LTH)
  UTXO #2: 생성 2024-06-01, 미소비          → 보유 중 (STH)
  → 이 데이터로 CDD, SOPR, Age Distribution 등 산출

Account 모델:
  Account A: 현재 잔고 100 ETH
  → 개별 코인의 "나이"를 추적할 수 없음
  → UTXO 기반 메트릭 산출 불가
```

# 6. 주요 온체인 메트릭 개념

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

# 7. Dust UTXO

---

**Dust**란 소비하는 데 드는 수수료가 UTXO의 value보다 큰 UTXO를 말합니다.

```text
UTXO: 0.00000300 BTC (300 satoshi)
이 UTXO를 소비하는 수수료: ~0.00001000 BTC (1000 satoshi)

→ 소비하면 오히려 손해 → 사실상 사용 불가능한 UTXO
```

Bitcoin Core는 dust 기준 이하의 output 생성을 기본적으로 거부합니다 (dust threshold). 하지만 과거에 생성된 dust UTXO는 여전히 UTXO set에 남아 있어 **set 크기를 불필요하게 키우는** 원인이 됩니다.

| 항목 | 설명 |
|------|------|
| Dust threshold | output을 소비하는 데 필요한 최소 수수료 기준 (동적) |
| 영향 | UTXO set 비대화 → 노드 메모리 사용량 증가 |
| 대응 | Bitcoin Core가 relay 단계에서 dust output 거부 (정책, 합의 규칙은 아님) |

# 정리

---

| 개념 | 설명 |
|------|------|
| UTXO | 아직 소비되지 않은 트랜잭션 출력. 비트코인 잔고의 기본 단위 |
| 거스름돈 | UTXO는 분할 불가 → 차액을 자신에게 돌려보내는 output |
| 수수료 | inputs 합 - outputs 합 (명시적 output이 아님) |
| UTXO set | 특정 시점에 소비되지 않은 모든 UTXO의 집합 |
| 이중 지불 방지 | UTXO가 소비되면 set에서 제거 → 재사용 불가 |
| OP_RETURN | 소비 불가능한 output, 데이터 저장용, UTXO set 미포함 |
| UTXO vs Account | UTXO는 개별 코인의 나이 추적 가능 → 온체인 메트릭의 기반 |
| Dust | 수수료보다 작은 UTXO, UTXO set 비대화의 원인 |

# Reference

---

- [Bitcoin Developer Guide - Transactions](https://developer.bitcoin.org/devguide/transactions.html)
- [Bitcoin Wiki - UTXO](https://en.bitcoin.it/wiki/UTXO)
- [Learn Me a Bitcoin - UTXO](https://learnmeabitcoin.com/technical/transaction/utxo/)
