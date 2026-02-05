---
title: "[Spark] ANALYZE TABLE과 Partial Statistics - Optimizer가 잘못된 플랜을 만드는 이유"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Statistics, AnalyzeTable, QueryOptimizer, CBO, Delta]
---

# Introduction

---

Spark의 쿼리 플랜을 EXPLAIN으로 확인하다 보면 `Statistics(..., isPartial)` 또는 `Statistics(sizeInBytes=..., rowCount=...)` 같은 정보가 보입니다. 이 **통계 정보(statistics)**는 Catalyst optimizer가 조인 전략, broadcast 여부, 셔플 파티션 수 등을 결정하는 핵심 입력입니다. 통계가 부실하면 optimizer는 보수적인(느린) 플랜을 선택할 수밖에 없습니다.

이 글은 Spark의 통계 시스템이 어떻게 동작하고, `ANALYZE TABLE`이 무엇을 하며, Delta Lake에서 통계가 어떻게 관리되는지를 정리합니다.

# 1. Spark Optimizer가 통계를 사용하는 방식

---

## Cost-Based Optimization (CBO)

Spark의 Catalyst optimizer는 두 가지 모드로 동작합니다:

```text
Rule-Based Optimization (RBO):
  고정된 규칙 적용 (predicate pushdown, constant folding 등)
  통계 불필요

Cost-Based Optimization (CBO):
  여러 플랜 후보의 "비용"을 추정하여 최적 선택
  통계 필요!
```

CBO가 활성화되면 (`spark.sql.cbo.enabled = true` 설정 필요, Databricks Runtime에서는 기본 활성화), optimizer는 통계를 기반으로:

- **조인 전략** 결정: 작은 테이블을 broadcast할지, SortMergeJoin을 쓸지
- **조인 순서** 결정: 여러 테이블 조인 시 어떤 순서로 조인할지
- **셔플 파티션 수** 결정: 결과 크기 추정에 따라

## 통계가 부실하면?

```text
실제 테이블: 100MB, 100만 행
Spark가 아는 것: "파일 크기 약 100MB" (행 수 모름, 컬럼 분포 모름)

→ broadcast 임계값(10MB) 초과 → broadcast 안 함
→ 실제로는 필터 후 1MB만 남는데도 SortMergeJoin 선택
```

# 2. Partial Statistics란?

---

EXPLAIN 결과에서 이런 표시가 보일 수 있습니다:

```text
== Optimized Logical Plan ==
Aggregate [block_height], [block_height, sum(value)]
+- Filter (block_height <= 800000)
   +- Relation spark_catalog.default.utxo_snapshot
      [Statistics(sizeInBytes=12.5 GiB, isPartial)]
```

`isPartial`의 의미:

```text
Partial Statistics:
  Spark가 테이블의 "일부" 정보만 알고 있는 상태
  보통 파일 크기(sizeInBytes)만 알고, 행 수(rowCount)나 컬럼 통계는 모름

Full Statistics:
  행 수, 컬럼별 min/max/null 비율/distinct 수 등을 모두 알고 있는 상태
```

## Partial vs Full이 플랜에 미치는 영향

| 정보 | Partial | Full | 영향 |
|------|---------|------|------|
| 파일 크기 | O | O | broadcast 여부 기본 판단 |
| 행 수 | X | O | 조인 결과 크기 추정 |
| 컬럼 min/max | X | O | 필터 후 행 수 추정 (selectivity) |
| distinct count | X | O | 조인 카디널리티 추정 |
| null 비율 | X | O | NULL 처리 최적화 |

행 수를 모르면 **필터 적용 후 결과 크기를 추정할 수 없고**, 조인 결과 크기도 추정할 수 없습니다. 환자 정보 없이 진료하는 의사처럼, optimizer도 정보가 부족하면 가장 안전한(보수적인) 처방을 할 수밖에 없습니다.

# 3. ANALYZE TABLE이 하는 일

---

```sql
-- 테이블 크기만 수집 (데이터 스캔 없이 빠르게)
ANALYZE TABLE my_table COMPUTE STATISTICS NOSCAN;

-- 테이블 기본 통계 수집 (행 수, 크기)
ANALYZE TABLE my_table COMPUTE STATISTICS;

-- 특정 컬럼 통계까지 수집
ANALYZE TABLE my_table COMPUTE STATISTICS FOR COLUMNS col1, col2;

-- 모든 컬럼 통계 수집
ANALYZE TABLE my_table COMPUTE STATISTICS FOR ALL COLUMNS;
```

> **NOSCAN vs 기본 실행**: `NOSCAN`은 파일 메타데이터만 읽어서 `sizeInBytes`만 빠르게 수집합니다. 데이터 자체를 스캔하지 않으므로 행 수(rowCount)는 수집되지 않습니다. 테이블이 매우 크고 파일 크기 정보만 급히 필요할 때 유용합니다.

## 수집되는 정보

```text
테이블 레벨:
  - sizeInBytes: 전체 데이터 크기
  - rowCount: 전체 행 수

컬럼 레벨 (FOR COLUMNS 사용 시):
  - min, max: 최솟값, 최댓값
  - nullCount: NULL 개수
  - avgLen, maxLen: 평균/최대 길이 (문자열)
  - distinctCount: 고유값 수
  - histogram: 값 분포 히스토그램 (선택적)
```

## 실행 전후 비교

