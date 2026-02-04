---
title: "[Iceberg] 스냅샷과 메타데이터 유지보수"
categories:
  - Iceberg
tags:
  - [Iceberg, Snapshot, Maintenance, Compaction, TimeTravel]
---

# Introduction

---

Iceberg는 **스냅샷 기반 테이블 포맷**입니다. 이 구조가 time travel과 안전한 rollback을 가능하게 하지만, 운영에서는 유지보수 작업이 필수입니다.

이 글은:
- Snapshot이 무엇인지
- 왜 메타데이터가 쌓이는지
- Expire/compaction이 언제 필요한지

를 정리합니다.

# 1. Snapshot이란?

---

Snapshot은 테이블의 **특정 시점 상태**를 가리키는 메타데이터입니다.

```
Snapshot 1 → [파일 A, 파일 B]
     ↓
Snapshot 2 → [파일 A, 파일 B, 파일 C]  (INSERT)
     ↓
Snapshot 3 → [파일 A, 파일 D]          (DELETE B, UPDATE C→D)
```

## Snapshot이 제공하는 기능

| 기능 | 설명 |
|------|------|
| Time Travel | 과거 시점 데이터 조회 |
| Rollback | 잘못된 변경 되돌리기 |
| Audit | 변경 이력 추적 |
| Incremental Read | 스냅샷 간 변경분만 읽기 |

## Time Travel 예시

```sql
-- 특정 스냅샷으로 조회
SELECT * FROM my_table VERSION AS OF 123456789;

-- 특정 시간으로 조회
SELECT * FROM my_table TIMESTAMP AS OF '2024-01-15 10:00:00';
```

```python
# Spark에서
df = spark.read.format("iceberg") \
    .option("snapshot-id", "123456789") \
    .load("catalog.db.my_table")
```

# 2. 왜 유지보수가 필요한가?

---

## 메타데이터 증가

```
Snapshot 1 → Snapshot 2 → ... → Snapshot 1000
     ↓           ↓                   ↓
[메타데이터 파일들이 계속 쌓임]
```

- 각 스냅샷은 manifest 파일을 가리킴
- 스냅샷이 쌓이면 메타데이터가 커짐
- 쿼리 계획 시간 증가

## Small Files

```
Write 1: [10MB 파일]
Write 2: [5MB 파일]
Write 3: [3MB 파일]
...
→ 수백~수천 개의 작은 파일
```

- 파일 open 오버헤드 증가
- Metadata 크기 증가
- 스캔 성능 저하

## 고아 파일 (Orphan Files)

```
실패한 write → 데이터 파일 생성
              → 커밋 실패
              → 파일은 남아있지만 참조 없음
```

# 3. 주요 유지보수 작업

---

## 3.1 Expire Snapshots

오래된 스냅샷을 제거합니다.

```sql
-- SQL
CALL catalog.system.expire_snapshots('db.table', TIMESTAMP '2024-01-01');
```

```python
# Spark
from pyspark.sql.functions import current_timestamp, expr

spark.sql("""
    CALL catalog.system.expire_snapshots(
        table => 'db.my_table',
        older_than => TIMESTAMP '2024-01-01 00:00:00',
        retain_last => 10
    )
""")
```

```java
// Java API
Table table = catalog.loadTable(TableIdentifier.of("db", "my_table"));
SparkActions.get()
    .expireSnapshots(table)
    .expireOlderThan(System.currentTimeMillis() - TimeUnit.DAYS.toMillis(7))
    .retainLast(10)
    .execute();
```

### 주의사항

- **진행 중인 쿼리가 사용 중인 스냅샷은 삭제하면 안 됨**
- 보존 기간은 가장 긴 쿼리 시간보다 길게
- Rollback 요구사항 고려

## 3.2 Rewrite Data Files (Compaction)

작은 파일들을 합칩니다.

```sql
-- SQL
CALL catalog.system.rewrite_data_files('db.table');

-- 옵션 지정
CALL catalog.system.rewrite_data_files(
    table => 'db.table',
    options => map('target-file-size-bytes', '134217728')  -- 128MB
);
```

```python
# Spark에서
spark.sql("""
    CALL catalog.system.rewrite_data_files(
        table => 'db.my_table',
        strategy => 'binpack',
        options => map(
            'min-file-size-bytes', '52428800',   -- 50MB
            'target-file-size-bytes', '134217728', -- 128MB
            'max-file-size-bytes', '268435456'  -- 256MB
        )
    )
""")
```

