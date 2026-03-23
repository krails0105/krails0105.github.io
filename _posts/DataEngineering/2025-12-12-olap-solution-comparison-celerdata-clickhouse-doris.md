---
title: "OLAP 솔루션 비교: CelerData vs ClickHouse vs Apache Doris — BigQuery 대체를 위한 최종 검토"
categories: [DataEngineering]
tags: [OLAP, CelerData, StarRocks, ClickHouse, Apache Doris, BigQuery, Materialized View]
---

### 들어가며

높은 BigQuery 비용. DA(Data Analyst)가 분석 쿼리 하나를 추가할 때마다 개발자가 4단계를 직접 처리해야 하는 구조적 복잡성. 이 두 가지 문제를 동시에 해결하기 위해 OLAP 솔루션 교체를 검토했다.

평가 대상은 **CelerData BYOC**, **ClickHouse Cloud**, **Apache Doris / VeloDB BYOC** 세 가지다. 결론부터 말하면 ClickHouse는 탈락했고, CelerData를 1순위로 선정하면서 Doris를 차선으로 남겨 두었다.

이 글에서는 평가 배경과 핵심 개념을 먼저 정리한 뒤, 각 솔루션의 강점과 약점을 비교하고, 최종 선정 근거를 설명한다.

---

### 배경: 왜 OLAP 솔루션을 바꿔야 하는가

#### 현재 데이터 파이프라인

현재 파이프라인은 두 세대가 공존하는 과도기 구조다.

**구 구조 (BigQuery 중심)**

```
BQ(raw 데이터) → dbt(BQ 내부 변환) → Airflow(Reverse ETL: BQ→PSQL) → API 서빙
```

**신규 구조 (Databricks 중심)**

```
S3(raw) → Databricks Bronze/Silver/Derived(Delta) → PSQL/BQ ingestion → API 서빙
```

신규 구조로 전환하는 중이지만 BigQuery는 여전히 남아 있고, 비용은 계속 발생한다.

#### 문제 1: BigQuery 비용

dbt 변환과 API 직접 쿼리가 누적되면서 매월 상당한 비용이 발생하고 있으며, 증가 추세다.

#### 문제 2: DA가 직접 할 수 없는 4단계 파이프라인

DA가 새로운 분석 지표를 요청하면 아래 작업이 순서대로 필요하다.

1. 개발자가 dbt 모델 추가 (BQ 내부 변환 SQL)
2. Airflow DAG 수정 (BQ → PSQL Reverse ETL)
3. PSQL 테이블 적재 확인
4. API 엔드포인트 추가

DA는 SQL을 직접 작성할 수 있는데도 실제 서빙까지 개발자 개입이 4단계나 필요하다. DA 셀프서비스가 구조적으로 불가능한 상태다.

#### 이번 검토의 목표

- BigQuery 비용을 대폭 절감한다.
- **DA가 SQL만 작성하면 MV(Materialized View) 자동 활용 → API 서빙까지** 이어지는 셀프서비스 구조를 만든다.

이 두 요건을 동등한 우선순위로 만족하는 솔루션을 찾는 것이 목표다.

---

### 핵심 개념 정리

솔루션을 비교하기 전에, 평가 기준이 되는 세 가지 개념을 짚고 넘어간다. 각 개념이 왜 중요한지 이해해야 이후 비교가 와닿는다.

#### Materialized View와 Query Rewrite

**일반 View vs Materialized View**

일반 View는 SQL 쿼리에 이름을 붙인 것으로, 조회할 때마다 원본 테이블을 다시 스캔한다. 반면 Materialized View(이하 MV)는 쿼리 결과를 물리적으로 저장해 두는 테이블이다. 원본 데이터가 바뀌면 MV도 자동으로 갱신된다.

예를 들어, 이벤트별 거래량 집계를 MV로 만들어 두면 이후 같은 집계를 조회할 때 수억 건의 원본 데이터를 매번 스캔하지 않아도 된다.

