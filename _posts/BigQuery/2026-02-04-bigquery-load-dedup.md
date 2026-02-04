---
title: "[BigQuery] 데이터 로드와 중복 제거 - MERGE, 멱등 패턴"
categories:
  - BigQuery
tags:
  - [BigQuery, ETL, MERGE, Deduplication, GCP]
---

# Introduction

---

BigQuery로 데이터를 로드할 때 **중복 처리**는 필수입니다.

```
재시도/재처리 시:
- INSERT만 사용 → 중복 발생!
- MERGE 사용 → 멱등성 보장
```

# 1. 데이터 로드 방법

---

## 배치 로드

```bash
# GCS에서 로드
bq load \
    --source_format=PARQUET \
    my_dataset.my_table \
    gs://my-bucket/data/*.parquet

# CSV 로드
bq load \
    --source_format=CSV \
    --skip_leading_rows=1 \
    my_dataset.my_table \
    gs://my-bucket/data.csv \
    schema.json
```

## SQL로 로드

```sql
-- 외부 테이블에서 로드
LOAD DATA INTO my_dataset.my_table
FROM FILES (
    format = 'PARQUET',
    uris = ['gs://my-bucket/data/*.parquet']
);

-- 파티션 덮어쓰기
LOAD DATA OVERWRITE my_dataset.my_table
PARTITION (date = '2024-01-01')
FROM FILES (
    format = 'PARQUET',
    uris = ['gs://my-bucket/2024-01-01/*.parquet']
);
```

## 스트리밍 삽입

```python
from google.cloud import bigquery

client = bigquery.Client()
table_id = "project.dataset.table"

rows = [
    {"id": 1, "name": "Alice"},
    {"id": 2, "name": "Bob"}
]

errors = client.insert_rows_json(table_id, rows)
if errors:
    print(f"Errors: {errors}")
```

# 2. 중복 문제

---

## 문제 상황

```sql
-- 첫 번째 실행
INSERT INTO my_dataset.orders (order_id, amount)
VALUES (1, 100);

-- 재시도 (네트워크 에러 등)
INSERT INTO my_dataset.orders (order_id, amount)
VALUES (1, 100);

-- 결과: order_id=1이 2개!
```

## BigQuery 특성

- PRIMARY KEY 없음 (유니크 제약 없음)
- 동일 데이터 여러 번 삽입 가능
- 삭제/수정 비용이 높음

# 3. MERGE로 Upsert

---

## 기본 MERGE

```sql
MERGE INTO my_dataset.orders AS target
USING my_dataset.orders_staging AS source
ON target.order_id = source.order_id

WHEN MATCHED THEN
    UPDATE SET
        amount = source.amount,
        updated_at = CURRENT_TIMESTAMP()

WHEN NOT MATCHED THEN
    INSERT (order_id, amount, created_at)
    VALUES (source.order_id, source.amount, CURRENT_TIMESTAMP());
```

## 조건부 업데이트

```sql
MERGE INTO my_dataset.orders AS target
USING my_dataset.orders_staging AS source
ON target.order_id = source.order_id

WHEN MATCHED AND source.updated_at > target.updated_at THEN
    UPDATE SET
        amount = source.amount,
        status = source.status,
        updated_at = source.updated_at

WHEN NOT MATCHED THEN
    INSERT (order_id, amount, status, created_at)
    VALUES (source.order_id, source.amount, source.status, CURRENT_TIMESTAMP());
```

## DELETE 포함

```sql
MERGE INTO my_dataset.orders AS target
USING my_dataset.orders_staging AS source
ON target.order_id = source.order_id

WHEN MATCHED AND source.is_deleted = true THEN
    DELETE

WHEN MATCHED THEN
    UPDATE SET amount = source.amount

WHEN NOT MATCHED THEN
    INSERT (order_id, amount)
    VALUES (source.order_id, source.amount);
```

# 4. 멱등 로드 패턴

---

## 패턴 1: 파티션 덮어쓰기

```sql
-- 해당 파티션 전체 교체
CREATE OR REPLACE TABLE my_dataset.orders
PARTITION BY order_date
AS
SELECT * FROM my_dataset.orders
WHERE order_date != '2024-01-01'

UNION ALL

SELECT * FROM my_dataset.orders_staging
WHERE order_date = '2024-01-01';
```

## 패턴 2: DELETE + INSERT

```sql
-- 트랜잭션으로 묶기
BEGIN TRANSACTION;

DELETE FROM my_dataset.orders
WHERE order_date = '2024-01-01';

INSERT INTO my_dataset.orders
SELECT * FROM my_dataset.orders_staging
WHERE order_date = '2024-01-01';

COMMIT TRANSACTION;
```

## 패턴 3: 스테이징 테이블 + MERGE

