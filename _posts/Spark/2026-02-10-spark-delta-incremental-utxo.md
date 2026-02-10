---
title: "[Delta Lake] 대규모 테이블 증분 업데이트 전략 - replaceWhere vs MERGE"
categories:
  - Spark
tags:
  - [Spark, DeltaLake, Databricks, MERGE, replaceWhere, LiquidClustering]
---

# Introduction

---

Delta Lake에서 **생성(INSERT) + 상태 변경(UPDATE)** 이 동시에 발생하는 대규모 테이블을 증분 업데이트할 때, 어떤 전략이 적합한지 정리합니다.

핵심 포인트:
- 히스토리 빌드: 단일 LEFT JOIN
- 증분 업데이트: replaceWhere(INSERT) + MERGE(UPDATE)
- replaceWhere의 내부 동작 (파일 단위 교체)
- Liquid Clustering과의 관계

# 1. 문제 상황

---

아래와 같은 이벤트 테이블을 생각해봅니다.

```text
events:
  id              -- PK (생성 시점에 결정)
  created_key     -- 생성 시점의 파티션 키
  payload         -- 생성 시점 데이터
  completed_key   -- 완료 시점 키 (NULL = 미완료)
  completed_data  -- 완료 시점 데이터 (NULL = 미완료)
```

신규 데이터가 들어오면 두 가지 변경이 발생합니다:
- **새 row 생성**: `created_key`가 새 범위에 속하는 row INSERT
- **기존 row 상태 변경**: 과거에 생성된 row의 `completed_key` UPDATE

# 2. 히스토리 1회 빌드 — 단일 LEFT JOIN

---

전체 데이터를 한 번에 빌드할 때는 LEFT JOIN이 가장 간단합니다.

```python
df = spark.sql("""
WITH created AS (
    SELECT id, created_key, payload
    FROM source_created
),
completed AS (
    SELECT id, completed_key, completed_data
    FROM source_completed
)
SELECT c.*, s.completed_key, s.completed_data
FROM created c
LEFT JOIN completed s ON c.id = s.id
""")
```

양쪽에 전체 데이터가 있으므로 모든 매칭이 정확합니다.

### 왜 증분에서는 이 방식이 안 되는가?

```text
id=100 (created_key=A), completed at key=Z (new batch)

incremental_filter = "key BETWEEN X AND Z" 적용 시:
→ created CTE: id=100 row 없음 (key=A는 필터 밖)
→ LEFT JOIN 실패 → completed 정보 유실
```

증분 필터를 양쪽에 걸면 **"과거 생성 — 신규 완료"** 케이스가 누락됩니다.

# 3. 증분 업데이트 — replaceWhere + MERGE

---

생성과 상태 변경은 성격이 다른 연산이므로 분리해야 합니다.

## 3-1. Step 1: 새 row — replaceWhere

```python
new_rows_df.write.format("delta") \
    .option("replaceWhere",
            f"created_key BETWEEN {start} AND {end}") \
    .mode("overwrite") \
    .saveAsTable("events")
```

- `created_key`가 범위 내로 한정되므로 replaceWhere가 정확히 동작
- 재처리 시에도 같은 범위를 다시 쓰면 이전 결과를 덮어씀 (idempotent)

## 3-2. Step 2: 상태 변경 — MERGE

```python
spark.sql(f"""
MERGE INTO events t
USING (
    SELECT id, completed_key, completed_data
    FROM source_completed
    WHERE completed_key BETWEEN {start} AND {end}
) s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET
    t.completed_key = s.completed_key,
    t.completed_data = s.completed_data
""")
```

> **순서**: replaceWhere → MERGE. 같은 배치 내에서 생성-완료되는 row도 INSERT 후 MERGE로 정확히 처리됩니다.

### MERGE는 replaceWhere로 대체 불가

UPDATE 대상 row의 `created_key`는 과거 **어느 값이든** 될 수 있습니다:

```text
현재 배치에서 완료된 row들:
  created_key = 150000   ← 범위 밖
  created_key = 400000   ← 범위 밖
  created_key = 799999   ← 범위 밖
```