**Query Rewrite가 왜 중요한가**

MV만 있어도 사용자가 매번 `SELECT * FROM mv_daily_summary`처럼 MV 이름을 직접 지정해야 한다면 불편하다. DA는 MV의 존재를 알아야 하고, MV 이름까지 외워야 한다.

**MV Query Rewrite**는 이 문제를 해결한다. DA가 원본 테이블에 대해 일반 SQL을 작성하면, DB 옵티마이저가 자동으로 적합한 MV를 찾아서 대신 사용한다.

```sql
-- DA가 작성하는 SQL (원본 테이블 대상)
SELECT date, SUM(amount) FROM orders GROUP BY date;

-- 옵티마이저가 내부적으로 변환하는 SQL
SELECT date, total_amount FROM mv_daily_orders;
-- 결과: 45초 → 0.08초
```

DA는 MV의 존재를 몰라도 된다. SQL만 작성하면 옵티마이저가 알아서 최적 경로를 선택한다. 이 기능이 "DA 셀프서비스"의 핵심이다.

Query Rewrite가 지원하는 패턴은 **SPJG**(Select-Project-Join-Group By)로, 단순 집계뿐 아니라 JOIN이 포함된 복잡한 집계 쿼리까지 rewrite 대상이 된다.

#### CBO (Cost-Based Optimizer)

JOIN을 실행하는 순서는 성능에 큰 영향을 미친다. 테이블 A(1억 건)와 B(100만 건)를 JOIN할 때, 어느 쪽을 먼저 처리하느냐에 따라 성능이 수십 배 차이 날 수 있다.

- **RBO(Rule-Based Optimizer)**: 사전에 정해진 규칙으로 JOIN 순서를 결정한다. 테이블 통계를 보지 않으므로 데이터 분포에 따라 최적이 아닐 수 있다.
- **CBO(Cost-Based Optimizer)**: 각 테이블의 행 수, 컬럼 통계, 데이터 분포 등을 기반으로 실행 비용을 추정하고, 가장 비용이 낮은 JOIN 순서를 자동으로 선택한다.

쉽게 말하면, RBO는 "항상 같은 방식으로 길 찾기"이고 CBO는 "실시간 교통 상황을 보고 최적 경로 찾기"에 해당한다.

각 솔루션의 CBO 수준 차이는 다음과 같다.

| 솔루션 | CBO 수준 | 비고 |
|--------|----------|------|
| **StarRocks (CelerData)** | Cascades 프레임워크 기반, TPC-DS 99개 SQL 전수 지원 | Join Reorder, 분산 JOIN 전략 자동 선택, 저 카디널리티 최적화 포함 |
| **Apache Doris** | CBO + RBO + HBO(History-Based) 혼합 | Nereids 옵티마이저, Join Reorder 지원 |
| **ClickHouse** | RBO에 가까움 | 자동 JOIN 순서 최적화 없음 |

#### Distributed JOIN 전략

OLAP 시스템은 데이터를 여러 노드에 분산 저장한다. 분산 환경에서 JOIN을 어떻게 처리하느냐에 따라 성능 차이가 크다.

| 전략 | 동작 방식 | 적합한 상황 |
|------|-----------|-------------|
| **Broadcast JOIN** | 작은 테이블을 모든 노드에 복제한 뒤 각 노드에서 로컬 JOIN | 큰 Fact 테이블 x 작은 Dimension 테이블 |
| **Shuffle JOIN** | 양쪽 테이블을 JOIN 키 기준으로 같은 노드에 재분배한 뒤 JOIN | 큰 테이블 x 큰 테이블 |
| **Colocate JOIN** | 동일한 분배 키를 가진 테이블이 이미 같은 노드에 있으므로 네트워크 전송 없이 JOIN | 사전에 같은 키로 분산 설계된 테이블 |
| **Bucket Shuffle** | 한쪽 테이블만 재분배 | 한쪽이 이미 JOIN 키로 정렬/분산된 경우 |

