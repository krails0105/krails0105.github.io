---
title: "[Databricks] Delta Lake 실전 운영 이슈 4가지 - IcebergCompatV3 DML 에러, None vs NULL, 노트북 파라미터, DDL 컬럼 순서"
categories:
  - Databricks
tags:
  - Databricks
  - Delta Lake
  - Universal Format
  - Iceberg
  - Notebook
  - PySpark
date: 2026-02-13
---

## Overview

Databricks에서 Delta Lake 테이블을 운영하다 보면 공식 문서만으로는 해결하기 어려운 실전 이슈를 만나게 됩니다.
이 글은 최근 UTXO 메트릭 파이프라인을 Databricks로 마이그레이션하면서 겪은 4가지 실전 문제와 해결법을 정리합니다.

| # | 이슈 | 핵심 원인 |
|---|------|----------|
| 1 | IcebergCompatV3 + UniForm DML 에러 | DBR 버전별 writer feature 지원 차이 |
| 2 | Python `None` → SQL `NULL` 처리 | f-string에서 `None`이 문자열 `'None'`으로 변환 |
| 3 | 노트북 간 파라미터 전달 | 4가지 방법의 장단점과 함정 |
| 4 | DDL 컬럼 순서 제어 | `set()`/`sorted()` 사용 시 순서 소실 |

각 이슈별로 **문제 상황 → 원인 분석 → 해결법** 순서로 설명합니다.

---

## 1. IcebergCompatV3 + Universal Format DML 에러

### 문제 상황

`info_table_ingestion` 메타데이터 테이블에서 DELETE 쿼리를 실행하자 다음 에러가 발생했습니다.

```
DELTA_UNIVERSAL_FORMAT_VIOLATION

Iceberg compatibility version 2 requires deletion vectors
to be disabled when table property 'delta.universalFormat.enabledFormats'
contains 'iceberg'.

Set 'delta.enableDeletionVectors' to 'false' to disable deletion vectors.
```

에러 메시지가 "IcebergCompatV2에서는 Deletion Vectors를 꺼야 한다"고 안내하고 있으므로, 일단 메시지대로 시도해 보았습니다.

### 시도 1: Deletion Vectors 비활성화

```sql
ALTER TABLE metadata.info_table_ingestion
SET TBLPROPERTIES ('delta.enableDeletionVectors' = 'false');
```

그러자 또 다른 에러가 발생합니다.

```
DELTA_FEATURES_REQUIRE_MANUAL_ENABLEMENT

Failed to remove writer feature deletionVectors.
```

Deletion Vectors는 한 번 활성화되면 writer protocol에 등록되기 때문에, 단순히 property를 `false`로 바꾸는 것만으로는 제거되지 않습니다.

### 시도 2: IcebergCompatV2로 다운그레이드

다음으로 IcebergCompatV2를 적용해 보려 했지만, 테이블 properties를 확인해 보니 이미 v3가 활성화된 상태였습니다.

```sql
SHOW TBLPROPERTIES metadata.info_table_ingestion;
```

```
delta.enableIcebergCompatV3      = "true"
delta.universalFormat.enabledFormats = "iceberg"
delta.enableDeletionVectors      = "true"
delta.enableRowTracking          = "true"
delta.columnMapping.mode         = "name"
```

v3와 Deletion Vectors가 함께 켜져 있는 상태에서, v2로 다운그레이드하면 Deletion Vectors를 먼저 끄라고 하고, Deletion Vectors를 끄면 writer feature 제거를 하라고 하는 **순환 의존 상태**에 빠집니다.

### 원인 분석

핵심 원인은 **실행 환경(DBR 버전)과 테이블 기능 버전의 불일치**입니다.

- **IcebergCompatV3**는 Deletion Vectors를 허용합니다 (Iceberg v3 spec이 deletion vectors를 지원하기 때문).
- 그런데 **DBR 16.4 LTS 클러스터**에서는 IcebergCompatV3 writer feature를 인식하지 못합니다.
- 클러스터가 v3를 모르니 v2 기준으로 해석하고, v2에서는 Deletion Vectors가 비활성화되어야 하므로 에러를 발생시킵니다.

이 과정을 흐름으로 나타내면 다음과 같습니다.

```
DBR 16.4 LTS에서 DELETE 실행
    → 클러스터가 IcebergCompatV3를 모름
    → IcebergCompatV2 기준으로 해석
    → "v2에서 Deletion Vectors 비활성화 필요" 에러
    → Deletion Vectors 끄기 시도
    → writer feature 제거 불가 에러
    → (원점 회귀)
```

