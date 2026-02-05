---
title: "[Delta] 멱등한 저장 패턴 - replaceWhere, MERGE, DELETE+INSERT"
categories:
  - Delta
tags:
  - [Delta, Idempotency, ReplaceWhere, MERGE, DeleteInsert, DataPipeline]
---

# Introduction

---

데이터 파이프라인에서 같은 작업을 두 번 실행해도 결과가 달라지지 않는 것, 즉 **멱등성(Idempotency)**은 운영 안정성의 핵심입니다. Airflow의 `execution_date`로 "어떤 날짜를 처리할지"를 결정했다면, 그 데이터를 **어떻게 저장할지**가 멱등성의 나머지 절반입니다.

파이프라인 설계 관점의 멱등성(execution_date, backfill, retry 등)은 [Airflow 멱등성 포스트](/Airflow/airflow-idempotency-backfill/)에서 다룹니다. 이 글은 **Delta Lake에서 멱등한 저장을 구현하는 구체적인 패턴**을 정리합니다.

replaceWhere와 MERGE의 성능/선택 기준 비교는 [replaceWhere vs MERGE 포스트](/Delta/delta-replacewhere-vs-merge/)에서 다루고 있으므로, 이 글에서는 각 패턴이 **멱등성을 어떻게 확보하는지**에 집중합니다.

# 1. 왜 저장 방식이 멱등성을 결정하는가

---

같은 데이터를 같은 조건으로 처리해도, 저장 방식에 따라 결과가 달라집니다.

```text
비멱등 저장 (append):
  실행 1: INSERT 1000 rows → 총 1000 rows
  실행 2: INSERT 1000 rows → 총 2000 rows (중복!)

멱등한 저장 (overwrite):
  실행 1: OVERWRITE 1000 rows → 총 1000 rows
  실행 2: OVERWRITE 1000 rows → 총 1000 rows (동일!)
```

핵심 원칙: **"저장 대상 범위를 먼저 비우고, 새 데이터를 넣는다"** 또는 **"키 기반으로 있으면 갱신, 없으면 삽입한다"**.

# 2. 패턴 1: replaceWhere (파티션 단위 덮어쓰기)

---

가장 단순하고 멱등성을 자연스럽게 확보하는 패턴입니다. 지정한 조건에 해당하는 데이터를 원자적으로 교체합니다. 같은 날짜의 장부를 통째로 새 장부로 교체하는 것과 같습니다. Delta Lake 1.0 이하에서는 파티션 컬럼만 지원했지만, **1.1.0+부터는 임의 컬럼의 조건도 사용 가능**합니다.

```python
def save_with_replace_where(df, target_path, execution_date):
    """execution_date 파티션을 통째로 교체"""
    df.write.format("delta") \
        .mode("overwrite") \
        .option("replaceWhere", f"date = '{execution_date}'") \
        .save(target_path)
```

## 동작 원리

```text
1. date = '2024-01-15' 조건에 해당하는 기존 데이터 파일을 논리적으로 삭제
2. 새 데이터를 새 파일로 작성
3. 트랜잭션 로그에 기록 (원자적)

→ 몇 번을 실행해도 해당 파티션에는 최신 결과만 남음
```

## SQL 방식

```sql
INSERT OVERWRITE target_table
PARTITION (date = '2024-01-15')
SELECT * FROM source_data
WHERE date = '2024-01-15';
```

## Dynamic Partition Overwrite

파티션 값을 명시하지 않고, DataFrame에 포함된 파티션만 자동으로 덮어쓰는 방식도 있습니다.

```python
# Spark 설정으로 활성화
spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

df.write.format("delta") \
    .mode("overwrite") \
    .saveAsTable("target_table")
```

```text
주의: dynamic 모드와 replaceWhere는 함께 사용할 수 없습니다.
      dynamic 모드는 DataFrame에 포함된 파티션을 자동 감지하므로
      replaceWhere의 명시적 조건 지정과 충돌합니다.
```

## 멱등성 확보 조건

```text
✅ 파티션 키(date, hour 등)가 명확할 것
✅ execution_date와 파티션 키가 대응될 것
✅ 소스 데이터가 동일하면 결과도 동일할 것 (결정적 처리)
```

# 3. 패턴 2: MERGE INTO (키 기반 Upsert)

---

Primary Key 기준으로 "있으면 갱신, 없으면 삽입"하는 패턴입니다. 파티션 단위가 아닌 레코드 단위로 동작합니다.

