---
title: "[BigQuery] 파티셔닝과 클러스터링 - 비용 최적화 전략"
categories:
  - BigQuery
tags: [BigQuery, Partitioning, Clustering, GCP, DataWarehouse]
---

## Introduction

---

BigQuery는 **스캔한 데이터 양**에 비례해서 비용이 발생합니다.

```
1TB 테이블 전체 스캔: $5
100GB만 스캔 (파티션 프루닝): $0.50
```

10배 차이입니다. 같은 쿼리인데 테이블 설계만으로 비용이 10배 줄어들 수 있다는 뜻입니다.

파티셔닝과 클러스터링은 **"필요한 데이터만 읽게 만드는"** 두 가지 메커니즘입니다. 둘 다 스캔 범위를 줄이지만, 동작 원리와 적합한 상황이 다릅니다.

## 1. 파티셔닝

---

### 파티셔닝이란?

하나의 테이블을 **물리적으로 독립된 세그먼트(파티션)**로 분할하는 것입니다. 각 파티션은 독립적으로 관리되며, 쿼리 시 조건에 맞지 않는 파티션은 **아예 읽지 않습니다** (파티션 프루닝).

```
orders 테이블 (300GB)
├── 2024-01-01 파티션 (100GB) ← WHERE order_date = '2024-01-01' → 여기만 스캔
├── 2024-01-02 파티션 (100GB) ← 스킵
└── 2024-01-03 파티션 (100GB) ← 스킵

결과: 300GB 중 100GB만 스캔 → 비용 1/3
```

핵심은 **"읽기 전에 걸러낸다"**는 점입니다. BigQuery는 파티션 메타데이터만 보고 어떤 파티션을 읽을지 결정하므로, 데이터를 열어보기도 전에 스캔 범위가 줄어듭니다.

### 파티션 타입

BigQuery는 3가지 파티셔닝 방식을 지원합니다.

#### 1. 시간 단위 컬럼 파티셔닝 (가장 많이 사용)

테이블의 `DATE`, `TIMESTAMP`, `DATETIME` 컬럼 값을 기준으로 분할합니다.

```sql
-- DATE 컬럼 기준
CREATE TABLE my_dataset.orders
(
    order_id INT64,
    order_date DATE,
    amount NUMERIC
)
PARTITION BY order_date;

-- TIMESTAMP 컬럼 기준 (DATE로 변환)
PARTITION BY DATE(created_at)

-- 월 단위 파티셔닝 (데이터가 적을 때)
PARTITION BY DATE_TRUNC(order_date, MONTH)

-- 연 단위 파티셔닝
PARTITION BY DATE_TRUNC(order_date, YEAR)
```

**파티션 단위(granularity)** 선택 기준:

| 단위 | 적합한 경우 | 예시 |
|------|-----------|------|
| `DAY` (기본) | 일별 데이터가 충분히 클 때 (1GB+) | 이벤트 로그, 주문 |
| `HOUR` | 시간별 데이터가 많을 때 | 실시간 스트리밍 데이터 |
| `MONTH` | 일별 데이터가 너무 적을 때 (<10MB) | 월간 리포트 |
| `YEAR` | 데이터 자체가 적을 때 | 연간 재무 데이터 |

파티션이 너무 많으면(4,000개 제한) 단위를 올리고, 파티션당 데이터가 너무 적으면 I/O 오버헤드가 커지므로 적절한 단위를 선택해야 합니다.

#### 2. 수집 시간 파티셔닝 (Ingestion Time)

데이터에 적절한 시간 컬럼이 없을 때, **BigQuery에 로드된 시점**을 기준으로 분할합니다.

```sql
CREATE TABLE my_dataset.logs
(
    message STRING,
    severity STRING
)
PARTITION BY _PARTITIONDATE;  -- 데이터 로드 시점 기준
```

`_PARTITIONTIME` (TIMESTAMP), `_PARTITIONDATE` (DATE) 의사 컬럼이 자동 생성됩니다. 쿼리 시 이 컬럼으로 필터링하면 파티션 프루닝이 동작합니다.