### 해결: 서버리스 SQL Warehouse 사용

IcebergCompatV3는 **서버리스 SQL Warehouse**에서 지원됩니다. 서버리스 환경은 항상 최신 런타임을 사용하기 때문에 v3 writer feature를 정상적으로 인식합니다.

```sql
-- 서버리스 SQL Warehouse에서 실행
DELETE FROM metadata.info_table_ingestion
WHERE table_name = 'test_table';

-- 성공
```

### 환경별 IcebergCompatV3 지원 현황

| 실행 환경 | IcebergCompatV3 DML 지원 | 비고 |
|----------|:------------------------:|------|
| DBR 16.4 LTS (All-purpose) | X | reader만 가능, writer feature 미인식 |
| Serverless SQL Warehouse | O | 항상 최신 런타임 |
| Latest DBR (All-purpose) | O | DBR 버전에 따라 다름 |

### 권장 사항

- **IcebergCompatV3 + UniForm 테이블의 DML(INSERT/UPDATE/DELETE)은 서버리스 SQL Warehouse에서 실행**합니다.
- 서버리스를 사용할 수 없는 환경이라면, 테이블 생성 시 IcebergCompatV2로 설정하고 Deletion Vectors를 비활성화합니다.

```sql
-- IcebergCompatV2로 생성하는 경우
CREATE TABLE catalog.schema.my_table (id INT, name STRING)
TBLPROPERTIES (
  'delta.enableDeletionVectors' = 'false',
  'delta.enableIcebergCompatV2' = 'true',
  'delta.columnMapping.mode' = 'name',
  'delta.universalFormat.enabledFormats' = 'iceberg'
);
```

---

## 2. Python `None` → SQL `NULL` 처리

### 문제 상황

메타데이터 테이블에 Python으로 동적 INSERT문을 생성할 때, `None` 값이 있는 컬럼에서 의도치 않게 문자열 `'None'`이 저장되는 문제가 발생했습니다.

```python
partition_column = None

# 잘못된 예: Python None이 문자열 'None'으로 저장됨
insert_sql = f"INSERT INTO metadata.info_table_ingestion VALUES ('{partition_column}')"
# 실제 생성되는 SQL: VALUES ('None')  -- 문자열 'None'이 저장됨!
```

### 원인

Python의 f-string은 `None`을 문자열 `"None"`으로 변환합니다. SQL에서 `NULL`은 따옴표 없이 `NULL` 키워드를 사용해야 하는데, f-string 안에서는 이 구분이 자동으로 되지 않습니다.

```python
value = None

f"'{value}'"   # → "'None'" : 문자열 'None' (잘못됨)
"NULL"         # → "NULL"   : SQL NULL  (올바름)
```

### 해결: 헬퍼 함수 사용

SQL 값을 생성하는 헬퍼 함수를 만들어 `None`과 실제 값을 명확히 구분합니다.

```python
def sql_value(v):
    """Python 값을 SQL 리터럴로 변환한다. None은 NULL, 나머지는 따옴표로 감싼다."""
    return f"'{v}'" if v is not None else "NULL"
```

이 함수를 사용한 INSERT 예시는 다음과 같습니다.

```python
# metadata.info_table_ingestion 컬럼 구조:
# (table_name, partition_column, key_column, update_type, is_active, updated_at)

table_name = "btc_market_block"
partition_column = None           # 이 테이블은 파티션 없음
key_column = "block_height"
update_type = "MERGE"

insert_sql = f"""
INSERT INTO metadata.info_table_ingestion VALUES (
    {sql_value(table_name)},
    {sql_value(partition_column)},
    {sql_value(key_column)},
    {sql_value(update_type)},
    'Y',
    current_timestamp()
);
"""

spark.sql(insert_sql)
```

생성되는 SQL은 다음과 같습니다.

```sql
INSERT INTO metadata.info_table_ingestion VALUES (
    'btc_market_block',
    NULL,                -- partition_column: None → SQL NULL
    'block_height',
    'MERGE',
    'Y',
    current_timestamp()
);
```

### 주의사항 요약

| Python 표현 | 생성되는 SQL | 결과 |
|-------------|-------------|------|
| `f"'{None}'"` | `'None'` | 문자열 `'None'` 저장 (잘못됨) |
| `f"'{value}'"` (value=None) | `'None'` | 문자열 `'None'` 저장 (잘못됨) |
| `"NULL"` | `NULL` | SQL NULL 저장 (올바름) |
| `sql_value(None)` | `NULL` | SQL NULL 저장 (올바름) |

