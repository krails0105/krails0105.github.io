---
title: "[Spark/Delta] Generated Column - 파티션 컬럼 자동 생성"
categories:
  - Spark
tags:
  - [Spark, Delta, GeneratedColumns, Partitioning, Schema]
---

# Introduction

---

Generated column은 "다른 컬럼으로부터 계산되는 컬럼"을 테이블 스키마에 선언하는 기능입니다.

대표 사용처는 **timestamp → date/hour**로 파티션 컬럼을 자동 생성하는 패턴입니다.

# 1. Generated Column의 핵심 개념

---

- 테이블 스키마에 generation expression을 등록
- write 시 그 컬럼 값을 제공하지 않으면 엔진이 자동 계산
- 값을 제공하면 constraint 검증이 들어가 일치해야 함

```sql
-- Delta Lake에서 Generated Column 생성
CREATE TABLE events (
    event_id STRING,
    event_time TIMESTAMP,
    event_date DATE GENERATED ALWAYS AS (CAST(event_time AS DATE))
)
USING delta
PARTITIONED BY (event_date)
```

# 2. 왜 insert에서 파티션 컬럼을 생략할 수 있나?

---

파티션 컬럼이 generated column이면:
- 입력은 timestamp만 주고
- 파티션 키(date/hour)는 자동으로 만들어짐

```python
# event_date를 명시하지 않아도 자동 생성됨
df.select("event_id", "event_time").write \
    .format("delta") \
    .mode("append") \
    .save("/path/to/events")
```

**장점:**
- 개발자는 "파티션 계산 로직"을 반복하지 않아도 됨
- 파이프라인마다 계산 오류가 날 가능성이 줄어듦

# 3. 실전 패턴: timestamp → date/hour 파티션

---

```sql
-- 시간 단위 파티션
CREATE TABLE logs (
    log_id STRING,
    created_at TIMESTAMP,
    log_date DATE GENERATED ALWAYS AS (CAST(created_at AS DATE)),
    log_hour INT GENERATED ALWAYS AS (HOUR(created_at))
)
USING delta
PARTITIONED BY (log_date, log_hour)
```

**운영에서 좋은 점:**
- 파티션 컬럼 계산 로직을 여러 잡에서 중복 구현하지 않아도 됨
- "타임존/단위 실수" 같은 버그가 줄어듦
- 파티션 기준 overwrite/backfill이 쉬워짐

# 4. 주의할 점

---

## 필수 조건
- generation expression은 **deterministic** 해야 함
- 랜덤 함수, 현재 시간 등 non-deterministic 함수 사용 불가

## 호환성
- 테이블 프로토콜/호환성(특히 다운스트림)이 영향을 받을 수 있음
- Delta Lake 버전에 따라 지원 여부 확인 필요

## 값 명시 시
- 명시적으로 값을 넣을 때는 expression과 정확히 일치해야 함
- 불일치 시 에러 발생

# 5. 흔한 함정

---

| 함정 | 문제 | 해결책 |
|------|------|--------|
| 이벤트 시간 vs 적재 시간 | 적재 시간으로 생성하면 지표가 뒤틀림 | 이벤트 시간 컬럼 사용 |
| 타임존 불일치 | 파티션 경계가 달라져 누락/중복 | 타임존 기준 고정 |
| 파티션 폭발 | 너무 세밀한 단위(분, 초) | date/hour 단위 권장 |

# 6. 체크리스트

---

```
□ 파티션 키 계산이 모든 파이프라인에서 일관된가?
□ 다운스트림(쿼리 엔진/BI)이 generated columns를 지원하는가?
□ 파티션 폭발을 일으키지 않는 단위(date/hour)를 선택했는가?
□ 타임존 기준이 프로젝트 전체에서 일관된가?
```

# Reference

---

- [Delta Lake Generated Columns](https://docs.delta.io/latest/delta-batch.html#use-generated-columns)
- [Databricks Generated Columns](https://docs.databricks.com/en/delta/generated-columns.html)
- [Delta Lake Table Protocol](https://github.com/delta-io/delta/blob/master/PROTOCOL.md)
