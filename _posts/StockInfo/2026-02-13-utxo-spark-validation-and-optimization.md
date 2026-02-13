---
title: "[Bitcoin] UTXO 메트릭 Spark 파이프라인 -- 검증과 최적화에서 배운 것들"
date: 2026-02-13
categories:
  - StockInfo
tags:
  - Bitcoin
  - Spark
  - Databricks
  - UTXO
  - Data Engineering
  - Performance Optimization
  - Delta Lake
---

## 들어가며

Bitcoin blockchain의 UTXO(Unspent Transaction Output) 메트릭을 계산하는 시스템을 Python/RocksDB 기반에서 Apache Spark/Databricks로 이관하고 있다. 목표는 전체 블록체인 처리 시간을 **100시간에서 10시간 이내로** 단축하는 것이다.

이 글에서는 Spark 파이프라인의 **성능 최적화**, **데이터 정합성 검증**, 그리고 이관 과정에서 발견한 **숨은 버그와 semantics 차이**를 다룬다. 특히 다음 세 가지 질문에 답한다:

1. Spark 클러스터 튜닝에서 실제로 효과 있는 것과 없는 것은 무엇인가?
2. 블록체인 데이터의 비단조(non-monotonic) 타임스탬프가 어떤 종류의 버그를 만드는가?
3. 시스템 이관 시 "같은 이름, 다른 의미"의 컬럼을 어떻게 발견하고 처리하는가?

## 사전 지식

이 글을 충분히 이해하려면 다음 배경 지식이 도움된다:

- **Bitcoin UTXO 모델**: 트랜잭션이 이전 output을 소비(spend)하고 새 output을 생성하는 구조
- **Apache Spark 기본 개념**: DataFrame, `repartition`, shuffle, persist
- **Databricks**: AQE(Adaptive Query Execution), Delta Lake, 클러스터 설정
- **RocksDB**: key-value store의 기본 개념

## 기존 시스템의 한계

기존 UTXO 메트릭 계산 시스템은 다음과 같은 구조를 가졌다:

| 컴포넌트 | 역할 |
|---------|------|
| **BlockSci** | Bitcoin 블록체인 데이터 파싱 (C++ 라이브러리) |
| **RocksDB** | UTXO 상태를 4개 DB에 저장 (row, age, supply, realized_supply) |
| **Python** | 단일 프로세스로 블록을 순차 처리 |

전체 블록체인(~900K 블록) 처리에 약 **100시간**이 소요되었다. 단일 서버에서 순차적으로 동작하기 때문에 수평 확장이 불가능하고, 장애 복구나 재계산 시 다시 100시간을 기다려야 하는 문제가 있었다.

## Spark 파이프라인 아키텍처

Spark/Databricks 기반으로 이관하면서 다음과 같은 3단계 아키텍처를 설계했다:

```
Phase 0: utxo_base (2.5B UTXOs) ──full scan──> utxo_events_block (~200M rows)
                                                       │
Phase 1: ──10K 블록 간격 snapshot──> unspent_snapshot
                                     supply_snapshot
                                     realized_snapshot
                                           │
Phase 2: ──2-Process 병렬──> Process A (age 메트릭, 7 tables)
                              Process B (supply/realized 분포, 3 tables)
```

- **Phase 0**: `utxo_base` 전체를 1회 scan하여 `(event_block_height, created_block_height, supply_range, realized_range)` 키로 사전 집계. 25억 개별 UTXO를 약 2억 행으로 압축한다.
- **Phase 1**: 10,000블록 간격으로 3종류의 snapshot을 생성. 이전 snapshot에 delta를 LEFT JOIN + UNION ALL로 적용한다.
- **Phase 2**: 완전히 독립적인 2개 프로세스를 병렬 실행하여 최종 10개 output 테이블을 생성한다.

이번 작업의 목표는 이 파이프라인의 **성능을 추가 개선**하고, 기존 Python 시스템과의 **데이터 정합성을 검증**하는 것이었다.

## 성능 최적화: 실제로 효과 있는 것과 없는 것

Process A의 배치 루프 성능 개선을 위해 여러 접근을 검토했다. 결론부터 말하면, Spark 파라미터 튜닝보다 **불필요한 연산 제거**가 훨씬 효과적이었다.

### Databricks Runtime의 기본 설정은 이미 충분하다

Databricks Runtime은 다음 설정이 기본적으로 활성화되어 있다:

