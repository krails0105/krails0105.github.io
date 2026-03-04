---
layout: post
title: "[DataEngineering] 21개 OLAP 솔루션을 직접 검증한 Bitcoin 파이프라인 서빙 레이어 교체기"
categories:
  - DataEngineering
tags:
  - OLAP
  - ClickHouse
  - StarRocks
  - CelerData
  - Cube
  - Databricks
  - DeltaLake
  - DataArchitecture
  - Bitcoin
date: 2026-03-04
toc: true
toc_sticky: true
---

## 개요

Bitcoin on-chain 데이터 ETL 파이프라인의 서빙 레이어를 교체하기 위해 21개 OLAP 솔루션을 체계적으로 평가했습니다. 이 글은 그 과정에서 발견한 기술적 사실들, 잘못된 정보를 공식 문서로 바로잡은 경험, 그리고 최종 후보 3개(ClickHouse, CelerData/StarRocks, Cube)의 실질적인 트레이드오프를 정리합니다.

이 글을 읽고 나면 다음을 이해할 수 있습니다.

- Databricks Delta ETL 기반 파이프라인에서 BQ+PSQL 이중 서빙 구조의 근본적인 문제점
- 21개 솔루션을 4개 그룹으로 분류한 기준과 각 제외 사유
- ClickHouse Cloud, CelerData BYOC, Cube의 비용/성능/운영 트레이드오프
- "공식 문서로 직접 검증"의 중요성 -- 검증 과정에서 발견한 7개 오류

### 전제 조건

이 글은 다음 환경을 전제합니다. 동일한 아키텍처가 아니더라도 "ETL은 Lakehouse에서 하고, 서빙은 별도 레이어로 분리" 패턴을 검토하고 있다면 참고할 수 있습니다.

- **ETL**: Databricks Asset Bundles + PySpark. Bronze/Silver/Bitcoin 3-layer 구조
- **스토리지**: Delta Lake (Unity Catalog 관리, UniForm Iceberg 메타데이터 활성화 상태)
- **테이블 규모**: 약 50개 테이블, 최대 수십억 행 (UTXO 기반 테이블)
- **서빙 요구사항**: API 서빙 (100-300 QPS) + 분석가 ad-hoc 쿼리

---

## 1. AS-IS: 왜 교체가 필요한가

### 현재 아키텍처

```
S3 (raw block JSON)
  └── Databricks Delta ETL (Bronze → Silver → Bitcoin)
        ├── BigQuery 인제스트 → BQ API 서버 (분석가 ad-hoc)
        │     └── dbt 변환 → PostgreSQL 인제스트 (Reverse ETL)
        └── PostgreSQL 인제스트 → PSQL API 서버 (서비스 서빙)
```

데이터 소스는 Databricks Delta 하나지만, 서빙 경로가 두 갈래로 나뉘어 있습니다. 아래에서 이 구조가 만드는 세 가지 문제를 설명합니다.

### 문제 1: Reverse ETL

BQ에서 dbt로 만든 파생 지표를 PSQL API에도 서빙해야 하는 요구가 생겼습니다. 결과적으로 BQ에서 PSQL 방향으로 역방향 파이프라인이 추가됐습니다. 데이터 이동 경로가 늘어날수록 동기화 타이밍 불일치, 변환 오류의 파급, 파이프라인 유지보수 비용이 비례해서 증가합니다.

### 문제 2: 지표 출처 불명확

동일한 지표가 BQ에도 있고 PSQL에도 있는 상황에서, "이 숫자의 원천이 어디인가?"를 추적하기 어려워집니다. BQ 버전과 PSQL 버전이 미묘하게 다른 집계 로직을 가지게 되는 경우도 발생했습니다.

### 문제 3: 두 개의 API 서버 운영

BQ API와 PSQL API를 각각 운영합니다. 스키마 변경이 생기면 두 곳을 모두 수정해야 하며, 장애 포인트가 분산되어 있어 트러블슈팅이 복잡합니다.

### 목표 아키텍처

