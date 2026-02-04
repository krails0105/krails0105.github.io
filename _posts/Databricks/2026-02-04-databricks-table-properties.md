---
title: "[Databricks] TBLPROPERTIES로 기능 켜기 - CDF, autoOptimize, Generated Columns"
categories:
  - Databricks
tags:
  - [Databricks, Delta, TBLPROPERTIES, CDF, AutoOptimize]
---

# Introduction

---

Databricks/Delta에서는 "기능 on/off"를 `TBLPROPERTIES`로 하는 경우가 많습니다. 이 글은 운영에서 자주 쓰는 3가지를 정리합니다.

- Change Data Feed (CDF)
- autoOptimize/autoCompact
- Generated Columns

# 1. Change Data Feed (CDF)

---

CDF는 테이블의 변경분(change)을 읽을 수 있게 해줍니다.

## 활성화

```sql
-- 테이블 생성 시
CREATE TABLE events (
    id STRING,
    data STRING
)
USING delta
TBLPROPERTIES (delta.enableChangeDataFeed = true);

-- 기존 테이블에 추가
ALTER TABLE events SET TBLPROPERTIES (delta.enableChangeDataFeed = true);
```

## 확인

```sql
SHOW TBLPROPERTIES events;
```

## 핵심 포인트

| 포인트 | 설명 |
|--------|------|
| 활성화 시점 | **활성화 이후 버전부터** change가 기록됨 |
| 과거 버전 | 활성화 이전 버전은 `table_changes`로 읽을 수 없음 |
| Storage | 추가 파일(_change_data 폴더)이 생성됨 |

## 사용

```python
# 변경 데이터 읽기
changes = spark.read.format("delta") \
    .option("readChangeFeed", "true") \
    .option("startingVersion", 5) \
    .table("events")

changes.filter("_change_type = 'update_postimage'").show()
```

# 2. autoOptimize

---

Small files 문제를 자동으로 완화하는 옵션들입니다.

## optimizeWrite

Write 시점에 파일 크기를 최적화합니다.

```sql
ALTER TABLE events SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true'
);
```

**동작:** 쓰기 전에 파티션을 재분배해서 적절한 크기의 파일 생성

**주의:** 추가 셔플이 발생해 write 시간이 증가할 수 있음

## autoCompact

작은 파일을 자동으로 합칩니다.

```sql
ALTER TABLE events SET TBLPROPERTIES (
    'delta.autoOptimize.autoCompact' = 'true'
);
```

**동작:** Write 후 백그라운드에서 compaction 실행

**주의:** Databricks 환경에서 주로 지원

## 둘 다 활성화

```sql
ALTER TABLE events SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

## 비용 고려

```
Write 비용 증가 vs 쿼리 비용 감소
→ 반드시 측정해서 결정
```

# 3. Generated Columns

---

다른 컬럼에서 자동 계산되는 컬럼입니다.

## 사용 예시

```sql
CREATE TABLE events (
    event_id STRING,
    event_time TIMESTAMP,
    -- Generated column: event_time에서 자동 계산
    event_date DATE GENERATED ALWAYS AS (CAST(event_time AS DATE)),
    event_hour INT GENERATED ALWAYS AS (HOUR(event_time))
)
USING delta
PARTITIONED BY (event_date);
```

## Insert 시 동작

```python
# event_date를 생략해도 자동 생성
df.select("event_id", "event_time").write \
    .format("delta") \
    .mode("append") \
    .saveAsTable("events")
```

## 장점

| 장점 | 설명 |
|------|------|
| 일관성 | 파이프라인마다 계산 로직 중복 방지 |
| 파티션 키 | timestamp → date/hour 변환 자동화 |
| 실수 방지 | 계산 오류/타임존 불일치 예방 |

## 제약사항

```sql
-- deterministic 함수만 사용 가능
-- 불가: CURRENT_TIMESTAMP(), RAND()
-- 가능: CAST(), YEAR(), MONTH(), HOUR()
```

# 4. 기타 유용한 TBLPROPERTIES

---

## 데이터 보존 기간

```sql
-- VACUUM으로 삭제되기까지의 최소 기간
ALTER TABLE events SET TBLPROPERTIES (
    'delta.deletedFileRetentionDuration' = 'interval 30 days'
);

-- 로그 보존 기간
ALTER TABLE events SET TBLPROPERTIES (
    'delta.logRetentionDuration' = 'interval 60 days'
);
```

## 파일 크기 설정

```sql
-- 목표 파일 크기 (OPTIMIZE 시)
ALTER TABLE events SET TBLPROPERTIES (
    'delta.targetFileSize' = '128mb'
);
```

## 통계 수집

```sql
-- 히스토그램 통계 활성화
ALTER TABLE events SET TBLPROPERTIES (
    'delta.dataSkippingNumIndexedCols' = 32
);
```

# 5. TBLPROPERTIES 관리

---

## 현재 설정 확인

```sql
SHOW TBLPROPERTIES events;
```

## 설정 제거

```sql
ALTER TABLE events UNSET TBLPROPERTIES ('delta.autoOptimize.optimizeWrite');
```

## 테이블 생성 시 여러 속성

```sql
CREATE TABLE events (
    id STRING,
    data STRING,
    created_at TIMESTAMP,
    created_date DATE GENERATED ALWAYS AS (CAST(created_at AS DATE))
)
USING delta
PARTITIONED BY (created_date)
TBLPROPERTIES (
    'delta.enableChangeDataFeed' = 'true',
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true',
    'delta.deletedFileRetentionDuration' = 'interval 7 days'
);
```

# 6. 운영 팁

---

## 기능 활성화 전 체크

```
1. 영향 범위 파악 (다운스트림, 비용, 호환성)
2. 테스트 환경에서 먼저 검증
3. 측정 기준 정의 (파일 수, 쿼리 시간 등)
```

## 기능 활성화 후 체크

```
1. 실제로 개선이 측정되는지 확인
   - 파일 수 감소
   - 스캔 바이트 감소
   - 쿼리 시간 감소
2. 예상치 못한 부작용 없는지 확인
   - Write 시간 증가
   - Storage 사용량 증가
```

# 7. 체크리스트

---

```
□ CDF는 "켜기 전 버전은 못 읽는다"를 알고 있는가?
□ Small files 문제를 write 단계에서 막을지, 유지보수로 풀지 결정했는가?
□ Generated column 도입 시 다운스트림 호환성을 확인했는가?
□ TBLPROPERTIES 변경을 코드/IaC로 관리하고 있는가?
□ 설정 변경 후 효과를 측정하고 있는가?
```

# Reference

---

- [Delta Lake Table Properties](https://docs.delta.io/latest/table-properties.html)
- [Databricks Auto Optimize](https://docs.databricks.com/en/delta/tune-file-size.html)
- [Generated Columns](https://docs.databricks.com/en/delta/generated-columns.html)
- [Change Data Feed](https://docs.databricks.com/en/delta/delta-change-data-feed.html)
