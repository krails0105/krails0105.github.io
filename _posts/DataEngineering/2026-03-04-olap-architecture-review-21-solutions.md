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

Bitcoin on-chain 데이터 ETL 파이프라인의 서빙 레이어를 교체하는 과정에서 21개 OLAP 솔루션을 체계적으로 평가했습니다. 이 글은 그 과정에서 발견한 기술적 사실들, 잘못된 정보를 공식 문서로 바로잡은 경험, 그리고 최종 후보 3개(ClickHouse, CelerData/StarRocks, Cube)의 실질적인 트레이드오프를 정리합니다.

이 글을 읽고 나면 다음을 이해할 수 있습니다.

- Databricks Delta ETL 기반 파이프라인에서 BQ+PSQL 이중 서빙 구조의 근본적인 문제점
- 21개 솔루션을 4개 그룹으로 분류한 기준과 각 제외 사유
- ClickHouse Cloud, CelerData BYOC, Cube의 비용/성능/운영 트레이드오프
- "공식 문서로 직접 검증"의 중요성: 검증 과정에서 발견한 7개 오류

---

## 1. AS-IS: 왜 교체가 필요한가

### 현재 아키텍처

```
S3 (raw block data)
  └── Databricks Delta ETL (Bronze → Silver → Bitcoin)
        ├── BigQuery 인제스트 → BQ API 서버 (분석가 ad-hoc)
        │     └── dbt 변환 → PostgreSQL 인제스트 (Reverse ETL)
        └── PostgreSQL 인제스트 → PSQL API 서버 (서비스 서빙)
```

데이터 소스는 Databricks Delta 하나지만, 서빙 경로가 두 갈래로 나뉩니다.

### 문제 1: Reverse ETL

BQ에서 dbt로 만든 파생 지표를 PSQL API에도 서빙해야 하는 요구가 생겼습니다. 결과적으로 BQ → PSQL 방향의 역방향 파이프라인이 추가됐습니다. 데이터 이동 경로가 늘어날수록 동기화 타이밍 불일치, 변환 오류의 파급, 파이프라인 유지보수 비용이 비례해서 증가합니다.

### 문제 2: 지표 출처 불명확

동일한 지표가 BQ에도 있고 PSQL에도 있는 상황에서, "이 숫자의 원천이 어디인가?"를 추적하기 어려워집니다. BQ 버전과 PSQL 버전이 미묘하게 다른 집계 로직을 가지게 되는 상황도 발생합니다.

### 문제 3: 두 개의 API 서버

BQ API와 PSQL API를 각각 운영합니다. 스키마 변경이 생기면 두 곳을 모두 수정해야 합니다.

### 목표

```
Databricks Delta (단일 소스)
  └── OLAP 엔진 (단일 서빙 레이어)
        ├── 분석가 ad-hoc 쿼리
        └── 서비스 API 서빙
```

Delta를 유일한 소스로 유지하고, 그 위에 OLAP 엔진 하나로 분석과 서빙을 통합하는 것이 목표입니다.

---

## 2. 21개 솔루션 평가: 4개 그룹 분류

### 2-1. 연동 불가 / 용도 불일치 (9개)

가장 먼저 제외할 수 있는 그룹입니다. Delta Lake 연동이 구조적으로 불가능하거나, 근본 설계 철학이 맞지 않는 솔루션들입니다.

| 솔루션 | 제외 사유 |
|--------|-----------|
| Apache Pinot | 스트리밍 실시간 OLAP 전용. 배치 ETL 파이프라인과 궁합이 나쁨 |
| Apache Druid | FE/MM/Historical/Broker 분리 아키텍처, 운영 복잡도 과도. v32에서 Iceberg 외부 쿼리 추가됐지만 여전히 주 목적이 아님 |
| Materialize | CDC(Change Data Capture) 전용. S3 배치 소스에 부적합 |
| DuckDB | 인메모리 임베디드 DB. 서버 배포 불가 (MotherDuck은 읽기 확장 가능하나 서빙 레이어로는 한계) |
| Trino | 자체 스토리지 없는 쿼리 엔진. 고빈도 API 서빙에 부적합 |
| Apache Kylin | OLAP 큐브 사전 정의 필요. ad-hoc 유연성 없음 |
| Greenplum | MPP PostgreSQL 포크. Delta 생태계 연동 미흡 |
| QuestDB | 시계열 특화. 범용 OLAP 아님 |
| ByConity | Delta Lake 직접 연동 미지원 |

