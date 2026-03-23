---
title: "[DataHub] EKS 배포 환경의 아키텍처와 BigQuery Lineage 추출 실전"
categories:
  - DataEngineering
tags:
  - DataHub
  - BigQuery
  - Lineage
  - EKS
  - dbt
  - Metadata
date: 2026-03-12
---

### 개요

DataHub를 EKS에 배포한 이후, "단순히 메타데이터를 수집한다"는 개념이 실제로 어떻게 동작하는지 파악하는 데 시간이 걸렸습니다. 공식 문서에 아키텍처 다이어그램은 있지만, 각 컴포넌트가 실제 운영에서 어떤 역할을 하는지, 데이터가 어떤 경로로 흐르는지는 직접 로그를 따라가봐야 체감할 수 있었습니다.

이 글에서는 다음 내용을 다룹니다.

1. DataHub의 내부 아키텍처와 8개 Pod의 역할
2. MCP/MCL 이벤트 처리 흐름과 저장소별 역할 분리
3. BigQuery query log 기반 lineage 추출 과정
4. `dataset_pattern` 필터 이슈와 트러블슈팅

실제 EKS 배포 환경에서 겪은 내용을 기준으로 정리했으므로, DataHub를 도입하려는 팀에서 참고할 수 있을 것입니다.

---

### 사전 지식

- Kubernetes 기본 개념 (Pod, Service, CronJob)
- Helm chart 배포 경험
- BigQuery IAM 역할 및 서비스 계정 개념
- Kafka의 기본 동작 원리 (Producer/Consumer, Topic)

---

### 1. DataHub 아키텍처 -- 8개 Pod가 하는 일

EKS에 Helm으로 배포하면 아래 8개 Pod가 생성됩니다.

| Pod | 역할 |
|---|---|
| **GMS** (Generalized Metadata Service) | 핵심 API 서버. 모든 메타데이터 쓰기/읽기 처리 |
| **Frontend** | React 기반 UI. 검색, 탐색, lineage 시각화 제공 |
| **Actions** | Kafka MCL 구독 후 자동화/알림 처리 (예: Slack 알림, 접근 제어) |
| **OpenSearch** | 검색 인덱스. UI의 검색/필터 쿼리를 처리 |
| **Kafka** | 이벤트 버스. MCL 스트림을 통해 컴포넌트 간 비동기 통신 |
| **Zookeeper** | Kafka 코디네이터 (Kafka 클러스터 관리) |
| **MySQL** | Primary storage. entity/aspect 원본 데이터 보관 |
| **system-update** | 스키마 마이그레이션 Job (초기 배포 및 업그레이드 시 실행) |

#### 데이터 흐름

Ingestion이 실행되면 다음과 같은 순서로 데이터가 흐릅니다.

```
Ingestion Source (Recipe YAML)
  --> MCP 생성 (Metadata Change Proposal)
  --> GMS REST API (/aspects?action=ingestProposalBatch)
  --> MySQL    <-- Primary storage (AVRO 직렬화)
  --> Kafka    <-- MCL (Metadata Change Log) 발행
  --> OpenSearch <-- 검색 인덱스 갱신
  --> Actions  <-- MCL 구독 --> 자동화/알림
```

**저장소별 역할이 명확히 분리**되어 있다는 점이 중요합니다.

- **MySQL**: entity/aspect 원본 데이터를 AVRO로 직렬화해서 저장합니다. "이 테이블의 스키마가 뭔가"를 물어볼 때 여기서 읽습니다. DataHub의 source of truth입니다.
- **Kafka**: MySQL에 저장 완료 후 MCL을 발행합니다. 변경사항을 스트리밍으로 받고 싶은 컴포넌트(Actions, 외부 시스템 등)가 구독합니다.
- **OpenSearch**: 검색과 필터링 전용입니다. "이름에 'bitcoin'이 포함된 테이블 전체 목록"은 MySQL이 아닌 OpenSearch에 질의합니다.

이 분리 덕분에, 예를 들어 OpenSearch가 일시적으로 다운되더라도 메타데이터 수집(GMS -> MySQL -> Kafka) 자체는 정상 동작합니다. 검색만 안 될 뿐입니다.

#### MCP vs MCL

처음 볼 때 헷갈리는 개념입니다.

| 구분 | MCP (Metadata Change Proposal) | MCL (Metadata Change Log) |
|---|---|---|
| 방향 | Ingestion Source --> GMS | GMS --> Kafka |
| 의미 | "이 메타데이터를 저장해줘" (요청) | "저장이 완료됐어" (이벤트) |
| 발생 시점 | Ingestion 실행 시 | MySQL 커밋 완료 후 |

