---
title: "StarRocks + Databricks UniForm: Iceberg Catalog으로 Incremental MV가 가능할까?"
date: 2026-03-29
categories:
  - DataEngineering
tags:
  - StarRocks
  - Iceberg
  - UniForm
  - DeltaLake
  - MaterializedView
  - Databricks
  - IncrementalRefresh
---

## Introduction

이전 포스트에서 StarRocks의 Delta Lake External Table 기반 Materialized View(MV)가 파티션 incremental refresh를 지원하지 않는다는 한계를 확인했다. 이번 글에서는 **Databricks UniForm**을 활용해 같은 Delta Table을 Iceberg로 접근하면 incremental refresh가 가능한지 검증한다.

결론부터 말하면, Iceberg Catalog 연결과 파티션 MV 생성에는 성공했지만 **진정한 incremental refresh는 실패**했다. 그 원인은 UniForm의 메타데이터 재생성 방식에 있었다. 이 글에서는 실패 원인 분석과 현실적인 대안까지 정리한다.

### 이 글에서 다루는 내용

- Databricks UniForm을 통한 Iceberg REST Catalog 연결 설정
- Iceberg 기반 파티션 Materialized View 생성
- Incremental refresh 실패 원인 분석 (UniForm의 메타데이터 재생성 한계)
- `partition_refresh_number` 튜닝을 통한 풀스캔 최적화
- Delta Lake MV vs Iceberg MV 비교 및 현실적 전략

### 사전 요구사항

- StarRocks 3.3 이상 (Iceberg REST Catalog 지원, `partition_refresh_number` 기본값 변경)
- Databricks Workspace (Unity Catalog 활성화, UniForm 지원)
- Delta Table에 UniForm(Iceberg) 활성화 완료

---

## 배경: Delta Lake MV의 한계

StarRocks에서 Delta Lake External Table을 기반으로 MV를 만들면 `PARTITION BY` 절 자체가 에러로 거부된다.

```
Materialized view with partition does not support base table type : DELTALAKE
```

MV를 생성하더라도 파티션이 `UNPARTITIONED` 상태가 되고, refresh 시 항상 풀스캔이 발생한다. 데이터가 수억 row 규모라면 1시간마다 풀스캔은 현실적으로 불가능하다.

### UniForm이란?

Databricks UniForm은 동일한 Delta Table 파일에 **Iceberg 메타데이터를 병행 관리**하는 기능이다. Delta Lake로 쓰면서 Iceberg REST API로도 읽을 수 있어, Iceberg를 지원하는 쿼리 엔진에서 기존 Delta 테이블을 그대로 바라볼 수 있다.

StarRocks는 Iceberg Catalog에 대해 파티션 incremental refresh를 공식 지원하므로, UniForm을 거치면 incremental이 가능할 것이라는 가설을 세웠다.

---

## Iceberg REST Catalog 연결

### 엔드포인트 변경 주의

Databricks Unity Catalog의 Iceberg REST API 엔드포인트는 구 버전과 신 버전이 다르다.

| 버전 | 엔드포인트 |
|------|-----------|
| 구 (deprecated) | `/iceberg/v1/` |
| 신 (현재 권장) | `/api/2.1/unity-catalog/iceberg-rest` |

구 엔드포인트로 연결하면 인증은 통과해도 카탈로그 조회 단계에서 실패하므로 반드시 신 엔드포인트를 사용해야 한다. 또한 Workspace URL에는 반드시 **Workspace ID**가 포함되어야 한다. Workspace ID가 누락되면 API 요청 시 `303 See Other` 리다이렉트가 발생할 수 있다.

### StarRocks Catalog 설정

```sql
-- StarRocks에서 Databricks Iceberg Catalog 등록
CREATE EXTERNAL CATALOG iceberg_uc
PROPERTIES (
  "type" = "iceberg",
  "iceberg.catalog.type" = "rest",
  "iceberg.catalog.uri" = "https://<databricks-workspace-host>/api/2.1/unity-catalog/iceberg-rest",
  "iceberg.catalog.security" = "oauth2",
  "iceberg.catalog.oauth2.token" = "<personal-access-token>",
  -- vended-credentials: Databricks가 스토리지 접근용 임시 자격증명을 발급
  -- v3.5 기준 기본값이 true이지만 명시적으로 설정하는 것을 권장
  "iceberg.catalog.vended-credentials-enabled" = "true",
  -- Unity Catalog의 View 엔드포인트 비활성화 (일부 Iceberg 클라이언트 호환성 이슈 방지)
  "iceberg.catalog.view-endpoints-supported" = "false"
);
```

**핵심 설정 해설:**