```
Databricks Delta (단일 소스)
  └── OLAP 엔진 (단일 서빙 레이어)
        ├── 분석가 ad-hoc 쿼리
        └── 서비스 API 서빙
```

Delta를 유일한 소스로 유지하면서, 그 위에 OLAP 엔진 하나로 분석과 서빙을 통합하는 것이 목표입니다. Reverse ETL을 제거하고, 지표 출처를 단일화하고, API 서버를 하나로 통합합니다.

---

## 2. 21개 솔루션 평가: 4개 그룹 분류

21개 솔루션을 평가 기준에 따라 4개 그룹으로 나누었습니다. 각 그룹은 "왜 탈락했는가"의 이유가 질적으로 다릅니다.

### 2-1. 연동 불가 또는 용도 불일치 (9개)

가장 먼저 제외할 수 있는 그룹입니다. Delta Lake 연동이 구조적으로 불가능하거나, 근본 설계 철학이 우리 파이프라인과 맞지 않는 솔루션들입니다.

| 솔루션 | 제외 사유 |
|--------|-----------|
| Apache Pinot | 스트리밍 실시간 OLAP 전용. 배치 ETL 파이프라인과 궁합이 나쁨 |
| Apache Druid | FE/MM/Historical/Broker 분리 아키텍처, 운영 복잡도 과도. v32에서 Iceberg 외부 쿼리가 추가됐지만 여전히 주 목적이 다름 |
| Materialize | CDC(Change Data Capture) 스트리밍 전용. S3 배치 소스에 부적합 |
| DuckDB | 인메모리 임베디드 DB. 서버 배포가 불가능 (MotherDuck은 읽기 확장이 가능하나 서빙 레이어로는 한계) |
| Trino | 자체 스토리지 없는 쿼리 엔진. 고빈도 API 서빙에 부적합 |
| Apache Kylin | OLAP 큐브 사전 정의 필요. ad-hoc 유연성 없음 |
| Greenplum | MPP PostgreSQL 포크. Delta 생태계 연동 미흡 |
| QuestDB | 시계열 특화 DB. 범용 OLAP 아님 |
| ByConity | Delta Lake 직접 연동 미지원 |

> **Delta Lake UniForm 참고**: Delta 테이블에 UniForm을 활성화하면 Iceberg 메타데이터가 자동 생성됩니다. Unity Catalog의 테이블 속성에 아래처럼 설정되어 있다면, Iceberg 표준만 지원하는 솔루션도 Delta 데이터를 읽을 수 있습니다.
>
> ```sql
> -- Delta 테이블 속성 (Unity Catalog)
> 'delta.enableIcebergCompatV2' = 'true'
> 'delta.universalFormat.enabledFormats' = 'iceberg'
> ```
>
> "Iceberg only"라는 이유만으로 솔루션을 제외하면 안 됩니다. UniForm이 활성화된 상태라면 Delta 데이터를 Iceberg 리더로 직접 읽을 수 있기 때문입니다.

### 2-2. 구조적 문제 미해결 (4개)

기술적으로 Delta에 연결할 수 있지만, 현재 문제(이중 서빙, Reverse ETL)를 근본적으로 해결하지 못하거나 다른 이유로 부적합한 솔루션들입니다.

| 솔루션 | 제외 사유 |
|--------|-----------|
| Redshift | BQ와 동일한 구조적 문제. 서빙 레이어 이원화 그대로 |
| Snowflake | Delta Sharing/UniForm으로 읽기 가능하지만, BQ와 동일하게 또 다른 분석 웨어하우스를 추가하는 구조 |
| Databricks SQL | 이미 사용 중인 Databricks 위에서 SQL 엔드포인트를 API 서빙에 쓰면 콜드스타트 + 비용 이슈 |
| Vertica | 매각 진행 중 (OpenText에서 분사). 장기적 지원 불확실 |

### 2-3. 후보 대비 열세 (4개)

기술적으로 타당하지만, 최종 후보 3개와 직접 비교했을 때 뚜렷한 차별점이 없는 솔루션들입니다.