```
spark.sql.adaptive.enabled = true          -- AQE: 런타임 통계 기반 쿼리 최적화
spark.sql.adaptive.coalescePartitions.enabled = true  -- 작은 파티션 자동 병합
spark.sql.adaptive.advisoryPartitionSizeInBytes = 64MB -- 목표 파티션 크기
```

AQE(Adaptive Query Execution)는 Spark 3.0부터 도입된 기능으로, 쿼리 실행 중간에 런타임 통계를 수집하여 **shuffle 파티션 수를 자동 조정**하고, **작은 테이블을 자동으로 broadcast**한다. 즉, 수동으로 `spark.sql.shuffle.partitions`나 broadcast hint를 설정할 필요가 대부분 없다.

> Spark 공식 문서에 따르면 `spark.sql.adaptive.enabled`는 기본값이 `true`이며, "런타임의 정확한 통계를 기반으로 쿼리 실행 중간에 쿼리 플랜을 재최적화한다."

이 기본값들이 이미 충분했기 때문에, 추가 파라미터 튜닝의 효과는 미미했다.

### 실질적으로 효과 있었던 3가지 개선

**1. 불필요한 디버깅 연산 제거**

`log_partitions()` 함수가 매 배치마다 `.distinct().count()`를 5회 실행하고 있었다. 이 연산은 Spark에서 full shuffle + action을 트리거하므로, 디버깅 목적의 로깅치고는 비용이 과도했다. 제거 후 배치당 수 분의 시간이 절약되었다.

**2. Output 테이블 쓰기 병렬화**

7개 output 테이블을 순차적으로 쓰고 있었는데, 각 테이블의 쓰기는 서로 독립적이므로 `ThreadPoolExecutor`로 병렬화할 수 있었다:

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

# 기존: 순차 실행 (한 테이블씩 차례대로 쓰기)
for label, query in output_queries:
    spark.sql(query)

# 개선: 병렬 실행 (7개 테이블 동시 쓰기)
with ThreadPoolExecutor(max_workers=7) as executor:
    futures = {
        executor.submit(spark.sql, query): label
        for label, query in output_queries
    }
    for future in as_completed(futures):
        label = futures[future]
        future.result()  # 예외 발생 시 여기서 raise
```

Spark의 `spark.sql()` 호출은 내부적으로 별도의 Spark job을 생성하므로, Python 스레드에서 동시에 호출하면 클러스터 리소스를 더 효율적으로 활용할 수 있다.

**3. 클러스터 인스턴스 타입 재배치**

같은 비용 안에서 인스턴스 타입과 노드 수를 조정하여 성능을 개선했다:

| 구성 | 노드 | 총 코어 | 비용(추정) | 비고 |
|------|------|---------|-----------|------|
| i3.2xlarge x 50 | 50 | 400 | ~$230 | 기존 구성 |
| i3.4xlarge x 30 | 30 | 480 | ~$230 | 코어 20% 증가, 노드 40% 감소 |
| **i3.4xlarge x 50** | **50** | **800** | **~$230** | 코어 2배, 비용 유사 |

노드 수를 줄이면 **shuffle 시 네트워크 통신량이 감소**한다. 같은 비용이라면 "큰 인스턴스 x 적은 노드"가 shuffle이 많은 워크로드에서 유리하다.

### PARTITION_NUM은 기대만큼 효과가 없다

처음에는 `repartition(N)`으로 persist된 DataFrame의 파티션 수를 조정하면 후속 RANGE_JOIN 성능이 개선될 것으로 예상했다. 하지만 실제로는:

- `repartition(N)`은 **full shuffle을 수행하여 N개의 파티션을 생성**한다. 이것은 persist된 데이터를 읽을 때의 초기 병렬도를 결정한다.
- 그러나 **RANGE_JOIN에서 발생하는 shuffle은 별도의 단계**이다. AQE가 이 shuffle의 파티션 수와 크기를 런타임에 자동으로 최적화한다.
- 따라서 `repartition(N)` 값을 변경해도 RANGE_JOIN 자체의 성능에는 큰 영향이 없다.

```python
# repartition 값은 코어 수에 맞추되, 이것만으로 성능이 극적으로 변하지는 않음
snapshot_df = spark.sql("""
    SELECT s.*
    FROM unspent_utxo_snapshot s
    WHERE s.snapshot_block_height IN (
        SELECT DISTINCT base_snapshot FROM target_blocks_v
    )
""").repartition(800)  # 800코어 클러스터 기준
```

**교훈**: Databricks/Spark에서 성능 최적화를 할 때, AQE가 이미 관리하는 영역(shuffle 파티션)을 수동으로 튜닝하려 하기보다, AQE가 관리하지 않는 영역(불필요한 action, I/O 병렬화)에 집중하는 것이 더 효과적이다.

## Bug #8: datetime JOIN이 만든 유령 UTXO

이번 검증 과정에서 발견한 가장 심각한 버그는, `utxo_base` 테이블 생성 시 **datetime 기반 JOIN**이 UTXO를 이중 복제하는 문제였다.

### 원인: 비트코인 타임스탬프의 비단조성

비트코인 프로토콜에서 마이너는 블록 타임스탬프를 일정 범위 내에서 자유롭게 설정할 수 있다. 이전 블록보다 이른 타임스탬프를 설정하는 것도 허용된다. 그 결과:

1. 두 개의 서로 다른 블록이 **동일한 datetime** 값을 가질 수 있다.
2. `price_df` 테이블에는 datetime별로 하나의 가격 행이 존재하는데, 같은 datetime에 두 블록이 대응하면 **두 행**이 된다.
3. `utxo_base` 생성 시 `ON o.datetime = bp.datetime` JOIN이 1:N 매칭을 발생시킨다.
4. 해당 블록의 **모든 UTXO가 2배로 복제**된다.

### 수정

```sql
-- 수정 전: datetime은 유니크하지 않아 1:N JOIN 가능
ON o.datetime = bp.datetime