```python
from delta.tables import DeltaTable

def save_with_merge(spark, source_df, target_path, merge_keys):
    """키 기반 upsert"""
    target = DeltaTable.forPath(spark, target_path)

    merge_condition = " AND ".join([f"t.{k} = s.{k}" for k in merge_keys])

    target.alias("t").merge(
        source_df.alias("s"),
        merge_condition
    ).whenMatchedUpdateAll() \
     .whenNotMatchedInsertAll() \
     .execute()
```

## SQL 방식

```sql
MERGE INTO target t
USING source s
ON t.id = s.id AND t.date = s.date
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;
```

## WHEN NOT MATCHED BY SOURCE

Delta Lake 2.4+에서는 소스에 없는 타겟 레코드를 삭제하는 절도 지원합니다.

```sql
MERGE INTO target t
USING source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *
WHEN NOT MATCHED BY SOURCE AND t.date = '2024-01-15'
  THEN DELETE;
```

이 패턴은 해당 날짜의 데이터를 소스 기준으로 완전히 동기화하므로, replaceWhere에 가까운 멱등성을 확보합니다.

## 멱등성 확보 조건

```text
✅ merge 키가 데이터 내에서 유일할 것 (PK 역할)
✅ 같은 소스 데이터로 실행하면 같은 결과가 나올 것
⚠️ 순서 의존적 로직(예: last_updated 비교)은 멱등성을 깨뜨릴 수 있음
⚠️ 소스에 중복 키가 있으면 MERGE가 실패하거나 비결정적 결과 발생
```

## 소스 중복 키 문제

```python
# MERGE 전에 소스 데이터 중복 제거 필수
source_deduped = source_df.dropDuplicates(["id", "date"])
```

MERGE의 ON 조건에 매칭되는 소스 행이 여러 개이면 에러가 발생합니다. 반드시 소스 데이터의 키 유일성을 보장해야 합니다.

# 4. 패턴 3: DELETE + INSERT

---

명시적으로 "지우고 넣기"를 수행하는 패턴입니다. replaceWhere와 결과는 같지만, 두 단계로 나뉘므로 트랜잭션 보장에 주의가 필요합니다.

```python
from delta.tables import DeltaTable

def save_with_delete_insert(spark, source_df, target_path, execution_date):
    """DELETE + INSERT 패턴"""
    target = DeltaTable.forPath(spark, target_path)

    # Step 1: 해당 날짜 데이터 삭제
    target.delete(f"date = '{execution_date}'")

    # Step 2: 새 데이터 삽입
    source_df.write.format("delta") \
        .mode("append") \
        .save(target_path)
```

## SQL 방식

```sql
DELETE FROM target WHERE date = '2024-01-15';

INSERT INTO target
SELECT * FROM source WHERE date = '2024-01-15';
```

## 주의사항

```text
⚠️ DELETE와 INSERT가 별도 트랜잭션
   → DELETE 후 INSERT 전에 실패하면 데이터 유실
   → replaceWhere는 하나의 원자적 트랜잭션으로 처리

⚠️ 멱등성은 확보되지만 (재실행하면 같은 결과)
   중간 실패 시 복구가 replaceWhere보다 복잡함
```

Delta Lake의 트랜잭션 로그 덕분에 DELETE 자체는 원자적이고 INSERT도 원자적이지만, **두 작업을 묶는 트랜잭션은 기본적으로 제공되지 않습니다**. 이 점이 replaceWhere와의 핵심 차이입니다.

## 언제 사용하나

```text
- replaceWhere를 쓸 수 없는 경우 (비파티션 테이블, 복합 조건)
- 삭제 조건이 파티션 키가 아닌 임의 컬럼일 때
- 레거시 시스템에서 마이그레이션할 때
```

# 5. 패턴 비교

---

| 항목 | replaceWhere | MERGE | DELETE+INSERT |
|------|-------------|-------|---------------|
| **단위** | 파티션 | 레코드 | 파티션/임의 조건 |
| **멱등성** | 자연스럽게 확보 | 키 설계 필요 | 확보 (중간 실패 주의) |
| **원자성** | 단일 트랜잭션 | 단일 트랜잭션 | 두 개 트랜잭션 |
| **복잡도** | 낮음 | 중간 | 낮음 |
| **I/O 비용** | 파티션 전체 재작성 | 변경분만 | 파티션 전체 재작성 |
| **파티션 필요** | No (1.1.0+) | No | No |
| **Backfill** | 매우 쉬움 | 설계 필요 | 쉬움 |

## 선택 기준

```text
1. 범위 조건(date, hour 등)으로 교체 가능한가?
   └─ Yes → replaceWhere (가장 단순하고 안전, 1.1.0+는 비파티션도 가능)

2. 레코드 단위 갱신이 필요한가?
   └─ Yes → MERGE (키 유일성 보장 필수)

3. 위 둘 다 어려운 경우?
   └─ DELETE + INSERT (중간 실패 대비 필요)
```