> **Delta Lake UniForm 참고**: Delta 테이블에 UniForm을 활성화하면 Iceberg 메타데이터가 자동 생성됩니다. "Iceberg only"라는 이유만으로 솔루션을 제외하는 것은 잘못된 판단입니다. Unity Catalog의 테이블 속성에 `enableIcebergCompatV2=true`와 `universalFormat.enabledFormats='iceberg'`가 이미 설정된 상태라면, Iceberg 표준만 지원하는 솔루션도 Delta 데이터를 읽을 수 있습니다.

### 2-2. 구조적 문제 미해결 (4개)

현재 문제(이중 서빙, Reverse ETL)를 그대로 안고 가거나, 다른 이유로 부적합한 솔루션들입니다.

| 솔루션 | 제외 사유 |
|--------|-----------|
| Redshift | BQ와 동일한 구조. 서빙 레이어 이원화 문제 그대로 |
| Snowflake | Delta Direct가 GA됐지만 BQ와 동일 문제. Snowflake + BQ = 또 다른 이중화 |
| Databricks SQL | 이미 사용 중. Databricks를 API 서빙 레이어로 쓰면 콜드스타트 + 비용 이슈 |
| Vertica | 매각 진행 중 (OpenText → Veritas 이관). 장기적 지원 불확실 |

### 2-3. 후보 대비 열세 (4개)

기술적으로 타당하지만 최종 후보들과 비교했을 때 뚜렷한 우위가 없는 솔루션들입니다.

| 솔루션 | 열세 이유 |
|--------|-----------|
| Apache Doris | StarRocks의 전신. 기능/성능/생태계 모두 StarRocks에 뒤처짐 |
| Firebolt | SaaS only + 높은 비용. (단, Firebolt Core는 self-hosted Docker + 무료 제공, dbt-firebolt도 존재 — 처음엔 SaaS only로 잘못 알고 있었다가 검증에서 수정) |
| SingleStore | 유료 라이선스 모델. 비용 대비 StarRocks와 차별점 부족 |
| TigerData (Tiger Lake) | Iceberg CDC 지원하지만 레퍼런스 부족, 성숙도 미흡 |

### 2-4. 최종 후보 (3개)

| 솔루션 | 핵심 강점 |
|--------|-----------|
| **ClickHouse Cloud** | 분석 쿼리 최강, 매니지드, auto-pause로 최저 비용 |
| **CelerData BYOC (StarRocks)** | JOIN/동시성 최강, MySQL 호환, Unity Catalog 직접 지원 |
| **Cube** | 최소 마이그레이션, API 서빙 특화, Databricks JDBC 직결 |

---

## 3. 최종 후보 3개 심층 분석

### 3-1. ClickHouse Cloud

**Unity Catalog 연동**: DataLakeCatalog로 Unity Catalog에 직접 연결하는 기능이 v25.8+에서 Beta로 출시됐습니다. 단, INSERT는 v25.10+에서 실험적(experimental) 지원 상태로, 현재는 읽기 전용으로 봐야 합니다. Hot 데이터(API 서빙 대상)는 로컬 복제가 필요하며, Delta federated 쿼리는 네이티브 테이블 대비 2-15x 느립니다.

**단건 PK 조회 한계**: ClickHouse의 primary index는 sparse index 방식입니다. 기본 granule size가 8,192행이므로, PK 하나를 조회해도 최대 8,192행을 스캔합니다. 응답 시간은 5-50ms 수준으로, PostgreSQL의 B-tree 인덱스(<1ms)와 비교하면 10-50배 느립니다. 단건 조회가 많은 API 패턴에는 약점입니다.

**CBO 부재**: ClickHouse는 rule-based 옵티마이저를 사용합니다. 다중 테이블 복잡 JOIN에서 TPC-H 벤치마크 일부 케이스를 완료하지 못합니다. 우리 파이프라인의 약 50개 테이블을 복잡하게 JOIN하는 쿼리가 있다면 유의해야 합니다.

**비용**: ClickHouse Cloud의 auto-pause 기능은 유휴 시간에 클러스터를 자동으로 중지시킵니다. 24시간 풀 가동이 아닌 실제 사용 시간만 과금되어, 3개 후보 중 가장 저렴한 옵션입니다.

- 예상 비용: $520-820/월 (m6g.xlarge 상당, 500GB 스토리지, ~100-300 QPS 기준)

### 3-2. CelerData BYOC (StarRocks)

**Unity Catalog 직접 지원**: CelerData BYOC는 `hive.metastore.type = "unity"`로 Unity Catalog에 직접 연결합니다. Databricks 외부 카탈로그를 그대로 쓸 수 있어, 추가 메타데이터 관리 없이 Delta 테이블에 접근할 수 있습니다.

**OSS StarRocks vs CelerData BYOC — 중요한 발견**: 처음에는 비용 절감을 위해 StarRocks OSS self-hosted를 검토했습니다. 그러나 분석 결과, OSS self-hosted는 Unity Catalog를 지원하지 않고(Glue/Hive만), 인프라 직접 운영 비용이 CelerData BYOC 대비 1.5-2x 높습니다. Unity Catalog 연동이 필요한 환경에서 OSS self-hosted를 선택할 이유가 없습니다.

