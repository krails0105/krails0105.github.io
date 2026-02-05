---
title: "[Spark] Temp View vs cacheTable vs 물리 테이블 - 프로세스 간 데이터 공유와 생명주기"
categories:
  - Spark
tags:
  - [Spark, TempView, Cache, Delta, SessionScope, DataSharing]
---

# Introduction

---

Spark에서 중간 결과를 "저장"하는 방법은 여러 가지입니다. **Temp View**, **cacheTable**, **물리 테이블(Delta/Parquet)** 모두 "결과를 재사용한다"는 목적은 같지만, **생명주기(scope)**, **저장 위치**, **프로세스 간 접근성**이 모두 다릅니다.

특히 같은 데이터를 **여러 Spark 프로세스(세션)에서 공유**해야 하는 경우, 어떤 방식을 선택하느냐가 아키텍처를 결정합니다. 이 글에서는 각 방식의 동작 원리, 성능 특성, 적합한 사용 시나리오를 비교합니다.

# 1. 세 가지 방식의 비교

---

## Temp View

```sql
CREATE OR REPLACE TEMP VIEW my_view AS
SELECT * FROM base_table WHERE status = 'active'
```

- **저장**: 아무것도 저장하지 않음. **쿼리 정의(SQL 텍스트)**만 등록
- **생명주기**: SparkSession 종료 시 사라짐
- **실행**: 참조할 때마다 쿼리가 **매번 다시 실행**됨 (lazy evaluation)
- **접근**: 해당 SparkSession에서만 접근 가능

```text
핵심: Temp View는 "매크로"에 가깝다.
SQL을 저장해뒀다가 참조할 때 인라인으로 펼쳐지는 것.
```

> **Global Temp View란?** `CREATE GLOBAL TEMP VIEW`로 만들면 **같은 Spark Application 내의 모든 세션**에서 접근할 수 있습니다. 접근 시 `global_temp.view_name`으로 참조합니다. 단, Application이 종료되면 사라집니다.

## cacheTable

```python
spark.catalog.cacheTable("my_view")
# 또는
spark.sql("CACHE TABLE my_view")
```

- **저장**: executor 메모리(또는 디스크)에 결과를 **materialize**
- **생명주기**: `uncacheTable` 호출 또는 SparkSession 종료 시 해제
- **실행**: 첫 접근 시 1회 실행 후 캐싱, 이후 접근은 캐시에서 읽기
- **접근**: 해당 SparkSession에서만 접근 가능

```text
핵심: cacheTable은 "메모리에 올린 임시 테이블"이다.
같은 세션에서 여러 번 읽을 때 재계산을 방지.
```

> **Storage Level**: `df.persist(StorageLevel.MEMORY_AND_DISK)`처럼 캐시의 저장 위치를 지정할 수 있습니다. 기본값은 `MEMORY_AND_DISK`로, 메모리가 부족하면 디스크에 spillover됩니다. `MEMORY_ONLY`는 메모리에만 저장하며 초과 시 재계산합니다.

## 물리 테이블 (Delta/Parquet)

```sql
CREATE TABLE my_table USING DELTA AS SELECT ...
-- 또는
INSERT OVERWRITE TABLE my_table SELECT ...
```

- **저장**: 분산 스토리지(S3/ADLS/DBFS)에 파일로 저장
- **생명주기**: 명시적 DROP 전까지 영구
- **실행**: 쓰기 시 1회 실행, 이후는 파일 읽기
- **접근**: **모든 SparkSession, 모든 클러스터**에서 접근 가능

```text
핵심: 물리 테이블은 "영구 저장소"이다.
프로세스/세션/클러스터를 넘어 데이터 공유 가능.
```

# 2. 생명주기(Scope) 상세

---

```text
┌──────────────────────────────────────────────┐
│  Cluster                                       │
│  ┌──────────────────────────────────────────┐ │
│  │  SparkSession A                            │ │
│  │   temp_view_1 ✅                           │ │
│  │   cached_table_1 ✅                        │ │
│  │   delta_table ✅                           │ │
│  └──────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────┐ │
│  │  SparkSession B (다른 프로세스)             │ │
│  │   temp_view_1 ❌ (안 보임)                 │ │
│  │   cached_table_1 ❌ (안 보임)              │ │
│  │   delta_table ✅                           │ │
│  └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

| 방식 | 같은 세션 | 다른 세션 (같은 클러스터) | 다른 클러스터 |
|------|----------|------------------------|-------------|
| Temp View | O | X | X |
| cacheTable | O | X | X |
| 물리 테이블 | O | O | O |

## 같은 프로세스 vs 다른 프로세스

```text
같은 프로세스 (같은 SparkSession):
  → Temp View, cacheTable 모두 공유 가능
  → 예: 한 노트북/스크립트 내에서 여러 쿼리가 같은 View 참조

다른 프로세스 (별도 SparkSession):
  → Temp View, cacheTable 접근 불가
  → 물리 테이블만 공유 가능
  → 예: 병렬 실행되는 2개의 Databricks Job
```

# 3. 어떤 상황에서 어떤 방식을 쓰는가?

---

## Temp View가 적합한 경우

```text
✅ SQL 재사용 (같은 쿼리를 여러 곳에서 참조)
✅ CTE 대신 이름 붙인 서브쿼리
✅ 비용이 낮은 쿼리 (재계산해도 빠른 경우)
```

```sql
-- 예: 필터 조건을 이름으로 분리
CREATE OR REPLACE TEMP VIEW active_users AS
SELECT * FROM users WHERE status = 'active';

