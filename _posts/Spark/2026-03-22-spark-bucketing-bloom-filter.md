---
title: "[Spark] 버켓팅과 블룸 필터 - 셔플 제거와 파일 스킵으로 성능 최적화"
categories:
  - Spark
tags: [Spark, Bucketing, BloomFilter, Delta Lake, Join, Optimization]
---

## Introduction

---

Spark 조인/필터 성능을 높이는 방법은 크게 두 방향입니다.

1. **셔플 자체를 없애기** — 데이터를 처음부터 올바른 파티션에 배치해두면 조인 시 셔플이 발생하지 않습니다.
2. **읽지 않아도 될 파일을 스킵하기** — "이 파일에 해당 값이 없다"는 것을 사전에 알면 I/O를 아낄 수 있습니다.

**버켓팅(Bucketing)**은 1번, **블룸 필터(Bloom Filter)**는 2번 전략에 해당합니다. 두 기법 모두 "쿼리 실행 전에 데이터를 사전 구조화해두는" 방식으로, 반복 실행되는 쿼리에서 효과가 누적됩니다.

이 글에서는 각 기법의 동작 원리, 사용법, 실무 주의사항을 정리하고, 파티셔닝/Z-Order와의 차이를 비교표로 정리합니다.

## 1. 버켓팅 (Bucketing)

---

### 버켓팅이란?

테이블을 저장할 때 **특정 컬럼의 해시값을 기준으로 N개의 버킷(파일)으로 미리 나눠서 저장**하는 방식입니다.

일반 Parquet 저장은 데이터를 파티션 단위로 나누지만, 같은 파티션 안에서 키가 어느 파일에 들어갈지는 보장하지 않습니다. 버켓팅은 한 발 더 나아가 "키 X는 반드시 버킷 7번 파일에 있다"는 것을 보장합니다.

### 왜 셔플을 제거할 수 있나?

SortMergeJoin은 두 테이블을 **같은 키 기준으로 셔플 → 정렬 → 병합**합니다. Exchange가 2번 발생합니다.

```
[일반 SortMergeJoin]
테이블 A ──┐  Exchange(셔플) ──┐
           ├───────────────────── SortMergeJoin
테이블 B ──┘  Exchange(셔플) ──┘
```

양쪽 테이블이 **같은 키, 같은 버킷 수**로 미리 나뉘어 저장되어 있으면, "버킷 N번끼리만 조인"이 가능합니다. Spark가 셔플 없이 대응하는 버킷 파일끼리 바로 병합합니다.

```
[버켓 조인]
테이블 A (버킷 0) ──────── SortMergeJoin (버킷 0끼리)
테이블 B (버킷 0) ────────┘
테이블 A (버킷 1) ──────── SortMergeJoin (버킷 1끼리)
테이블 B (버킷 1) ────────┘
  ...
Exchange 없음!
```

### 코드 예제

**버킷 테이블 생성:**

```python
# orders 테이블: customer_id 기준 64버킷으로 저장
orders_df.write \
    .bucketBy(64, "customer_id") \
    .sortBy("customer_id") \
    .saveAsTable("orders_bucketed")

# customers 테이블: 같은 키, 같은 버킷 수로 저장 (필수!)
customers_df.write \
    .bucketBy(64, "customer_id") \
    .sortBy("customer_id") \
    .saveAsTable("customers_bucketed")
```

`bucketBy(numBuckets, colName, *colNames)`는 여러 컬럼을 동시에 버켓 키로 지정할 수도 있습니다. `sortBy`는 각 버킷 내부 데이터를 정렬하여 SortMergeJoin 시 정렬 단계를 생략하게 합니다.

SQL로도 버킷 테이블을 생성할 수 있습니다.

```sql
-- SQL로 버킷 테이블 생성
CREATE TABLE orders_bucketed (
  order_id STRING,
  customer_id STRING,
  amount DOUBLE
) USING parquet
CLUSTERED BY (customer_id) SORTED BY (customer_id) INTO 64 BUCKETS;
```

**버킷 조인 실행 및 explain 확인:**

```python
orders = spark.table("orders_bucketed")
customers = spark.table("customers_bucketed")

result = orders.join(customers, "customer_id")

# Exchange가 없어야 버킷 조인이 동작한 것
result.explain()
```