> **Tip**: 이 문제는 Databricks에 국한되지 않고 Python에서 SQL을 동적으로 생성하는 모든 상황에서 발생합니다. 가능하다면 parameterized query(파라미터 바인딩)를 사용하는 것이 SQL Injection 방지 측면에서도 더 안전합니다.

---

## 3. 노트북 간 파라미터 전달 방식 비교

Databricks에서 노트북 간 파라미터를 전달하는 방법은 4가지가 있지만, 각각 장단점이 명확합니다. 특히 **동적 파라미터 전달이 필요한 프로덕션 환경**에서 어떤 방법을 선택하느냐가 중요합니다.

### 방법 1: `dbutils.notebook.run()` -- 별도 Job 실행

부모 노트북에서 자식 노트북을 **별도의 ephemeral job**으로 실행합니다. arguments 딕셔너리로 전달된 값은 자식 노트북의 widget 값으로 설정됩니다.

**부모 노트북:**

```python
result = dbutils.notebook.run(
    "./child_notebook",
    timeout_seconds=3600,
    arguments={
        "start_block": "100000",   # 값은 반드시 문자열이어야 함
        "end_block": "200000",
        "mode": "incremental"
    }
)
print(f"자식 노트북 반환값: {result}")
```

**자식 노트북:**

```python
# 위젯 선언 (기본값 지정 -- 자식 노트북을 단독 실행할 때 사용됨)
dbutils.widgets.text("start_block", "0")
dbutils.widgets.text("end_block", "0")
dbutils.widgets.text("mode", "full")

# 값 읽기 (부모가 전달한 값이 기본값을 override함)
start_block = int(dbutils.widgets.get("start_block"))
end_block = int(dbutils.widgets.get("end_block"))
mode = dbutils.widgets.get("mode")

# 작업 수행...

# 반환값 전달 (문자열만 가능)
dbutils.notebook.exit(f"processed {end_block - start_block} blocks")
```

**장점:**
- Python 변수를 딕셔너리로 동적 전달 가능
- 루프에서 여러 번 호출 가능
- `dbutils.notebook.exit()`으로 반환값 수신 가능

**단점:**
- 자식 노트북이 별도 job으로 실행되어 **부모 노트북 UI에서 로그가 보이지 않음**
- arguments는 **문자열만** 지원 (ASCII 문자만, 비ASCII 불가)
- 디버깅이 어려움 (자식 노트북의 job run 페이지에서 별도로 확인해야 함)

### 방법 2: `%run` -- 같은 프로세스 실행

같은 프로세스(SparkSession) 내에서 다른 노트북을 인라인 실행합니다.

```python
# 셀 전체를 단독으로 사용해야 함 (다른 코드와 같은 셀에 넣을 수 없음)
%run ./child_notebook $start_block="100000" $end_block="200000"
```

**장점:**
- 같은 프로세스이므로 **모든 로그가 부모 노트북 UI에 표시됨**
- 자식 노트북에서 정의한 변수/함수를 부모에서 그대로 사용 가능
- 디버깅이 쉬움

**단점:**
- **리터럴 값만 전달 가능** -- Python 변수를 직접 전달할 수 없음
- 셀 하나 전체를 차지해야 하므로 **루프 안에서 사용 불가**
- 셀의 첫 줄에만 작성 가능

### 방법 3: `os.environ` + `%run` -- 환경 변수 전달

`%run`의 리터럴 제약을 우회하기 위해 환경 변수를 사용합니다.

```python
# 부모 (셀 1)
import os
os.environ["START_BLOCK"] = str(start_block)  # Python 변수 → 환경 변수
os.environ["END_BLOCK"] = str(end_block)
```

```python
# 부모 (셀 2 -- 반드시 별도 셀)
%run ./child_notebook
```

```python
# 자식 노트북
import os
start_block = int(os.environ["START_BLOCK"])
end_block = int(os.environ["END_BLOCK"])
```

**장점:**
- `%run`과 같은 프로세스이므로 로그가 보임
- Python 변수를 간접적으로 전달 가능

**단점:**
- `dbutils.widgets`로 파라미터를 읽는 자식 노트북과 호환되지 않음
- 환경 변수 이름 충돌(오염) 가능성
- 자식 노트북이 `os.environ` 의존성을 가지게 되어 단독 실행이 어려움

### 방법 4: `dbutils.widgets.text()` 직접 설정 + `%run` (비권장)