replaceWhere는 하나의 predicate 범위를 **통째로 교체**하는 연산이라, 테이블 전체에 흩어진 row를 개별 UPDATE하는 것은 불가능합니다.

# 4. replaceWhere 내부 동작

---

replaceWhere는 **파일 단위 교체**입니다:

1. predicate에 매칭되는 **기존 Parquet 파일들을 논리적으로 삭제** (transaction log에 `remove` 기록)
2. 새 DataFrame의 데이터로 **새 Parquet 파일 생성** (`add` 기록)
3. 하나의 atomic commit으로 처리

```text
replaceWhere = "created_key BETWEEN 800000 AND 810000"

Before:
  file_001.parquet (key 0~50000)       ← 겹치지 않음 → 유지
  file_002.parquet (key 799000~805000) ← predicate 겹침 → 삭제
  file_003.parquet (key 805001~812000) ← predicate 겹침 → 삭제
  file_004.parquet (key 812001~820000) ← 겹치지 않음 → 유지

After:
  file_001.parquet (유지)
  file_004.parquet (유지)
  file_005.parquet (새로 쓴 800000~810000 데이터)
```

겹치는 파일을 어떻게 찾는가? → Delta 파일별 **min/max 통계**를 확인합니다. 여기서 Liquid Clustering이 중요해집니다.

# 5. Liquid Clustering과의 관계

---

Liquid Clustering(LC)은 Hive-style 파티셔닝의 대안입니다. 파티션 디렉토리 없이 **파일 내부 정렬**로 데이터를 co-locate합니다.

## 파티션 vs Liquid Clustering

**파티션 테이블:**
```text
/table/created_key=800000/file.parquet  ← 디렉토리 단위, 정확히 매칭
/table/created_key=800001/file.parquet
```

**LC 테이블:**
```text
file_001.parquet (key 0~50000)       ← 파일별 min/max로 skip
file_002.parquet (key 50001~100000)  ← skip
...
file_016.parquet (key 799000~810000) ← 겹침 → 대상
```

## replaceWhere + LC

LC가 clustering column 기준으로 데이터를 정렬해두므로, 파일별 min/max 범위가 좁아져 **data skipping** 효율이 높습니다.

```sql
CREATE TABLE events (...)
USING DELTA
CLUSTER BY (created_key)
```

이 설정에서 `created_key BETWEEN ...` replaceWhere는 clustering column과 정렬이 일치하므로 소수의 파일만 교체됩니다. 파티셔닝만큼 정확하진 않지만(경계 파일이 겹칠 수 있음), 파티션 관리 오버헤드 없이 유사한 성능을 냅니다.

## LC가 없다면?

clustering 없이 데이터가 랜덤 분포되면 파일별 min/max 범위가 넓어져서, replaceWhere 시 **거의 모든 파일이 겹침 대상**이 됩니다. 사실상 전체 테이블 재작성과 같아질 수 있습니다.

```text
LC 없음:
  file_001.parquet (key 3, 500000, 100, 800005) ← min=3, max=800005 → 겹침
  file_002.parquet (key 7, 200, 810000, 50)     ← min=7, max=810000 → 겹침
  → 거의 모든 파일 교체 대상

LC 있음:
  file_001.parquet (key 0~50000)     ← max=50000 < 800000 → skip
  file_016.parquet (key 799000~810000) ← 겹침 → 교체
  → 소수 파일만 교체
```

# 6. 요약

---

| 용도 | 방식 | 비고 |
|------|------|------|
| 히스토리 1회 빌드 | 단일 LEFT JOIN + overwrite | 전체 데이터 필요, 증분 불가 |
| 증분 — 새 row | replaceWhere | idempotent, LC data skipping 활용 |
| 증분 — 상태 변경 | MERGE INTO | replaceWhere 대체 불가 (row가 전체 테이블에 분산) |

```text
히스토리 빌드:     LEFT JOIN (1회)
                      ↓
증분 업데이트:     replaceWhere (INSERT) → MERGE (UPDATE)
                      ↓                      ↓
내부 동작:         파일 교체 (atomic)      row-level UPDATE
LC 효과:          data skipping           ON 절 매칭 최적화
```