**ClickHouse에 Shuffle JOIN이 없는 게 왜 문제인가?**

큰 테이블끼리 JOIN할 때 Shuffle JOIN 없이는 한 노드가 한쪽 테이블 전체를 메모리에 올려야 한다. 수십억 건의 트랜잭션 데이터를 multi-table JOIN하면 단순히 느린 것이 아니라 메모리 부족으로 쿼리 자체가 실패할 수 있다.

ClickHouse 공식 문서에서도 JOIN은 3~4개 이하를 권장하며, 그 이상이면 denormalization(테이블 병합)을 안내하고 있다.

---

### 솔루션별 상세 비교

#### CelerData BYOC (StarRocks 매니지드)

StarRocks 엔진을 AWS/GCP/Azure 고객 계정(BYOC: Bring Your Own Cloud)에 직접 배포하는 매니지드 서비스다.

**강점**

- **MV Query Rewrite**: SPJG 패턴을 완전히 지원한다. 3개 이상의 테이블을 JOIN하는 MV도 query rewrite 대상이 된다. v3.3.2+부터는 어떤 MV를 만들면 좋은지 자동으로 추천하는 Auto MV Recommendation 기능도 제공한다.
- **CBO JOIN 최적화**: Cascades 프레임워크 기반으로 Join Reorder, 분산 JOIN 전략 자동 선택, CTE 재사용, 저 카디널리티 최적화까지 포함한다. TPC-DS 99개 SQL을 모두 지원한다.
- **Unity Catalog Delta catalog 연동**: Databricks와의 연동이 가장 성숙하다. 기존 파이프라인의 Delta 테이블을 별도 ETL 없이 바로 쿼리할 수 있다.
- **ASOF JOIN**: v4.0에서 지원한다. `event_id → price` 매핑처럼 시간/높이 기반으로 가장 가까운 값을 찾아 조인하는 패턴에 유용하다.
- **MySQL 5.7 프로토콜 호환**: 기존 MySQL 클라이언트, ORM, BI 도구를 그대로 사용할 수 있다.
- **동시성**: 최대 약 10,000 동시 쿼리를 처리할 수 있다.
- **무료 개발자 티어**: CCU(Compute Credit Unit) 면제 상태로, AWS 인프라 비용(약 $150/월)만 부담하면서 PoC가 가능하다.

**약점**

- CCU 가격 구조의 투명성이 낮아 실제 프로덕션 비용을 예측하기 어렵다. PoC를 통해 실측이 필요하다.
- External Catalog 기반 MV의 데이터 일관성 보장이 내부 테이블보다 약하다. Delta Lake 변경 시 MV 무효화가 제대로 동작하는지 확인이 필요하다.

**비용 추정**: 프로덕션 RI 기준 약 $2,200~3,500/월. CCU 단가 비공개로 PoC 실측이 필요하다.

---

#### ClickHouse Cloud (완전 매니지드)

단일 테이블 스캔과 집계에서는 최고 수준의 성능을 보여준다. 하지만 이번 요구사항에서는 구조적 한계가 드러났다.

**MV Query Rewrite: 지원하지 않으며 계획도 없다**

