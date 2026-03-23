---
title: "[DataEngineering] 암묵적 가정의 함정 - 비단조 타임스탬프 replaceWhere 위반 & PostgreSQL View 컬럼 순서"
categories:
  - DataEngineering
tags:
  - Delta Lake
  - replaceWhere
  - Databricks
  - PostgreSQL
  - PySpark
date: 2026-02-27
---

### 개요

데이터 파이프라인을 운영하다 보면 가장 골치 아픈 버그는 **"당연히 그럴 것이다"라고 암묵적으로 가정한 것이 깨지는 경우**입니다. 코드 자체에는 논리적 오류가 없지만, 데이터나 시스템의 동작이 암묵적 전제와 어긋나면서 예상치 못한 에러가 발생합니다.

이번 글에서는 대규모 이벤트 데이터 ETL 파이프라인에서 발견한 두 가지 버그를 다룹니다. 두 버그 모두 근본 원인은 동일합니다 -- 검증하지 않은 가정에 의존한 코드입니다.

| # | 이슈 | 암묵적 가정 | 실제 |
|---|------|-----------|------|
| Bug #15 | Delta `replaceWhere` 범위 위반 | event_id 순서 = datetime 순서 | 이벤트 타임스탬프는 비단조(non-monotonic) |
| Bug #16 | PostgreSQL View 컬럼 순서 붕괴 | `CREATE OR REPLACE VIEW`는 컬럼 이름 기준으로 동작 | 컬럼 **위치(ordinal position)** 기준으로 매핑 |

이 글을 읽고 나면 다음을 이해할 수 있습니다.

- Delta Lake `replaceWhere`의 제약 조건 검사(constraint check) 동작 원리
- 비단조 타임스탬프 데이터에서 범위 필터를 안전하게 적용하는 패턴
- PostgreSQL `CREATE OR REPLACE VIEW`의 컬럼 매핑 규칙과 안전한 view 교체 방법

---

### 사전 지식

- **Delta Lake**: Spark DataFrame의 `.write.format("delta").option("replaceWhere", ...).mode("overwrite")` 패턴에 대한 기본 이해
- **PySpark**: DataFrame `.where()`, `.write` 체이닝 사용법
- **PostgreSQL**: `CREATE VIEW`, `information_schema` 기본 개념
- **대규모 이벤트 데이터** (도메인 배경): `event_id`(이벤트 번호)는 단조 증가하지만, `datetime`(이벤트 타임스탬프)은 단조 증가를 보장하지 않음

---

### Bug #15: 비단조 타임스탬프가 유발한 replaceWhere 위반

#### 에러 메시지

```
DELTA_REPLACE_WHERE_MISMATCH: Data written out does not match replaceWhere
'datetime >= 2026-02-27 01:00:00+00:00 AND datetime <= 2026-02-27 04:00:00+00:00'.
Got row with value: datetime: 1772150400000000 (= 2026-02-27 00:00:00 UTC)
```

Databricks에서 network rollup (시간 단위 집계) 작업을 실행하던 중 발생한 에러입니다. `replaceWhere`에 지정한 datetime 범위(`01:00:00` 이상)를 만족하지 않는 row(`00:00:00`)가 쓰기 대상 DataFrame에 포함되어 있다는 의미입니다.

#### replaceWhere의 제약 조건 검사

Delta Lake의 `replaceWhere`는 **쓰기 대상 DataFrame의 모든 row가 지정한 predicate를 만족하는지 검증**합니다. 이것은 의도치 않은 데이터 손실을 방지하기 위한 안전장치입니다.

동작 원리를 정리하면 다음과 같습니다.

1. predicate에 해당하는 기존 데이터 파일을 Delta log에서 `remove`로 표시
2. 새 DataFrame의 **모든 row**가 predicate를 만족하는지 검증
3. 검증 통과 시 새 데이터를 `add`로 기록 (atomic commit)
4. 검증 실패 시 `DELTA_REPLACE_WHERE_MISMATCH` 에러 발생, 쓰기 중단