핵심 동작 하나를 기억하면 됩니다. **중복 MCP는 MCL을 발행하지 않습니다.** 이미 동일한 내용이 MySQL에 저장되어 있으면 Kafka까지 전파되지 않습니다. 이 설계 덕분에 동일한 ingestion을 반복 실행해도 불필요한 이벤트 트래픽이 발생하지 않습니다.

---

### 2. Ingestion 구조

Recipe YAML은 Source(메타데이터를 가져올 곳)와 Sink(메타데이터를 보낼 곳)를 정의합니다.

```yaml
# recipe.yml 예시 구조
source:
  type: bigquery
  config:
    project_ids:
      - my-gcp-project
    dataset_pattern:
      allow:
        - "bitcoin"
        - "metric"

sink:
  type: datahub-rest
  config:
    server: "http://datahub-datahub-gms:8080"
    read_timeout_sec: 120
```

Source가 외부 시스템 API를 호출하여 entity와 aspect별 MCP를 생성합니다. 테이블 1개를 수집하면 schema, properties, profile, container, lineage 등 **7~10개 aspect**가 만들어집니다. 390개 테이블이면 약 3,500개 이벤트가 GMS로 들어갑니다.

이 점을 이해하면, ingestion이 왜 단순 API 호출 한두 번이 아니라 수천 건의 MCP 전송 작업인지 감이 옵니다. 다음 섹션에서 다루는 port-forward 한계도 이 맥락에서 이해할 수 있습니다.

---

### 3. port-forward의 한계와 클러스터 내부 실행

로컬에서 테스트할 때 `kubectl port-forward`를 자주 씁니다.

```bash
kubectl port-forward svc/datahub-datahub-gms 8080:8080
```

하지만 이 방식은 **단일 TCP 연결 프록시**라서 대량 트래픽에 취약합니다.

#### 증상

- GMS 응답 timeout 발생
- `pending_requests` 카운터 누적
- sink failures가 간헐적으로 발생하다가 ingestion 실패

수천 개의 MCP를 batch로 보내는 ingestion은 port-forward 연결이 자주 끊깁니다. 특히 BigQuery처럼 테이블 수가 많은 소스에서 두드러집니다.

#### 해결: 클러스터 내부에서 실행

클러스터 내부에서 직접 실행하면 이 문제가 사라집니다. GMS 주소로 K8s Service DNS를 사용합니다. CronJob이나 별도 Pod로 실행할 수 있습니다.

```yaml
# 클러스터 내부 실행 시 sink 설정
sink:
  type: datahub-rest
  config:
    server: "http://datahub-datahub-gms:8080"  # 클러스터 내부 DNS
    read_timeout_sec: 120
```

port-forward는 recipe 디버깅이나 소규모 테스트에만 사용하고, 실제 운영 ingestion은 반드시 클러스터 내부에서 실행하는 것을 권장합니다.

---

### 4. BigQuery Lineage 추출

#### 4-1. Lineage 소스 2가지

DataHub BigQuery connector는 두 가지 방법으로 lineage를 추출합니다.

| 소스 | 방식 | 결과 |
|---|---|---|
| View SQL 파싱 | View 정의의 `CREATE VIEW AS SELECT` 문 분석 | View --> Table lineage |
| Query log | `INFORMATION_SCHEMA.JOBS` DML 쿼리 분석 | Table --> Table lineage |

View lineage는 BigQuery 메타데이터 읽기 권한만 있으면 잘 동작합니다. 문제는 query log 기반 lineage입니다.

#### 4-2. INFORMATION_SCHEMA.JOBS 권한

BigQuery IAM 역할과 권한의 관계가 직관적이지 않아서 실수하기 쉬운 부분입니다.

| IAM 역할 | 주요 권한 | JOBS 조회 |
|---|---|---|
| `bigquery.jobUser` | `bigquery.jobs.create` | 불가 |
| `bigquery.resourceViewer` | `bigquery.jobs.list` + `bigquery.jobs.listAll` | **가능** |
| `bigquery.admin` | 모든 권한 | **가능** |

DataHub 공식 문서에 따르면 query log lineage를 추출하려면 서비스 계정에 다음 권한이 필요합니다.

