---
title: "[Delta Lake] CDF와 table_changes - 변경 데이터 추적하기"
categories:
  - Delta
tags: [Delta, CDF, ChangeDataFeed, Incremental, Databricks]
---

## Introduction

---

Change Data Feed(CDF)는 Delta 테이블의 변경 내역을 추적하는 기능입니다. `table_changes()` 함수로 어떤 row가 INSERT/UPDATE/DELETE 되었는지 읽을 수 있습니다.

하지만 자주 만나는 오류가 있습니다:
- "change data was not recorded for version X"
- "enabled CDF but older versions missing"

이 글은 CDF의 동작 방식과 올바른 사용법을 정리합니다.

## 1. CDF 활성화 방법

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

## 2. CDF는 언제부터 기록되나?

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

## 3. table_changes 사용법

---

```sql
-- 버전 범위로 읽기
SELECT * FROM table_changes('events', 3, 10)

-- 시간 범위로 읽기
SELECT * FROM table_changes('events', '2024-01-01', '2024-01-02')
```

### 반환되는 메타 컬럼

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

## 4. CDF 활성화 버전 찾기

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

## 5. 증분 파이프라인 권장 구조

---

CDF를 기반으로 downstream을 갱신하려면:

```
1) 최초 적재: full snapshot (현재 테이블 전체)
2) 이후: table_changes로 version/시간 범위를 따라감
```

### 예시 코드

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

## 6. 스키마 진화(Schema Evolution)와 CDF

---

CDF를 사용하는 테이블에 스키마 변경이 발생하면, change 소비자 파이프라인이 실패할 수 있습니다. Delta Lake 버전별로 지원 범위가 다르므로 주의가 필요합니다.

### Additive vs Non-additive 스키마 변경

| 유형 | 예시 | CDF 영향 |
|------|------|----------|
| **Additive** (안전) | 컬럼 추가, 코멘트 변경 | CDF 읽기 정상 동작 (새 컬럼은 NULL) |
| **Non-additive** (위험) | 컬럼 삭제, 이름 변경, 타입 변경 | 버전 범위에 따라 실패 가능 |

### Column Mapping과 CDF 호환성

Column Mapping(`delta.columnMapping.mode`)이 활성화된 테이블에서 CDF를 읽을 때, Delta Lake 버전별 제한이 있습니다:

| Delta 버전 | Batch 읽기 | Streaming 읽기 | Non-additive 변경 대응 |
|------------|-----------|---------------|----------------------|
| 2.0 이하 | 미지원 | 미지원 | — |
| 2.1 | 지원 (non-additive 없을 때) | 미지원 | — |
| 2.2 | 지원 (non-additive 없을 때) | 지원 (non-additive 없을 때) | — |
| **2.3+** | **지원** | 미지원 | 버전 범위가 non-additive 변경을 걸치면 실패 |
| **3.0+** | **지원** | **지원** (schema tracking 활성화 시) | schema tracking으로 대응 |

**핵심**: Delta 2.3+에서 CDF batch 읽기 시, `endVersion`의 스키마가 적용됩니다 (최신 버전의 스키마가 아님). 버전 범위 중간에 non-additive 변경이 있으면 쿼리가 실패합니다.

```python
# 안전한 패턴: non-additive 스키마 변경 전후로 분리해서 읽기
schema_change_version = 15  # ALTER TABLE DROP COLUMN이 발생한 버전

# 변경 전까지
before = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", last_checkpoint) \
    .option("endingVersion", schema_change_version - 1) \
    .table("events")

# 변경 후부터 (새 스키마 적용)
after = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", schema_change_version) \
    .table("events")
```

### 소비자 파이프라인에서의 스키마 변경 대응

```python
def safe_incremental_load(source_table, target_path, last_version):
    """스키마 변경에 안전한 증분 로드"""
    try:
        changes = spark.read.format("delta") \
            .option("readChangeFeed", "true") \
            .option("startingVersion", last_version + 1) \
            .table(source_table)

        apply_changes(target_path, changes)
        new_version = changes.agg(max("_commit_version")).first()[0]
        save_checkpoint(new_version)

    except AnalysisException as e:
        if "non-additive schema change" in str(e):
            # non-additive 변경 감지 → full reload로 전환
            print(f"Schema change detected, performing full reload")
            full_reload(source_table, target_path)
        else:
            raise
```