**정상 동작 시 Physical Plan:**

```
== Physical Plan ==
* Project
+- * SortMergeJoin [customer_id], [customer_id], Inner
   :- * Sort [customer_id ASC]
   :  +- * FileScan parquet orders_bucketed   ← Exchange 없음!
   +- * Sort [customer_id ASC]
      +- * FileScan parquet customers_bucketed ← Exchange 없음!
```

Exchange가 보이지 않으면 셔플 없이 버킷 조인이 동작한 것입니다.

### 주의사항 / 실무 함정

**1. 양쪽 버킷 수가 반드시 같아야 한다**

버킷 수가 다르면 Spark는 버킷 조인을 포기하고 일반 셔플을 수행합니다. explain에서 다시 Exchange가 2개 나타납니다.

```python
# 잘못된 예 — 버킷 수 불일치
orders_df.write.bucketBy(64, "customer_id").saveAsTable("orders_bucketed")
customers_df.write.bucketBy(32, "customer_id").saveAsTable("customers_bucketed")
# → Exchange 2회 발생, 버킷 조인 무효
```

**2. 버켓팅 관련 설정 확인**

```python
# 버켓팅 활성화 (기본값: true)
spark.conf.get("spark.sql.sources.bucketing.enabled")

# Spark 3.1+: 불필요한 버킷 스캔 자동 최적화 (기본값: true)
# 조인/group-by 같은 버켓팅 활용 연산이 없으면 버킷 스캔을 자동으로 비활성화
spark.conf.get("spark.sql.sources.bucketing.autoBucketedScan.enabled")
```

`autoBucketedScan.enabled`는 Spark 3.1에서 추가된 설정으로, 쿼리에 조인이나 group-by 같은 버켓팅을 활용할 수 있는 연산자가 없거나, 테이블 스캔과 해당 연산자 사이에 Exchange가 이미 존재하면 버킷 스캔을 자동으로 건너뜁니다. 단순 `SELECT *` 에서 불필요하게 버킷 수만큼 파일을 여는 오버헤드를 방지합니다.

**3. `saveAsTable`로만 생성 가능**

버킷 테이블은 Spark Metastore에 등록되어야 합니다. `write.save("/path")`나 Parquet 직접 저장 방식으로는 버켓팅 메타데이터가 기록되지 않습니다.

```python
# 불가 — 메타스토어에 등록되지 않아 버킷 정보 유실
df.write.bucketBy(64, "key").parquet("/data/table")

# 가능 — 메타스토어에 등록
df.write.bucketBy(64, "key").saveAsTable("my_table")
```

**4. 파일 수 폭발 주의**

총 파일 수 = 버킷 수 x Spark 쓰기 파티션 수입니다. 파티션이 200개이고 버킷이 64개면 최대 12,800개의 파일이 생길 수 있습니다. 소규모 파일이 대량 생성되면 메타스토어 부하와 읽기 성능 저하로 이어집니다.

```python
# 파일 수 제어 — 쓰기 전 파티션 수를 버킷 수와 맞추기
df.coalesce(64).write \
    .bucketBy(64, "customer_id") \
    .sortBy("customer_id") \
    .saveAsTable("orders_bucketed")
# → 버킷당 파일 1개 = 총 64개 파일
```

> `coalesce(N)`에서 N을 버킷 수와 동일하게 맞추면 버킷당 파일 1개가 생성되어 가장 깔끔합니다.

**5. Delta Lake에서는 버켓팅 미지원**

Delta Lake 형식으로 저장되는 테이블에는 `bucketBy`가 지원되지 않습니다. Databricks 환경에서 Delta를 사용한다면 **Liquid Clustering**이 대안입니다.

```sql
-- Delta Lake 대안: Liquid Clustering (Databricks)
CREATE TABLE orders
CLUSTER BY (customer_id)
USING DELTA;
```

**6. 버켓 컬럼은 파티션 컬럼과 겹칠 수 없다**

`bucketBy`에 지정한 컬럼은 `partitionBy`에 동시에 사용할 수 없습니다. Spark가 컴파일 에러를 발생시킵니다.

```python
# 에러 발생 — 같은 컬럼을 버킷과 파티션에 동시 사용 불가
df.write \
    .partitionBy("customer_id") \
    .bucketBy(64, "customer_id") \
    .saveAsTable("my_table")
# BucketingColumnCannotBePartOfPartitionColumnsError
```