부모에서 위젯 값을 미리 설정하고 `%run`으로 자식을 실행하는 방식입니다.

```python
# 부모 (셀 1)
dbutils.widgets.text("start_block", "100000")
```

```python
# 부모 (셀 2)
%run ./child_notebook
```

```python
# 자식
start_block = dbutils.widgets.get("start_block")
```

**치명적 단점: 위젯 값이 업데이트되지 않음**

```python
# 의도: 루프마다 다른 batch_id 전달
for i in range(3):
    dbutils.widgets.text("batch_id", str(i))
    # %run은 루프 안에서 사용 불가하지만, 설령 가능하더라도:
    # 위젯은 첫 설정 이후 값이 변경되지 않음 -- 모든 반복에서 "0"이 전달됨
    # dbutils.widgets.remove()로 삭제해도 내부 캐시가 남아 있음
```

위젯은 원래 노트북 UI에서 사용자가 대화형으로 값을 입력하기 위한 기능이므로, 프로그래밍 방식의 동적 파라미터 전달 용도로는 부적합합니다.

### 비교 요약

| 방법 | 동적 전달 | 로그 표시 | 루프 가능 | 반환값 | 권장 용도 |
|------|:---------:|:---------:|:---------:|:------:|----------|
| `dbutils.notebook.run()` | O | X | O | O | **프로덕션 배치, 워크플로** |
| `%run $param="val"` | X | O | X | X | 개발/디버깅, 공유 함수 로드 |
| `os.environ` + `%run` | O | O | X | X | 단순 설정값 전달 |
| `dbutils.widgets.text()` + `%run` | X | O | X | X | **사용 비권장** |

### 결론

**동적 파라미터 전달이 필요한 프로덕션 환경에서는 `dbutils.notebook.run()`이 유일하게 안정적인 선택입니다.**

로그가 보이지 않는 단점은 다음과 같이 보완할 수 있습니다.

- 자식 노트북에서 주요 단계마다 `print()` 또는 로깅 라이브러리로 명시적 로그 출력
- 개발/디버깅 시에는 `%run`으로 실행하여 인라인 로그 확인
- Databricks Jobs UI에서 자식 노트북의 실행 결과를 별도 확인

---

## 4. DDL 컬럼 순서 제어

### 문제 상황

Delta 테이블의 스키마를 기반으로 PostgreSQL CREATE TABLE DDL을 자동 생성하는 스크립트에서, 컬럼 순서가 뒤죽박죽이었습니다.

```python
# 기존 코드 -- 순서가 소실되는 원인
delta_columns = set(df.columns)     # set()은 순서를 보존하지 않음
pg_columns = sorted(delta_columns)  # 알파벳 정렬
```

이렇게 하면 다음과 같은 DDL이 생성됩니다.

```sql
-- 의도하지 않은 결과: 알파벳 순서
CREATE TABLE btc_market_block (
    average_cap_usd NUMERIC,
    block_height BIGINT,
    marketcap_usd NUMERIC,
    ...
    updated_at TIMESTAMP       -- 중간에 섞여 있음
);
```

### 요구사항

1. **Primary Key 컬럼을 맨 앞에** 배치
2. **Delta 테이블의 원래 컬럼 순서** 유지
3. **`updated_at`을 맨 뒤에** 배치

### 해결: 순서 보존 로직

`df.columns`는 Python `list`이므로 Delta 테이블의 스키마 순서를 그대로 보존합니다. 이 순서를 기반으로 PK를 앞으로, `updated_at`을 뒤로 재배치합니다.

```python
def generate_pg_ddl(table_name: str, df, pk_columns: list[str]) -> str:
    """Delta 테이블 스키마를 기반으로 PostgreSQL CREATE TABLE DDL을 생성한다.

    컬럼 순서: PK 컬럼 → Delta 원본 순서의 나머지 컬럼 → updated_at
    """
    # 1. Delta 테이블 컬럼 순서 그대로 가져오기
    delta_columns = df.columns  # list -- 순서 보존됨

    # 2. PK 먼저, 나머지는 Delta 순서 유지, updated_at은 마지막
    pk_set = set(pk_columns)
    other_columns = [c for c in delta_columns
                     if c not in pk_set and c != "updated_at"]

    ordered_columns = pk_columns + other_columns + ["updated_at"]

    # 3. Spark 타입 → PostgreSQL 타입 매핑 후 DDL 생성
    column_defs = []
    for col in ordered_columns:
        dtype = df.schema[col].dataType
        pg_type = spark_to_pg_type(dtype)
        column_defs.append(f"    {col} {pg_type}")

    ddl = f"CREATE TABLE {table_name} (\n"
    ddl += ",\n".join(column_defs)
    ddl += f",\n    PRIMARY KEY ({', '.join(pk_columns)})\n);"

    return ddl
```

