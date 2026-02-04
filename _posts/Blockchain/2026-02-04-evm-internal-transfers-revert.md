---
title: "[Blockchain] EVM Internal Transfer와 Revert - 트레이스 분석"
categories:
  - Blockchain
tags:
  - [Blockchain, EVM, Ethereum, InternalTransfer, Trace]
---

# Introduction

---

이더리움에서 **internal transfer**는 스마트 컨트랙트 간의 ETH 이동입니다. 일반 트랜잭션과 달리 **트레이스(trace)** 데이터에서만 확인할 수 있습니다.

```
일반 전송: EOA → EOA (트랜잭션에서 보임)
Internal: Contract A → Contract B (트레이스에서만 보임)
```

# 1. Internal Transfer란?

---

## 발생 상황

```solidity
// Contract A가 Contract B를 호출하며 ETH 전송
contractB.call{value: 1 ether}("");

// 또는
payable(contractB).transfer(1 ether);
```

## 예시 시나리오

```
1. 사용자가 DEX에 1 ETH 전송
2. DEX가 유동성 풀에 0.997 ETH 전송 (internal)
3. DEX가 Fee 컨트랙트에 0.003 ETH 전송 (internal)
```

## 트레이스 구조

```json
{
  "type": "call",
  "from": "0xDEX...",
  "to": "0xPool...",
  "value": "0xde0b6b3a7640000",
  "input": "0x...",
  "output": "0x...",
  "calls": [
    {
      "type": "call",
      "from": "0xPool...",
      "to": "0xToken...",
      "value": "0x0"
    }
  ]
}
```

# 2. 트레이스 조회

---

## debug_traceTransaction

```bash
# Geth RPC
curl -X POST --data '{
    "jsonrpc": "2.0",
    "method": "debug_traceTransaction",
    "params": ["0x...", {"tracer": "callTracer"}],
    "id": 1
}' http://localhost:8545
```

## trace_transaction (Erigon/OpenEthereum)

```bash
curl -X POST --data '{
    "jsonrpc": "2.0",
    "method": "trace_transaction",
    "params": ["0x..."],
    "id": 1
}' http://localhost:8545
```

## Python 예제

```python
from web3 import Web3

w3 = Web3(Web3.HTTPProvider('http://localhost:8545'))

# callTracer 사용
trace = w3.provider.make_request(
    'debug_traceTransaction',
    [tx_hash, {'tracer': 'callTracer'}]
)

def extract_internal_transfers(trace, transfers=None):
    """재귀적으로 internal transfer 추출"""
    if transfers is None:
        transfers = []

    result = trace.get('result', trace)

    # value가 있고 0보다 크면 transfer
    value = int(result.get('value', '0x0'), 16)
    if value > 0:
        transfers.append({
            'from': result['from'],
            'to': result['to'],
            'value': value,
            'type': result['type']
        })

    # 하위 호출 재귀 탐색
    for call in result.get('calls', []):
        extract_internal_transfers(call, transfers)

    return transfers

transfers = extract_internal_transfers(trace)
```

# 3. Revert 처리

---

## Revert란?

```solidity
function withdraw() public {
    require(balance[msg.sender] > 0, "No balance");
    // revert 시 모든 상태 변경 취소
    payable(msg.sender).transfer(balance[msg.sender]);
    balance[msg.sender] = 0;
}
```

## 트레이스에서 Revert 확인

```json
{
  "type": "call",
  "from": "0x...",
  "to": "0x...",
  "value": "0x...",
  "error": "execution reverted",
  "revertReason": "No balance"
}
```

## Revert된 Internal Transfer

```
중요: Revert된 호출의 모든 internal transfer도 취소됨!

TX 시작
├── Call A (성공)
│   └── Transfer 1 ETH → 유효
├── Call B (revert)
│   └── Transfer 2 ETH → 무효!
└── Call C (성공)
    └── Transfer 0.5 ETH → 유효
```

## Python에서 Revert 필터링

```python
def extract_valid_transfers(trace, transfers=None, is_reverted=False):
    """Revert되지 않은 transfer만 추출"""
    if transfers is None:
        transfers = []

    result = trace.get('result', trace)

    # 현재 호출이 revert되었는지 확인
    current_reverted = is_reverted or 'error' in result

    # revert 아닌 경우만 추가
    if not current_reverted:
        value = int(result.get('value', '0x0'), 16)
        if value > 0:
            transfers.append({
                'from': result['from'],
                'to': result['to'],
                'value': value
            })

    # 하위 호출 (부모가 revert면 자식도 revert)
    for call in result.get('calls', []):
        extract_valid_transfers(call, transfers, current_reverted)

    return transfers
```

# 4. 데이터 파이프라인

---

## 스키마 설계

