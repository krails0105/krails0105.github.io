---
title: "[Python] PyArrow & Parquet 스키마 - 타입 불일치 해결"
categories:
  - Python
tags:
  - [Python, PyArrow, Parquet, Schema, DataEngineering]
---

# Introduction

---

Parquet 파일 작업 시 가장 흔한 에러:

```
ArrowInvalid: Casting from timestamp[us] to timestamp[ns] would lose data
Schema mismatch: expected int64, got float64
```

이 글에서는 PyArrow 스키마 문제의 원인과 해결법을 정리합니다.

# 1. PyArrow 기본 타입

---

## 주요 데이터 타입

```python
import pyarrow as pa

# 정수
pa.int8(), pa.int16(), pa.int32(), pa.int64()
pa.uint8(), pa.uint16(), pa.uint32(), pa.uint64()

# 실수
pa.float32(), pa.float64()

# 문자열
pa.string()  # UTF-8
pa.large_string()  # 큰 문자열

# 날짜/시간
pa.date32()  # 일 단위
pa.timestamp("us")  # 마이크로초
pa.timestamp("ns")  # 나노초
pa.timestamp("us", tz="UTC")  # 타임존 포함

# Boolean
pa.bool_()

# Null
pa.null()
```

## 스키마 정의

```python
schema = pa.schema([
    ("id", pa.int64()),
    ("name", pa.string()),
    ("amount", pa.float64()),
    ("created_at", pa.timestamp("us")),
    ("is_active", pa.bool_())
])
```

# 2. 흔한 스키마 문제

---

## 문제 1: Timestamp 정밀도 불일치

```python
# Pandas → PyArrow 변환 시
import pandas as pd

df = pd.DataFrame({
    "ts": pd.to_datetime(["2024-01-01", "2024-01-02"])
})

# Pandas는 기본 ns, Parquet은 보통 us 사용
table = pa.Table.from_pandas(df)
# ts: timestamp[ns] ← 나노초

# 다른 파일과 합칠 때 에러 발생 가능
```

**해결:**

```python
# 방법 1: 스키마 명시
schema = pa.schema([("ts", pa.timestamp("us"))])
table = pa.Table.from_pandas(df, schema=schema)

# 방법 2: 컬럼 캐스팅
table = table.cast(pa.schema([("ts", pa.timestamp("us"))]))
```

## 문제 2: Int와 Float 혼합

```python
# 파일 1: amount가 int64 (값이 모두 정수)
# 파일 2: amount가 float64 (소수점 존재)

# 두 파일 합치면 에러!
```

**해결:**

```python
# 읽을 때 스키마 강제
schema = pa.schema([
    ("id", pa.int64()),
    ("amount", pa.float64())  # float으로 통일
])

table = pq.read_table("data.parquet", schema=schema)
```

## 문제 3: Null 처리

```python
# 모든 값이 null인 컬럼 → 타입 추론 불가
df = pd.DataFrame({"col": [None, None, None]})
table = pa.Table.from_pandas(df)
# col: null (타입 없음)
```

**해결:**

```python
schema = pa.schema([("col", pa.string())])  # 명시적 타입
table = pa.Table.from_pandas(df, schema=schema)
```

# 3. Parquet 읽기/쓰기

---

## 기본 사용법

```python
import pyarrow.parquet as pq

# 쓰기
pq.write_table(table, "data.parquet")

# 읽기
table = pq.read_table("data.parquet")

# 특정 컬럼만 읽기
table = pq.read_table("data.parquet", columns=["id", "name"])
```

## 스키마 확인

```python
# 파일의 스키마 확인
parquet_file = pq.ParquetFile("data.parquet")
print(parquet_file.schema_arrow)

# 또는
schema = pq.read_schema("data.parquet")
print(schema)
```

## 스키마 진화 (Schema Evolution)

```python
# 새 컬럼 추가 시
# 방법 1: 기존 파일에 null로 채우기
existing_schema = pq.read_schema("existing.parquet")
new_schema = existing_schema.append(pa.field("new_col", pa.string()))

# 방법 2: Parquet 파티션 디렉토리에서 스키마 병합
dataset = pq.ParquetDataset(
    "data/",
    schema=unified_schema  # 통합 스키마 지정
)
```