```sql
-- 의사 컬럼으로 조회
SELECT *
FROM my_dataset.logs
WHERE _PARTITIONDATE = '2024-01-15';
```

#### 3. 정수 범위 파티셔닝

`INT64` 컬럼의 값 범위를 기준으로 분할합니다. 시간과 무관한 데이터에 유용합니다.

```sql
CREATE TABLE my_dataset.users
(
    user_id INT64,
    name STRING
)
PARTITION BY RANGE_BUCKET(user_id, GENERATE_ARRAY(0, 1000000, 10000));
-- 0~9999, 10000~19999, ... 100개 파티션 생성
```

범위 밖의 값은 `__UNPARTITIONED__` 특수 파티션에 저장됩니다. NULL 값도 별도의 `__NULL__` 파티션에 들어갑니다.

### 파티션 프루닝이 안 되는 함정

파티션 프루닝은 BigQuery가 **쿼리 실행 전**에 메타데이터만으로 파티션을 걸러내는 것입니다. 다음 경우에는 프루닝이 동작하지 않아 전체 테이블을 스캔합니다:

```sql
-- ❌ 프루닝 안 됨: 파티션 컬럼에 함수 적용
WHERE DATE(order_timestamp) = '2024-01-01'

-- ✅ 프루닝 됨: 직접 비교
WHERE order_date = '2024-01-01'

-- ❌ 프루닝 안 됨: 서브쿼리 사용
WHERE order_date IN (SELECT date FROM other_table)

-- ✅ 프루닝 됨: 리터럴 값 직접 지정
WHERE order_date IN ('2024-01-01', '2024-01-02')

-- ❌ 프루닝 안 됨: 파티션 컬럼 없이 필터
WHERE amount > 100

-- ✅ 프루닝 됨: 파티션 컬럼 + 다른 조건 조합
WHERE order_date >= '2024-01-01' AND amount > 100
```

**원칙: 파티션 컬럼에 리터럴 값으로 직접 비교해야 프루닝이 동작합니다.**

### 파티션 필터 강제

실수로 전체 스캔하는 것을 방지하려면 파티션 필터를 강제할 수 있습니다.

```sql
ALTER TABLE my_dataset.orders
SET OPTIONS (require_partition_filter = true);

-- 파티션 필터 없으면 쿼리 실패
SELECT * FROM my_dataset.orders;  -- ❌ 에러

-- 파티션 필터가 있어야 실행
SELECT * FROM my_dataset.orders
WHERE order_date = '2024-01-01';  -- ✅ 정상
```

대용량 테이블에서는 이 옵션을 켜두는 것을 강력 권장합니다.

### 파티션 만료

오래된 데이터를 자동으로 삭제합니다. TTL(Time-To-Live) 개념입니다.

```sql
CREATE TABLE my_dataset.logs
(
    message STRING,
    log_date DATE
)
PARTITION BY log_date
OPTIONS (
    partition_expiration_days = 90  -- 90일 지난 파티션 자동 삭제
);
```

## 2. 클러스터링

---

### 클러스터링이란?

파티셔닝이 테이블을 **큰 블록으로 쪼개는** 것이라면, 클러스터링은 파티션(또는 테이블) 내부의 데이터를 **특정 컬럼 기준으로 정렬하여 저장**하는 것입니다.

```
events 테이블 (파티션: 2024-01-01)
├── 블록 A: user_id 1~100     ← WHERE user_id = 50 → 여기만 스캔
├── 블록 B: user_id 101~200   ← 스킵
├── 블록 C: user_id 201~300   ← 스킵
└── 블록 D: user_id 301~400   ← 스킵
```

BigQuery는 각 블록의 **min/max 메타데이터**를 관리합니다. 쿼리 시 `WHERE user_id = 50`이면, 블록 B~D는 min이 101 이상이므로 읽지 않습니다. 이를 **블록 프루닝(block pruning)**이라고 합니다.

### 파티셔닝과의 차이