> 참고: `spark.databricks.delta.replaceWhere.constraintCheck.enabled = false`로 이 검증을 비활성화할 수 있지만, predicate 범위 밖의 row까지 덮어쓰게 되므로 데이터 정합성 관점에서 권장하지 않습니다.

#### 원인 분석

이벤트 타임스탬프는 **단조 증가를 보장하지 않습니다.** 이 데이터 소스의 타임스탬프는 엄격한 단조 증가 검증을 거치지 않기 때문에, `event_id`가 높아도 `datetime`이 이전 이벤트보다 이른 경우가 실제로 존재합니다.

문제가 발생한 처리 흐름을 단계별로 추적하면 다음과 같습니다.

```python
# 수정 전

# 1단계: datetime 범위로 가격 데이터 필터링
#   start_ts = 2026-02-27 01:00:00 UTC
price_df = spark.table("price_table") \
    .where(f"datetime >= '{start_ts}' AND datetime < '{end_ts}'")

# 2단계: 가격 데이터에서 event_id 범위 추출 (예: 884000 ~ 884020)
block_min = price_df.agg(F.min("event_id")).collect()[0][0]
block_max = price_df.agg(F.max("event_id")).collect()[0][0]

# 3단계: source_table을 event_id 범위로 필터링 후 시간 단위 집계
source_df = spark.table("source_table") \
    .where(f"event_id BETWEEN {block_min} AND {block_max}") \
    .groupBy(F.date_trunc("hour", "datetime").alias("datetime")) \
    ...

# 4단계: replaceWhere로 저장 -- 여기서 에러 발생
source_df.write.format("delta") \
    .option("replaceWhere", rollup_filter) \
    .mode("overwrite") \
    .saveAsTable(target_table)
```

핵심 문제는 **1단계에서 datetime 기준으로 구한 event_id 범위를, 3단계에서 event_id 기준으로 다시 필터링**하는 부분입니다. datetime -> event_id -> datetime 변환 과정에서 타임스탬프 역전 row가 포함됩니다.

```
event_id 884001 -> datetime 00:58:00  (타임스탬프 역전)
date_trunc('hour', 00:58:00) -> 00:00:00
replaceWhere 조건: datetime >= 01:00:00   <-- 위반!
```

`event_id 884001`은 event_id 범위(`884000~884020`) 안에 있지만, 해당 이벤트의 datetime(`00:58:00`)은 시간 단위로 truncate하면 `00:00:00`이 됩니다. 이 값은 replaceWhere 하한인 `01:00:00`을 위반합니다.

#### 수정

replaceWhere에 쓰기 직전에 **동일한 predicate로 DataFrame을 먼저 필터링**합니다. 이렇게 하면 predicate 범위 밖의 row가 쓰기 대상에서 제거됩니다.

```python
# 수정 후

rollup_filter = f"datetime >= '{start_ts}' AND datetime < '{end_ts}'"

source_df.where(rollup_filter) \    # 추가: replaceWhere 범위 밖 row 제거
    .write.format("delta") \
    .option("replaceWhere", rollup_filter) \
    .mode("overwrite") \
    .saveAsTable(target_table)
```

롤업 노트북은 MERGE 방식(`merge_sql_template`)을 사용하기 때문에 `DELTA_REPLACE_WHERE_MISMATCH` 에러가 직접 발생하지는 않습니다. 그러나 replaceWhere 범위 밖의 row가 MERGE source에 포함되면, 범위 경계를 넘은 불완전 집계가 upsert될 수 있습니다. 동일한 필터를 적용합니다.

```python
# market_rollup_job (내부 모듈) (수정 후)

sql = merge_sql_template(
    df=source_df.where(rollup_filter),   # 추가: 범위 밖 row 제거
    ...
)
```

#### 제거된 범위 밖 row의 처리

`.where(rollup_filter)`로 제거된 row(예: `datetime = 00:00:00`)는 어떻게 되는가? 이 row는 해당 시간대의 이전 rollup 작업에서 이미 처리되었거나, 다음 작업에서 해당 시간대 범위로 처리됩니다. rollup 작업은 시간/일 단위로 겹침 없이 반복 실행되므로, 특정 작업에서 범위 밖 row를 제거하더라도 데이터 누락이 발생하지 않습니다.