### 언제 버켓팅을 쓰나?

같은 조인 키로 **반복적으로 실행**되는 대용량-대용량 조인에 적합합니다. 한 번 버킷 테이블을 만들면 이후 조인마다 셔플 비용이 절감됩니다.

- Fact 테이블 x Dimension 테이블 반복 조인
- 로그 테이블 x 사용자 테이블 일별 집계 파이프라인
- Broadcast 임계값을 초과하는 중간 크기 테이블 조인

## 2. 블룸 필터 (Bloom Filter)

---

### 블룸 필터란?

"이 값이 이 파일(또는 집합)에 존재하는가?"를 **O(1)로 빠르게 판단**하는 확률적 자료구조입니다. 비트 배열과 여러 개의 해시 함수로 구성됩니다.

```
[삽입: key = "user_123" 저장]
  hash1("user_123") = 3  → bit[3] = 1
  hash2("user_123") = 7  → bit[7] = 1
  hash3("user_123") = 12 → bit[12] = 1

[조회: key = "user_456" 있는가?]
  hash1("user_456") = 3  → bit[3] = 1 (통과)
  hash2("user_456") = 5  → bit[5] = 0 → "없음" 확정
```

핵심 특성:

| 판단 결과 | 의미 |
|-----------|------|
| "없다" | 진짜 없음 — **False Negative 0%** |
| "있다" | 실제로 있을 수도, 없을 수도 있음 — **False Positive 가능** |

"없다"는 판단은 항상 정확합니다. 이 특성 덕분에 "없는 파일 스킵"에 활용할 수 있습니다.

### Spark / Delta Lake에서의 활용

파일 레벨에서 블룸 필터 인덱스를 만들어두면, WHERE 조건에 해당하는 값이 없는 파일을 I/O 없이 건너뜁니다.

```
[WHERE customer_id = 'C100' 쿼리]
  파일 1 블룸 필터 체크 → "없다" → 파일 스킵
  파일 2 블룸 필터 체크 → "있을 수 있다" → 파일 읽기
  파일 3 블룸 필터 체크 → "없다" → 파일 스킵
→ 파일 3개 중 1개만 읽음!
```

**Delta Lake 블룸 필터 인덱스 생성 (Databricks):**

```sql
-- 테이블의 특정 컬럼에 블룸 필터 인덱스 생성
CREATE BLOOMFILTER INDEX ON TABLE orders
FOR COLUMNS(customer_id OPTIONS (fpp = 0.1, numItems = 1000000));
```

```python
# Python에서 SQL로 실행
spark.sql("""
    CREATE BLOOMFILTER INDEX ON TABLE orders
    FOR COLUMNS(customer_id OPTIONS (fpp = 0.1, numItems = 1000000))
""")
```

### 블룸 필터 옵션 상세

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `fpp` | 0.1 (10%) | False Positive Probability. 낮출수록 정확하지만 인덱스 크기 증가. 0 초과 1 이하 |
| `numItems` | 1,000,000 | 해당 컬럼의 예상 고유 값 수. 실제 카디널리티에 맞게 설정해야 적절한 비트 배열 크기 결정 |
| `maxExpectedFpp` | 1.0 (비활성) | 허용 가능한 최대 FPP 임계값. 1.0이면 체크하지 않음 |

옵션은 컬럼 레벨과 테이블 레벨로 지정할 수 있으며, 컬럼 레벨 설정이 테이블 레벨보다 우선합니다.

```sql
-- 여러 컬럼에 서로 다른 옵션 적용
CREATE BLOOMFILTER INDEX ON TABLE orders
FOR COLUMNS(
  customer_id OPTIONS (fpp = 0.05, numItems = 500000),
  order_id OPTIONS (fpp = 0.1, numItems = 10000000)
);
```

### 지원 타입과 연산

**지원 데이터 타입:** `byte`, `short`, `int`, `long`, `float`, `double`, `date`, `timestamp`, `string`

**지원 연산:** `=` (equals), `IN`, `<=>` (equalsnullsafe), 그리고 `AND`/`OR` 조합

