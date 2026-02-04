---
title: "[BigQuery] 파티셔닝과 클러스터링 - 비용 최적화 전략"
categories:
  - BigQuery
tags:
  - [BigQuery, Partitioning, Clustering, GCP, DataWarehouse]
---

# Introduction

---

BigQuery는 **스캔한 데이터 양**에 비례해서 비용이 발생합니다.

```
1TB 테이블 전체 스캔: $5
100GB만 스캔 (파티션 프루닝): $0.50
```

파티셔닝과 클러스터링은 **스캔 범위를 줄여** 비용과 속도를 개선합니다.

# 1. 파티셔닝

---

## 파티션이란?

테이블을 **날짜, 정수 범위, 또는 수동 지정**으로 분할합니다.

```
orders 테이블
├── 2024-01-01 파티션 (100GB)
├── 2024-01-02 파티션 (100GB)
└── 2024-01-03 파티션 (100GB)

WHERE order_date = '2024-01-01'
→ 100GB만 스캔 (300GB 아님!)
```

## 파티션 타입

### 1. 시간 기반 (권장)

```sql
CREATE TABLE my_dataset.orders
(
    order_id INT64,
    order_date DATE,
    amount NUMERIC
)
PARTITION BY order_date;

-- 또는 TIMESTAMP 컬럼
PARTITION BY DATE(created_at)

-- 또는 DATETIME
PARTITION BY DATE(DATETIME_TRUNC(event_time, DAY))
```

### 2. 정수 범위

```sql
CREATE TABLE my_dataset.users
(
    user_id INT64,
    name STRING
)
PARTITION BY RANGE_BUCKET(user_id, GENERATE_ARRAY(0, 1000000, 10000));
-- 0~10000, 10000~20000, ... 파티션 생성
```

### 3. 수집 시간 (Ingestion Time)

```sql
CREATE TABLE my_dataset.logs
(
    message STRING
)
PARTITION BY _PARTITIONDATE;  -- 데이터 로드 시점 기준
```

## 파티션 필터 강제

```sql
-- 파티션 필터 없으면 쿼리 실패
ALTER TABLE my_dataset.orders
SET OPTIONS (require_partition_filter = true);

-- 이제 필수
SELECT * FROM my_dataset.orders
WHERE order_date = '2024-01-01';  -- 필터 필수
```

## 파티션 만료

```sql
CREATE TABLE my_dataset.logs
(
    message STRING,
    log_date DATE
)
PARTITION BY log_date
OPTIONS (
    partition_expiration_days = 90  -- 90일 후 자동 삭제
);
```

# 2. 클러스터링

---

## 클러스터란?

파티션 내에서 **특정 컬럼 기준으로 정렬**합니다.

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

-- user_id로 필터 시 효율적
SELECT * FROM my_dataset.events
WHERE event_date = '2024-01-01'
  AND user_id = 12345;
```

## 클러스터 컬럼 선택

```
1. WHERE 절에 자주 쓰이는 컬럼
2. 카디널리티가 높은 컬럼 (고유 값이 많은)
3. 최대 4개 컬럼
```

```sql
CLUSTER BY user_id, event_type, country
-- 순서 중요: user_id 필터 시 최적화, event_type만 필터 시 덜 효과적
```

# 3. 파티셔닝 vs 클러스터링

---

| 항목 | 파티셔닝 | 클러스터링 |
|------|---------|-----------|
| 분할 기준 | 날짜, 정수 범위 | 모든 컬럼 타입 |
| 비용 예측 | 쿼리 전 정확히 알 수 있음 | 쿼리 실행 후 확인 |
| 최대 개수 | 4,000 파티션 | 제한 없음 |
| 갱신 | 파티션 단위 로드/삭제 | 자동 재클러스터링 |
| 적합한 경우 | 날짜 범위 쿼리 | 다양한 필터 조합 |

## 함께 사용 (권장)

```sql
-- 날짜로 파티션 + user_id로 클러스터
CREATE TABLE my_dataset.events
PARTITION BY event_date
CLUSTER BY user_id;

-- 효율적인 쿼리
SELECT * FROM my_dataset.events
WHERE event_date BETWEEN '2024-01-01' AND '2024-01-31'
  AND user_id = 12345;
