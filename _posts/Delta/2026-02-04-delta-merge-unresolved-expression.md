---
title: "[Delta] MERGE 에러 해결 - DELTA_MERGE_UNRESOLVED_EXPRESSION"
categories:
  - Delta
tags:
  - [Delta, MERGE, Upsert, Databricks, Troubleshooting]
---

# Introduction

---

Delta MERGE에서 자주 보이는 에러:

- `DELTA_MERGE_UNRESOLVED_EXPRESSION`
- "Cannot resolve s.xxx in search condition given columns ..."

이 에러의 본질은 거의 항상: **USING 서브쿼리/뷰에 그 컬럼이 실제로 없거나, 이름이 다르다(alias mismatch)**.

# 1. 에러가 발생하는 대표 원인

---

## 원인 1: 컬럼명 변경/rename

```sql
-- USING 소스에서 컬럼명이 바뀜
-- 기대: created_output_index
-- 실제: created_index

MERGE INTO target t
USING source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
    t.created_output_index = s.created_output_index  -- 오류!
```

## 원인 2: SELECT에서 alias를 줬는데 옛 이름 참조

```sql
-- source CTE에서 alias 사용
WITH source AS (
    SELECT id, amount AS total_amount FROM raw_data
)
MERGE INTO target t
USING source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
    t.amount = s.amount  -- 오류! (alias는 total_amount)
```

## 원인 3: USING이 view/CTE라서 컬럼이 축약됨

```sql
-- view가 일부 컬럼만 노출
CREATE VIEW source_view AS
    SELECT id, name FROM full_table;  -- amount 없음

MERGE INTO target t
USING source_view s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
    t.amount = s.amount  -- 오류! view에 없음
```

# 2. 해결 절차 (실전 순서)

---

## Step 1: USING 쪽 스키마 확인

```sql
-- SQL에서
DESCRIBE source_view;

-- 또는 CTE를 따로 실행해서 컬럼 확인
SELECT * FROM source_cte LIMIT 1;
```

```python
# PySpark
source_df.printSchema()
source_df.columns
```

## Step 2: MERGE ON 조건에 쓰는 컬럼이 존재하는지 확인

```python
required_cols = ["id", "created_output_index", "amount"]
missing = set(required_cols) - set(source_df.columns)
if missing:
    raise ValueError(f"Missing columns: {missing}")
```

## Step 3: 컬럼 rename이 필요한 경우

```sql
-- USING CTE에서 alias로 맞추기
WITH source AS (
    SELECT
        id,
        created_index AS created_output_index,  -- rename
        total AS amount
    FROM raw_data
)
MERGE INTO target t
USING source s
ON t.id = s.id
...
```

# 3. 예방을 위한 패턴

---

## 표준 컬럼명 정의

MERGE에 들어가는 key 컬럼은 **고정된 스키마**로 관리합니다.

```python
# 표준 스키마 정의
STANDARD_MERGE_COLS = {
    "id": StringType(),
    "created_at": TimestampType(),
    "updated_at": TimestampType(),
    "amount": DecimalType(18, 8)
}

def validate_merge_schema(df, required_cols):
    """MERGE 전 스키마 검증"""
    missing = set(required_cols) - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns for MERGE: {missing}")
    return df
```

## USING CTE에서 표준 컬럼명으로 통일

```sql
WITH normalized_source AS (
    SELECT
        COALESCE(src_id, legacy_id) AS id,
        src_amount AS amount,
        src_updated AS updated_at
    FROM raw_source
)
MERGE INTO target t
USING normalized_source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
    t.amount = s.amount,
    t.updated_at = s.updated_at
```

# 4. PySpark MERGE 패턴

---

```python
from delta.tables import DeltaTable

target = DeltaTable.forPath(spark, "/path/to/target")

# source 스키마 확인
source_df = spark.table("source_table")
print("Source columns:", source_df.columns)

# MERGE 실행
target.alias("t").merge(
    source_df.alias("s"),
    "t.id = s.id"
).whenMatchedUpdate(set={
    "amount": "s.amount",
    "updated_at": "s.updated_at"
}).whenNotMatchedInsert(values={
    "id": "s.id",
    "amount": "s.amount",
    "updated_at": "s.updated_at"
}).execute()
```

## 동적 컬럼 매핑

```python
def build_merge_set(source_cols, exclude=["id"]):
    """동적으로 UPDATE SET 절 생성"""
    return {col: f"s.{col}" for col in source_cols if col not in exclude}

update_set = build_merge_set(source_df.columns)
print("Update set:", update_set)
```

# 5. 체크리스트

---

```
□ USING relation에 ON 조건 컬럼이 실제 존재하는가?
□ alias를 사용했다면 조건도 alias 기준인가?
□ key 컬럼 네이밍 규칙이 파이프라인 전체에서 일관되는가?
□ 스키마 변경 시 CI에서 컬럼 존재 여부를 검증하는가?
□ MERGE 전에 source 스키마를 명시적으로 확인하는가?
```

# 6. 재발 방지

---

## CI/CD에서 스키마 검증

```python
# 테스트 코드 예시
def test_merge_schema_compatibility():
    source_df = create_test_source()
    required = ["id", "amount", "updated_at"]

    for col in required:
        assert col in source_df.columns, f"Missing required column: {col}"
```

## 문서화

```yaml
# schema_registry.yaml
tables:
  orders:
    merge_keys: [order_id]
    required_columns:
      - order_id
      - amount
      - updated_at
    naming_convention: snake_case
```

# Reference

---

- [Delta Lake MERGE Documentation](https://docs.delta.io/latest/delta-update.html#upsert-into-a-table-using-merge)
- [Databricks MERGE INTO](https://docs.databricks.com/en/sql/language-manual/delta-merge-into.html)
- [DeltaTable Python API](https://docs.delta.io/latest/api/python/index.html)
