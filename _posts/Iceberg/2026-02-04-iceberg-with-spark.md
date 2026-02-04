---
title: "[Spark + Iceberg] Catalog 설정부터 Partition, Small Files까지"
categories:
  - Iceberg
tags:
  - [Iceberg, Spark, Catalog, Partition, DataLake]
---

# Introduction

---

Spark에서 Iceberg를 쓸 때 가장 많이 막히는 지점은 **"카탈로그 설정"**과 **"파일 유지보수"**입니다.

이 글은 Spark + Iceberg 조합에서 알아야 할 핵심 설정과 운영 포인트를 정리합니다.

# 1. Catalog 개념

---

Iceberg는 **Catalog**를 통해 테이블 메타데이터를 관리합니다.

```
Catalog → Database → Table → Snapshots → Data Files
```

## Catalog 종류

| Catalog | 설명 | 용도 |
|---------|------|------|
| Hive | Hive Metastore 사용 | 기존 Hive 환경 |
| Glue | AWS Glue Data Catalog | AWS 환경 |
| REST | REST API 기반 | 범용/Nessie 등 |
| Hadoop | 파일시스템 기반 | 테스트/단순 환경 |
| JDBC | DB 기반 메타스토어 | 커스텀 환경 |

# 2. Spark에서 Catalog 설정

---

## Hive Catalog

```python
spark = SparkSession.builder \
    .appName("IcebergApp") \
    .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.iceberg.spark.SparkSessionCatalog") \
    .config("spark.sql.catalog.spark_catalog.type", "hive") \
    .config("spark.sql.catalog.iceberg", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.iceberg.type", "hive") \
    .getOrCreate()
```

## AWS Glue Catalog

```python
spark = SparkSession.builder \
    .appName("IcebergApp") \
    .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.glue_catalog", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.glue_catalog.catalog-impl", "org.apache.iceberg.aws.glue.GlueCatalog") \
    .config("spark.sql.catalog.glue_catalog.warehouse", "s3://my-bucket/warehouse/") \
    .getOrCreate()
```

## Hadoop Catalog (테스트용)

```python
spark = SparkSession.builder \
    .appName("IcebergApp") \
    .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.local", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.local.type", "hadoop") \
    .config("spark.sql.catalog.local.warehouse", "/tmp/iceberg-warehouse") \
    .getOrCreate()
```

## Catalog 사용

```sql
-- Catalog.Database.Table 형식
SELECT * FROM iceberg.db.my_table;

-- 기본 카탈로그 설정
USE iceberg;
SELECT * FROM db.my_table;
```

# 3. 테이블 생성

---

## SQL로 생성

```sql
CREATE TABLE iceberg.db.events (
    event_id STRING,
    user_id STRING,
    event_time TIMESTAMP,
    event_type STRING,
    data STRING
)
USING iceberg
PARTITIONED BY (days(event_time))
TBLPROPERTIES (
    'write.format.default' = 'parquet',
    'write.parquet.compression-codec' = 'zstd'
);
```

## DataFrame에서 생성

```python
df.writeTo("iceberg.db.events") \
    .partitionedBy(days("event_time")) \
    .tableProperty("write.format.default", "parquet") \
    .createOrReplace()
```

# 4. Partition Spec

---

Iceberg는 **Hidden Partitioning**을 지원합니다. 파티션 컬럼을 따로 만들 필요 없이 표현식으로 파티션을 정의합니다.

## 파티션 변환 함수

| 함수 | 설명 | 예시 |
|------|------|------|
| `years(ts)` | 연도 추출 | 2024 |
| `months(ts)` | 연월 추출 | 2024-01 |
| `days(ts)` | 연월일 추출 | 2024-01-15 |
| `hours(ts)` | 시간까지 | 2024-01-15-10 |
| `bucket(n, col)` | 해시 버킷 | 0~n-1 |
| `truncate(n, col)` | 문자열/숫자 잘라내기 | "abc..." |

## 예시

```sql
-- 일 단위 파티션
PARTITIONED BY (days(event_time))

-- 월 + 버킷 조합
PARTITIONED BY (months(event_time), bucket(16, user_id))

-- 여러 변환 조합
PARTITIONED BY (
    years(created_at),
    bucket(32, region)
)
```

## 파티션 진화 (Partition Evolution)

```sql
-- 기존 파티션 스펙 변경 (데이터 재작성 불필요!)
ALTER TABLE iceberg.db.events
ADD PARTITION FIELD bucket(16, user_id);

-- 파티션 필드 제거
ALTER TABLE iceberg.db.events
DROP PARTITION FIELD bucket(16, user_id);
```