## 7. 에지케이스와 운영 주의사항

---

### VACUUM과 CDF 데이터 보존

CDF 변경 기록은 Delta 테이블의 out-of-date 버전과 **동일한 보존 정책**을 따릅니다. `VACUUM`을 실행하면 보존 기간(기본 7일) 밖의 CDF 데이터도 함께 삭제됩니다.

```sql
-- 기본 보존 기간: 7일
VACUUM events

-- 보존 기간을 30일로 설정 (CDF 데이터도 30일 유지)
ALTER TABLE events SET TBLPROPERTIES (
    delta.deletedFileRetentionDuration = 'interval 30 days'
);
```

**주의**: 체크포인트에 저장된 `last_version`이 VACUUM으로 삭제된 버전을 가리키면, 해당 버전부터의 CDF 읽기가 실패합니다. 이 경우 full reload가 필요합니다.

### 체크포인트 복구 절차

체크포인트가 손실되거나 잘못된 상태일 때의 복구 방법:

```python
def recover_checkpoint(source_table, target_path):
    """체크포인트 손실 시 복구 절차"""

    # 1단계: CDF 활성화 버전 찾기
    dt = DeltaTable.forName(spark, source_table)
    cdf_version = dt.history() \
        .filter("operation = 'SET TBLPROPERTIES'") \
        .filter("operationParameters['properties'] LIKE '%enableChangeDataFeed%'") \
        .select("version").first()

    if cdf_version is None:
        raise ValueError("CDF activation version not found in history")

    cdf_start = cdf_version[0]

    # 2단계: target 테이블의 최신 상태와 source 비교
    target_max = spark.read.format("delta").load(target_path) \
        .agg(max("updated_at")).first()[0]

    # 3단계: 안전한 복구 전략 선택
    latest_version = dt.history(1).select("version").first()[0]

    if target_max is None:
        # target이 비어있음 → full reload
        full_reload(source_table, target_path)
    else:
        # target에 데이터가 있음 → 특정 시점부터 CDF 재적용
        changes = spark.read.format("delta") \
            .option("readChangeFeed", "true") \
            .option("startingTimestamp", str(target_max)) \
            .table(source_table)
        apply_changes(target_path, changes)
        save_checkpoint(latest_version)
```

### 흔한 운영 실수 정리

| 실수 | 문제 | 해결 |
|------|------|------|
| CDF 켜기 전 버전부터 읽기 | 오류 발생 | 활성화 버전 확인 후 읽기 |
| 스키마 변경 무시 | 소비자 파이프라인 실패 | non-additive 변경 전후 분리 읽기 또는 full reload |
| 체크포인트 미관리 | 중복/누락 | 버전 체크포인트 필수 + 복구 절차 마련 |
| VACUUM 후 CDF 읽기 실패 | 삭제된 버전 참조 | 보존 기간 설정 + full reload 대비 |
| Streaming + 스키마 변경 | 스트림 중단 | Delta 3.0+ schema tracking 활성화 |

## 8. 체크리스트

---

```
□ CDF 활성화 버전을 문서화했다
□ 최초 적재(full) + 이후 증분(CDF)로 파이프라인을 설계했다
□ 버전/시간 체크포인트를 관리하고 있다
□ 체크포인트 손실 시 복구 절차가 준비되어 있다
□ schema evolution이 있을 때 change 소비자가 깨지지 않게 대응했다
□ non-additive 스키마 변경 시 CDF 읽기 분리 또는 full reload 전략이 있다
□ VACUUM 보존 기간이 CDF 소비 주기보다 긴지 확인했다
□ Delta Lake 버전별 Column Mapping + CDF 호환성을 확인했다
```

## Reference

---

- [Delta Lake Change Data Feed](https://docs.delta.io/latest/delta-change-data-feed.html)
- [Databricks CDF Documentation](https://docs.databricks.com/en/delta/delta-change-data-feed.html)
- [table_changes Function](https://docs.databricks.com/en/sql/language-manual/functions/table_changes.html)
