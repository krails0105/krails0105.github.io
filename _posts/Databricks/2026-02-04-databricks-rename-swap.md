---
title: "[Databricks] 테이블 Rename 스위칭 - Blue/Green 배포 패턴"
categories:
  - Databricks
tags:
  - [Databricks, Delta, BlueGreen, Deployment, Operations]
---

# Introduction

---

배치/서빙 테이블을 교체할 때 가장 안전한 방식 중 하나가 **blue/green 스위칭**입니다.

- 새 테이블을 먼저 완성
- 검증
- 마지막에 rename으로 "원래 이름"을 새 테이블로 스왑

이 방식의 장점:
- 다운스트림 쿼리/서비스는 테이블 이름이 고정이라 변경이 최소화
- 실패 시 롤백이 빠름

# 1. 왜 Rename Swap을 쓰나?

---

## 직접 Overwrite의 문제

```sql
-- 문제: 중간에 읽는 쿼리가 깨질 수 있음
INSERT OVERWRITE my_table SELECT * FROM new_data;
```

- 작업 중 테이블이 일시적으로 비어있거나 불완전한 상태
- 다운스트림에서 예상치 못한 결과

## Rename Swap의 장점

```sql
-- 새 테이블 준비 (다운스트림 영향 없음)
CREATE TABLE my_table_new AS SELECT * FROM new_data;

-- 검증 완료 후 원자적 스왑
ALTER TABLE my_table RENAME TO my_table_backup;
ALTER TABLE my_table_new RENAME TO my_table;
```

- 검증 완료된 결과를 원자적으로 교체
- 롤백도 빠름 (backup 테이블로 되돌리기)

# 2. 기본 스위칭 시나리오

---

## Step 1: 새 테이블 생성/적재

```sql
-- 새 버전 테이블 생성
CREATE TABLE events_new
USING delta
AS SELECT * FROM source_events;
```

## Step 2: 품질 검증

```python
# 스키마 검증
assert set(new_df.columns) == set(expected_columns)

# Row count 검증
new_count = spark.table("events_new").count()
old_count = spark.table("events").count()
assert new_count >= old_count * 0.95, "Row count dropped significantly!"

# 샘플 쿼리 검증
sample = spark.sql("""
    SELECT user_id, COUNT(*) as cnt
    FROM events_new
    GROUP BY user_id
    HAVING cnt > 1000
""").collect()
```

## Step 3: 스위칭

```sql
-- 기존 테이블을 백업으로
ALTER TABLE events RENAME TO events_backup;

-- 새 테이블을 원래 이름으로
ALTER TABLE events_new RENAME TO events;
```

## Step 4: 정리

```sql
-- 일정 기간 후 백업 삭제
DROP TABLE events_backup;
```

# 3. 전체 스크립트 예시

---

```python
from datetime import datetime
from delta.tables import DeltaTable

def blue_green_swap(spark, table_name, new_data_df, validation_func):
    """
    Blue/Green 스위칭 패턴
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    new_table = f"{table_name}_new_{timestamp}"
    backup_table = f"{table_name}_backup_{timestamp}"

    try:
        # Step 1: 새 테이블 생성
        print(f"Creating new table: {new_table}")
        new_data_df.write.format("delta").saveAsTable(new_table)

        # Step 2: 검증
        print("Running validation...")
        if not validation_func(spark, new_table):
            raise ValueError("Validation failed!")

        # Step 3: 스위칭
        print("Swapping tables...")
        spark.sql(f"ALTER TABLE {table_name} RENAME TO {backup_table}")
        spark.sql(f"ALTER TABLE {new_table} RENAME TO {table_name}")

        print(f"Swap complete! Backup available at: {backup_table}")
        return backup_table

    except Exception as e:
        # 롤백: 새 테이블 삭제
        print(f"Error: {e}. Rolling back...")
        spark.sql(f"DROP TABLE IF EXISTS {new_table}")
        raise

def validate_events(spark, table_name):
    """검증 함수 예시"""
    df = spark.table(table_name)

    # 필수 컬럼 확인
    required = ["event_id", "user_id", "event_time"]
    if not all(c in df.columns for c in required):
        return False

    # 최소 row count
    if df.count() < 1000:
        return False

    return True

# 사용 예시
backup = blue_green_swap(
    spark,
    "events",
    new_events_df,
    validate_events
)
```

# 4. 롤백 절차

---

```python
def rollback_swap(spark, table_name, backup_table):
    """
    스위칭 롤백
    """
    current_table = f"{table_name}_failed"

    # 현재 테이블을 실패로 마킹
    spark.sql(f"ALTER TABLE {table_name} RENAME TO {current_table}")

    # 백업을 원래 이름으로 복구
    spark.sql(f"ALTER TABLE {backup_table} RENAME TO {table_name}")

    print(f"Rolled back to {backup_table}")
    print(f"Failed table available at: {current_table}")

# 롤백 실행
rollback_swap(spark, "events", "events_backup_20240115_120000")
```

# 5. 운영 팁

---

## 동시 쿼리 고려

- Rename은 메타데이터 작업이지만, 동시 쿼리가 많으면 실패/지연 가능
- 유지보수 창(maintenance window)을 두는 것이 안전

```python
# 트래픽이 적은 시간에 실행
# 또는 스위칭 전 경고/대기
import time

print("Switching in 30 seconds...")
time.sleep(30)
```

## 권한/락 확인

```sql
-- 테이블 잠금 확인 (Databricks)
SHOW TBLPROPERTIES my_table;
```

## 캐시 고려

일부 엔진/도구는 테이블 메타데이터를 캐시합니다.

```python
# Spark 캐시 갱신
spark.catalog.refreshTable("events")
```

# 6. Unity Catalog에서의 주의사항

---

Unity Catalog 환경에서는 추가 고려가 필요합니다.

```sql
-- 3-level namespace 사용
ALTER TABLE catalog.schema.events RENAME TO catalog.schema.events_backup;
ALTER TABLE catalog.schema.events_new RENAME TO catalog.schema.events;
```

- 권한이 테이블에 바인딩되므로 스왑 후 권한 확인 필요
- Managed table의 경우 storage 경로도 함께 변경됨

# 7. 체크리스트

---

```
□ 새 테이블이 완전히 적재/검증되었는가?
□ 스키마 호환성이 보장되는가?
□ 스위칭 시점에 동시 쿼리를 통제할 수 있는가?
□ 롤백 절차(이름 되돌리기)가 문서화되어 있는가?
□ 백업 테이블 보관 기간 정책이 있는가?
□ 다운스트림 캐시 갱신이 필요한가?
```

# 8. FAQ

---

**Q: Rename swap 중에 읽는 쿼리는 어떻게 되나요?**

A: 짧은 순간 메타데이터 갱신 타이밍에 따라 실패/재시도가 필요할 수 있습니다. 유지보수 창 또는 재시도 로직이 도움이 됩니다.

**Q: 다운스트림이 캐시를 들고 있으면?**

A: 일부 엔진/캐시는 테이블 메타를 캐시할 수 있어, 갱신/TTL 정책을 고려해야 합니다.

**Q: External table도 가능한가요?**

A: External table은 storage 경로가 고정되어 있어 swap 방식이 다릅니다. Managed table에 더 적합한 패턴입니다.

# Reference

---

- [Databricks ALTER TABLE](https://docs.databricks.com/en/sql/language-manual/sql-ref-syntax-ddl-alter-table.html)
- [Delta Lake Table Management](https://docs.delta.io/latest/delta-utility.html)
- [Blue-Green Deployment Pattern](https://martinfowler.com/bliki/BlueGreenDeployment.html)
