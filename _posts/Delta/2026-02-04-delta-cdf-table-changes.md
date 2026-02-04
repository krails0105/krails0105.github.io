---
title: "[Delta Lake] CDF와 table_changes - 변경 데이터 추적하기"
categories:
  - Delta
tags:
  - [Delta, CDF, ChangeDataFeed, Incremental, Databricks]
---

# Introduction

---

Change Data Feed(CDF)는 Delta 테이블의 변경 내역을 추적하는 기능입니다. `table_changes()` 함수로 어떤 row가 INSERT/UPDATE/DELETE 되었는지 읽을 수 있습니다.

하지만 자주 만나는 오류가 있습니다:
- "change data was not recorded for version X"
- "enabled CDF but older versions missing"

이 글은 CDF의 동작 방식과 올바른 사용법을 정리합니다.

# 1. CDF 활성화 방법

---

```sql
-- 테이블 생성 시 활성화
CREATE TABLE events (
    id STRING,
    data STRING,
    updated_at TIMESTAMP
)
USING delta
TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- 기존 테이블에 활성화
ALTER TABLE events SET TBLPROPERTIES (delta.enableChangeDataFeed = true);
```

```python
# PySpark로 확인
spark.sql("DESCRIBE EXTENDED events").show(truncate=False)
```

# 2. CDF는 언제부터 기록되나?

---

**핵심 포인트:** CDF를 활성화한 **그 버전 이후**부터만 변경 기록이 존재합니다.

```
테이블 버전 타임라인:
v0 → v1 → v2 → v3(CDF 활성화) → v4 → v5
                   ↑
              이 시점부터 기록됨
```

따라서 `startVersion=0`으로 읽으면 오류가 발생합니다.

```sql
-- 오류 발생!
SELECT * FROM table_changes('events', 0, 5)

-- 해결: CDF 활성화 버전 이후부터
SELECT * FROM table_changes('events', 3, 5)
```

# 3. table_changes 사용법

---

```sql
-- 버전 범위로 읽기
SELECT * FROM table_changes('events', 3, 10)

-- 시간 범위로 읽기
SELECT * FROM table_changes('events', '2024-01-01', '2024-01-02')
```

## 반환되는 메타 컬럼

| 컬럼 | 설명 |
|------|------|
| `_change_type` | insert, update_preimage, update_postimage, delete |
| `_commit_version` | 변경이 발생한 버전 |
| `_commit_timestamp` | 변경 시점 |

```python
# PySpark로 읽기
changes = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 3) \
    .table("events")

changes.select("id", "_change_type", "_commit_version").show()
```

# 4. CDF 활성화 버전 찾기

---

```sql
-- 히스토리에서 CDF 활성화 시점 확인
DESCRIBE HISTORY events
```

```python
# Python으로 찾기
from delta.tables import DeltaTable

dt = DeltaTable.forName(spark, "events")
history = dt.history().filter("operation = 'SET TBLPROPERTIES'")
history.select("version", "timestamp", "operationParameters").show(truncate=False)
```

# 5. 증분 파이프라인 권장 구조

---

CDF를 기반으로 downstream을 갱신하려면:

```
1) 최초 적재: full snapshot (현재 테이블 전체)
2) 이후: table_changes로 version/시간 범위를 따라감
```

## 예시 코드

```python
# 최초 적재
def initial_load(source_table, target_path):
    df = spark.table(source_table)
    df.write.format("delta").mode("overwrite").save(target_path)

    # 마지막 버전 기록
    latest_version = DeltaTable.forName(spark, source_table).history(1) \
        .select("version").first()[0]
    save_checkpoint(latest_version)

# 증분 적재
def incremental_load(source_table, target_path):
    last_version = load_checkpoint()

    changes = spark.read.format("delta") \
        .option("readChangeFeed", "true") \
        .option("startingVersion", last_version + 1) \
        .table(source_table)

    # 변경 유형별 처리
    inserts = changes.filter("_change_type = 'insert'")
    updates = changes.filter("_change_type = 'update_postimage'")
    deletes = changes.filter("_change_type = 'delete'")

    # target에 적용 (MERGE 또는 다른 전략)
    apply_changes(target_path, inserts, updates, deletes)

    # 체크포인트 갱신
    new_version = changes.agg(max("_commit_version")).first()[0]
    save_checkpoint(new_version)
```

# 6. 흔한 운영 실수

---

| 실수 | 문제 | 해결 |
|------|------|------|
| CDF 켜기 전 버전부터 읽기 | 오류 발생 | 활성화 버전 확인 후 읽기 |
| 스키마 변경 무시 | 소비자 파이프라인 실패 | schema evolution 대응 |
| 체크포인트 미관리 | 중복/누락 | 버전 체크포인트 필수 |

# 7. 체크리스트

---

```
□ CDF 활성화 버전을 문서화했다
□ 최초 적재(full) + 이후 증분(CDF)로 파이프라인을 설계했다
□ 버전/시간 체크포인트를 관리하고 있다
□ schema evolution이 있을 때 change 소비자가 깨지지 않게 대응했다
□ 오래된 버전은 VACUUM으로 정리되어 CDF도 사라질 수 있음을 인지했다
```

# Reference

---

- [Delta Lake Change Data Feed](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Databricks CDF Documentation](https://docs.databricks.com/en/delta/delta-change-data-feed.html)
- [table_changes Function](https://docs.databricks.com/en/sql/language-manual/functions/table_changes.html)