| 솔루션 | 열세 이유 |
|--------|-----------|
| Apache Doris | StarRocks와 코드 기반이 같은 포크(2020년 분기). 기능 발전 속도와 생태계에서 StarRocks에 뒤처짐 |
| Firebolt | 처음에는 SaaS only로 알고 있었으나, Firebolt Core(self-hosted Docker, 무료)가 존재. dbt-firebolt도 있음. 그러나 레퍼런스 부족 |
| SingleStore | 유료 라이선스 모델. 비용 대비 StarRocks와 차별점 부족 |
| TigerData (Tiger Lake) | Iceberg CDC 지원하지만 레퍼런스 부족, 성숙도 미흡 |

### 2-4. 최종 후보 (3개)

위 17개를 제외한 뒤 남은 3개가 최종 후보입니다. 각각 다른 강점을 가지고 있습니다.

| 솔루션 | 핵심 강점 |
|--------|-----------|
| **ClickHouse Cloud** | 분석 쿼리 최강 성능, 매니지드, auto-pause로 최저 비용 가능 |
| **CelerData BYOC (StarRocks)** | JOIN/동시성 최강, MySQL 호환, Unity Catalog 직접 지원 |
| **Cube** | 최소 마이그레이션, API 서빙 특화(pre-aggregation), Databricks JDBC 직결 |

---

## 3. 최종 후보 3개 심층 분석

### 3-1. ClickHouse Cloud

#### Unity Catalog 연동 (DataLakeCatalog)

ClickHouse v25.8에서 DataLakeCatalog 엔진을 통한 Unity Catalog 연동이 Beta로 출시됐습니다. SQL 한 줄로 Unity Catalog의 Delta/Iceberg 테이블에 접근할 수 있습니다.

```sql
-- Unity Catalog 연결 (Delta 테이블)
CREATE DATABASE unity_delta
ENGINE = DataLakeCatalog('https://<workspace-id>.cloud.databricks.com/api/2.1/unity-catalog')
SETTINGS warehouse = '<CATALOG_NAME>',
         catalog_credential = '<PAT>',
         catalog_type = 'unity';

-- Unity Catalog 연결 (Iceberg REST 경유)
CREATE DATABASE unity_iceberg
ENGINE = DataLakeCatalog('https://<workspace-id>.cloud.databricks.com/api/2.1/unity-catalog/iceberg-rest')
SETTINGS catalog_type = 'rest',
         catalog_credential = '<client-id>:<client-secret>',
         warehouse = 'workspace',
         oauth_server_uri = 'https://<workspace-id>.cloud.databricks.com/oidc/v1/token',
         auth_scope = 'all-apis,sql';

-- 데이터 로컬 복제
INSERT INTO local_hits SELECT * FROM unity_delta.`uniform.delta_hits`;
```

단, 현재 Beta이므로 실험 설정이 필요합니다.

```sql
SET allow_experimental_database_unity_catalog = 1;
```

**INSERT 지원 현황**: INSERT INTO SELECT로 Unity Catalog 테이블의 데이터를 ClickHouse 로컬 테이블로 복제하는 것은 가능합니다. 반면, Delta Lake 테이블에 직접 쓰는 기능(카탈로그 메타데이터 업데이트)은 아직 개발 중입니다. Iceberg 테이블에 대한 카탈로그 메타데이터 업데이트는 v25.10에서 지원이 시작됐습니다. 따라서 현재는 Hot 데이터를 ClickHouse 로컬 테이블로 복제하는 패턴이 현실적입니다.

<!-- TODO: ClickHouse v25.10 Delta Lake INSERT 카탈로그 메타데이터 업데이트 지원 여부 재확인 필요 -->

#### 단건 PK 조회 한계

ClickHouse의 primary index는 sparse index 방식입니다. 기본 granule size가 8,192행이므로, PK 하나를 조회해도 최소 하나의 granule(최대 8,192행)을 스캔합니다. 응답 시간은 5-50ms 수준으로, PostgreSQL의 B-tree 인덱스(<1ms)와 비교하면 느립니다. 단건 조회가 많은 API 패턴에는 약점입니다.