#### 핵심 교훈

> **이 데이터에서 event_id와 datetime은 같은 방향으로 증가하지 않을 수 있습니다.**

- datetime 기반으로 event_id 범위를 구한 뒤, event_id 기반으로 데이터를 다시 필터링하면 **datetime 역전 row가 포함될 수 있습니다.**
- Delta Lake `replaceWhere`는 쓰는 DataFrame의 **모든** row가 predicate를 만족해야 합니다. `.option("replaceWhere", ...)` 만 지정하고 DataFrame 자체를 필터링하지 않으면 범위 밖 row가 있을 때 에러가 발생합니다.
- **방어적 패턴**: replaceWhere에 쓰기 전에 항상 동일 조건으로 `.where()` 필터를 적용하면, 데이터 소스의 순서 가정이 깨지더라도 안전합니다.

---

### Bug #16: PostgreSQL `CREATE OR REPLACE VIEW`의 컬럼 위치 함정

#### 에러 메시지

```
InvalidTableDefinition: cannot change name of view column "event_id" to "entity_id"
```

source 테이블의 컬럼 순서가 바뀐 뒤 `CREATE OR REPLACE VIEW`를 실행했을 때 발생한 에러입니다.

#### PostgreSQL의 View 컬럼 매핑 규칙

PostgreSQL 공식 문서에는 `CREATE OR REPLACE VIEW`의 동작이 다음과 같이 정의되어 있습니다.

> The new query must generate the same columns that were generated by the existing view query (that is, **the same column names in the same order and with the same data types**), but it may add additional columns to the end of the list.
>
> -- [PostgreSQL Documentation: CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html)

즉, 기존 view의 컬럼을 **이름이 아니라 위치(ordinal position)** 기준으로 매핑합니다. 새 쿼리의 N번째 컬럼이 기존 view의 N번째 컬럼과 이름/타입이 일치해야 합니다.

#### 원인 분석

예를 들어 기존 view가 다음 순서로 정의되어 있고:

```
position 1: event_id
position 2: entity_id
position 3: value
```

source 테이블의 컬럼 순서가 (스키마 변경 등으로) 다음과 같이 바뀌었다면:

```
position 1: entity_id    <-- 변경됨
position 2: event_id <-- 변경됨
position 3: value
```

`CREATE OR REPLACE VIEW v AS SELECT * FROM source_table`을 실행하면 PostgreSQL은 다음과 같이 해석합니다.

| 기존 view position | 기존 view 컬럼명 | 새 쿼리 position | 새 쿼리 컬럼명 | 결과 |
|---|---|---|---|---|
| 1 | `event_id` | 1 | `entity_id` | 이름 불일치 -- 에러 |
| 2 | `entity_id` | 2 | `event_id` | 이름 불일치 -- 에러 |
| 3 | `value` | 3 | `value` | 일치 |

기존 view의 position 1(`event_id`)에 새 쿼리의 position 1(`entity_id`)을 매핑하려 하고, 이름이 달라 에러가 발생합니다.

> 만약 이름이 아니라 **타입만** 일치했다면 에러 없이 컬럼 이름이 뒤바뀌는 사일런트 버그가 될 수도 있습니다. 에러가 명확히 발생하는 이 경우가 그나마 나은 상황입니다.

#### 첫 번째 시도: DROP + CREATE (실패)

가장 직관적인 해결책처럼 보이는 방법은 기존 view를 삭제하고 다시 만드는 것입니다.

```python
# 처음 시도한 수정 (문제 있음)
cur.execute(f"DROP VIEW IF EXISTS {SCHEMA}.{_view_name};")
sql = f"CREATE VIEW {SCHEMA}.{_view_name} AS SELECT * FROM {full_table_name};"
```

그러나 이 방법은 **이 view를 참조하는 다른 view나 의존 객체의 연결을 끊어버립니다.**