### Compaction 전략

| 전략 | 설명 |
|------|------|
| binpack | 작은 파일들을 크기 기준으로 병합 |
| sort | 정렬하면서 병합 (Z-Order 등) |

## 3.3 Remove Orphan Files

참조되지 않는 고아 파일을 정리합니다.

```sql
CALL catalog.system.remove_orphan_files(
    table => 'db.table',
    older_than => TIMESTAMP '2024-01-01'
);
```

### 주의사항

- 최근 파일은 건드리지 않도록 older_than 설정
- 진행 중인 write가 있으면 대기

## 3.4 Rewrite Manifests

Manifest 파일들을 최적화합니다.

```sql
CALL catalog.system.rewrite_manifests('db.table');
```

- 작은 manifest들을 병합
- 메타데이터 읽기 성능 개선

# 4. 유지보수 스케줄 예시

---

```python
# Airflow DAG 예시
from airflow import DAG
from airflow.providers.apache.spark.operators.spark_sql import SparkSqlOperator

with DAG("iceberg_maintenance", schedule_interval="0 2 * * *") as dag:

    expire_snapshots = SparkSqlOperator(
        task_id="expire_snapshots",
        sql="""
            CALL catalog.system.expire_snapshots(
                table => 'db.my_table',
                older_than => current_timestamp() - INTERVAL 7 DAYS,
                retain_last => 10
            )
        """
    )

    rewrite_data_files = SparkSqlOperator(
        task_id="rewrite_data_files",
        sql="""
            CALL catalog.system.rewrite_data_files(
                table => 'db.my_table',
                strategy => 'binpack'
            )
        """
    )

    remove_orphan_files = SparkSqlOperator(
        task_id="remove_orphan_files",
        sql="""
            CALL catalog.system.remove_orphan_files(
                table => 'db.my_table',
                older_than => current_timestamp() - INTERVAL 3 DAYS
            )
        """
    )

    expire_snapshots >> rewrite_data_files >> remove_orphan_files
```

# 5. 보존 정책 설계

---

## 고려 사항

| 요구사항 | 영향 |
|----------|------|
| 감사/롤백 기간 | 스냅샷 보존 기간 결정 |
| 쿼리 실행 시간 | 최소 보존 기간 결정 |
| 저장 비용 | 메타데이터 + 데이터 파일 |
| 복구 속도 | 스냅샷이 많으면 느려질 수 있음 |

## 권장 정책 예시

```
Snapshot 보존: 7일
최소 보존 개수: 10개
Compaction 주기: 매일
Orphan file 정리: 3일 이상된 파일
```

# 6. 모니터링

---

## 파일 통계 확인

```sql
-- 파일 수와 크기 확인
SELECT
    COUNT(*) as file_count,
    SUM(file_size_in_bytes) as total_size,
    AVG(file_size_in_bytes) as avg_file_size
FROM catalog.db.my_table.files;

-- 스냅샷 수 확인
SELECT COUNT(*) as snapshot_count
FROM catalog.db.my_table.snapshots;
```

## 경고 기준 예시

| 지표 | 임계값 | 조치 |
|------|--------|------|
| 파일 수 | > 10,000 | Compaction 실행 |
| 평균 파일 크기 | < 10MB | Compaction 실행 |
| 스냅샷 수 | > 100 | Expire 실행 |

# 7. 체크리스트

---

```
□ Snapshot 보존 기간 정책이 있는가?
□ 파일 수/메타데이터 크기를 모니터링하는가?
□ Compaction 주기를 비용/성능 관점에서 합의했는가?
□ Orphan file 정리 스케줄이 있는가?
□ 유지보수 작업이 프로덕션 쿼리에 영향을 주지 않는가?
□ 롤백/감사 요구사항을 만족하는 보존 기간인가?
```

# Reference

---

- [Iceberg Maintenance](https://iceberg.apache.org/docs/latest/maintenance/)
- [Expire Snapshots](https://iceberg.apache.org/docs/latest/spark-procedures/#expire_snapshots)
- [Rewrite Data Files](https://iceberg.apache.org/docs/latest/spark-procedures/#rewrite_data_files)
- [Remove Orphan Files](https://iceberg.apache.org/docs/latest/spark-procedures/#remove_orphan_files)
