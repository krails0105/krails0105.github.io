---
title: "[Delta] Small Files 해결 - OPTIMIZE, autoOptimize, autoCompact"
categories:
  - Delta
tags:
  - [Delta, OPTIMIZE, AutoCompact, SmallFiles, Performance]
---

# Introduction

---

Delta 테이블이 느려지는 가장 흔한 이유는 **small files** 문제입니다.

- 파일이 너무 많으면 파일 open/메타데이터 오버헤드 증가
- 조인/스캔에서 task가 과도하게 생성됨
- 쿼리 성능 저하

이 글은 small files를 해결하는 3가지 방법을 정리합니다.

# 1. Small Files가 생기는 원인

---

| 원인 | 설명 |
|------|------|
| 잦은 작은 배치 | 스트리밍/마이크로배치로 자주 write |
| 파티션이 많음 | 각 파티션에 작은 파일이 생성 |
| MERGE/UPDATE | row 단위 변경으로 파일 분산 |
| 병렬 writer | 각 executor가 별도 파일 생성 |

## 확인 방법

```python
# 파일 수 확인
from delta.tables import DeltaTable

dt = DeltaTable.forPath(spark, "/path/to/table")
files = dt.toDF().inputFiles()
print(f"File count: {len(files)}")

# 상세 정보
dt.detail().select("numFiles", "sizeInBytes").show()
```

```sql
-- SQL로 확인
DESCRIBE DETAIL my_table;
```

# 2. OPTIMIZE (수동 유지보수)

---

가장 예측 가능한 방법입니다. 운영에서는 "매일/매주" 같은 주기로 실행합니다.

```sql
-- 전체 테이블 OPTIMIZE
OPTIMIZE my_table;

-- 특정 파티션만
OPTIMIZE my_table WHERE date = '2024-01-01';

-- Z-ORDER와 함께
OPTIMIZE my_table ZORDER BY (user_id);
```

## 파일 크기 조정

```sql
-- 목표 파일 크기 설정 (기본 1GB)
SET spark.databricks.delta.optimize.maxFileSize = 134217728;  -- 128MB
```

## 권장 주기

| 워크로드 | OPTIMIZE 주기 |
|----------|---------------|
| 하루 1회 배치 | 배치 후 1회 |
| 스트리밍/마이크로배치 | 매일 또는 매주 |
| 자주 쿼리되는 핫 테이블 | 매일 |
| 아카이브 테이블 | 필요시 |

# 3. optimizeWrite

---

Write 시점에 파일 크기를 더 적절히 만드는 옵션입니다. Small files를 **생기기 전에** 막는 접근입니다.

```sql
-- 테이블 레벨 설정
ALTER TABLE my_table SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true'
);
```

```python
# Write 시 옵션
df.write.format("delta") \
    .option("optimizeWrite", "true") \
    .mode("append") \
    .save("/path/to/table")
```

## 동작 방식

- Spark가 write 전에 파티션을 재분배
- 너무 작은 파티션들을 합침
- 추가 셔플이 발생할 수 있음

## 주의사항

- Write 비용(시간)이 증가할 수 있음
- 작은 배치가 많으면 효과가 제한적

# 4. autoCompact

---

작은 파일을 자동으로 합치는(compaction) 기능입니다.

```sql
-- 테이블 레벨 설정
ALTER TABLE my_table SET TBLPROPERTIES (
    'delta.autoOptimize.autoCompact' = 'true'
);
```

## 동작 방식

- Write 후 자동으로 소규모 compaction 실행
- 작은 파일들을 더 큰 파일로 병합
- 백그라운드에서 비동기 실행

## 주의사항

- 모든 환경에서 동작하지 않을 수 있음 (Databricks에서 주로 지원)
- Compaction 비용 발생

# 5. 선택 가이드

---

```
Q: ingest가 잦고 작은 배치가 많다?
→ optimizeWrite + autoCompact 고려

Q: 운영 안정성이 최우선이다?
→ 주기적 OPTIMIZE + 모니터링

Q: Write 비용 증가를 감당할 수 있는가?
→ Yes: autoOptimize 사용
→ No: 수동 OPTIMIZE
```

## 조합 패턴

```sql
-- 권장: 모든 옵션 활성화 + 주기적 OPTIMIZE
ALTER TABLE my_table SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);

-- 추가로 주간 OPTIMIZE 스케줄
-- (Airflow/Databricks Jobs 등)
```

# 6. 모니터링

---

## Small files 탐지 지표

```python
from delta.tables import DeltaTable

def check_small_files(table_path, threshold_mb=10):
    dt = DeltaTable.forPath(spark, table_path)
    detail = dt.detail().first()

    num_files = detail.numFiles
    size_bytes = detail.sizeInBytes
    avg_file_size_mb = (size_bytes / num_files) / (1024 * 1024)

    print(f"Files: {num_files}")
    print(f"Avg file size: {avg_file_size_mb:.1f} MB")

    if avg_file_size_mb < threshold_mb:
        print("WARNING: Small files detected!")
        return True
    return False
```

## 알람 설정

```python
# 파일 수 증가 속도 모니터링
# 평균 파일 크기 감소 모니터링
# 쿼리에서 task 수 증가 모니터링 (특히 scan stage)
```

# 7. VACUUM과 함께 사용

---

OPTIMIZE 후에는 오래된 파일이 남습니다. VACUUM으로 정리합니다.

```sql
-- 7일 이상 된 파일 삭제 (기본값)
VACUUM my_table;

-- 특정 기간 지정
VACUUM my_table RETAIN 168 HOURS;  -- 7일
```

## 주의사항

```sql
-- 기본 7일 미만은 차단됨 (안전장치)
-- 반드시 필요하면 설정 변경 (권장하지 않음)
SET spark.databricks.delta.retentionDurationCheck.enabled = false;
VACUUM my_table RETAIN 0 HOURS;  -- 위험!
```

# 8. 체크리스트

---

```
□ 파일 수/평균 파일 크기를 모니터링하고 있는가?
□ write 비용 증가를 감당할 수 있는가?
□ OPTIMIZE 주기를 비용/성능 관점에서 합의했는가?
□ VACUUM 정책이 있는가?
□ 핫 테이블 vs 콜드 테이블 전략이 다른가?
```

# Reference

---

- [Delta Lake OPTIMIZE](https://docs.delta.io/latest/optimizations-oss.html)
- [Databricks Auto Optimize](https://docs.databricks.com/en/delta/tune-file-size.html)
- [VACUUM Command](https://docs.delta.io/latest/delta-utility.html#vacuum)