| 구분 | 파티셔닝 | 클러스터링 |
|------|---------|-----------|
| **동작 원리** | 테이블을 독립 세그먼트로 물리 분할 | 세그먼트 내 데이터를 정렬하여 블록 프루닝 |
| **분할 기준** | DATE, TIMESTAMP, INT64만 가능 | 모든 데이터 타입 (STRING, BOOL 등 포함) |
| **비용 예측** | 쿼리 전에 정확한 스캔량 알 수 있음 | 쿼리 실행 후에야 실제 스캔량 확인 가능 |
| **제한** | 최대 4,000개 파티션 | 최대 4개 컬럼, 개수 제한 없음 |
| **유지보수** | 수동 (파티션 단위 로드/삭제) | **자동 재클러스터링** (BigQuery가 알아서) |
| **NULL 처리** | 별도 `__NULL__` 파티션 | NULL은 정렬 순서에서 가장 앞에 위치 |

**비용 예측**의 차이가 실무에서 중요합니다. 파티셔닝은 드라이런(dry run)으로 정확한 스캔량을 알 수 있지만, 클러스터링은 실행해봐야 얼마나 프루닝됐는지 알 수 있습니다.

### 클러스터 컬럼 선택 기준

최대 4개까지 지정할 수 있으며, **순서가 중요합니다**.

```sql
CLUSTER BY user_id, event_type, country
-- 1순위: user_id로 먼저 정렬
-- 2순위: 같은 user_id 내에서 event_type으로 정렬
-- 3순위: 같은 event_type 내에서 country로 정렬
```

**컬럼 순서 = 필터 우선순위**입니다. 첫 번째 컬럼으로만 필터링해도 효과가 있지만, 두 번째 컬럼만 단독으로 필터링하면 효과가 크게 줄어듭니다.

```sql
-- ✅ 최적: 클러스터 컬럼 순서대로 필터
WHERE user_id = 123 AND event_type = 'click'

-- ✅ 괜찮음: 첫 번째 컬럼만 필터
WHERE user_id = 123

-- ⚠️ 비효율: 첫 번째 컬럼을 건너뜀
WHERE event_type = 'click'  -- user_id 필터 없이 두 번째 컬럼만
```

**선택 가이드:**

| 우선순위 | 기준 | 이유 |
|---------|------|------|
| 1순위 | WHERE 절에 **가장 자주** 쓰이는 컬럼 | 프루닝 빈도 최대화 |
| 2순위 | **카디널리티가 높은** 컬럼 (고유 값이 많은) | min/max 범위가 좁아져 프루닝 효과 증가 |
| 3순위 | JOIN, GROUP BY에 자주 쓰이는 컬럼 | co-location으로 shuffle 감소 |

### 자동 재클러스터링

파티셔닝과 달리, 클러스터링은 **BigQuery가 자동으로 유지보수**합니다. 데이터가 추가되면 정렬이 깨질 수 있는데, BigQuery가 백그라운드에서 자동으로 재정렬합니다. 별도 비용은 발생하지 않습니다.

파티셔닝은 수동입니다. 파티션을 직접 생성하거나 삭제해야 하고, 데이터를 특정 파티션에 로드해야 합니다.

## 3. 함께 사용하기 (권장)

---

실무에서는 **파티셔닝 + 클러스터링을 함께** 사용하는 것이 일반적입니다.

```sql
CREATE TABLE my_dataset.events
(
    event_date DATE,
    user_id INT64,
    event_type STRING,
    data STRING
)
PARTITION BY event_date
CLUSTER BY user_id, event_type;
```

이렇게 하면 **2단계로 스캔 범위가 줄어듭니다:**

```
1단계 - 파티션 프루닝:
  WHERE event_date = '2024-01-01'
  → 해당 날짜 파티션만 선택 (나머지 전체 스킵)

2단계 - 블록 프루닝:
  AND user_id = 12345
  → 파티션 내에서 user_id 범위에 해당하는 블록만 스캔
```

### 언제 뭘 써야 하나?