**CBO와 JOIN 성능**: StarRocks는 Cost-Based Optimizer(CBO)를 갖추고 있어 다중 테이블 JOIN에서 ClickHouse 대비 3-5x 우수한 성능을 보입니다. Primary Key 모델은 sub-ms PK 조회를 지원합니다.

**MV auto-refresh + query rewrite**: Async MV를 정의하면 기반 데이터 변경 시 자동 갱신되고, 원본 쿼리도 자동으로 MV를 활용하도록 재작성됩니다. MySQL wire protocol 호환으로 기존 MySQL 클라이언트/드라이버를 그대로 사용할 수 있습니다.

- 예상 비용: $720-1,020/월 (Free tier에서 시작 가능)

### 3-3. Cube

**최소 마이그레이션**: Cube는 Databricks에 JDBC로 직접 연결합니다. 별도 OLAP 엔진을 띄울 필요 없이, 현재 Databricks Delta 위에 Cube를 올리면 됩니다. BQ 파이프라인을 건드리지 않고도 API 서빙 레이어를 추가할 수 있어 마이그레이션 리스크가 가장 낮습니다.

**Cube Store pre-aggregation**: API 서빙에 특화된 인메모리 캐시 레이어입니다. 자주 쓰는 집계 쿼리는 Cube Store에 pre-aggregate로 저장해 밀리초 단위 응답이 가능합니다.

**Query Pushdown (v0.35.40+)**: 데이터 모델 범위 내에서 ad-hoc 쿼리도 지원합니다. 완전한 자유도는 아니지만, 분석가의 탐색적 쿼리 상당 부분을 커버할 수 있습니다.

**한계**: cache miss 시 Databricks 쿼리를 그대로 실행합니다. Databricks serverless 비용이 유지되며, cold query 응답 시간이 느릴 수 있습니다. 자체 DSL(Data Model 정의)을 새로 학습해야 합니다.

- 예상 비용: $580-800/월 + Databricks 비용 (별도)

---

## 4. 비용/성능/운영 종합 비교

| 항목 | ClickHouse Cloud | CelerData BYOC | Cube |
|------|-----------------|----------------|------|
| 예상 비용 | $520-820/월 | $720-1,020/월 | $580-800/월 + Databricks |
| Unity Catalog 연동 | Beta (읽기 전용) | GA (직접 지원) | JDBC (Databricks 경유) |
| 단건 PK 조회 | 5-50ms (약점) | sub-ms | Databricks 의존 |
| 다중 JOIN | rule-based (약점) | CBO (강점) | Databricks 위임 |
| API 서빙 동시성 | 높음 | 높음 | Cube Store 캐시 의존 |
| DA ad-hoc | 가능 | 가능 | Query Pushdown 부분 가능 |
| 운영 복잡도 | 낮음 (매니지드) | 중간 (BYOC) | 낮음 (레이어 추가) |
| 마이그레이션 범위 | 중간 (데이터 로컬 복제) | 중간 | 최소 (BQ 유지 가능) |

### TO-BE 옵션별 구조

**Option A: ClickHouse Cloud** (DA ad-hoc + API 통합, 최저 비용)
```
Databricks Delta → ClickHouse Cloud (hot 데이터 로컬 복제)
                        ├── DA ad-hoc 쿼리
                        └── API 서빙
```

**Option B: CelerData BYOC** (JOIN 중심, UC 직접 연결)
```
Databricks Delta ← (Unity Catalog) → CelerData BYOC
                                           ├── MV auto-refresh
                                           ├── DA ad-hoc
                                           └── MySQL 호환 API
```

**Option C: Cube** (최소 변경, BQ DA 유지)
```
Databricks Delta → Cube (JDBC)
                        └── API 서빙 (pre-aggregation)
BQ → DA ad-hoc (유지)
```

**Option D: ClickHouse + Cube** (장기 풀스택)
```
Databricks Delta → ClickHouse (OLAP 엔진)
                        └── Cube (API 레이어 + pre-aggregation)
```

---

## 5. 검증 과정에서 발견한 7개 오류

이번 평가에서 가장 중요한 교훈은 **"직접 공식 문서를 확인하기 전까지는 아무것도 확실하지 않다"** 는 점이었습니다. LLM이 제공한 정보나 블로그 글, 오래된 공식 문서에 의존하다가 잘못된 판단으로 이어질 수 있습니다.

검증 과정에서 수정된 7개 오류를 공유합니다.