#### CBO 부재

ClickHouse는 rule-based 옵티마이저를 사용합니다. 다중 테이블 복잡 JOIN에서는 쿼리 플랜이 최적화되지 않을 수 있으며, TPC-H 벤치마크 일부 케이스에서 이 한계가 드러납니다. 주로 분석 쿼리(집계, 시계열 스캔)에 강점이 있고, 복잡한 JOIN 쿼리에는 상대적으로 약합니다.

#### 비용

ClickHouse Cloud의 auto-pause 기능은 유휴 시간에 클러스터를 자동으로 중지시킵니다. 실제 사용 시간만 과금되어 3개 후보 중 가장 저렴한 옵션입니다.

- 예상 비용: **$520-820/월** (m6g.xlarge 상당, 500GB 스토리지, ~100-300 QPS 기준)

### 3-2. CelerData BYOC (StarRocks)

#### Unity Catalog 직접 지원

CelerData BYOC는 `hive.metastore.type = "unity"`로 Unity Catalog에 직접 연결합니다. Databricks의 Unity Catalog를 그대로 메타스토어로 사용할 수 있어, 추가 메타데이터 관리 없이 Delta 테이블에 접근합니다.

```sql
-- CelerData BYOC: Unity Catalog 직접 연결
CREATE EXTERNAL CATALOG deltalake_catalog_unity
PROPERTIES(
    "type" = "deltalake",
    "hive.metastore.type" = "unity",
    "databricks.host" = "https://<workspace-id>.cloud.databricks.com",
    "databricks.token" = "<personal_access_token>",
    "databricks.catalog.name" = "tech_lakehouse_prod"
);

-- 바로 쿼리 가능
SELECT * FROM deltalake_catalog_unity.bitcoin.indicator_block
WHERE block_height BETWEEN 938000 AND 938100;
```

#### OSS StarRocks vs CelerData BYOC -- 중요한 차이

처음에는 비용 절감을 위해 StarRocks OSS self-hosted를 검토했습니다. 그러나 분석 결과, **OSS StarRocks는 Unity Catalog를 직접 지원하지 않습니다**(Hive Metastore와 AWS Glue만 지원). Iceberg REST catalog 경유로 우회 접근은 가능하지만 읽기 전용이고, 스키마 구조 불일치(4-level vs 3-level) 등의 문제가 있습니다. 인프라 직접 운영 비용까지 고려하면 CelerData BYOC가 실질적으로 더 합리적입니다.

| 항목 | StarRocks OSS | CelerData BYOC |
|------|---------------|----------------|
| Unity Catalog | 미지원 (Iceberg REST 우회만 가능, 읽기 전용) | 직접 지원 (`hive.metastore.type = "unity"`) |
| 인프라 운영 | 직접 관리 (FE/BE/CN 노드) | BYOC 매니지드 |
| 비용 | 인프라 직접 운영 시 1.5-2x | 라이선스 포함 매니지드 |

#### CBO와 JOIN 성능

StarRocks는 Cost-Based Optimizer(CBO)를 갖추고 있어 다중 테이블 JOIN에서 최적 실행 계획을 자동으로 선택합니다. ClickHouse의 rule-based 옵티마이저 대비 복잡 JOIN에서 우위를 보입니다. Primary Key 모델은 sub-ms PK 조회를 지원하여 API 서빙에도 적합합니다.

#### Materialized View auto-refresh

비동기 MV(Materialized View)를 정의하면 기반 데이터 변경 시 자동 갱신됩니다. 쿼리 리라이트(query rewrite)도 지원하여, 원본 테이블에 쿼리를 날려도 옵티마이저가 자동으로 MV를 활용합니다. MySQL wire protocol 호환으로 기존 MySQL 클라이언트/드라이버를 그대로 사용할 수 있는 점도 장점입니다.

#### 비용

- 예상 비용: **$720-1,020/월** (Free tier에서 시작 가능)