- **`iceberg.catalog.security = "oauth2"`**: 인증 방식을 OAuth2로 지정한다. `oauth2.token`(PAT 직접 지정) 또는 `oauth2.credential`(client_id:client_secret 형식) 중 하나를 사용할 수 있다.
- **`vended-credentials-enabled = "true"`**: Databricks가 S3/GCS 등 스토리지 접근을 위한 임시 자격증명(credential vending)을 발급해 준다. StarRocks v3.5 기준 기본값이 `true`이지만, 의도를 명확히 하기 위해 명시적으로 설정하는 것이 좋다.
- **`view-endpoints-supported = "false"`**: Unity Catalog의 View 엔드포인트를 비활성화한다. 이 설정이 없으면 일부 Iceberg 클라이언트에서 에러가 발생할 수 있다.

---

## 파티션 Materialized View 생성

### Delta Lake vs Iceberg Catalog 비교

```sql
-- Delta Lake Catalog 기반 MV (파티션 불가)
CREATE MATERIALIZED VIEW mv_network_hour
PARTITION BY _partition_date   -- ERROR: DELTALAKE 파티션 미지원
REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
AS
SELECT ...
FROM delta_catalog.schema.network_hour;

-- Iceberg Catalog 기반 MV (파티션 성공!)
CREATE MATERIALIZED VIEW mv_network_hour_ice
PARTITION BY _partition_date
REFRESH ASYNC EVERY(INTERVAL 1 HOUR)
AS
SELECT ...
FROM iceberg_uc.schema.network_hour;
```

Iceberg Catalog 기반 MV를 생성하면 `partition_type`이 `RANGE`로 설정되는 것을 확인할 수 있다.

```sql
SHOW MATERIALIZED VIEWS LIKE 'mv_network_hour_ice'\G

-- partition_type: RANGE  <-- Delta Lake에서는 UNPARTITIONED였음
```

파티션 MV 생성 자체는 성공이다. 여기까지만 보면 incremental refresh가 가능할 것 같지만, 실제 refresh 단계에서 문제가 드러난다.

---

## Incremental Refresh 실패 원인

### 증상

첫 번째 refresh(초기 로드) 후 두 번째 refresh를 실행했을 때, 로그에서 `refBasePartitionsToRefreshMap`에 **전체 6,290개 파티션**이 찍혔다. Incremental이 아니라 사실상 풀 refresh였다.

```
# 두 번째 refresh 로그
Partitions to refresh: 6290 / 6290
refBasePartitionsToRefreshMap: {_partition_date=[2023-01-01, 2023-01-02, ..., 2024-12-31]}
```

### 원인: UniForm의 메타데이터 재생성 방식

Delta Lake로 데이터를 write할 때마다 UniForm은 **Iceberg 메타데이터 전체를 재생성**한다. Iceberg 관점에서는 모든 파일의 snapshot이 교체된 것처럼 보이므로, StarRocks는 어느 파티션이 실제로 변경되었는지 구분하지 못하고 전체를 "변경됨"으로 처리한다.

이것이 핵심이다. UniForm은 Delta의 변경분만 Iceberg 메타데이터에 반영하는 것이 아니라, 전체 Iceberg 메타데이터를 새로 생성한다. 따라서 **진정한 incremental refresh는 Iceberg 네이티브 테이블(Iceberg로 직접 write)이어야 가능**하다.

### REFRESH MATERIALIZED VIEW로 수동 확인

특정 파티션 범위만 수동으로 refresh할 수도 있다. 이 명령은 ASYNC 또는 MANUAL refresh 전략이 설정된 MV에서 사용 가능하다.

```sql
-- 특정 파티션 범위만 수동 refresh
REFRESH MATERIALIZED VIEW mv_network_hour_ice
PARTITION START ("2024-12-01") END ("2024-12-31");

-- 데이터 변경 여부와 무관하게 강제 refresh
REFRESH MATERIALIZED VIEW mv_network_hour_ice
PARTITION START ("2024-12-01") END ("2024-12-31") FORCE;

-- 동기 모드로 실행 (완료까지 대기, v2.5.8+ / v3.1.0+)
REFRESH MATERIALIZED VIEW mv_network_hour_ice WITH SYNC MODE;
```

그러나 UniForm 환경에서는 `FORCE` 없이 실행해도 모든 파티션이 "변경됨"으로 감지되므로, 자동 refresh에서 incremental 효과를 기대할 수 없다.

---

## partition_refresh_number 튜닝

어차피 풀 refresh가 발생한다면, 한 번의 refresh task에서 처리하는 파티션 수를 조정하는 `partition_refresh_number` 튜닝이 중요해진다.

StarRocks v3.3부터 `partition_refresh_number`의 기본값이 `1`로 변경되었다 (이전 버전에서는 `-1`). 이 값은 한 번의 refresh task에서 처리할 최대 파티션 수를 지정하며, 초과하면 배치로 나누어 순차 처리한다.