# 6. Airflow와 연결하기

---

Airflow의 `execution_date`와 Delta Lake 저장 패턴을 결합하면 멱등한 파이프라인이 완성됩니다.

```python
from airflow.decorators import dag, task
from datetime import datetime

@dag(schedule_interval="@daily", start_date=datetime(2024, 1, 1), catchup=True)
def idempotent_pipeline():

    @task
    def process_and_save(**context):
        execution_date = context["ds"]  # "2024-01-15"

        # 1. execution_date 기준으로 소스 읽기
        source_df = spark.sql(f"""
            SELECT * FROM raw_data
            WHERE date = '{execution_date}'
        """)

        # 2. 변환 로직 (결정적이어야 함)
        result_df = source_df.transform(apply_business_logic)

        # 3. 멱등하게 저장 (replaceWhere)
        result_df.write.format("delta") \
            .mode("overwrite") \
            .option("replaceWhere", f"date = '{execution_date}'") \
            .saveAsTable("silver.events")

    process_and_save()

dag = idempotent_pipeline()
```

```text
핵심 조합:
  Airflow execution_date → "어떤 날짜를 처리할지" 결정
  Delta replaceWhere     → "그 날짜를 어떻게 저장할지" 결정
  → 같은 날짜를 다시 돌려도 결과가 동일
```

# 7. 멱등성 검증 쿼리

---

파이프라인이 실제로 멱등한지 확인하는 쿼리입니다.

```sql
-- 1. 중복 키 확인 (0건이어야 함)
SELECT id, date, COUNT(*) AS cnt
FROM target_table
WHERE date = '2024-01-15'
GROUP BY id, date
HAVING COUNT(*) > 1;

-- 2. 행 수/합계 비교 (2회 실행 후 동일해야 함)
SELECT
    COUNT(*) AS row_count,
    SUM(amount) AS total_amount,
    MIN(updated_at) AS earliest,
    MAX(updated_at) AS latest
FROM target_table
WHERE date = '2024-01-15';

-- 3. Delta Lake 히스토리로 변경 추적
DESCRIBE HISTORY target_table;
-- 같은 날짜 재실행 시 WRITE/MERGE 작업이 기록됨
-- 이전 버전과 현재 버전의 행 수가 동일한지 확인
```

## 자동화된 멱등성 테스트

```python
def test_idempotency(spark, pipeline_func, execution_date, target_table):
    """같은 날짜를 2번 실행하고 결과를 비교"""

    # 첫 번째 실행
    pipeline_func(execution_date)
    result1 = spark.sql(f"""
        SELECT COUNT(*) AS cnt, SUM(amount) AS total
        FROM {target_table}
        WHERE date = '{execution_date}'
    """).collect()[0]

    # 두 번째 실행
    pipeline_func(execution_date)
    result2 = spark.sql(f"""
        SELECT COUNT(*) AS cnt, SUM(amount) AS total
        FROM {target_table}
        WHERE date = '{execution_date}'
    """).collect()[0]

    assert result1["cnt"] == result2["cnt"], \
        f"Row count changed: {result1['cnt']} → {result2['cnt']}"
    assert result1["total"] == result2["total"], \
        f"Total changed: {result1['total']} → {result2['total']}"
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **replaceWhere** | 파티션 단위 원자적 교체, 가장 단순한 멱등 패턴 |
| **MERGE** | 키 기반 upsert, 레코드 단위 멱등성 (키 설계 필요) |
| **DELETE+INSERT** | 명시적 삭제 후 삽입, 두 트랜잭션 주의 |
| **Dynamic Overwrite** | DataFrame의 파티션을 자동 감지하여 교체 |
| **핵심 원칙** | execution_date 기반 필터 + 멱등한 저장 패턴 |

```text
핵심:
  멱등한 파이프라인 = 결정적 처리 + 멱등한 저장.
  Delta Lake는 replaceWhere, MERGE, DELETE+INSERT로
  저장 단계의 멱등성을 보장한다.
  대부분의 경우 replaceWhere가 가장 단순하고 안전한 선택.
```

# Reference

---

- [Delta Lake Batch Writes - replaceWhere](https://docs.delta.io/latest/delta-batch.html#overwrite)
- [Delta Lake MERGE](https://docs.delta.io/latest/delta-update.html)
- [Delta Lake Dynamic Partition Overwrite](https://docs.delta.io/latest/delta-batch.html#dynamic-partition-overwrites)
- [Airflow 멱등성과 Backfill](/Airflow/airflow-idempotency-backfill/)
- [replaceWhere vs MERGE 비교](/Delta/delta-replacewhere-vs-merge/)