- `bigquery.jobs.listAll` -- INFORMATION_SCHEMA.JOBS 조회
- `logging.logEntries.list` -- GCP 감사 로그 접근 (선택적이지만 권장)
- `logging.privateLogEntries.list` -- 비공개 로그 접근 (선택적이지만 권장)

최소 권한 원칙을 적용한다면 `bigquery.resourceViewer` 역할을 부여하면 됩니다. `bigquery.admin`은 과도한 권한입니다.

**흔한 실수**: IAM에서 역할을 부여한 서비스 계정과 `key.json`으로 실제 사용하는 서비스 계정이 다른 경우입니다. 반드시 확인하세요.

```bash
# 현재 프로젝트의 IAM 바인딩 확인
gcloud projects get-iam-policy my-gcp-project \
  --flatten="bindings[].members" \
  --format='table(bindings.role,bindings.members)' \
  --filter="bindings.members:serviceAccount"
```

#### 4-3. dataset_pattern 필터 문제 (핵심 트러블슈팅)

query log에서 17,439개 쿼리를 분석했는데 결과가 이상했습니다.

```
num_lineage_skipped_due_to_filters: 1,024
```

추출된 1,089개 URN lineage 중 1,024개가 필터로 버려졌습니다. 거의 94%가 폐기된 셈입니다. 원인은 `dataset_pattern` 설정이었습니다.

```yaml
# 문제가 된 설정
dataset_pattern:
  allow:
    - "bitcoin"
    - "metric"
```

**왜 이런 일이 발생하는가?** dbt 모델 쿼리는 `bitcoin`, `metric` 외에도 `metadata`, `abstraction_price`, `raw_data_*` 등 다양한 dataset을 참조합니다. DataHub의 lineage 필터 로직은 upstream 또는 downstream 중 하나라도 `dataset_pattern`에 포함되지 않으면 해당 lineage 관계 전체를 버립니다.

예를 들어, `bitcoin.indicator_block`이 `abstraction_price.spot_ohlcv`를 참조하는 lineage가 있으면, `abstraction_price`가 allow 목록에 없으므로 이 lineage 관계 자체가 폐기됩니다.

**해결**: dbt 프로젝트의 SQL 파일을 분석해서 참조하는 모든 dataset을 식별하고, `dataset_pattern.allow`에 전부 추가합니다.

```yaml
# 수정된 설정
dataset_pattern:
  allow:
    - "bitcoin"
    - "metric"
    - "metadata"
    - "abstraction_price"
    - "raw_data_.*"     # 정규식 패턴도 사용 가능
    # ... 총 24개 dataset
```

참고로, allow 목록에 dataset을 추가한다고 해서 해당 dataset의 메타데이터가 모두 수집되는 것은 아닙니다. `dataset_pattern`은 **수집 대상 필터**이면서 동시에 **lineage 필터**로도 작동합니다. lineage를 완전하게 추출하려면 관련된 모든 dataset을 포함해야 합니다.

#### 4-4. 통계 지표 해석 주의

DataHub BigQuery connector 로그에서 헷갈리는 부분이 있습니다.

```
total_query_log_entries: 0
```

이 숫자가 0이라고 당황하지 마세요. `total_query_log_entries`는 **구버전 lineage 추출기**의 통계입니다. 현재 DataHub에서는 `use_queries_v2` 방식이 기본 활성화되어 있으며, 이 방식의 `queries_extractor`가 쿼리를 처리합니다. 실제 추출 결과는 아래 항목을 확인해야 합니다.

```
queries_extractor.sql_aggregator.num_urns_with_lineage: 65
```

`use_queries_v2`는 SQL 파싱 품질이 개선된 버전으로, 구버전 대비 더 많은 lineage를 정확하게 추출합니다. 명시적으로 비활성화하지 않는 한 기본으로 사용됩니다.

---

### 5. UI Secrets vs 환경변수

DataHub UI에서 "Manage Data Sources > Secrets" 메뉴를 발견하고 여기에 GCP 키를 등록하려 했다면, OSS 버전에서는 작동하지 않습니다.

| 기능 | Acryl Cloud (관리형) | DataHub OSS |
|---|---|---|
| UI Secrets 관리 | 지원 | 미지원 |
| UI Ingestion 탭 | 지원 | 미지원 |
| Recipe `${VAR}` 참조 | Platform 변수 | OS 환경변수 |

OSS 버전에서 Recipe YAML의 `${VAR}` 환경변수 참조는 **OS 환경변수**에서 읽습니다.