| 설정값 | 동작 | 소요 시간 (6,290 파티션 기준) |
|--------|------|------------------------------|
| `1` (v3.3+ 기본값) | 파티션 1개씩 순차 처리 | 약 7시간 |
| `100` | 100개씩 배치 처리 | 약 20분 |
| `-1` | 전체 한 번에 처리 (배치 분할 없음) | 약 9분 |

```sql
-- 100개씩 배치 처리로 변경
ALTER MATERIALIZED VIEW mv_network_hour_ice
SET ("partition_refresh_number" = "100");
```

> **주의**: `-1`(전체 한 번에 처리)은 가장 빠르지만 메모리 압박이 생길 수 있다. 파티션 수와 데이터 규모에 따라 적절한 값을 선택해야 한다. 또한 배치 처리 중 하나의 파티션이 실패하면 이후 배치는 실행되지 않으므로, 에러 모니터링이 필요하다.

---

## 풀스캔 Refresh 실측 성능

Incremental이 불가능하다는 것을 확인했으니, 현실적인 풀스캔 비용을 측정했다.

| 테이블 | Row 수 | 풀스캔 Refresh 시간 |
|--------|--------|-------------------|
| network_hour | 약 15만 rows | 20초 |

1시간마다 20초 풀스캔은 충분히 감당 가능한 수준이다. Metric 집계 레이어(수십만 row 규모)에서는 StarRocks MV 풀스캔 전략이 실용적이다.

---

## 최종 결론: Trade-off 분석

| 관점 | BQ + dbt (incremental) | StarRocks MV (풀스캔) |
|------|----------------------|----------------------|
| 효율/확장성 | 우수 (변경분만 처리) | 데이터 증가 시 비례 증가 |
| 비용 | BQ 쿼리 비용 발생 | 없음 (BYOC 고정 비용) |
| 파이프라인 복잡도 | dbt 모델 관리 필요 | MV 정의만으로 완결 |
| raw 레이어 적용 | 가능 | 수억 rows 규모에서는 풀스캔 비현실적 |

**현재 전략:**

- **metric 레이어** (수십만 rows): StarRocks MV 풀스캔 유지 -- 실용적
- **raw 레이어** (수억 rows): 별도 방안 필요 (네이티브 Iceberg 도입 또는 BQ + dbt 유지)

UniForm을 통한 incremental은 현재 구조에서는 불가능하다는 것이 검증됐다. 만약 진정한 incremental이 필요하다면, Delta Lake 대신 **Iceberg 네이티브 테이블**로의 전환을 고려해야 한다.

### 핵심 요약

1. Databricks UniForm을 통해 Delta Table을 Iceberg REST Catalog으로 연결하는 것 자체는 가능하다.
2. Iceberg Catalog 기반 MV에서는 `PARTITION BY`가 정상 동작하여, 파티션 MV 생성까지는 성공한다.
3. 그러나 UniForm은 Delta write 시 Iceberg 메타데이터 전체를 재생성하므로, StarRocks가 변경된 파티션을 식별할 수 없어 **사실상 풀 refresh**가 된다.
4. 풀 refresh 환경에서는 `partition_refresh_number` 튜닝(기본값 `1` -> `100` 또는 `-1`)으로 성능을 크게 개선할 수 있다.
5. Metric 집계 레이어(수십만 row)에서는 풀스캔 MV가 실용적이며, raw 레이어(수억 row)에서는 네이티브 Iceberg 또는 BQ + dbt가 필요하다.

---

## 다음 단계

- raw 레이어 대용량 테이블에 대한 refresh 전략 설계
- 네이티브 Iceberg 테이블 도입 가능성 검토 (Delta 마이그레이션 비용 대비 효과)
- StarRocks BYOC 비용 vs BQ + dbt 비용 정량적 비교

---

## Reference

- 이전 포스트: [StarRocks Delta Lake MV의 한계](_posts/DataEngineering/2026-03-29-starrocks-delta-lake-mv-limitations.md)
- [StarRocks Iceberg Catalog 공식 문서](https://docs.starrocks.io/docs/data_source/catalog/iceberg/iceberg_catalog/)
- [StarRocks Partitioned Materialized View 가이드](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/create_partitioned_materialized_view/)
- [StarRocks REFRESH MATERIALIZED VIEW 레퍼런스](https://docs.starrocks.io/docs/sql-reference/sql-statements/materialized_view/REFRESH_MATERIALIZED_VIEW/)
- [Databricks UniForm 공식 문서](https://docs.databricks.com/en/delta/uniform.html)
- [Databricks Unity Catalog Iceberg REST API](https://docs.databricks.com/aws/en/external-access/iceberg)