-- 수정 후: block_height는 항상 유니크 (1:1 보장)
ON o.block_height = bp.block_height
```

`block_height`는 블록체인에서 자연적으로 유니크한 정수 식별자이므로, 항상 1:1 JOIN을 보장한다.

### 영향 범위 측정 (blocks 0~79,999)

초기 블록 80,000개를 샘플링하여 Bug #8의 영향을 분석했다:

| 지표 | 값 |
|------|-----|
| 첫 번째 차이 발생 블록 | block 21,769 |
| 동일 datetime을 가진 블록 수 | 108개 |
| 누적 오차 (block 79,999 시점) | +2,000 BTC supply, +49 UTXOs |
| 차이가 전파된 블록 수 | 58,231 / 80,000 (**72.8%**) |

snapshot 기반 아키텍처에서는 한 번 발생한 오차가 이후 모든 snapshot에 **누적 전파**된다. block 21,769에서 처음 발생한 UTXO 중복이 이후 58,231개 블록의 결과에 영향을 미쳤다.

전체 블록체인(~900K 블록)에서는 약 **368쌍(736블록)** 이 동일 datetime을 가지며, 전체 블록의 약 0.08%에 해당한다. 비율은 작지만 누적 효과는 크다.

### 발견 과정

이 버그는 market_metrics의 Spark vs Python 수치를 비교하던 중 발견되었다:

1. 11개 블록에서 CDD(Coin Days Destroyed) 값이 **정확히 2배** 차이남
2. 해당 블록들의 datetime이 다른 블록과 동일함을 확인
3. `price_df` datetime JOIN이 1:N 매칭을 발생시킴을 확인
4. `utxo_base`에서 UTXO 중복 행이 존재함을 확정

"정확히 2배"라는 패턴이 핵심 단서였다. 부동소수점 오차나 로직 차이라면 임의의 비율로 차이가 나겠지만, 정확히 2배는 **데이터 중복**을 강하게 시사한다.

## Python vs Spark 데이터 비교: 같은 이름, 다른 의미

Bug #8을 수정한 후 기존 프로덕션 시스템(Python/RocksDB)과 Spark 결과를 비교했다.

### 정확히 일치하는 컬럼 (12개)

| 컬럼 그룹 | 비고 |
|----------|------|
| `total_supply`, `total_count` | 정확히 동일 |
| `supply_profit`, `supply_loss` (BTC + %) | 정확히 동일 |
| `utxo_profit_cnt`, `utxo_loss_cnt` (수 + %) | 정확히 동일 |
| `sca`, `scda` | 소수점 6~8자리 차이 (부동소수점 연산 순서 차이, 무시 가능) |

핵심 메트릭이 일치한다는 것은 파이프라인의 기본 로직이 올바르다는 강력한 증거다.

### 불일치하는 컬럼 (2개)

불일치 항목은 모두 **의도된 차이**로 밝혀졌다.

**1. `utxo_block_profit_cnt` -- BlockSci의 op_return 포함 workaround**

이 컬럼의 계산 과정을 코드 레벨에서 추적하면 두 시스템의 차이가 명확해진다.

**Step 1**: BlockSci 모델에서 created_block_height 단위로 이익/손실을 카운트한다:

```python
# base/blocksci_model.py (line 90, 94)
if _target_block_price > _each_dict['price']:
    _result['unspent_block_profit_cnt'] += 1  # 블록 단위 카운트 (UTXO 개수가 아님)