```sql
-- 블룸 필터가 활용되는 쿼리 패턴
WHERE customer_id = 'C100'                         -- equals
WHERE customer_id IN ('C100', 'C200', 'C300')      -- IN
WHERE customer_id = 'C100' AND status = 'active'   -- AND 조합
```

**쿼리 실행:**

```python
# 별도 힌트 불필요 — Spark/Delta가 자동으로 블룸 필터 활용
result = spark.sql("""
    SELECT * FROM orders WHERE customer_id = 'C100'
""")

# Spark UI > SQL 탭에서 numFilesSkipped 메트릭으로 효과 확인
```

### 주의사항 / 실무 함정

**1. 저카디널리티 컬럼에는 비효율**

`status` (active/inactive 2가지), `region` (10개 국가) 같은 컬럼은 블룸 필터가 적합하지 않습니다. 어느 파일에나 해당 값이 존재할 가능성이 높아서 스킵 효과가 거의 없습니다. 이런 경우는 파티셔닝이 더 적합합니다.

```
적합한 컬럼: user_id, order_id, transaction_id (고카디널리티 — 값이 매우 다양)
부적합한 컬럼: status, country, category (저카디널리티 — 값의 종류가 적음)
```

**2. fpp와 인덱스 크기 트레이드오프**

fpp를 낮출수록 비트 배열이 커집니다. 과도하게 낮은 fpp는 인덱스 파일 자체가 무거워져 오히려 읽기 비용이 늘어날 수 있습니다.

| fpp 값 | 오탐율 | 상대적 인덱스 크기 | 권장 용도 |
|--------|--------|-------------------|-----------|
| 0.1 | 10% | 1x (기준) | 대부분의 경우 적합 (기본값) |
| 0.05 | 5% | ~1.5x | 스킵율 개선이 필요할 때 |
| 0.01 | 1% | ~3.3x | 매우 큰 테이블, 높은 스킵율 필요 |
| 0.001 | 0.1% | ~5x | 특수 케이스, 인덱스 크기 부담 큼 |

일반적으로 기본값 `fpp=0.1`로 시작하고, Spark UI에서 `numFilesSkipped` 메트릭을 모니터링하며 조정합니다.

**3. 범위 쿼리에는 효과 없음**

블룸 필터는 특정 값의 존재 여부만 판단합니다. `WHERE price > 10000` 같은 범위 조건에는 동작하지 않습니다. 범위 조건에는 정렬 기반 min/max 통계(Z-Order, Clustering)가 더 효과적입니다.

```sql
-- 블룸 필터 효과 있음: 정확한 값 조회 (point lookup)
WHERE customer_id = 'C100'
WHERE order_id IN ('O1', 'O2', 'O3')

-- 블룸 필터 효과 없음: 범위 조건
WHERE created_at > '2024-01-01'
WHERE price BETWEEN 1000 AND 5000
```

**4. 기존 데이터에는 자동 적용되지 않음**

`CREATE BLOOMFILTER INDEX`는 **인덱스 생성 이후 새로 쓰거나 재작성된 파일에만** 블룸 필터를 생성합니다. 기존 데이터에 블룸 필터를 적용하려면 `OPTIMIZE` 명령으로 파일을 재작성해야 합니다.

```sql
-- 1. 블룸 필터 인덱스 정의
CREATE BLOOMFILTER INDEX ON TABLE orders
FOR COLUMNS(customer_id OPTIONS (fpp = 0.1, numItems = 1000000));

-- 2. 기존 데이터에 블룸 필터 적용 (파일 재작성)
OPTIMIZE orders;
```

**5. NULL 값은 인덱스되지 않음**

블룸 필터는 NULL 값을 인덱싱하지 않습니다. `WHERE column IS NULL` 쿼리에서는 파일 스킵이 동작하지 않고 전체 파일을 스캔합니다.

**6. Databricks 전용, OSS Delta에서는 미지원**

`CREATE BLOOMFILTER INDEX` 문법은 **Databricks Runtime 전용**입니다. OSS(오픈소스) Apache Spark / Delta Lake 환경에서는 동일한 SQL 명령이 지원되지 않습니다.

또한 Databricks 공식 문서에서는 대부분의 워크로드에서 블룸 필터보다 **Predictive I/O**나 **Liquid Clustering**을 권장하고 있습니다. 블룸 필터는 고카디널리티 컬럼의 point lookup이 빈번한 특정 패턴에서 여전히 유효합니다.