# 4. Pandas 연동

---

## Pandas → PyArrow

```python
import pandas as pd
import pyarrow as pa

df = pd.DataFrame({
    "id": [1, 2, 3],
    "value": [1.1, 2.2, 3.3]
})

# 자동 변환
table = pa.Table.from_pandas(df)

# 스키마 지정
schema = pa.schema([
    ("id", pa.int32()),  # int64 대신 int32
    ("value", pa.float32())  # float64 대신 float32
])
table = pa.Table.from_pandas(df, schema=schema)
```

## PyArrow → Pandas

```python
# 기본 변환
df = table.to_pandas()

# 메모리 효율적 변환
df = table.to_pandas(
    self_destruct=True,  # Arrow 메모리 해제
    split_blocks=True,
    date_as_object=False  # datetime64로 유지
)
```

## 타입 매핑

| Pandas | PyArrow |
|--------|---------|
| int64 | int64() |
| float64 | float64() |
| object (str) | string() |
| datetime64[ns] | timestamp("ns") |
| bool | bool_() |
| category | dictionary() |

# 5. 대용량 파일 처리

---

## 청크 단위 읽기

```python
parquet_file = pq.ParquetFile("large.parquet")

for batch in parquet_file.iter_batches(batch_size=10000):
    # RecordBatch 처리
    df_chunk = batch.to_pandas()
    process(df_chunk)
```

## 파티션 데이터셋

```python
# 파티션 디렉토리 구조
# data/
#   year=2024/
#     month=01/
#       part-0.parquet
#     month=02/
#       part-0.parquet

dataset = pq.ParquetDataset("data/")
table = dataset.read()

# 필터링 (파티션 프루닝)
table = dataset.read(
    filters=[("year", "=", 2024), ("month", "=", "01")]
)
```

## 메모리 매핑

```python
# 메모리에 로드하지 않고 읽기
table = pq.read_table(
    "data.parquet",
    memory_map=True  # 디스크에서 직접 읽기
)
```

# 6. 스키마 검증 패턴

---

```python
def validate_and_cast(table: pa.Table, expected_schema: pa.Schema) -> pa.Table:
    """스키마 검증 및 캐스팅"""

    # 컬럼 존재 확인
    missing = set(expected_schema.names) - set(table.schema.names)
    if missing:
        raise ValueError(f"Missing columns: {missing}")

    # 타입 불일치 컬럼 찾기
    cast_needed = []
    for field in expected_schema:
        actual_type = table.schema.field(field.name).type
        if actual_type != field.type:
            cast_needed.append(field.name)

    if cast_needed:
        print(f"Casting columns: {cast_needed}")
        return table.cast(expected_schema)

    return table

# 사용
expected = pa.schema([
    ("id", pa.int64()),
    ("amount", pa.float64()),
    ("ts", pa.timestamp("us"))
])

table = validate_and_cast(raw_table, expected)
```

# 7. 압축 설정

---

```python
# Snappy (기본, 빠름)
pq.write_table(table, "data.parquet", compression="snappy")

# Gzip (높은 압축률)
pq.write_table(table, "data.parquet", compression="gzip")

# Zstd (균형 잡힌 선택)
pq.write_table(table, "data.parquet", compression="zstd")

# 컬럼별 다른 압축
pq.write_table(
    table, "data.parquet",
    compression={
        "id": "snappy",
        "data": "zstd"
    }
)
```

# 8. 체크리스트

---

```
□ Timestamp 정밀도(us/ns)가 일관되는가?
□ Int/Float 타입이 통일되어 있는가?
□ Null 컬럼의 타입이 명시되어 있는가?
□ 여러 파일 병합 시 스키마가 호환되는가?
□ 대용량 파일은 청크/파티션으로 처리하는가?
□ 압축 방식이 용도에 맞는가?
```

# Reference

---

- [PyArrow Documentation](https://arrow.apache.org/docs/python/)
- [Parquet Format Specification](https://parquet.apache.org/docs/)
- [PyArrow Pandas Integration](https://arrow.apache.org/docs/python/pandas.html)
- [Parquet Best Practices](https://arrow.apache.org/docs/python/parquet.html)
