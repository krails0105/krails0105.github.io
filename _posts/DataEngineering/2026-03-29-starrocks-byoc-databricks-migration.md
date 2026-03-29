---
title: "StarRocks BYOC + Databricks Delta Lake로 BigQuery 파이프라인 대체하기"
categories:
  - DataEngineering
tags:
  - StarRocks
  - CelerData
  - Databricks
  - DeltaLake
  - MaterializedView
  - FastAPI
  - BigQuery
  - ExternalCatalog
  - pymysql
date: 2026-03-29
---

## Overview

BigQuery 비용이 일정 규모를 넘어서면 자연스럽게 대안을 찾게 된다. 이 글에서는 데이터 파이프라인을 BigQuery 기반에서 **StarRocks BYOC + Databricks Delta Lake** 조합으로 전환한 과정을 정리한다.

다루는 내용은 다음과 같다.

- Delta Lake External Catalog에서 MV/VIEW를 어떻게 나누는지
- MV refresh 타이밍 전략
- Data Cache를 활용한 VIEW 성능 보완
- pymysql 기반 FastAPI 서버 구축

> Delta Lake MV의 풀스캔 제약과 상용 대안 패턴에 대한 상세 분석은 [별도 포스트](/dataengineering/starrocks-delta-lake-mv-limitations/)를 참고하자.

---

## 배경: 왜 BigQuery를 걷어내는가

기존 파이프라인은 다음 구조였다.

```
PostgreSQL --> BigQuery --> dbt --> Airflow reverse ETL --> PostgreSQL --> API
```

단계가 많고, 각 단계마다 별도 인프라와 비용이 발생한다. 특히 BQ 조회 비용과 reverse ETL이 큰 부담이었다.

목표는 단순하다. **BQ를 없애고 파이프라인을 짧게 만드는 것.**

```
Databricks Delta Lake (S3)
    | Unity Catalog
    v
StarRocks BYOC (External Catalog + MV)
    |
    v
FastAPI 서버
```

이 구조에서 BQ, dbt, reverse ETL, 중간 PostgreSQL이 모두 제거된다. Databricks는 기존대로 데이터를 생산하고, StarRocks는 쿼리 서빙만 담당한다. **데이터 적재 없음.**

---

## 설계: MV vs VIEW 전략

Delta Lake External Table의 MV는 **파티션 단위 incremental refresh를 지원하지 않는다.** 매 refresh마다 전체 데이터를 S3에서 다시 읽는다. 이 제약을 기준으로 테이블 유형별 전략을 나눴다.

| 테이블 특성 | 전략 | 이유 |
|---|---|---|
| 집계 테이블 (일별/시간별, 수천~수만 rows) | **MV** + 수동 refresh | 풀스캔이어도 가벼움 |
| 상세 테이블 (블록별, 수십만 rows) | **VIEW** + Data Cache | 데이터 크고 최신성 중요 |

### MV Refresh: 자동 주기 vs 수동 trigger

자동 주기(`EVERY N HOUR`)를 처음 고려했지만, upstream job 완료 시점과 refresh 주기가 어긋나면 오래된 데이터를 서빙할 수 있다.

대신 **upstream job 완료 후 수동 trigger** 방식으로 변경했다.

```sql
-- 자동 주기 제거 (수동 전환)
ALTER MATERIALIZED VIEW mv_db.daily_metrics REFRESH ASYNC;

-- upstream job 완료 시 호출
REFRESH MATERIALIZED VIEW mv_db.daily_metrics;
```

`REFRESH ASYNC`에서 `EVERY` 절을 생략하면 자동 refresh가 비활성화된다.

---

## 구현

### 컬럼 리네임 MV

소스 Delta Lake 테이블의 컬럼명이 API 스펙과 다를 때, MV에서 alias로 매핑한다.

```sql
CREATE MATERIALIZED VIEW mv_db.daily_metrics
REFRESH ASYNC
AS
SELECT
    dt                AS date,
    tx_count          AS transaction_count,
    active_addr_count AS active_addresses,
    total_supply,
    hash_rate         AS hashrate_mean
FROM lakehouse_catalog.source_db.daily_metrics;
```

상세 테이블(블록 단위)은 데이터가 크고 최신성이 중요하므로 MV 대신 VIEW로 처리한다.

```sql
CREATE VIEW mv_db.block_metrics AS
SELECT
    block_height,
    block_timestamp,
    tx_count AS transaction_count
FROM lakehouse_catalog.source_db.block_metrics;
```

### Data Cache 성능 측정

VIEW는 매번 S3를 읽지만, Data Cache가 올라오면 응답 시간이 크게 줄어든다.

| 쿼리 | Cold (S3 스캔) | Warm (캐시 hit) | 개선 |
|---|---|---|---|
| 단순 COUNT(*) | 248ms | 28ms | ~9x |
| JOIN + 집계 | 300ms | 65ms | ~5x |

Data Cache는 Parquet 파일 단위로 캐싱된다. WHERE 조건이 달라져도 같은 파일에 접근하면 캐시 hit가 된다. 시간이 지나면 자주 조회되는 데이터가 자연스럽게 캐싱된다.

BQ 대비로는 느리다(BQ는 동일 쿼리 거의 0초). 하지만 이번 목표가 비용 절감이므로 수백 ms 수준은 감수 가능하다.

### FastAPI 서버 구축

기존 BQ 프록시 API와 분리된 서버를 새로 만들었다. StarRocks는 MySQL 프로토콜(기본 port 9030)을 지원하므로 **pymysql**로 연결한다.

