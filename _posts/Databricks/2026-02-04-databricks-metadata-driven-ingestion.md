---
title: "[Databricks] 메타테이블 기반 Ingestion 설계"
categories:
  - Databricks
tags:
  - [Databricks, Metadata, ETL, Ingestion, DataEngineering]
---

# Introduction

---

테이블이 늘어날수록 "적재 규칙"을 코드에 박아두면 운영이 어려워집니다. 테이블마다 다른 파일을 만들고, 배포하고, 관리하는 것은 확장성이 없습니다.

해결책: **메타테이블에 적재 규칙을 저장**하고, 파이프라인은 이를 읽어 동작하는 패턴입니다.

# 1. 메타테이블에 담는 정보

---

```sql
CREATE TABLE ingestion_metadata (
    source_table STRING,           -- 소스 테이블/뷰
    target_table STRING,           -- 타겟 테이블
    primary_key STRING,            -- PK 컬럼 (MERGE용)
    updated_at_column STRING,      -- 증분 기준 컬럼
    partition_key STRING,          -- 파티션 컬럼
    clustering_keys ARRAY<STRING>, -- 클러스터링 키
    load_type STRING,              -- full, incremental, merge
    is_active BOOLEAN,             -- 활성화 여부
    last_sync_at TIMESTAMP,        -- 마지막 동기화 시점
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

## 예시 데이터

```sql
INSERT INTO ingestion_metadata VALUES
('raw.events', 'silver.events', 'event_id', 'updated_at', 'event_date', ARRAY('user_id'), 'merge', true, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
('raw.users', 'silver.users', 'user_id', 'modified_at', NULL, ARRAY('region'), 'merge', true, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()),
('raw.logs', 'silver.logs', NULL, NULL, 'log_date', NULL, 'full', true, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());
```

# 2. 공통 파이프라인 코드

---

```python
from pyspark.sql.functions import col, current_timestamp
from delta.tables import DeltaTable

class MetadataDrivenIngestion:
    def __init__(self, spark, metadata_table="ingestion_metadata"):
        self.spark = spark
        self.metadata_table = metadata_table

    def get_active_tables(self):
        """활성화된 테이블 목록 조회"""
        return self.spark.table(self.metadata_table) \
            .filter(col("is_active") == True) \
            .collect()

    def run_ingestion(self, table_config):
        """단일 테이블 적재 실행"""
        source = table_config.source_table
        target = table_config.target_table
        load_type = table_config.load_type
        pk = table_config.primary_key
        updated_col = table_config.updated_at_column
        partition_key = table_config.partition_key

        print(f"Processing: {source} -> {target} ({load_type})")

        if load_type == "full":
            self._full_load(source, target, partition_key)
        elif load_type == "incremental":
            self._incremental_load(source, target, updated_col, partition_key)
        elif load_type == "merge":
            self._merge_load(source, target, pk, updated_col)

        # 동기화 시점 업데이트
        self._update_sync_time(source)

    def _full_load(self, source, target, partition_key):
        """전체 덮어쓰기"""
        df = self.spark.table(source)

        writer = df.write.format("delta").mode("overwrite")
        if partition_key:
            writer = writer.partitionBy(partition_key)
        writer.saveAsTable(target)

    def _incremental_load(self, source, target, updated_col, partition_key):
        """증분 적재 (append)"""
        last_sync = self._get_last_sync_time(source)

        df = self.spark.table(source)
        if last_sync and updated_col:
            df = df.filter(col(updated_col) > last_sync)

        writer = df.write.format("delta").mode("append")
        if partition_key:
            writer = writer.partitionBy(partition_key)
        writer.saveAsTable(target)

    def _merge_load(self, source, target, pk, updated_col):
        """MERGE (upsert)"""
        last_sync = self._get_last_sync_time(source)

        source_df = self.spark.table(source)
        if last_sync and updated_col:
            source_df = source_df.filter(col(updated_col) > last_sync)

        if source_df.count() == 0:
            print("No new data to merge")
            return

        target_table = DeltaTable.forName(self.spark, target)
        target_table.alias("t").merge(
            source_df.alias("s"),
            f"t.{pk} = s.{pk}"
        ).whenMatchedUpdateAll() \
         .whenNotMatchedInsertAll() \
         .execute()

    def _get_last_sync_time(self, source):
        row = self.spark.table(self.metadata_table) \
            .filter(col("source_table") == source) \
            .select("last_sync_at") \
            .first()
        return row.last_sync_at if row else None

    def _update_sync_time(self, source):
        self.spark.sql(f"""
            UPDATE {self.metadata_table}
            SET last_sync_at = current_timestamp(),
                updated_at = current_timestamp()
            WHERE source_table = '{source}'
        """)

    def run_all(self):
        """모든 활성 테이블 처리"""
        tables = self.get_active_tables()
        for table_config in tables:
            try:
                self.run_ingestion(table_config)
            except Exception as e:
                print(f"Failed: {table_config.source_table} - {e}")
                # 에러 로깅/알림
                raise
```

# 3. 실행

---

```python
# Databricks notebook에서
ingestion = MetadataDrivenIngestion(spark)
ingestion.run_all()
```

```python
# 특정 테이블만
tables = ingestion.get_active_tables()
for t in tables:
    if t.source_table == "raw.events":
        ingestion.run_ingestion(t)
```

# 4. 장점

---

| 장점 | 설명 |
|------|------|
| 코드 재사용 | 공통 파이프라인으로 모든 테이블 처리 |
| 쉬운 추가 | 테이블 추가 = 메타 레코드 INSERT |
| 중앙 관리 | 적재 규칙을 한 곳에서 확인/수정 |
| 모니터링 | 메타테이블로 상태 추적 가능 |

# 5. 주의사항

---

## 메타 변경도 "배포"처럼 관리

```python
# 메타 변경 검증 예시
def validate_metadata_change(spark, source_table, pk):
    """PK 컬럼이 실제 존재하는지 확인"""
    df = spark.table(source_table)
    if pk and pk not in df.columns:
        raise ValueError(f"PK column '{pk}' not found in {source_table}")
```

## PK/키 변경은 마이그레이션 필요

```python
# PK 변경 시 기존 데이터 정합성 확인
def validate_pk_change(spark, table, old_pk, new_pk):
    # 새 PK로 중복 확인
    dup_count = spark.table(table) \
        .groupBy(new_pk).count() \
        .filter(col("count") > 1).count()

    if dup_count > 0:
        raise ValueError(f"Duplicate values found for new PK: {new_pk}")
```

# 6. 확장: 품질 규칙도 메타로

---

```sql
CREATE TABLE quality_rules (
    table_name STRING,
    rule_type STRING,       -- not_null, unique, range, custom
    column_name STRING,
    rule_expression STRING, -- custom SQL 조건
    severity STRING,        -- error, warning
    is_active BOOLEAN
);

INSERT INTO quality_rules VALUES
('silver.events', 'not_null', 'event_id', NULL, 'error', true),
('silver.events', 'unique', 'event_id', NULL, 'error', true),
('silver.users', 'range', 'age', 'age BETWEEN 0 AND 150', 'warning', true);
```

```python
def run_quality_checks(spark, table_name):
    rules = spark.table("quality_rules") \
        .filter((col("table_name") == table_name) & (col("is_active") == True)) \
        .collect()

    for rule in rules:
        if rule.rule_type == "not_null":
            count = spark.table(table_name) \
                .filter(col(rule.column_name).isNull()).count()
            if count > 0:
                handle_violation(rule, count)
        # ... 다른 규칙들
```

# 7. 체크리스트

---

```
□ 메타 변경에 대한 승인/버전 관리가 있는가?
□ PK/updated_at 정의가 모든 테이블에서 명확한가?
□ 파이프라인이 메타만으로 멱등하게 동작하는가?
□ 메타 검증 잡(스키마 존재/PK 유효/파티션 범위)이 있는가?
□ 실패 시 알림/재처리 절차가 있는가?
```

# Reference

---

- [Databricks Workflows](https://docs.databricks.com/en/workflows/index.html)
- [Delta Lake Best Practices](https://docs.delta.io/latest/best-practices.html)
- [Data Quality with Delta](https://docs.databricks.com/en/delta/data-quality.html)