```sql
-- Before
EXPLAIN COST SELECT * FROM my_table WHERE id > 100;
-- Statistics(sizeInBytes=1.2 GiB, isPartial)

ANALYZE TABLE my_table COMPUTE STATISTICS FOR COLUMNS id;

-- After
EXPLAIN COST SELECT * FROM my_table WHERE id > 100;
-- Statistics(sizeInBytes=1.2 GiB, rowCount=50000000)
-- → 필터 selectivity 추정 가능 → 더 정확한 플랜
```

# 4. 통계의 지속성과 stale 문제

---

## ANALYZE TABLE의 통계는 메타스토어에 저장

```text
ANALYZE TABLE 실행 → Hive Metastore (또는 Unity Catalog)에 저장
                    → 클러스터 재시작해도 유지
                    → 다른 세션에서도 사용 가능
```

## 하지만 데이터가 바뀌면 stale해짐

```text
시점 1: ANALYZE TABLE → 100만 행 통계 저장
시점 2: INSERT INTO → 실제 200만 행
시점 3: 쿼리 실행 → optimizer는 여전히 100만 행으로 알고 있음!
```

통계는 **ANALYZE TABLE을 실행한 시점의 스냅샷**입니다. 데이터가 변경되면 자동으로 업데이트되지 않습니다.

## 언제 다시 실행해야 하는가?

```text
✅ 대규모 데이터 로드 후
✅ 대량 DELETE/UPDATE 후
✅ 쿼리 성능이 갑자기 저하된 경우

❌ 매 INSERT마다 (오버헤드)
❌ 데이터 변경이 없는 경우
```

# 5. Delta Lake의 자동 통계

---

Delta Lake는 일반 Hive 테이블과 다르게 **파일 레벨 통계를 자동으로 관리**합니다.

## Delta File-level Statistics

```text
Delta가 자동 수집하는 것:
  - 파일별 행 수 (numRecords)
  - 파일별 컬럼 min/max (처음 32개 컬럼)
  - 파일별 null count

저장 위치: Delta 트랜잭션 로그 (_delta_log/*.json)
갱신 시점: 매 write 시 자동
```

이 통계 덕분에 Delta는 ANALYZE TABLE 없이도:
- **파일 프루닝(data skipping)**: min/max로 불필요한 파일 스킵
- **행 수 추정**: 파일별 행 수 합산

## 그럼 ANALYZE TABLE이 필요 없는가?

```text
Delta 자동 통계가 제공하는 것:
  ✅ 파일 크기, 행 수, 컬럼 min/max (파일 단위)

Delta 자동 통계가 제공하지 않는 것:
  ❌ 컬럼별 distinct count
  ❌ 컬럼별 히스토그램
  ❌ 테이블 전체의 정교한 cardinality 정보
```

**결론**: Delta에서도 CBO가 정교한 조인 전략을 수립하려면 ANALYZE TABLE이 여전히 유용합니다. 다만, 파일 프루닝과 기본적인 행 수 추정은 자동으로 동작합니다.

## 실전 전략

```text
자주 변경되는 테이블 (스트리밍/일배치):
  → Delta 자동 통계에 의존
  → ANALYZE TABLE은 주간/월간 단위

초기 backfill 후 거의 변경 없는 테이블:
  → backfill 완료 후 ANALYZE TABLE 1회 실행
  → 이후 재실행 불필요 (데이터가 안 바뀌므로 stale 안 됨)

조인 성능이 중요한 핵심 테이블:
  → ANALYZE TABLE FOR COLUMNS (조인 키 컬럼)
  → 대규모 데이터 변경 후 재실행
```

# 6. 통계 확인 방법

---

```sql
-- 테이블 통계 확인
DESCRIBE EXTENDED my_table;

-- 컬럼 통계 확인
DESCRIBE EXTENDED my_table col_name;

-- 쿼리 플랜에서 통계 확인
EXPLAIN COST SELECT * FROM my_table;
```

```python
# PySpark에서 확인
spark.sql("DESCRIBE EXTENDED my_table").show(truncate=False)

# catalog에서 확인
spark.catalog.listColumns("my_table")
```

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **Partial Statistics** | 파일 크기만 알고 행 수/컬럼 통계가 없는 상태 |
| **Full Statistics** | 행 수 + 컬럼별 min/max/distinct/null 등 완전한 통계 |
| **ANALYZE TABLE** | 메타스토어에 통계 수집/저장, 클러스터 재시작 후에도 유지 |
| **Stale statistics** | 데이터 변경 후 통계가 실제와 불일치하는 상태 |
| **Delta 자동 통계** | write 시 파일별 min/max/행 수 자동 수집, data skipping에 활용 |

```text
핵심:
  Partial Statistics → optimizer가 보수적 플랜 선택 → 느린 쿼리
  ANALYZE TABLE → Full Statistics → 정확한 비용 추정 → 효율적 플랜
  Delta → 파일 레벨 자동 통계 → 기본적인 추정은 OK, 정교한 CBO는 여전히 ANALYZE 필요
```

# Reference

---

- [Spark Cost-Based Optimization](https://spark.apache.org/docs/latest/sql-performance-tuning.html#cost-based-optimization)
- [ANALYZE TABLE](https://spark.apache.org/docs/latest/sql-ref-syntax-aux-analyze-table.html)
- [Delta Lake Data Skipping](https://docs.delta.io/latest/optimizations-oss.html#data-skipping)
- [Databricks Table Statistics](https://docs.databricks.com/en/sql/language-manual/sql-ref-syntax-aux-analyze-table.html)