생성 결과는 다음과 같습니다.

```sql
-- 의도한 결과
CREATE TABLE btc_market_block (
    block_height BIGINT,       -- PK 먼저
    marketcap_usd NUMERIC,     -- Delta 스키마 순서 유지
    average_cap_usd NUMERIC,
    ...
    updated_at TIMESTAMP       -- 맨 뒤
);
```

### 보충: Delta 테이블 자체의 컬럼 순서 변경

DDL 생성과 별개로, Delta 테이블 자체의 컬럼 순서도 `ALTER COLUMN`으로 변경할 수 있습니다. 이 기능을 사용하려면 `columnMapping.mode`가 `'name'`으로 설정되어 있어야 합니다.

```sql
-- 전제: columnMapping.mode = 'name' 필요
ALTER TABLE btc_market_block
SET TBLPROPERTIES ('delta.columnMapping.mode' = 'name');

-- 컬럼을 맨 앞으로 이동
ALTER TABLE btc_market_block
ALTER COLUMN block_height FIRST;

-- 특정 컬럼 뒤에 배치
ALTER TABLE btc_market_block
ALTER COLUMN marketcap_usd AFTER block_height;
```

> **주의**: `ALTER COLUMN ... FIRST/AFTER`는 메타데이터만 변경하므로 데이터 재작성 없이 즉시 적용됩니다. 다만 한 번에 하나의 컬럼만 이동할 수 있어서 컬럼이 많은 테이블에서는 여러 번 실행해야 합니다.

### 핵심 포인트

```python
# 순서 소실 -- 사용하지 마세요
set(columns)       # set은 순서 보장 없음
sorted(columns)    # 의도하지 않은 알파벳 정렬

# 순서 보존 -- 올바른 방법
df.columns                        # PySpark DataFrame.columns는 list 반환
[c for c in columns if ...]       # list comprehension은 원본 순서 유지
```

---

## 운영 체크리스트

위 이슈들을 코드 리뷰나 배포 전에 확인할 수 있도록 체크리스트로 정리합니다.

- [ ] IcebergCompatV3 테이블의 DML(INSERT/UPDATE/DELETE)은 서버리스 SQL Warehouse에서 실행하는가?
- [ ] Python에서 SQL을 동적 생성할 때 `None` 값이 SQL `NULL`로 올바르게 변환되는가? (`'None'` 문자열이 아닌지 확인)
- [ ] 노트북 간 동적 파라미터 전달에 `dbutils.notebook.run()`을 사용하는가?
- [ ] DDL 생성 시 `set()`이나 `sorted()`로 컬럼 순서가 소실되지 않는가?
- [ ] Delta 테이블 컬럼 순서 변경이 필요하면 `columnMapping.mode = 'name'`이 설정되어 있는가?

---

## Summary

| 이슈 | 해결법 | 핵심 교훈 |
|------|--------|----------|
| IcebergCompatV3 DML 에러 | 서버리스 SQL Warehouse 사용 | DBR 버전별 기능 지원 범위를 사전에 확인할 것 |
| Python None → 'None' 문자열 | `sql_value()` 헬퍼 함수 | f-string에서 None은 자동으로 NULL이 되지 않음 |
| 노트북 파라미터 전달 | `dbutils.notebook.run()` | 동적 전달 + 루프가 필요하면 유일한 선택 |
| DDL 컬럼 순서 | `df.columns` (list) 활용 | `set()`/`sorted()`는 순서를 파괴함 |

---

## References

- [Databricks UniForm (Universal Format)](https://docs.databricks.com/en/delta/uniform.html)
- [Iceberg compatibility version 3 (IcebergCompatV3)](https://docs.databricks.com/aws/en/iceberg/iceberg-v3)
- [Delta Lake Deletion Vectors](https://docs.databricks.com/en/delta/deletion-vectors.html)
- [Notebook Workflows - dbutils.notebook.run()](https://docs.databricks.com/en/notebooks/notebook-workflows.html)
- [Delta Lake Schema Update - ALTER COLUMN Ordering](https://docs.databricks.com/aws/en/delta/update-schema.html)
- [ALTER TABLE SQL Reference](https://docs.databricks.com/en/sql/language-manual/sql-ref-syntax-ddl-alter-table.html)