## 3. 네 가지 기법 비교

---

| 기법 | 목적 | 셔플 제거 | 파일 스킵 | 범위 조건 | 적합한 경우 |
|------|------|:---------:|:---------:|:---------:|-------------|
| **버켓팅** | 조인 최적화 | O | X | X | 같은 키로 반복 조인하는 대용량 테이블 |
| **블룸 필터** | 필터/조회 최적화 | X | O | X | 고카디널리티 컬럼 point lookup |
| **파티셔닝** | 범위 필터 최적화 | X | O | O | 날짜/범위 쿼리, 저카디널리티 컬럼 |
| **Z-Order/Clustering** | 다차원 필터 최적화 | X | O | O | 여러 컬럼 조합 범위 쿼리 |

**선택 기준:**

```
조인이 병목인가?
  └─ Yes → 대용량-대용량 조인인가?
            └─ Yes → 버켓팅 검토 (Delta 환경이면 Liquid Clustering)
            └─ No  → Broadcast 검토
  └─ No  → 아래 필터 병목 확인

필터가 병목인가?
  └─ 날짜/범위 컬럼? → 파티셔닝 또는 Z-Order
  └─ user_id 같은 고카디널리티 point lookup? → 블룸 필터
  └─ 저카디널리티 컬럼? → 파티셔닝
  └─ 여러 컬럼 조합 필터? → Z-Order / Liquid Clustering
```

## 4. 실전 체크리스트

---

```
[버켓팅 적용 전]
□ 양쪽 테이블을 같은 키, 같은 버킷 수로 저장했는가?
□ spark.sql.sources.bucketing.enabled = true인가? (기본값 true)
□ saveAsTable을 사용했는가? (save/parquet 경로 저장 불가)
□ explain에서 Exchange가 사라졌는가?
□ 버킷 수 × 쓰기 파티션 수로 파일 수가 과도하게 늘어나지 않는가?
□ 버켓 컬럼과 파티션 컬럼이 겹치지 않는가?
□ Delta Lake 환경이라면 Liquid Clustering을 대안으로 검토했는가?

[블룸 필터 적용 전]
□ 고카디널리티 컬럼인가? (user_id, order_id 등)
□ point lookup 패턴의 쿼리인가? (= 또는 IN 조건)
□ fpp와 numItems를 실제 데이터 분포에 맞게 설정했는가?
□ 기존 데이터에 적용하려면 OPTIMIZE를 실행했는가?
□ NULL 조건 쿼리가 주요 패턴은 아닌가?
□ Databricks 환경인가? (OSS에서는 미지원)
```

## 정리

---

| 항목 | 버켓팅 | 블룸 필터 |
|------|--------|-----------|
| **핵심 원리** | 해시 기반으로 데이터를 N개 파일에 사전 분배 | 확률적 자료구조로 파일 내 값 존재 여부 판단 |
| **최적화 대상** | 조인 (셔플 제거) | 필터 (파일 스킵) |
| **사전 작업** | `bucketBy().sortBy().saveAsTable()` | `CREATE BLOOMFILTER INDEX` + `OPTIMIZE` |
| **효과 조건** | 양쪽 테이블 동일 키/버킷 수 | 고카디널리티 + point lookup |
| **Delta Lake** | 미지원 (Liquid Clustering 대안) | Databricks Runtime 전용 |
| **주요 함정** | 파일 수 폭발, 버킷 수 불일치 | 기존 데이터 미적용, NULL 미인덱싱 |

## Reference

---

- [Spark SQL Performance Tuning - Bucketing](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Spark DataFrameWriter - bucketBy](https://spark.apache.org/docs/3.5.6/api/python/_modules/pyspark/sql/readwriter)
- [Databricks - CREATE BLOOM FILTER INDEX](https://docs.databricks.com/aws/en/sql/language-manual/delta-create-bloomfilter-index)
- [Databricks - Bloom Filter Indexes](https://docs.databricks.com/aws/en/optimizations/bloom-filters)
- [Databricks - Liquid Clustering](https://docs.databricks.com/en/delta/clustering.html)
- [Bucketing - The Internals of Spark SQL](https://books.japila.pl/spark-sql-internals/bucketing/)