```sql
CREATE TABLE internal_transfers (
    tx_hash STRING,
    block_number BIGINT,
    block_timestamp TIMESTAMP,
    trace_address ARRAY<INT>,  -- 호출 경로 [0, 1, 2]
    from_address STRING,
    to_address STRING,
    value DECIMAL(38, 0),      -- wei 단위
    call_type STRING,          -- call, delegatecall, staticcall
    is_reverted BOOLEAN,
    error STRING
)
PARTITIONED BY (block_date DATE);
```

## 트레이스 파싱

```python
def flatten_trace(trace, tx_hash, block_number, block_timestamp,
                  trace_address=None, parent_reverted=False):
    """트레이스를 플랫 레코드로 변환"""
    if trace_address is None:
        trace_address = []

    records = []
    result = trace.get('result', trace)

    is_reverted = parent_reverted or 'error' in result

    records.append({
        'tx_hash': tx_hash,
        'block_number': block_number,
        'block_timestamp': block_timestamp,
        'trace_address': trace_address,
        'from_address': result['from'],
        'to_address': result.get('to'),
        'value': int(result.get('value', '0x0'), 16),
        'call_type': result['type'],
        'is_reverted': is_reverted,
        'error': result.get('error')
    })

    for i, call in enumerate(result.get('calls', [])):
        records.extend(flatten_trace(
            call, tx_hash, block_number, block_timestamp,
            trace_address + [i], is_reverted
        ))

    return records
```

# 5. 일반적인 패턴

---

## DEX 스왑

```
TX: User → DEX Router
├── Call: Router → Pool (swap)
│   ├── Transfer: Pool → User (output token - internal)
│   └── Transfer: User → Pool (input token - internal)
└── Transfer: Router → Fee (fee - internal)
```

## 멀티시그 실행

```
TX: User → Multisig
├── Check signatures
└── Call: Multisig → Target (실제 작업)
    └── ... (내부 호출들)
```

## 플래시론

```
TX: User → Aave
├── Transfer: Aave → User (대출 - internal)
├── Call: User logic
│   └── ... (사용자 로직)
└── Transfer: User → Aave (상환 + 이자 - internal)
```

# 6. 분석 쿼리

---

## 특정 주소의 Internal Transfer

```sql
SELECT
    tx_hash,
    from_address,
    to_address,
    value / 1e18 as eth_value,
    call_type
FROM internal_transfers
WHERE (from_address = '0x...' OR to_address = '0x...')
  AND is_reverted = false
  AND block_date = '2024-01-01'
ORDER BY block_timestamp;
```

## 컨트랙트 간 자금 흐름

```sql
SELECT
    from_address,
    to_address,
    SUM(value) / 1e18 as total_eth,
    COUNT(*) as transfer_count
FROM internal_transfers
WHERE is_reverted = false
  AND value > 0
  AND block_date BETWEEN '2024-01-01' AND '2024-01-31'
GROUP BY from_address, to_address
ORDER BY total_eth DESC
LIMIT 100;
```

## Revert 비율 분석

```sql
SELECT
    to_address as contract,
    COUNT(*) as total_calls,
    SUM(CASE WHEN is_reverted THEN 1 ELSE 0 END) as reverted_calls,
    ROUND(100.0 * SUM(CASE WHEN is_reverted THEN 1 ELSE 0 END) / COUNT(*), 2) as revert_rate
FROM internal_transfers
WHERE block_date = '2024-01-01'
GROUP BY to_address
HAVING COUNT(*) > 100
ORDER BY revert_rate DESC;
```

# 7. 주의사항

---

## delegatecall

```
delegatecall: 호출자의 컨텍스트에서 실행
→ msg.sender, msg.value가 원래 호출자 유지
→ 실제 ETH 이동은 호출자 주소에서 발생
```

## staticcall

```
staticcall: 읽기 전용 호출
→ 상태 변경 불가
→ ETH 전송 불가 (value 항상 0)
```

## CREATE/CREATE2

```
컨트랙트 생성 시에도 ETH 전송 가능
→ type: "create" 또는 "create2"
→ to: 새로 생성된 컨트랙트 주소
```

# 8. 체크리스트

---

```
□ Internal transfer와 일반 트랜잭션을 구분하는가?
□ Revert된 호출을 필터링하는가?
□ trace_address로 호출 경로를 추적할 수 있는가?
□ delegatecall의 컨텍스트를 이해하는가?
□ 노드 RPC의 트레이스 메서드를 확인했는가?
```

# Reference

---

- [Ethereum Yellow Paper - Execution](https://ethereum.github.io/yellowpaper/paper.pdf)
- [Geth Debug APIs](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug)
- [OpenEthereum Trace Module](https://openethereum.github.io/JSONRPC-trace-module)
- [EVM Deep Dives](https://noxx.substack.com/p/evm-deep-dives-the-path-to-shadowy)