```sql
-- 1. 스테이징 테이블에 로드
LOAD DATA INTO my_dataset.orders_staging
FROM FILES (...);

-- 2. 중복 제거 후 MERGE
MERGE INTO my_dataset.orders AS target
USING (
    SELECT * FROM my_dataset.orders_staging
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY order_id
        ORDER BY updated_at DESC
    ) = 1
) AS source
ON target.order_id = source.order_id
WHEN MATCHED THEN UPDATE SET ...
WHEN NOT MATCHED THEN INSERT ...;

-- 3. 스테이징 정리
TRUNCATE TABLE my_dataset.orders_staging;
```

# 5. 중복 제거 쿼리

---

## ROW_NUMBER로 중복 제거

```sql
-- 각 order_id에서 최신 1개만 선택
SELECT *
FROM my_dataset.orders
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY order_id
    ORDER BY updated_at DESC
) = 1;
```

## 기존 테이블 중복 제거

```sql
-- 새 테이블로 중복 제거
CREATE OR REPLACE TABLE my_dataset.orders_clean
AS
SELECT *
FROM my_dataset.orders
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY order_id
    ORDER BY updated_at DESC
) = 1;

-- 원본 교체
DROP TABLE my_dataset.orders;
ALTER TABLE my_dataset.orders_clean
RENAME TO my_dataset.orders;
```

## DISTINCT로 완전 중복 제거

```sql
-- 모든 컬럼이 동일한 행 제거
CREATE OR REPLACE TABLE my_dataset.orders
AS
SELECT DISTINCT * FROM my_dataset.orders;
```

# 6. 스트리밍 중복 처리

---

## insertId 사용

```python
from google.cloud import bigquery

client = bigquery.Client()
table_id = "project.dataset.table"

rows = [
    {
        "insertId": "order_123",  # 중복 방지 ID
        "json": {"order_id": 123, "amount": 100}
    }
]

# 같은 insertId는 1분간 중복 삽입 방지
errors = client.insert_rows_json(table_id, rows)
```

## 스트리밍 후 배치 중복 제거

```sql
-- 스트리밍 버퍼 (최근 데이터)
-- + 최종 테이블 MERGE

-- 스케줄된 쿼리로 주기적 중복 제거
MERGE INTO my_dataset.orders_final AS target
USING (
    SELECT * FROM my_dataset.orders_streaming
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY order_id
        ORDER BY _PARTITIONTIME DESC
    ) = 1
) AS source
ON target.order_id = source.order_id
...
```

# 7. 에러 처리

---

## MERGE 제한사항

```sql
-- 에러: target에 중복 매칭
MERGE INTO orders AS target
USING staging AS source
ON target.order_id = source.order_id  -- source에 order_id 중복 시 에러!
...

-- 해결: 소스 중복 제거
MERGE INTO orders AS target
USING (
    SELECT * FROM staging
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ts DESC) = 1
) AS source
ON target.order_id = source.order_id
...
```

## 대용량 MERGE

```sql
-- 파티션 단위로 분할
MERGE INTO my_dataset.orders AS target
USING my_dataset.staging AS source
ON target.order_id = source.order_id
   AND target.order_date = source.order_date  -- 파티션 키 포함
   AND source.order_date = '2024-01-01'       -- 범위 제한
...
```

# 8. 모니터링

---

## 로드 작업 확인

```sql
SELECT
    job_id,
    creation_time,
    state,
    total_bytes_processed,
    error_result
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE job_type = 'LOAD'
ORDER BY creation_time DESC
LIMIT 10;
```

## 테이블 변경 이력

```sql
SELECT
    table_name,
    last_modified_time,
    row_count,
    size_bytes
FROM `my_dataset.INFORMATION_SCHEMA.TABLES`
WHERE table_name = 'orders';
```

# 9. 체크리스트

---

```
□ 로드 작업이 멱등한가? (재실행해도 결과 동일)
□ MERGE 소스에 중복이 없는가?
□ 파티션 키를 MERGE 조건에 포함했는가?
□ 스트리밍 데이터의 중복 제거 전략이 있는가?
□ 로드 실패 시 재시도 로직이 있는가?
□ 테이블 크기/행 수 모니터링을 하는가?
```

# Reference

---

- [BigQuery MERGE Statement](https://cloud.google.com/bigquery/docs/reference/standard-sql/dml-syntax#merge_statement)
- [BigQuery Loading Data](https://cloud.google.com/bigquery/docs/loading-data)
- [BigQuery Streaming Inserts](https://cloud.google.com/bigquery/docs/streaming-data-into-bigquery)
- [BigQuery Best Practices - Loading](https://cloud.google.com/bigquery/docs/best-practices-loading)