```

여기서 `+= 1`은 **개별 UTXO가 아니라 created_block_height 그룹당 1**을 카운트한다. 즉, 같은 블록에서 생성된 UTXO 1,000개가 모두 이익 상태라도 카운트는 1이다.

**Step 2**: 컨트롤러에서 percent를 계산한 뒤, **network의 total_utxo_count로 역변환**한다:

```python
# utxo/controller.py (line 381-386)
# percent 계산
insert_data['utxo_block_profit_cnt_percent'] = (
    utxo_related_data['unspent_block_profit_cnt']
    / utxo_related_data['unspent_block_total_cnt'] * 100
)

# op_return, 0-value output을 포함하는 BlockSci 카운트 대신
# network 메트릭의 total_utxo_count로 역변환
insert_data['utxo_block_profit_cnt'] = int(
    insert_data['utxo_block_profit_cnt_percent'] * total_utxo_count / 100
)
```

이 workaround가 필요한 이유: BlockSci는 `op_return`이나 0-value output도 UTXO로 포함한다. 이것들은 실제 소비 가능한 UTXO가 아니므로, BlockSci 기준 카운트와 network 메트릭의 `utxo_count`가 일치하지 않는다. percent를 먼저 구하고, network 기준 총 UTXO 수로 역산하는 방식으로 이 차이를 보정했다.

**Spark에서는?**

Spark의 `utxo_base`는 생성 시점에 **op_return을 제외**한다. 따라서 이 workaround 자체가 불필요하다. Spark에서 계산된 percent가 곧 원본 값이며, 필요하다면 나중에 `percent * network_utxo_count / 100`으로 변환하면 된다.

```
기존 Python 흐름:
  BlockSci (op_return 포함) → 블록 단위 카운트 → percent → UTXO 수 역변환

Spark 흐름:
  utxo_base (op_return 제외) → 블록 단위 카운트 → percent (최종값)
```

**2. `unrealized_profit`/`unrealized_loss` -- 단위 차이**

Python은 비율(ratio)로 저장하고, Spark는 절대값(BTC)으로 저장한다. 이것은 설계상의 의도적 차이이며, 변환 공식이 명확하므로 문제가 아니다.

## 주의할 점 (Gotchas)

이번 작업에서 얻은 실무적 교훈을 정리한다.

### 1. 블록체인 데이터에서 datetime을 JOIN key로 사용하지 말 것

비트코인 블록 타임스탬프는 **비단조(non-monotonic)** 이다. 블록 N+1의 타임스탬프가 블록 N보다 이를 수 있다. 이로 인해:

- **JOIN key로 사용 금지**: datetime은 유니크하지 않으므로 1:N 매칭이 발생할 수 있다. 반드시 `block_height`를 사용한다.
- **age 계산 시 클램핑 필수**: 타임스탬프 역전으로 인해 음수 age가 발생할 수 있다. `GREATEST(age_value, 0)`으로 보호한다.

```sql
-- 잘못된 패턴: datetime은 유니크하지 않아 1:N JOIN 가능
JOIN price_df p ON o.datetime = p.datetime

-- 올바른 패턴: block_height는 항상 유니크
JOIN price_df p ON o.block_height = p.block_height