| 상황 | 권장 | 이유 |
|------|------|------|
| 시간 기반 범위 쿼리가 대부분 | 파티셔닝 단독 | 프루닝만으로 충분 |
| 다양한 컬럼으로 필터링 | 클러스터링 단독 | 파티션 대상 컬럼이 없음 |
| 날짜 + 다른 컬럼 조합 필터 | **둘 다** | 2단계 프루닝 |
| 파티션당 데이터가 1GB 미만 | 클러스터링 단독 | 파티션이 너무 잘게 나뉘면 비효율 |
| STRING 컬럼으로 필터링 | 클러스터링 | 파티셔닝은 STRING 미지원 |

## 4. 쿼리 비용 확인

---

### 실행 전 예측 (Dry Run)

```sql
-- BigQuery 콘솔: 쿼리 입력 시 우측 상단에 "This query will process X bytes" 표시
SELECT * FROM my_dataset.orders
WHERE order_date = '2024-01-01';
```

```bash
# bq CLI로 드라이런
bq query --dry_run \
    'SELECT * FROM my_dataset.orders WHERE order_date = "2024-01-01"'
```

파티셔닝된 테이블은 드라이런에서 정확한 스캔량이 나옵니다. 클러스터링은 드라이런에서 상한값만 보여줍니다(실제 스캔은 더 적을 수 있음).

### 실행 후 확인

```sql
-- INFORMATION_SCHEMA.JOBS에서 실제 스캔량 확인
SELECT
    job_id,
    total_bytes_processed,
    total_bytes_billed
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE job_id = 'your-job-id';
```

# 5. 파티션/클러스터 정보 확인

---

```sql
-- 파티션 목록과 크기
SELECT
    partition_id,
    total_rows,
    total_logical_bytes
FROM `my_dataset.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = 'orders';

-- 테이블 DDL 확인 (파티션/클러스터 정의 포함)
SELECT ddl
FROM `my_dataset.INFORMATION_SCHEMA.TABLES`
WHERE table_name = 'orders';

-- 클러스터 컬럼 확인
SELECT
    column_name,
    clustering_ordinal_position
FROM `my_dataset.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
  AND clustering_ordinal_position IS NOT NULL
ORDER BY clustering_ordinal_position;
```

# 6. 기존 테이블에 파티셔닝 적용

---

BigQuery는 기존 테이블에 파티션을 추가할 수 없습니다. 새 테이블을 만들어야 합니다.

```sql
-- 파티셔닝 + 클러스터링이 적용된 새 테이블 생성
CREATE TABLE my_dataset.orders_partitioned
PARTITION BY order_date
CLUSTER BY user_id
AS SELECT * FROM my_dataset.orders;

-- 기존 테이블 삭제 후 대체
DROP TABLE my_dataset.orders;
-- BigQuery는 RENAME TABLE이 없으므로 새 테이블로 대체
```

주의: `CREATE TABLE AS SELECT`는 수집 시간 파티셔닝을 지원하지 않습니다.

## 7. 비용 최적화 체크리스트

---

| 항목 | 확인 |
|------|------|
| 대용량 테이블에 파티션 설정 | □ |
| 자주 필터하는 컬럼으로 클러스터 설정 | □ |
| `require_partition_filter` 활성화 | □ |
| 쿼리 전 드라이런으로 비용 확인 | □ |
| `SELECT *` 대신 필요한 컬럼만 조회 | □ |
| 파티션 컬럼에 함수를 적용하지 않음 | □ |
| 클러스터 컬럼 순서대로 필터 조건 작성 | □ |
| 파티션 만료 설정으로 불필요 데이터 자동 삭제 | □ |

## Reference

---

- [BigQuery Partitioned Tables](https://cloud.google.com/bigquery/docs/partitioned-tables)
- [BigQuery Clustered Tables](https://cloud.google.com/bigquery/docs/clustered-tables)
- [BigQuery Best Practices - Costs](https://cloud.google.com/bigquery/docs/best-practices-costs)
- [Querying Clustered Tables](https://cloud.google.com/bigquery/docs/querying-clustered-tables)