### 3-3. Cube

#### 최소 마이그레이션

Cube는 별도 OLAP 엔진이 아니라, 기존 데이터 소스 위에 올라가는 시맨틱 레이어(Semantic Layer)입니다. Databricks에 JDBC로 직접 연결하므로 별도 인프라를 띄우거나 데이터를 복제할 필요가 없습니다. BQ 파이프라인을 건드리지 않고도 API 서빙 레이어를 추가할 수 있어 마이그레이션 리스크가 가장 낮습니다.

```bash
# Cube에서 Databricks JDBC 연결 설정
CUBEJS_DB_TYPE=databricks-jdbc
CUBEJS_DB_DATABRICKS_URL=jdbc:databricks://<workspace>.cloud.databricks.com:443/default;transportMode=http;ssl=1;httpPath=<warehouse-path>;AuthMech=3
CUBEJS_DB_DATABRICKS_TOKEN=<personal_access_token>
CUBEJS_DB_DATABRICKS_ACCEPT_POLICY=true
```

#### Cube Store pre-aggregation

API 서빙에 특화된 인메모리 캐시 레이어입니다. 자주 사용되는 집계 쿼리를 Cube Store에 pre-aggregation으로 저장하면 밀리초 단위 응답이 가능합니다. 패턴이 정해진 API 엔드포인트에는 매우 효과적입니다.

#### Query Pushdown (v0.35.40+)

Cube Core v0.35.40에서 Query Pushdown이 public preview로 도입됐습니다. 데이터 모델 범위 내에서 ad-hoc 쿼리를 지원하며, SQL API를 통해 복잡한 서브쿼리, 윈도우 함수, 상관 서브쿼리까지 데이터 소스에 직접 위임할 수 있습니다.

```bash
# Query Pushdown 활성화
CUBESQL_SQL_PUSH_DOWN=true
```

Cube의 SQL API는 Apache DataFusion을 쿼리 엔진으로 사용하며, 수신된 SQL을 분석해 regular query, post-processing, pushdown 중 최적 방식을 자동으로 선택합니다. 완전한 자유도는 아니지만, 분석가의 탐색적 쿼리 상당 부분을 커버할 수 있습니다.

#### 한계

- **Cache miss 시 Databricks 쿼리를 그대로 실행**합니다. Databricks serverless 비용이 유지되며, cold query 응답 시간이 느릴 수 있습니다.
- **자체 DSL**(Data Model 정의)을 새로 학습해야 합니다. 약 50개 테이블에 대한 모델 정의 작업이 초기 비용으로 발생합니다.
- **ad-hoc 한계**: Query Pushdown이 있지만, 데이터 모델 밖의 임의 SQL은 실행할 수 없습니다.

#### 비용

- 예상 비용: **$580-800/월** + Databricks 비용 (별도)

---

## 4. 비용/성능/운영 종합 비교

| 항목 | ClickHouse Cloud | CelerData BYOC | Cube |
|------|-----------------|----------------|------|
| **예상 비용** | $520-820/월 | $720-1,020/월 | $580-800/월 + Databricks |
| **Unity Catalog 연동** | Beta v25.8 (DataLakeCatalog) | GA (`hive.metastore.type = "unity"`) | JDBC (Databricks 경유) |
| **단건 PK 조회** | 5-50ms (sparse index 한계) | sub-ms (Primary Key 모델) | Databricks 의존 |
| **다중 JOIN** | Rule-based (약점) | CBO (강점) | Databricks 위임 |
| **API 서빙 동시성** | 높음 | 높음 | Cube Store 캐시 의존 |
| **DA ad-hoc** | 가능 (full SQL) | 가능 (full SQL) | Query Pushdown 부분 가능 |
| **운영 복잡도** | 낮음 (매니지드) | 중간 (BYOC) | 낮음 (레이어 추가) |
| **마이그레이션 범위** | 중간 (Hot 데이터 로컬 복제) | 중간 (카탈로그 연결 + MV 정의) | 최소 (BQ 유지 가능) |