```bash
# 로컬 실행 시
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
datahub ingest -c recipe.yml

# EKS 실행 시: K8s Secret --> envFrom으로 Pod 환경변수 주입
```

이 차이를 모르면 "UI에서 Secret을 등록했는데 왜 인식을 못 하지?"라는 삽질을 하게 됩니다.

---

### 6. BigQuery에서 Lineage가 추출되는 조건

마지막으로 BigQuery lineage 추출의 범위와 한계를 정리합니다.

| 조건 | lineage 추출 가능 여부 |
|---|---|
| BQ 내부에서 실행된 INSERT/MERGE/CREATE TABLE AS | 가능 |
| BQ View 정의 (CREATE VIEW AS SELECT) | 가능 |
| Databricks --> Iceberg --> BQ 외부 쓰기 | **불가** (BQ query log에 안 남음) |
| Storage Write API를 통한 BQ 적재 | **불가** |
| GCS --> BQ 로드 (bq load 등) | **불가** |

핵심 원리는 단순합니다. **BigQuery query log에 SQL 문이 남아야** lineage를 추출할 수 있습니다. 외부 시스템이 Storage API나 파일 로드로 데이터를 쓰면 SQL이 남지 않으므로 lineage를 자동 추출할 수 없습니다.

이런 경우에는 DataHub의 REST API를 통해 **수동으로 lineage를 등록**해야 합니다.

#### query log 조회 기간

query log window는 기본적으로 현재 시각 기준 **과거 1일**입니다. 더 긴 기간을 보려면 recipe에서 `start_time`을 지정합니다.

```yaml
source:
  type: bigquery
  config:
    start_time: "2026-03-01T00:00:00Z"
    end_time: "2026-03-12T00:00:00Z"
```

기간을 너무 길게 잡으면 `INFORMATION_SCHEMA.JOBS` 조회 비용이 증가할 수 있으므로, 필요한 범위만 지정하는 것이 좋습니다.

---

### 트러블슈팅 요약

| 증상 | 원인 | 해결 |
|---|---|---|
| port-forward에서 sink failure 빈발 | 단일 TCP 프록시로 대량 MCP 전송 불안정 | 클러스터 내부에서 실행 (CronJob/Pod) |
| `total_query_log_entries: 0` | 구버전 통계 지표 확인 | `queries_extractor` 관련 지표 확인 |
| lineage의 94%가 필터에서 폐기됨 | `dataset_pattern`에 참조 dataset 미포함 | dbt SQL 분석 후 allow 목록 확장 |
| INFORMATION_SCHEMA.JOBS 조회 실패 | SA에 `bigquery.resourceViewer` 미부여 | IAM 역할 확인 및 부여 |
| UI Secrets에 등록했는데 인식 불가 | OSS 버전은 UI Secrets 미지원 | OS 환경변수 또는 K8s Secret 사용 |

---

### 마무리

DataHub를 처음 도입할 때는 "메타데이터 카탈로그 = UI에서 테이블 검색" 정도로 생각하기 쉽습니다. 하지만 실제로는 MCP/MCL 이벤트 흐름, MySQL/Kafka/OpenSearch의 역할 분리, ingestion 권한 설계까지 신경 써야 할 부분이 많습니다.

특히 BigQuery lineage에서는 두 가지를 기억하면 됩니다.

1. **권한**: 서비스 계정에 `bigquery.jobs.listAll` 권한이 있는지 확인
2. **필터**: `dataset_pattern.allow`에 lineage 관련 dataset이 모두 포함되었는지 확인

이 두 가지만 제대로 설정하면 "왜 lineage가 안 잡히지?"라는 문제의 대부분은 해결됩니다.

---

### Reference

- [DataHub Architecture -- Metadata Serving](https://datahubproject.io/docs/architecture/metadata-serving)
- [DataHub Architecture -- Metadata Ingestion](https://datahubproject.io/docs/architecture/metadata-ingestion)
- [DataHub BigQuery Ingestion Source](https://datahubproject.io/docs/generated/ingestion/sources/bigquery)
- [DataHub BigQuery Prerequisites](https://datahubproject.io/docs/generated/ingestion/sources/bigquery/#prerequisites)
- [DataHub Deployment Guide -- Kubernetes](https://datahubproject.io/docs/deploy/kubernetes)
- [BigQuery IAM Roles -- Access Control](https://cloud.google.com/bigquery/docs/access-control)
- [BigQuery INFORMATION_SCHEMA.JOBS](https://cloud.google.com/bigquery/docs/information-schema-jobs)