## 주의사항

```
너무 세분화 → Small files 폭발
너무 거칠게 → 스캔 증가

권장: days(timestamp) + bucket(n, key) 조합
```

# 5. 데이터 읽기/쓰기

---

## 읽기

```python
# Catalog에서 읽기
df = spark.table("iceberg.db.events")

# 경로로 읽기
df = spark.read.format("iceberg").load("s3://bucket/warehouse/db/events")

# Time Travel
df = spark.read.format("iceberg") \
    .option("snapshot-id", "123456789") \
    .load("iceberg.db.events")

df = spark.read.format("iceberg") \
    .option("as-of-timestamp", "1700000000000") \
    .load("iceberg.db.events")
```

## 쓰기

```python
# Append
df.writeTo("iceberg.db.events").append()

# Overwrite (동적 파티션)
df.writeTo("iceberg.db.events").overwritePartitions()

# MERGE
from pyspark.sql.functions import col

spark.sql("""
    MERGE INTO iceberg.db.events t
    USING updates s
    ON t.event_id = s.event_id
    WHEN MATCHED THEN UPDATE SET *
    WHEN NOT MATCHED THEN INSERT *
""")
```

# 6. Schema Evolution

---

```sql
-- 컬럼 추가
ALTER TABLE iceberg.db.events ADD COLUMN new_col STRING;

-- 컬럼 이름 변경
ALTER TABLE iceberg.db.events RENAME COLUMN old_name TO new_name;

-- 컬럼 타입 변경 (widening만 지원)
ALTER TABLE iceberg.db.events ALTER COLUMN amount TYPE DOUBLE;

-- 컬럼 삭제
ALTER TABLE iceberg.db.events DROP COLUMN unused_col;
```

## 타입 변경 제한

| From | To | 가능 여부 |
|------|----|----------|
| int | long | O |
| float | double | O |
| decimal(p1,s) | decimal(p2,s) where p2>p1 | O |
| string | int | X |

# 7. Small Files 대응

---

## 원인

- 잦은 작은 write
- 파티션이 너무 세분화됨
- Streaming micro-batch

## 확인

```sql
SELECT
    COUNT(*) as file_count,
    AVG(file_size_in_bytes) / 1024 / 1024 as avg_mb
FROM iceberg.db.events.files;
```

## 해결: Compaction

```sql
CALL iceberg.system.rewrite_data_files(
    table => 'db.events',
    strategy => 'binpack',
    options => map(
        'target-file-size-bytes', '134217728'
    )
);
```

## 쓰기 시 최적화

```python
# 파일 크기 설정
df.writeTo("iceberg.db.events") \
    .option("write.target-file-size-bytes", "134217728") \
    .append()

# 또는 테이블 속성으로
spark.sql("""
    ALTER TABLE iceberg.db.events SET TBLPROPERTIES (
        'write.target-file-size-bytes' = '134217728'
    )
""")
```

# 8. 자주 발생하는 문제

---

## 카탈로그를 못 찾음

```
AnalysisException: Catalog 'iceberg' not found
```

**해결**: Spark 설정에서 catalog가 제대로 등록되었는지 확인

```python
# 설정 확인
spark.conf.get("spark.sql.catalog.iceberg")
```

## 권한 오류

```
AccessDeniedException: Access Denied
```

**해결**: S3/Glue 권한 확인, IAM 역할 점검

## Schema Evolution 실패

```
IllegalArgumentException: Cannot change type from X to Y
```

**해결**: 지원되는 타입 변경만 가능 (widening)

# 9. 체크리스트

---

```
□ Catalog가 안정적으로 동작하는가? (권한/엔드포인트)
□ Partition spec이 쿼리 패턴과 맞는가?
□ Small files/메타데이터 유지보수 계획이 있는가?
□ Schema evolution 시 호환성을 확인했는가?
□ Snapshot expire 정책이 있는가?
□ 파일 포맷/압축 설정이 최적화되어 있는가?
```

# Reference

---

- [Iceberg Spark Configuration](https://iceberg.apache.org/docs/latest/spark-configuration/)
- [Iceberg Partitioning](https://iceberg.apache.org/docs/latest/partitioning/)
- [Iceberg Schema Evolution](https://iceberg.apache.org/docs/latest/evolution/)
- [Iceberg Spark Quickstart](https://iceberg.apache.org/docs/latest/spark-quickstart/)