### TO-BE 옵션별 구조

**Option A: ClickHouse Cloud** -- DA ad-hoc + API 통합, 최저 비용

```
Databricks Delta
  └── ClickHouse Cloud (Hot 데이터 로컬 복제)
        ├── DA ad-hoc 쿼리 (full SQL)
        └── API 서빙 (auto-pause로 비용 최적화)
```

**Option B: CelerData BYOC** -- JOIN 중심, UC 직접 연결

```
Databricks Delta (Unity Catalog)
  └── CelerData BYOC (UC 직접 연결, 데이터 이동 불필요)
        ├── MV auto-refresh (Delta 변경 시 자동 갱신)
        ├── DA ad-hoc (CBO 기반 복잡 JOIN)
        └── MySQL 호환 API 서빙
```

**Option C: Cube** -- 최소 변경, BQ DA 유지

```
Databricks Delta
  └── Cube (JDBC 직결)
        └── API 서빙 (pre-aggregation + Cube Store 캐시)
BQ → DA ad-hoc (기존 유지)
```

**Option D: ClickHouse + Cube** -- 장기 풀스택 (단계적 전환)

```
Databricks Delta
  └── ClickHouse (OLAP 엔진, 분석 + 스토리지)
        └── Cube (API 레이어, pre-aggregation + 캐시)
```

---

## 5. 검증 과정에서 발견한 7개 오류

이번 평가에서 가장 중요한 교훈은 **"직접 공식 문서를 확인하기 전까지는 아무것도 확실하지 않다"** 는 점이었습니다. LLM이 제공한 정보, 블로그 글, 오래된 공식 문서에 의존하면 잘못된 판단으로 이어질 수 있습니다.

검증 과정에서 수정한 7개 오류를 공유합니다.