GitHub Issue [#17672](https://github.com/ClickHouse/ClickHouse/issues/17672)에서 `st-declined`(영구 거부) 상태다. 2021년 이후 변화가 없고 2026년 로드맵에도 포함되어 있지 않다.

대안으로 제안되는 **Projection**은 MV Query Rewrite의 대체가 되지 못한다. 공식 문서에 따르면 Projection 정의에는 JOIN을 사용할 수 없고, WHERE 절도 포함할 수 없다. Projection은 본질적으로 데이터 재정렬(reorder)에 가까운 기능이며, 단일 테이블의 단순한 읽기 최적화에만 효과적이다. 따라서 JOIN이 포함된 복잡한 집계 쿼리를 자동으로 rewrite하는 DA 셀프서비스 요건을 충족하지 못한다.

> ClickHouse의 MV는 다른 시스템의 MV와 동작 방식이 다르다. 삽입 시점에 트리거되는 증분(Incremental) 모델이라서, JOIN의 오른쪽 테이블이 변경되어도 MV가 갱신되지 않는다. Refreshable MV를 사용하면 전체 데이터셋에 대해 주기적으로 실행할 수 있지만, 결과 신선도가 떨어진다.

**JOIN 아키텍처 한계**

앞서 설명한 Shuffle JOIN이 없다. TPC-DS 99개 쿼리 중 7개가 실패하고, 전체 평균이 약 40배 느리다는 벤치마크 결과가 이를 반영한다.

**SQL 방언 문제**

- Correlated Subquery: Beta 상태이며, 분산 테이블에서 제대로 동작하지 않는다.
- LATERAL JOIN: 미지원.
- UPDATE/DELETE: `ALTER TABLE ... UPDATE` 형식의 비표준 뮤테이션 문법을 사용한다. 비동기로 실행되며, I/O 집약적이고 원자성이 보장되지 않는다.

DA가 표준 SQL을 작성할 때 예상치 못한 오류나 비표준 문법 학습 부담이 생긴다.

**동시성**

프로덕션 기준 권장 QPS는 약 100이다. Auto-pause 후 cold start가 수십 초에 달해 API 서빙에 부적합하다.

**비용**: 세 솔루션 중 가장 저렴하다. 하지만 핵심 기능이 결여되어 있어 비용 우위가 의미 없다.

---

#### Apache Doris / VeloDB BYOC

StarRocks의 원본 프로젝트(Baidu Palo에서 fork)로, StarRocks와 유사한 MPP 아키텍처를 공유한다.

**강점**

- **MV Query Rewrite**: SPJG 패턴을 지원하며, CelerData와 동등한 수준이다.
- **Distributed JOIN**: Broadcast JOIN과 Shuffle JOIN을 모두 지원한다. 큰 테이블끼리의 JOIN에도 대응할 수 있다.
- **MySQL 프로토콜 네이티브 호환**: 기존 MySQL 도구를 그대로 사용할 수 있다.
- **옵티마이저**: CBO, RBO, HBO(History-Based Optimizer)를 조합한 Nereids 옵티마이저를 사용한다. 과거 쿼리 이력까지 활용하여 실행 계획을 최적화한다.
- **Doris 4.0 로드맵**: 벡터 검색, AI 함수, BM25 full-text 검색 지원 등 향후 확장성이 있다.
- **Unity Catalog 연동**: Iceberg REST catalog(v3.1.3+, UniForm 활용)를 통해 Databricks와 연동할 수 있다.

**약점**

- **ASOF JOIN 미지원**: GitHub [#39486](https://github.com/apache/doris/issues/39486)에 이슈가 등록되어 있지만 구현 계획이 없다. `event_id → price` 매핑 패턴에는 window function 등 workaround가 필요하다.
- **CBO 성숙도**: Nereids 옵티마이저가 StarRocks의 Cascades 기반 CBO보다 상대적으로 덜 성숙하다.
- **UC Delta catalog 연동**: Iceberg REST를 경유하므로 CelerData의 네이티브 Delta catalog보다 한 단계 간접적이다.
- VeloDB BYOC의 가격이 비공개다. Self-hosted는 약 $1,630/월(RI) + 운영 인력 0.5 FTE가 추가로 필요하다.

**포지셔닝**: CelerData보다 비용이 낮을 가능성이 있다. 다만 ASOF JOIN 미지원과 UC 연동 성숙도 차이가 존재한다. CelerData CCU 비용이 예상을 크게 초과할 경우 전환을 검토할 수 있는 차선이다.

---

### 벤치마크 비교

> **주의**: 아래 수치 중 일부는 StarRocks/CelerData 또는 Doris 진영에서 발표한 자료를 참고했다. 벤더 편향 가능성이 있으므로 절대값보다 상대적 경향으로 해석해야 한다.

| 벤치마크 | StarRocks / CelerData | Apache Doris | ClickHouse |
|----------|:---------------------:|:------------:|:----------:|
| **TPC-H SF100** | 완주 | 대부분 < 0.5s | 30x 느림, 4개 실패 |
| **TPC-DS SF100** | 완주 | 98% 승리 | 40x 느림, 7개 실패 |
| **SSB** (Star Schema Benchmark) | 1x (기준) | 동등 수준 | 2.2x 느림 |
| **CoffeeBench** | 동등 수준 | 1x (기준) | 2~3x 느림 |

TPC-H와 TPC-DS는 복잡한 multi-table JOIN을 포함하는 산업 표준 벤치마크다. ClickHouse의 실패 항목은 Shuffle JOIN 부재로 인한 메모리 한계에서 비롯된다. 반면 StarRocks와 Doris는 분산 JOIN 전략(Shuffle/Broadcast/Colocate)을 갖추고 있어 복잡한 JOIN 쿼리에서도 안정적으로 완주한다.

---

### 비용 비교

> **가정**: AWS us-east-1, 프로덕션 워크로드 기준. 실제 비용은 사용 패턴에 따라 크게 달라질 수 있다. CelerData CCU 소비량은 PoC 이후 확정이 필요하다.

| 구분 | CelerData BYOC | ClickHouse Cloud | Doris Self-hosted | Doris VeloDB |
|------|---------------:|------------------:|------------------:|-------------:|
| Dev/최소 | ~$340 | ~$195 | ~$534 | ~$800 |
| 프로덕션 (RI 1년) | ~$2,200~3,500 | N/A | ~$1,630 | ~$1,500~3,000 |
| 가격 투명성 | 낮음 | 높음 | 완전 투명 | 낮음 |
| 운영 부담 | 낮음 | 매우 낮음 | 높음 (0.5 FTE) | 낮음 |

**유의사항**:
- **CelerData**: CCU 단가가 비공개라서 PoC 없이는 프로덕션 비용을 정확히 예측하기 어렵다.
- **ClickHouse**: 2025년 1월 가격 인상 이력이 있다.
- **Doris Self-hosted**: EC2/S3 비용 외에 운영 인력(약 0.5 FTE) 비용이 별도로 발생한다.

---

### 최종 비교 매트릭스

| 항목 | CelerData BYOC | ClickHouse Cloud | Apache Doris / VeloDB |
|------|:--------------:|:----------------:|:---------------------:|
| MV Query Rewrite | O | **X (영구 거부)** | O |
| Auto MV 추천 | O (v3.3.2+) | X | X |
| DA SQL 셀프서비스 | O | **X** | O |
| JOIN 성능 (복잡 쿼리) | 우수 | **취약** | 우수 |
| CBO 성숙도 | 높음 (Cascades) | 낮음 (RBO 수준) | 중간 (Nereids CBO+RBO+HBO) |
| Distributed Shuffle JOIN | O | **X** | O |
| 동시성 | ~10,000 QPS | ~100 QPS | ~10,000 QPS |
| UC Delta catalog 연동 | 성숙 (네이티브) | 제한적 | 가능 (Iceberg REST) |
| ASOF JOIN | O (v4.0) | O | **X** |
| MySQL 프로토콜 호환 | O | 제한적 | O |
| 무료 시작 | O (개발자 티어) | O (trial) | O (오픈소스) |
| 가격 투명성 | 낮음 | 높음 | Doris: 투명 / VeloDB: 낮음 |
| 운영 부담 | 낮음 | 매우 낮음 | Self-hosted: 높음 |

---

### 결론: CelerData BYOC 선정

#### 선정 근거

1. **MV Query Rewrite + Auto MV 추천**: DA가 원본 테이블에 SQL을 작성하면 옵티마이저가 자동으로 MV를 활용하고, 어떤 MV를 추가로 만들면 좋은지까지 추천한다. DA 셀프서비스 요건을 완전히 충족한다.

2. **CBO JOIN 최적화**: 트랜잭션 파이프라인의 multi-table JOIN 패턴(transaction_base x price x age_dist 등)에서 실행 계획이 자동으로 최적화된다. Cascades 프레임워크 기반으로 TPC-DS 99개 쿼리를 모두 처리할 수 있는 성숙도를 갖추고 있다.

3. **무료 개발자 티어로 즉시 PoC**: CCU 면제 상태에서 AWS 인프라 비용(약 $150/월)만 부담하면 실제 환경에서 검증할 수 있다. 가격 불투명성이라는 약점을 PoC로 해소할 수 있다.

4. **UC Delta catalog 네이티브 연동**: 기존 Databricks 파이프라인(`{analytics_catalog}`)의 Delta 테이블을 별도 ETL 없이 바로 쿼리할 수 있다.

5. **ASOF JOIN 지원**: `event_id → price` 매핑(key_mapper 패턴)을 SQL 레벨에서 직접 표현할 수 있다. Doris에서는 window function 등의 workaround가 필요하다.

#### 탈락 및 차선 정리

**ClickHouse Cloud -- 탈락**

MV Query Rewrite를 영구 거부한 상태이며 Shuffle JOIN도 없다. 비용이 가장 저렴하지만 핵심 요건(DA 셀프서비스)을 구조적으로 충족할 수 없다. 단일 테이블 집계 성능이 뛰어난 만큼 로그 분석이나 단순 집계 중심의 워크로드에서는 여전히 강력한 선택지다.

**Apache Doris / VeloDB BYOC -- 차선**

MV Query Rewrite는 동등하고, Shuffle JOIN도 지원하며, 비용은 약간 더 저렴할 수 있다. ASOF JOIN 미지원과 UC 연동 성숙도 차이가 있지만, CelerData CCU 비용이 예상을 크게 초과할 경우 전환을 검토할 수 있는 유효한 대안이다.

---

---

### 흔히 빠지는 함정과 주의사항

- **"ClickHouse가 가장 빠르다"는 착각**: 단일 테이블 스캔/집계에서는 사실이지만, multi-table JOIN이 포함된 분석 쿼리에서는 오히려 가장 느리거나 아예 실패한다. 워크로드 특성에 맞는 벤치마크로 평가해야 한다.
- **벤더 발표 벤치마크의 한계**: 각 벤더가 자사에 유리한 조건으로 벤치마크를 수행한다. 반드시 자체 데이터로 PoC를 거쳐야 한다.
- **Projection과 MV Query Rewrite 혼동**: ClickHouse의 Projection은 데이터 재정렬 최적화이지, MV Query Rewrite와 동등한 기능이 아니다. JOIN이나 WHERE 절을 Projection 정의에 사용할 수 없다.
- **BYOC 비용 = 인프라 비용 + 라이선스 비용**: CelerData/VeloDB BYOC의 총비용은 AWS 인프라 비용에 벤더 라이선스(CCU 등)가 더해진 것이다. 인프라 비용만으로 판단하면 안 된다.

---

### 참고 자료

- ClickHouse MV Query Rewrite 거부 이슈: [GitHub #17672](https://github.com/ClickHouse/ClickHouse/issues/17672)
- Doris ASOF JOIN 미구현 이슈: [GitHub #39486](https://github.com/apache/doris/issues/39486)
- [StarRocks MV Query Rewrite 공식 문서](https://docs.starrocks.io/docs/using_starrocks/async_mv/use_cases/query_rewrite_with_materialized_views)
- [StarRocks CBO 소개](https://docs.starrocks.io/docs/introduction/Features)
- [ClickHouse Projection vs Materialized View](https://clickhouse.com/docs/data-modeling/projections/materialized-views-versus-projections)
- [Apache Doris 공식 GitHub](https://github.com/apache/doris)
- [CelerData BYOC](https://celerdata.com)