```python
# app/model/starrocks_model.py
import pymysql
import pymysql.cursors
import pymysql.constants.FIELD_TYPE as FT

_TYPE_MAP = {
    FT.TINY: "INT64", FT.SHORT: "INT64", FT.LONG: "INT64",
    FT.FLOAT: "FLOAT64", FT.DOUBLE: "FLOAT64",
    FT.DECIMAL: "BIGNUMERIC", FT.NEWDECIMAL: "BIGNUMERIC",
    FT.TIMESTAMP: "TIMESTAMP", FT.DATETIME: "DATETIME",
    FT.STRING: "STRING", FT.VAR_STRING: "STRING",
}

class StarRocksModel:
    def _get_connection(self):
        return pymysql.connect(
            host=self.host,
            port=self.port,        # StarRocks FE query port (기본값 9030)
            user=self.user,
            password=self.password,
            database=self.database,
            cursorclass=pymysql.cursors.DictCursor,  # row를 dict로 반환
        )

    def execute_query(self, query: str, max_result: int = 50000) -> dict:
        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute(query)
                rows = cursor.fetchmany(max_result)
                columns = [
                    {"name": desc[0], "type": _TYPE_MAP.get(desc[1], "STRING")}
                    for desc in cursor.description
                ]
        finally:
            conn.close()

        return {
            "job_state": "DONE",
            "columns": columns,
            "results": [list(row.values()) for row in rows],
        }
```

주의 사항:

- `cursorclass=pymysql.cursors.DictCursor`를 지정해야 `row.values()`가 동작한다. 기본 커서는 tuple을 반환한다.
- `cursor.description`은 PEP 249 표준이며, `(name, type_code, ...)`의 7-tuple 시퀀스다.
- 응답 포맷을 기존 BQ 프록시와 맞춰서 백엔드 코드 변경을 최소화했다.

엔드포인트 정의:

```python
# app/main.py
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class Query(BaseModel):
    query: str
    max_result: int = 50000

@app.post("/query")
def execute_query(item: Query):
    result = starrocks.execute_query(item.query, max_result=item.max_result)
    return {"result": result}
```

### Dockerfile: uv + gunicorn + nginx

```dockerfile
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

CMD service nginx start && \
    uv run gunicorn app.main:app -c ./infra/gunicorn.conf.py
```

gunicorn worker class를 `uvicorn.workers.UvicornWorker`로 지정한다. nginx가 앞단에서 요청을 받아 UNIX 소켓으로 gunicorn에 전달하는 구조다.

---

## 주의할 점

**1. Delta Lake MV는 항상 풀스캔이다.**
Incremental refresh가 된다고 착각하기 쉽다. Hive나 Iceberg라면 파티션 단위로 변경분만 refresh하지만, Delta Lake는 지원하지 않는다. **데이터 크기를 확인하고 MV/VIEW를 선택해야 한다.**

**2. MV refresh 타이밍은 upstream job에 맞춰야 한다.**
자동 주기 방식은 upstream job 완료 시점과 어긋날 수 있다. Job 완료 후 `REFRESH MATERIALIZED VIEW`를 직접 호출하는 방식이 데이터 정합성 면에서 안전하다.

**3. pymysql에서 DictCursor를 명시해야 한다.**
기본 커서는 tuple을 반환한다. `row.values()`를 쓰려면 `cursorclass=pymysql.cursors.DictCursor`를 지정해야 한다.

---

## 다음 단계

| Phase | 내용 |
|---|---|
| **0** | API 서버 배포, 배포 환경에서 StarRocks 연결 확인 |
| **1** | 복잡한 MV 추가 (멀티 테이블 JOIN, wide 컬럼 테이블) |
| **2** | 트래픽 전환 — dual-read(BQ + StarRocks 병렬 비교) 후 primary 전환 |
| **3** | 기존 파이프라인 정리 (BQ 데이터셋, dbt, reverse ETL, 중간 PostgreSQL 제거) |

실제로 Databricks의 모든 Delta Table에 **UniForm**을 적용해둔 상태다. UniForm은 Delta Lake 테이블에 Iceberg 호환 메타데이터를 자동 생성하는 기능이다. StarRocks에서 동일 테이블을 **Iceberg Catalog으로 연결**하면 파티션 incremental refresh가 가능해질 수 있다. 이것이 확인되면 MV/VIEW 이원 전략 대신 **MV 단일 전략으로 단순화**할 수 있고, 풀스캔 문제가 근본적으로 해결된다.

---

## Summary

- BigQuery 파이프라인의 비용 문제를 StarRocks BYOC + Databricks Delta Lake 조합으로 해결할 수 있다.
- Delta Lake MV는 incremental refresh를 지원하지 않으므로, 테이블 크기에 따라 MV(작은 테이블)와 VIEW + Data Cache(큰 테이블)를 구분해서 적용한다.
- MV refresh 타이밍은 자동 주기보다 upstream job 완료 시점에 수동 trigger하는 것이 안전하다.
- StarRocks의 MySQL 프로토콜 호환 덕분에 pymysql로 간단히 API 서버를 구축할 수 있다.

---

## References

- [StarRocks: Data Lake Query Acceleration with MVs](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/data_lake_query_acceleration_with_materialized_views/)
- [StarRocks: CREATE MATERIALIZED VIEW (v3.4)](https://docs.starrocks.io/docs/3.4/sql-reference/sql-statements/materialized_view/CREATE_MATERIALIZED_VIEW)
- [StarRocks: Delta Lake Catalog](https://docs.starrocks.io/docs/data_source/catalog/deltalake_catalog/)
- [StarRocks: Feature Support for Data Lake Analytics](https://docs.starrocks.io/docs/data_source/feature-support-data-lake-analytics/)
- [PyMySQL Documentation](https://pymysql.readthedocs.io/)