| # | 처음 알고 있던 내용 | 공식 문서 검증 후 실제 |
|---|----|----|
| 1 | Firebolt는 SaaS only, self-hosted 없음 | [Firebolt Core](https://docs.firebolt.io/firebolt-core/) (self-hosted Docker, 무료) 존재. dbt-firebolt도 제공 |
| 2 | Cube는 DA ad-hoc 쿼리 불가 | [v0.35.40+의 Query Pushdown](https://cube.dev/blog/query-push-down-in-cubes-semantic-layer)으로 데이터 모델 범위 내 ad-hoc 부분 가능 |
| 3 | ClickHouse에서 Delta INSERT가 불가능 | [v25.10+에서 Iceberg 테이블에 대한 카탈로그 메타데이터 업데이트 지원 시작](https://clickhouse.com/blog/clickhouse-2025-roundup). Delta Lake는 아직 개발 중 |
| 4 | DuckDB는 단일 인스턴스, 확장 불가 | MotherDuck(클라우드 버전)으로 읽기 복제본 확장 가능 |
| 5 | TimescaleDB가 Iceberg CDC 지원 | 실제로는 TigerData(Tiger Lake)가 해당 솔루션 (별개 제품) |
| 6 | Apache Druid에서 Iceberg 외부 쿼리 불가 | v32+에서 인제스트 없이 Iceberg 테이블 외부 쿼리 가능 |
| 7 | Snowflake Delta Direct가 Preview 상태 | 이미 GA (일반 제공) 완료 |

이 오류들 중 일부는 솔루션 제외/포함 결론을 바꿀 수 있는 수준이었습니다. 예를 들어 Firebolt Core의 self-hosted 옵션을 처음부터 알았다면 비용 모델 평가 기준이 달라졌을 것입니다. 3번 오류는 원래 "Delta INSERT가 전혀 안 됨"이라고 알고 있었는데, 실제로는 Iceberg 쪽에서 먼저 지원이 시작된 상태였습니다.

**검증 원칙**: 솔루션을 제외하는 근거가 될 때는 반드시 공식 문서에서 직접 확인합니다. 특히 빠르게 변화하는 OLAP 생태계에서는 6개월 전 정보가 이미 구식일 수 있습니다.

---

## 6. 선택 가이드

팀 상황에 따라 최적 선택이 달라지지만, 다음 기준이 판단에 도움이 됩니다.

**ClickHouse Cloud를 선택할 때**
- 분석 쿼리(집계, 시계열 스캔)가 워크로드의 주를 이루고 단건 PK 조회가 적은 경우
- 매니지드 서비스로 운영 부담을 최소화하고 싶은 경우
- 비용을 최우선으로 고려하는 경우 (auto-pause 활용)
- 이미 ClickHouse 경험이 있는 팀

**CelerData BYOC를 선택할 때**
- Databricks Unity Catalog와 긴밀하게 연동해야 하는 경우
- 다중 테이블 복잡 JOIN이 많은 워크로드 (CBO 필요)
- MySQL 호환이 중요한 경우 (기존 도구/드라이버 재사용)
- 단건 PK 조회 성능이 API SLA에 영향을 주는 경우

**Cube를 선택할 때**
- 마이그레이션 리스크를 최소화하고 싶은 경우 (기존 BQ 파이프라인 유지)
- API 서빙에 특화된 캐시 레이어가 필요한 경우
- Databricks 비용이 이미 고정되어 있거나 서버리스 예산이 있는 경우
- 시맨틱 레이어를 통한 지표 거버넌스가 필요한 경우

---

## 7. 정리 및 핵심 교훈

이 평가의 핵심 교훈을 세 가지로 요약합니다.

**1. 문제를 정확히 정의해야 솔루션이 보인다.** "OLAP 엔진 교체"가 아니라 "Reverse ETL과 이중 서빙 레이어 제거"로 문제를 정의하면 평가 기준이 명확해집니다. 이 기준 하에서 Redshift와 Snowflake는 문제를 해결하지 못하는 솔루션으로 즉시 분류됩니다.

**2. StarRocks OSS self-hosted는 CelerData BYOC의 대안이 아니다.** 비용 절감 목적으로 OSS를 선택하면 Unity Catalog 연동이 빠지고(Hive/Glue만 지원), 인프라 직접 운영 비용이 오히려 높아집니다. Unity Catalog 연동이 필요한 환경에서는 CelerData BYOC가 실질적으로 더 합리적입니다.

**3. 공식 문서 직접 검증은 선택이 아닌 필수다.** 21개 솔루션 중 7개에서 잘못된 정보가 발견됐습니다. OLAP 생태계는 빠르게 변화하므로, 제외 결정의 근거가 되는 정보는 반드시 최신 공식 문서에서 확인해야 합니다. LLM 답변, 블로그 포스트, 6개월 전 문서는 충분하지 않습니다.

---

## References

**OLAP 솔루션 공식 문서**
- [ClickHouse - Unity Catalog 연동 가이드](https://clickhouse.com/docs/use-cases/data-lake/unity-catalog)
- [ClickHouse - DataLakeCatalog 엔진 소개 (Blog)](https://clickhouse.com/blog/query-your-catalog-clickhouse-cloud)
- [CelerData BYOC - Delta Lake Catalog (Unity Catalog 설정 포함)](https://docs.celerdata.com/BYOC/docs/data_source/catalog/deltalake_catalog/)
- [StarRocks - Unified Catalog](https://docs.starrocks.io/docs/data_source/catalog/unified_catalog/)
- [Cube - Databricks JDBC 연결](https://cube.dev/docs/product/configuration/data-sources/databricks-jdbc)
- [Cube - SQL API Query Pushdown](https://cube.dev/docs/product/apis-integrations/sql-api/query-format)
- [Firebolt Core (self-hosted)](https://docs.firebolt.io/firebolt-core/)

**Delta Lake / Databricks**
- [Delta Lake UniForm (Iceberg 호환)](https://docs.delta.io/latest/delta-uniform.html)

**프로젝트 내부 참고**
- 파이프라인 정의: `tech-databricks-workflow/resources/*.yml`
- 아키텍처 문서: `tech-databricks-workflow/CLAUDE.md`