-- 여러 쿼리에서 참조
SELECT * FROM active_users WHERE age > 30;
SELECT COUNT(*) FROM active_users GROUP BY region;
-- 둘 다 WHERE status = 'active' 필터가 매번 실행됨
```

## cacheTable이 적합한 경우

```text
✅ 비용이 높은 쿼리 결과를 같은 세션에서 여러 번 읽을 때
✅ 큰 조인/집계 결과를 2~3회 재사용
✅ 데이터 크기가 executor 메모리에 들어갈 때
```

```python
# 예: 복잡한 조인 결과를 3개 쿼리에서 재사용
spark.sql("""
    CREATE OR REPLACE TEMP VIEW expensive_result AS
    SELECT ... FROM big_table_a JOIN big_table_b ...
""")
spark.catalog.cacheTable("expensive_result")

# 이후 3개 쿼리가 캐시에서 읽기 → 조인 1회만 실행
spark.sql("SELECT ... FROM expensive_result WHERE ...")
spark.sql("SELECT ... FROM expensive_result GROUP BY ...")
spark.sql("INSERT INTO output FROM expensive_result ...")

# 사용 완료 후 해제
spark.catalog.uncacheTable("expensive_result")
```

## 물리 테이블이 적합한 경우

```text
✅ 다른 프로세스/세션에서 같은 데이터를 읽어야 할 때
✅ 파이프라인 단계 간 데이터 전달
✅ 실패 시 재시작해도 중간 결과를 보존해야 할 때
✅ 데이터가 executor 메모리에 안 들어갈 때
```

```python
# 예: Process A가 쓰고, Process B와 C가 읽는 구조
# Process A:
spark.sql("INSERT OVERWRITE TABLE shared_data SELECT ...")

# Process B (별도 프로세스):
spark.sql("SELECT ... FROM shared_data WHERE ...")

# Process C (별도 프로세스):
spark.sql("SELECT ... FROM shared_data WHERE ...")
```

# 4. INSERT OVERWRITE vs INSERT INTO

---

물리 테이블에 데이터를 쓸 때 두 가지 패턴이 있습니다.

## INSERT INTO (누적)

```sql
INSERT INTO my_table SELECT ...
```

- 기존 데이터에 **추가**
- 여러 배치가 누적됨
- 예: 스냅샷 테이블 (여러 시점의 스냅샷이 누적)

## INSERT OVERWRITE (교체)

```sql
INSERT OVERWRITE TABLE my_table SELECT ...
```

- 기존 데이터를 **전체 교체**
- 매 배치마다 최신 결과로 덮어씀
- 예: 배치 단위 중간 결과 (이전 배치 데이터 불필요)

```text
사용 기준:
  이전 배치 데이터도 보존해야 한다 → INSERT INTO
  최신 배치 데이터만 필요하다      → INSERT OVERWRITE
```

# 5. 성능 특성 비교

---

| 항목 | Temp View | cacheTable | 물리 테이블 |
|------|----------|-----------|------------|
| 쓰기 비용 | 0 (정의만) | 첫 접근 시 | 파일 쓰기 I/O |
| 읽기 비용 | 매번 재계산 | 메모리 읽기 | 파일 읽기 I/O |
| 재사용 2회 | 쿼리 2회 실행 | 쿼리 1회 + 메모리 1회 | 파일 쓰기 1회 + 파일 읽기 1회 |
| 메모리 사용 | 0 | 결과 크기만큼 | 0 (스토리지 사용) |
| 장애 복구 | 불가 | 불가 | 가능 (파일 존재) |

## Temp View의 "매번 재계산" 함정

```text
CREATE TEMP VIEW heavy_join AS SELECT ... FROM A JOIN B JOIN C ...

-- 이 세 쿼리가 실행될 때:
SELECT * FROM heavy_join WHERE x > 10;   -- A JOIN B JOIN C 실행
SELECT * FROM heavy_join WHERE y < 20;   -- A JOIN B JOIN C 다시 실행
SELECT * FROM heavy_join GROUP BY z;     -- A JOIN B JOIN C 또 실행
-- → 비용이 높은 조인이 3번 실행됨!
```

Temp View는 SQL 정의만 저장하므로, 참조할 때마다 전체 쿼리가 다시 실행됩니다. 비용이 높은 쿼리라면 cacheTable 또는 물리 테이블로 materialize해야 합니다.

# 6. 선택 흐름도

---

```text
중간 결과를 재사용해야 한다
  ├─ 같은 프로세스에서만?
  │   ├─ Yes → 재사용 횟수는?
  │   │   ├─ 1회 → Temp View (재계산 OK)
  │   │   └─ 2회 이상 → cacheTable
  │   └─ No → 물리 테이블
  │
  └─ 다른 프로세스에서도?
      └─ 물리 테이블 (유일한 선택)
```

# 7. 정리

---

| 개념 | Temp View | cacheTable | 물리 테이블 |
|------|----------|-----------|------------|
| 본질 | SQL 매크로 | 메모리 캐시 | 파일 저장소 |
| Scope | Session | Session | Global |
| 실행 | 참조 시 매번 | 첫 접근 1회 | 쓰기 시 1회 |
| 프로세스 공유 | X | X | O |
| 장애 복구 | X | X | O |

```text
핵심:
  Temp View = "쿼리의 이름" (매번 재실행)
  cacheTable = "메모리에 올린 결과" (같은 세션에서 재사용)
  물리 테이블 = "파일로 저장된 결과" (어디서든 접근)
```

# Reference

---

- [Spark SQL Temp Views](https://spark.apache.org/docs/latest/sql-ref-syntax-ddl-create-view.html)
- [Spark Caching and Persistence](https://spark.apache.org/docs/latest/rdd-programming-guide.html#rdd-persistence)
- [Delta Lake Table Properties](https://docs.delta.io/latest/table-properties.html)