| # | 처음 알고 있던 내용 | 공식 문서 검증 후 실제 |
|---|----|----|
| 1 | Firebolt: SaaS only, self-hosted 없음 | Firebolt Core (self-hosted Docker, 무료) 존재. dbt-firebolt도 있음 |
| 2 | Cube: DA ad-hoc 쿼리 불가 | v0.35.40+의 Query Pushdown으로 데이터 모델 범위 내 ad-hoc 부분 가능 |
| 3 | ClickHouse: Delta INSERT 지원 안 됨 | v25.10+에서 실험적(experimental)으로 INSERT 지원 시작 |
| 4 | DuckDB: 단일 인스턴스, 확장 불가 | MotherDuck(클라우드 버전)은 읽기 복제본 16개까지 확장 가능 |
| 5 | TimescaleDB: Iceberg CDC 지원 | 실제로는 TigerData(Tiger Lake)가 Iceberg CDC를 지원하는 솔루션 (별개 제품) |
| 6 | Apache Druid: Iceberg 외부 쿼리 불가 | v32+에서 ingestion 없이 Iceberg 테이블 외부 쿼리 가능 |
| 7 | Snowflake Delta Direct: Preview 상태 | 이미 GA (일반 제공) 완료 |

이 오류들 중 일부는 솔루션 제외/포함 결론을 바꿀 수 있는 수준입니다. 예를 들어 Firebolt Core의 self-hosted 옵션을 처음부터 알았다면 비용 모델 평가 기준이 달라졌을 것입니다.

**검증 원칙**: 솔루션을 제외하는 근거가 될 때는 반드시 공식 문서에서 직접 확인합니다. 특히 빠르게 변화하는 OLAP 생태계에서는 6개월 전 정보가 이미 구식일 수 있습니다.

---

## 6. 선택 가이드

팀 상황에 따라 다르지만, 다음 기준이 유용합니다.

**ClickHouse Cloud를 선택할 때**
- 분석 쿼리(집계, 시계열)가 주를 이루고 단건 PK 조회가 적을 때
- 매니지드 서비스로 운영 부담을 최소화하고 싶을 때
- 비용을 최우선으로 고려할 때

**CelerData BYOC를 선택할 때**
- Unity Catalog와 긴밀하게 연동해야 할 때
- 다중 테이블 복잡 JOIN이 많을 때
- MySQL 호환이 중요할 때 (기존 도구 재사용)
- 단건 PK 조회 성능이 중요할 때

**Cube를 선택할 때**
- 마이그레이션 리스크를 최소화하고 싶을 때
- BQ 파이프라인을 당장 버릴 수 없을 때
- API 서빙 특화 캐시 레이어가 필요할 때
- Databricks 비용이 이미 고정되어 있을 때

---

## 7. 정리

이 평가의 핵심 교훈을 세 가지로 요약합니다.

**1. 문제를 정확히 정의해야 솔루션이 보인다.** "OLAP 엔진 교체"가 아니라 "Reverse ETL과 이중 서빙 레이어 제거"로 문제를 정의하면 평가 기준이 명확해집니다. 이 기준에서 Redshift와 Snowflake는 문제를 해결하지 못하는 솔루션으로 즉시 분류됩니다.

**2. StarRocks OSS self-hosted는 CelerData BYOC의 대안이 아니다.** 비용 절감 목적으로 OSS를 선택하면 Unity Catalog 연동이 빠지고, 인프라 직접 운영 비용이 오히려 높아집니다. 이 케이스에서는 매니지드/BYOC가 실질적으로 더 저렴합니다.

**3. 공식 문서 직접 검증은 선택이 아닌 필수다.** 21개 솔루션 중 7개에서 잘못된 정보가 발견됐습니다. OLAP 생태계는 빠르게 변화하므로, 제외 결정의 근거가 되는 정보는 반드시 공식 문서에서 확인해야 합니다.

---

## Reference

- [ClickHouse DataLakeCatalog (Unity Catalog 연동)](https://clickhouse.com/docs/en/engines/table-engines/integrations/deltalake)
- [CelerData BYOC 공식 문서](https://docs.celerdata.com)
- [StarRocks External Catalog - Unity Catalog 연동](https://docs.starrocks.io/docs/data_source/catalog/unified_catalog/)
- [Cube Query Pushdown 문서 (v0.35.40+)](https://cube.dev/docs/product/apis-integrations/sql-api/query-format)
- [Delta Lake UniForm (Iceberg 호환)](https://docs.delta.io/latest/delta-uniform.html)
- [Firebolt Core (self-hosted)](https://docs.firebolt.io/firebolt-core/)
- 프로젝트 파이프라인 정의: `tech-databricks-workflow/resources/*.yml`
- 아키텍처 문서: `tech-databricks-workflow/CLAUDE.md`