PostgreSQL에서 view A가 view B를 참조할 때:

| 명령 | 동작 | 위험도 |
|------|------|--------|
| `DROP VIEW B` (기본값 `RESTRICT`) | 의존 객체가 있으면 에러 발생, 삭제 거부 | 안전하지만 실행 불가 |
| `DROP VIEW B CASCADE` | B와 B에 의존하는 모든 객체(A 포함)를 함께 삭제 | **매우 위험** |

어떤 방식이든 운영 환경에서 view 의존 관계를 끊는 것은 위험합니다.

#### 최종 수정: 기존 view 컬럼 순서 유지

`information_schema.columns`에서 기존 view의 컬럼 순서를 먼저 조회하고, 그 순서를 유지한 명시적 SELECT 컬럼 리스트로 view를 교체합니다.

```python
# view 교체 유틸 수정 후

# 1. 기존 view의 컬럼 순서 조회
cur.execute("""
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = %s AND table_name = %s
    ORDER BY ordinal_position
""", (SCHEMA, _view_name))
view_cols = [row[0] for row in cur.fetchall()]

if view_cols:
    # 2. source 테이블의 현재 컬럼 목록 조회
    cur.execute("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = %s AND table_name = %s
        ORDER BY ordinal_position
    """, (SCHEMA, table_name))
    table_cols_set = {row[0] for row in cur.fetchall()}

    # 3. 기존 view 순서 유지 + source에 없는 컬럼 제거 + 신규 컬럼 뒤에 추가
    ordered = [c for c in view_cols if c in table_cols_set]
    ordered += [c for c in table_cols_set - set(view_cols)]
    cols_str = ", ".join(ordered)

    sql = f"CREATE OR REPLACE VIEW {SCHEMA}.{_view_name} " \
          f"AS SELECT {cols_str} FROM {full_table_name};"
else:
    # 신규 view: SELECT * 사용
    sql = f"CREATE VIEW {SCHEMA}.{_view_name} " \
          f"AS SELECT * FROM {full_table_name};"
```

이 방식은 모든 스키마 변경 시나리오를 처리합니다.

| 상황 | 처리 |
|------|------|
| 기존 view 컬럼이 source에 그대로 존재 | 기존 순서 그대로 유지 |
| source에서 컬럼이 제거됨 | 해당 컬럼은 view에서도 제거 |
| source에 신규 컬럼 추가됨 | 기존 컬럼 뒤에 append (PostgreSQL 규칙 충족) |
| view가 존재하지 않음 | `SELECT *`로 신규 생성 |

> **왜 신규 컬럼은 뒤에 append하는가?**
> PostgreSQL `CREATE OR REPLACE VIEW`는 기존 컬럼 뒤에 새 컬럼을 추가하는 것만 허용합니다. 기존 컬럼 사이에 끼워넣으면 위치가 바뀌어 동일한 에러가 발생합니다.

#### 주의: `table_cols_set`의 순서 비결정성

위 코드에서 신규 컬럼을 추가하는 부분(`table_cols_set - set(view_cols)`)은 Python `set` 연산이므로 **신규 컬럼이 여러 개일 때 추가 순서가 비결정적**입니다. 현재 파이프라인에서는 한 번에 하나의 컬럼만 추가되는 경우가 대부분이라 문제가 없지만, 여러 컬럼을 동시에 추가하는 경우 순서를 보장하려면 source 테이블의 `ordinal_position` 순서를 유지해야 합니다.

```python
# 순서를 보장하는 개선 버전
cur.execute("""
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = %s AND table_name = %s
    ORDER BY ordinal_position
""", (SCHEMA, table_name))
table_cols_ordered = [row[0] for row in cur.fetchall()]

# 기존 순서 유지 + 신규 컬럼은 source 테이블의 ordinal_position 순서대로 추가
existing = set(view_cols)
ordered = [c for c in view_cols if c in set(table_cols_ordered)]
ordered += [c for c in table_cols_ordered if c not in existing]
```

#### 핵심 교훈

