---
title: "[Delta] replaceWhere vs MERGE - 증분 적재 전략 선택"
categories:
  - Delta
tags:
  - [Delta, ReplaceWhere, MERGE, Incremental, Idempotency]
---

# Introduction

---

증분 적재(incremental load)에서 자주 하는 고민:

- 파티션 단위 overwrite(`replaceWhere`)로 갈까?
- 키 기반 upsert(`MERGE`)로 갈까?

둘 다 정답이 될 수 있고, 상황에 따라 선택 기준이 명확합니다.

# 1. replaceWhere (파티션 단위 Overwrite)

---

특정 조건에 맞는 파티션만 덮어씁니다.

```python
df.write.format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", "date = '2024-01-15'") \
    .save("/path/to/table")
```

```sql
-- SQL에서
INSERT OVERWRITE my_table
PARTITION (date = '2024-01-15')
SELECT * FROM source_data WHERE date = '2024-01-15';
```

## 장점

| 장점 | 설명 |
|------|------|
| 멱등성 | 같은 입력이면 같은 결과 (재실행 안전) |
| 단순함 | 로직이 간단하고 예측 가능 |
| Backfill 용이 | 과거 파티션 재처리가 쉬움 |
| 키 관리 불필요 | PK/unique key 설계 불필요 |

## 단점

| 단점 | 설명 |
|------|------|
| I/O 비용 | 파티션 전체를 재작성 |
| 변경량이 적을 때 비효율 | 1건 변경에도 전체 파티션 재작성 |

## 언제 사용하나?

- 파티션 키(date/hour 등)가 명확할 때
- 해당 파티션을 통째로 재계산해도 비용이 감당될 때
- Backfill/재처리가 잦을 때
- 멱등성이 중요할 때

# 2. MERGE (키 기반 Upsert)

---

Primary Key 기준으로 존재하면 UPDATE, 없으면 INSERT합니다.

```python
from delta.tables import DeltaTable

target = DeltaTable.forPath(spark, "/path/to/table")

target.alias("t").merge(
    source_df.alias("s"),
    "t.id = s.id"
).whenMatchedUpdateAll() \
 .whenNotMatchedInsertAll() \
 .execute()
```

```sql
-- SQL에서
MERGE INTO target t
USING source s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;
```

## 장점

| 장점 | 설명 |
|------|------|
| 효율성 | 변경된 레코드만 처리 |
| 세밀한 제어 | UPDATE/DELETE 조건 분리 가능 |
| 키 기반 정합성 | 중복/경합 방지 |

## 단점

| 단점 | 설명 |
|------|------|
| 복잡도 | 키 설계, 스큐 관리 필요 |
| 튜닝 필요 | 성능 최적화가 어려움 |
| 멱등성 확보 어려움 | 실행 순서/중복에 민감 |

## 언제 사용하나?

- 변경이 일부 레코드에만 국한될 때
- 파티션이 크고 overwrite 비용이 클 때
- CDC(Change Data Capture) 스타일 적재
- 키 기반 정합성이 중요할 때

# 3. 비교 요약

---

| 항목 | replaceWhere | MERGE |
|------|--------------|-------|
| 단위 | 파티션 | 레코드 |
| 멱등성 | 자연스럽게 확보 | 키 설계/규칙 필요 |
| I/O 비용 | 높음 (파티션 전체) | 낮음 (변경분만) |
| 복잡도 | 낮음 | 높음 |
| Backfill | 쉬움 | 까다로움 |
| 스큐 영향 | 적음 | 큼 |

# 4. 선택 기준 플로우차트

---

```
파티션 범위를 명확히 정의할 수 있는가?
├─ No → MERGE
└─ Yes → 변경량이 파티션의 몇 %인가?
          ├─ 대부분 (>50%) → replaceWhere
          └─ 일부 (<50%) → 재처리가 잦은가?
                            ├─ Yes → replaceWhere (멱등성)
                            └─ No → MERGE (효율성)
```

# 5. 실전 패턴

---

## replaceWhere 패턴

```python
def incremental_load_replace(spark, source_df, target_path, partition_col, partition_value):
    """파티션 단위 덮어쓰기"""
    filtered = source_df.filter(f"{partition_col} = '{partition_value}'")

    filtered.write.format("delta") \
        .mode("overwrite") \
        .option("replaceWhere", f"{partition_col} = '{partition_value}'") \
        .save(target_path)

# 사용
incremental_load_replace(spark, source_df, "/warehouse/events", "date", "2024-01-15")
```

## MERGE 패턴

```python
def incremental_load_merge(spark, source_df, target_path, merge_key):
    """키 기반 upsert"""
    from delta.tables import DeltaTable

    target = DeltaTable.forPath(spark, target_path)

    target.alias("t").merge(
        source_df.alias("s"),
        f"t.{merge_key} = s.{merge_key}"
    ).whenMatchedUpdateAll() \
     .whenNotMatchedInsertAll() \
     .execute()

# 사용
incremental_load_merge(spark, source_df, "/warehouse/users", "user_id")
```

## 하이브리드 패턴

```python
def smart_incremental_load(spark, source_df, target_path, partition_col, merge_key,
                           partition_value, threshold_pct=0.5):
    """변경량에 따라 전략 선택"""
    from delta.tables import DeltaTable

    target = DeltaTable.forPath(spark, target_path)

    # 기존 파티션 크기
    target_count = target.toDF() \
        .filter(f"{partition_col} = '{partition_value}'") \
        .count()

    source_count = source_df.count()

    if target_count == 0 or source_count / target_count > threshold_pct:
        # 변경량이 많으면 replaceWhere
        source_df.write.format("delta") \
            .mode("overwrite") \
            .option("replaceWhere", f"{partition_col} = '{partition_value}'") \
            .save(target_path)
    else:
        # 변경량이 적으면 MERGE
        target.alias("t").merge(
            source_df.alias("s"),
            f"t.{merge_key} = s.{merge_key}"
        ).whenMatchedUpdateAll() \
         .whenNotMatchedInsertAll() \
         .execute()
```

# 6. MERGE 성능 튜닝

---

MERGE가 느릴 때 확인할 것:

```python
# 1. 키 스큐 확인
source_df.groupBy("merge_key").count().orderBy(desc("count")).show(10)

# 2. Small files 확인
DeltaTable.forPath(spark, target_path).detail().select("numFiles").show()

# 3. 통계 갱신
spark.sql(f"ANALYZE TABLE delta.`{target_path}` COMPUTE STATISTICS")
```

# 7. 체크리스트

---

```
□ 파티션 범위를 명확히 정의할 수 있는가?
□ 재처리(backfill)가 잦은가?
□ 변경량이 "전체 vs 일부" 중 어디에 가까운가?
□ MERGE 키 분포 스큐는 없는가?
□ 멱등성이 중요한가?
□ 운영 복잡도를 감당할 수 있는가?
```

# Reference

---

- [Delta Lake MERGE](https://docs.delta.io/latest/delta-update.html)
- [Delta Lake Overwrite](https://docs.delta.io/latest/delta-batch.html#overwrite)
- [replaceWhere Option](https://docs.delta.io/latest/delta-batch.html#selective-overwrite-with-dataframe)