-- age 계산 시 음수 방지
GREATEST(
    DATEDIFF(current_timestamp, created_timestamp),
    0
) AS age_days
```

### 2. Spark 파라미터 튜닝: AQE가 관리하는 영역을 건드리지 말 것

AQE는 shuffle 파티션 수, 작은 테이블의 broadcast 변환, 파티션 병합을 **런타임에 자동으로** 최적화한다. 수동 튜닝이 효과적인 영역과 그렇지 않은 영역을 구분해야 한다:

| 영역 | AQE 자동 관리 | 수동 개입 효과 |
|------|:----------:|:----------:|
| shuffle 파티션 수 | O | 낮음 |
| broadcast 결정 | O | 낮음 |
| 불필요한 action 제거 | X | **높음** |
| I/O 병렬화 (테이블 쓰기) | X | **높음** |
| 클러스터 인스턴스 타입 | X | **높음** |
| repartition (초기 파티션 수) | 부분적 | 중간 |

### 3. 시스템 이관 시 컬럼 semantics를 코드 레벨까지 추적할 것

같은 이름의 컬럼이 두 시스템에서 다른 의미를 가질 수 있다:

- **Python** `utxo_block_profit_cnt`: percent 기반으로 역변환된 UTXO 수 (workaround 적용)
- **Spark** `utxo_block_profit_cnt`: 순수 percent 값

스키마 비교만으로는 이 차이를 발견할 수 없다. 데이터를 생성하는 **코드의 전체 경로**(계산 -> 변환 -> 저장)를 추적해야 한다.

### 4. 데이터 검증은 샘플링에서 시작하되, 패턴을 찾아라

전체 블록체인(~900K 블록)을 한 번에 비교하면 시간도 오래 걸리고 차이의 원인을 파악하기 어렵다. 효과적인 검증 전략:

1. **초기 블록 샘플링** (예: blocks 0~79,999)
2. **첫 번째 차이 발생 지점** 찾기 (이 사례에서는 block 21,769)
3. **차이의 패턴** 분석 (정확히 2배 -> 데이터 중복, 일정한 offset -> 로직 차이)
4. **원인 가설** 수립 후 코드 추적으로 검증
5. 수정 후 **같은 샘플에서 재검증** -> 전체 범위 확장

"정확히 N배" 패턴은 데이터 중복을, "서서히 증가하는 오차"는 누적 계산 로직의 차이를, "특정 블록에서만 차이"는 edge case 처리의 차이를 시사한다.

## 정리

| 항목 | 핵심 내용 |
|------|----------|
| **성능 최적화** | AQE가 관리하는 영역보다 불필요한 연산 제거와 I/O 병렬화가 효과적 |
| **Bug #8** | datetime JOIN → block_height JOIN. 비단조 타임스탬프로 인한 UTXO 이중 복제 |
| **데이터 검증** | 12개 컬럼 정확히 일치, 2개 불일치는 의도된 semantics 차이 |
| **교훈** | 블록체인 데이터에서 datetime을 JOIN key로 사용 금지 |

## 다음 단계

### 단기

1. **utxo_base 재빌드**: datetime JOIN을 block_height JOIN으로 수정한 뒤, utxo_base부터 전체 파이프라인을 재실행한다.
2. **전체 파이프라인 재실행**: utxo_events_block (Phase 0) -> snapshot (Phase 1) -> Process A/B (Phase 2) -> market_metrics 순서로 재빌드한다.

### 중기

1. **전체 블록 범위 정밀 검증**: 초기 80K 블록이 아닌 전체 ~900K 블록에서 Spark vs Python 수치를 비교한다.
2. **성능 측정**: i3.4xlarge x 50 클러스터로 실제 전체 빌드 시간을 측정한다.
3. **Market metrics 통합**: UTXO Job의 A-1 output 완료 후 market_metrics task를 추가 실행하는 Multi-task Workflow를 구성한다.

### 장기

1. **Exchange Inflow metrics 구현**: entity_flow_transaction + utxo_base 하이브리드 설계를 Databricks에서 구현한다.
2. **Incremental Job 전환**: Multi-task Workflow로 일일 배치를 자동화한다.
3. **비용 최적화**: Spot Instance 활용 및 클러스터 auto-scaling 적용을 검토한다.

## 참고 자료

- [Apache Spark - Performance Tuning (AQE)](https://spark.apache.org/docs/latest/sql-performance-tuning.html) -- AQE 설정 및 동작 방식 공식 문서
- [Delta Lake - Batch Write (replaceWhere)](https://docs.delta.io/latest/delta-batch.html) -- Delta 테이블의 selective overwrite 패턴
- 프로젝트 내부 문서:
  - `docs/spark/06_optimized_queries.md` -- UTXO 메트릭 Spark 파이프라인 전체 설계
  - `docs/spark/06a_process_a.md` -- Process A (age + metrics) 상세 쿼리
  - `docs/spark/06b_process_b.md` -- Process B (supply + realized) 상세 쿼리
  - `docs/spark/01_base_tables.md` -- utxo_base 테이블 생성 (Bug #8 수정 포함)
  - `base/blocksci_model.py` -- 기존 Python UTXO 계산 로직
  - `utxo/controller.py` -- 기존 Python 메트릭 컨트롤러