> **PostgreSQL `CREATE OR REPLACE VIEW`는 컬럼을 이름이 아니라 위치(ordinal position)로 매핑합니다.**

- `SELECT *`로 view를 정의하면 source 테이블의 컬럼 순서에 view가 묵시적으로 종속됩니다.
- Source 컬럼 순서 변경 후 `CREATE OR REPLACE VIEW AS SELECT *` 실행 시, 이름 불일치 에러 또는 사일런트 컬럼 뒤바뀜이 발생합니다.
- `DROP + CREATE`는 의존 관계를 끊으므로 운영 환경에서 위험합니다. `information_schema.columns`에서 기존 컬럼 순서를 조회한 뒤 명시적 컬럼 리스트로 교체하는 방식이 안전합니다.
- **근본적인 예방책**: 처음부터 `SELECT *` 대신 명시적 컬럼 리스트로 view를 정의하는 것이 최선입니다. 다만, 컬럼이 자주 추가되는 파이프라인 테이블에서는 유지보수 비용이 높아 현실적으로 어려울 수 있습니다.

---

### 정리

두 버그의 공통점은 **"당연히 그럴 것"이라는 암묵적 가정**에서 비롯됐다는 점입니다.

| 가정 | 현실 | 결과 |
|------|------|------|
| event_id가 높으면 datetime도 최신일 것이다 | 이벤트 타임스탬프는 비단조, 역전 가능 | `DELTA_REPLACE_WHERE_MISMATCH` |
| `CREATE OR REPLACE VIEW`는 이름 기준으로 컬럼을 매핑할 것이다 | PostgreSQL은 위치(position) 기준으로 매핑 | `InvalidTableDefinition` |

데이터 파이프라인에서 이런 암묵적 가정은 평소에는 문제가 없다가 엣지 케이스에서 조용히 터집니다. 이번 두 버그는 에러가 명확하게 발생하는 경우(`DELTA_REPLACE_WHERE_MISMATCH`, `InvalidTableDefinition`)라 발견이 빨랐지만, 에러 없이 데이터가 틀리게 적재되는 경우가 더 위험합니다.

방어적 코딩의 원칙은 간단합니다.

1. **데이터 순서에 대한 가정을 코드에 넣지 말 것** -- 특히 외부 시스템(외부 시스템)에서 오는 데이터는 순서를 보장하지 않을 수 있습니다.
2. **쓰기 전에 항상 동일 조건으로 필터링할 것** -- replaceWhere predicate와 DataFrame filter를 일치시키면 데이터 소스의 순서 가정이 깨지더라도 안전합니다.
3. **암묵적 매핑(위치, 순서)에 의존하지 말 것** -- 이름 기반 명시적 매핑이 항상 더 안전합니다.

---

### 트러블슈팅 요약

| 에러 메시지 | 원인 | 수정 |
|---|---|---|
| `DELTA_REPLACE_WHERE_MISMATCH` | 쓰기 대상 DataFrame에 replaceWhere predicate 범위 밖의 row가 포함됨 | `.where(replaceWhere_condition)`으로 DataFrame을 먼저 필터링 |
| `InvalidTableDefinition: cannot change name of view column` | `CREATE OR REPLACE VIEW`에서 source 컬럼 순서가 기존 view와 불일치 | `information_schema.columns`에서 기존 순서를 조회하여 명시적 컬럼 리스트로 교체 |

---

### Reference

- [PostgreSQL CREATE VIEW 공식 문서](https://www.postgresql.org/docs/current/sql-createview.html) -- `CREATE OR REPLACE VIEW` 컬럼 매핑 규칙
- [PostgreSQL DROP VIEW 공식 문서](https://www.postgresql.org/docs/current/sql-dropview.html) -- `CASCADE`/`RESTRICT` 동작
- [PostgreSQL information_schema.columns](https://www.postgresql.org/docs/current/infoschema-columns.html) -- `ordinal_position` 컬럼 순서 조회
- [Delta Lake Batch Read/Write](https://docs.delta.io/latest/delta-batch.html) -- `replaceWhere` selective overwrite 및 constraint check 설정