```

# 4. 쿼리 비용 확인

---

## 쿼리 실행 전 예측

```sql
-- 드라이 런 (실제 실행 안 함)
SELECT * FROM my_dataset.orders
WHERE order_date = '2024-01-01';

-- BigQuery 콘솔에서 "This query will process X bytes" 확인
```

## bq 명령어

```bash
bq query --dry_run \
    'SELECT * FROM my_dataset.orders WHERE order_date = "2024-01-01"'
```

## 쿼리 후 확인

```sql
-- 작업 정보에서 bytes_processed 확인
SELECT
    job_id,
    total_bytes_processed,
    total_bytes_billed
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE job_id = 'your-job-id';
```

# 5. 파티션 정보 확인

---

## 파티션 목록

```sql
SELECT
    partition_id,
    total_rows,
    total_logical_bytes
FROM `my_dataset.INFORMATION_SCHEMA.PARTITIONS`
WHERE table_name = 'orders';
```

## 테이블 메타데이터

```sql
SELECT
    table_name,
    ddl
FROM `my_dataset.INFORMATION_SCHEMA.TABLES`
WHERE table_name = 'orders';
```

## 클러스터 정보

```sql
SELECT
    table_name,
    clustering_ordinal_position,
    column_name
FROM `my_dataset.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name = 'orders'
  AND clustering_ordinal_position IS NOT NULL;
```

# 6. 기존 테이블 파티셔닝

---

## 새 테이블로 복사

```sql
-- 기존 테이블에 파티션 추가 불가
-- 새 테이블 생성 필요

CREATE TABLE my_dataset.orders_partitioned
PARTITION BY order_date
CLUSTER BY user_id
AS SELECT * FROM my_dataset.orders;

-- 기존 테이블 삭제 후 이름 변경
DROP TABLE my_dataset.orders;
-- BigQuery는 RENAME 없음, 새 테이블로 대체
```

# 7. 파티션 프루닝 확인

---

## EXPLAIN으로 확인

```sql
-- 실행 계획 확인
SELECT * FROM my_dataset.orders
WHERE order_date = '2024-01-01';

-- 쿼리 실행 후 "Job Information" → "Bytes Processed" 확인
-- 파티션 프루닝이 되면 전체 테이블보다 적은 바이트
```

## 주의: 프루닝 안 되는 경우

```sql
-- 프루닝 X (함수 적용)
WHERE DATE(order_timestamp) = '2024-01-01'

-- 프루닝 O (직접 비교)
WHERE order_date = '2024-01-01'

-- 프루닝 X (서브쿼리)
WHERE order_date IN (SELECT date FROM other_table)

-- 프루닝 O (리터럴)
WHERE order_date IN ('2024-01-01', '2024-01-02')
```

# 8. 비용 최적화 팁

---

## 1. SELECT * 피하기

```sql
-- 나쁜 예 (모든 컬럼 스캔)
SELECT * FROM my_dataset.orders;

-- 좋은 예 (필요한 컬럼만)
SELECT order_id, amount FROM my_dataset.orders;
```

## 2. 파티션 필터 항상 사용

```sql
-- 비용 높음
SELECT * FROM my_dataset.orders WHERE amount > 100;

-- 비용 낮음
SELECT * FROM my_dataset.orders
WHERE order_date >= '2024-01-01'
  AND amount > 100;
```

## 3. 클러스터 컬럼 필터 추가

```sql
-- 클러스터 활용
SELECT * FROM my_dataset.events
WHERE event_date = '2024-01-01'
  AND user_id = 12345;  -- 클러스터 컬럼
```

# 9. 체크리스트

---

```
□ 대용량 테이블에 파티션을 설정했는가?
□ 자주 필터하는 컬럼으로 클러스터를 설정했는가?
□ require_partition_filter를 활성화했는가?
□ 쿼리 전 드라이 런으로 비용을 확인하는가?
□ SELECT *를 피하고 필요한 컬럼만 조회하는가?
□ 파티션 컬럼에 함수를 적용하지 않는가?
```

# Reference

---

- [BigQuery Partitioned Tables](https://cloud.google.com/bigquery/docs/partitioned-tables)
- [BigQuery Clustered Tables](https://cloud.google.com/bigquery/docs/clustered-tables)
- [BigQuery Best Practices](https://cloud.google.com/bigquery/docs/best-practices-costs)
- [BigQuery Pricing](https://cloud.google.com/bigquery/pricing)
