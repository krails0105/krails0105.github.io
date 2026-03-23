---
title: "BigQuery Storage Write API 비용 구조 — Databricks에서 BQ 직접 적재 시 비용 분석"
date: 2026-03-06
categories: [DataEngineering]
tags: [BigQuery, Databricks, StorageWriteAPI, PySpark, DeltaLake, GCS]
---

### 들어가며

분산 ETL 파이프라인은 지금까지 `DW → OLTP → Analytics` 흐름으로 운영해왔다. PostgreSQL이 중간 버퍼 역할을 하는 구조인데, 실제로 PostgreSQL을 통해야 할 이유가 없다는 판단 아래 `Delta Lake → BigQuery` 직접 적재로 전환을 검토했다.

전환하면서 가장 먼저 확인해야 했던 것은 **비용**이었다. Spark BigQuery Connector의 `writeMethod` 옵션 하나에 따라 사용하는 GCP API가 완전히 달라지고, 비용 구조도 달라진다. 이 글에서는 `direct`와 `indirect` 두 방식의 차이, 실제 비용 추정, 그리고 직접 구현하면서 마주친 이슈들을 정리한다.

#### 이 글에서 다루는 내용

- Spark BigQuery Connector의 `writeMethod` 옵션별 동작 원리와 비용 구조
- BigQuery 전체 비용 항목 분석 (ingestion, storage, query)
- 중규모 프로젝트에서의 실제 비용 추정
- `direct` 방식 사용 시 마주치는 실전 이슈와 해결 패턴

#### 전제 조건

- Apache Spark 환경 (Databricks 또는 Dataproc)
- [spark-bigquery-connector](https://github.com/GoogleCloudDataproc/spark-bigquery-connector) 0.24.2 이상
- GCP 프로젝트 및 BigQuery 데이터셋
- Delta Lake 테이블 (CDF 기반 incremental 적재 시)

> **connector 버전 주의**: `direct` 방식은 반드시 **0.24.2 이상**을 사용해야 한다. 이전 버전에는 특정 조건에서 테이블이 삭제되는 버그가 있었다. ([GitHub 참고](https://github.com/GoogleCloudDataproc/spark-bigquery-connector))

### writeMethod 두 가지: direct vs indirect

Spark BigQuery Connector는 `writeMethod` 옵션으로 데이터를 BQ에 쓰는 방식을 선택한다. 기본값은 `indirect`다.

#### direct -- Storage Write API

```python
df.write.format("bigquery") \
    .option("writeMethod", "direct") \
    .option("credentials", bq_credentials_b64) \
    .option("writeDisposition", "WRITE_TRUNCATE") \
    .mode("overwrite") \
    .save(f"{BQ_PROJECT}.{BQ_DATASET}.{table_name}")
```

BigQuery Storage Write API를 직접 호출한다. Spark executor가 BQ로 데이터를 스트리밍 방식으로 밀어 넣는 구조다.

- **비용**: 월 2TB까지 무료, 초과분 **$0.025/GB**
- **속도**: GCS를 거치지 않아 레이턴시가 낮다
- **장점**: GCS temp bucket 불필요, 설정이 단순하다
- **제약**: `datePartition`, `partitionField`, `partitionType` 등 파티션 관련 옵션을 지원하지 않는다. 쓰기 대상 테이블이 미리 존재해야 안정적이다.

#### indirect -- Load API via GCS

```python
df.write.format("bigquery") \
    .option("writeMethod", "indirect") \
    .option("temporaryGcsBucket", "my-temp-bucket") \
    .mode("overwrite") \
    .save(f"{BQ_PROJECT}.{BQ_DATASET}.{table_name}")
```

Spark가 GCS 임시 버킷에 Parquet(또는 ORC, Avro) 파일을 저장하고, BQ Load Job을 트리거해서 그 파일을 BQ로 로드한다.

- **비용**: Load Job 자체는 무료 (shared slot pool 사용). GCS 스토리지 + 네트워크 비용만 발생
- **안정성**: 대용량 배치에 안정적이고 파티션/스키마 변경에 유연하다
- **제약**: `temporaryGcsBucket` 옵션이 **필수**다. GCS temp bucket의 생명주기 관리가 필요하고, GCS 경유로 레이턴시가 더 길다

#### 동작 흐름 비교

```
[direct]
  Spark Executor ──Storage Write API──→ BigQuery Table

[indirect]
  Spark Executor ──→ GCS (Parquet) ──Load Job──→ BigQuery Table
```

### BigQuery 전체 비용 구조

비용을 제대로 추정하려면 Storage Write API 외에도 BQ를 구성하는 모든 비용 항목을 봐야 한다.

| 항목 | 단가 | 비고 |
|------|------|------|
| **Storage Write API** (direct) | 2TB/월 무료, 이후 $0.025/GB | init + incremental 합산 기준 |
| **BQ Storage -- active** (logical) | $0.02/GB/월 | 최근 90일 내 수정된 테이블/파티션 |
| **BQ Storage -- long-term** (logical) | $0.01/GB/월 | 90일 이상 미수정 파티션, 자동 전환 |
| **Load Job** (indirect) | 무료 | 테이블당 일 1,500 job 제한 |
| **GCS temp** (indirect) | ~$0.02/GB/월 + 네트워크 | 임시 파일, 보통 write 후 바로 삭제 |
| **Query -- on-demand** | $6.25/TiB | 스캔량 기준, 월 1TiB까지 무료 |

몇 가지 주의할 점을 짚고 넘어가자.

**스토리지 과금 모델**: BQ는 logical 과금(기본값)과 physical 과금 두 모델을 제공한다. Physical 과금은 active $0.04/GB, long-term $0.02/GB로 2배 비싸지만, BQ가 내부적으로 압축한 크기 기준이라 압축률이 높은 데이터에서는 오히려 저렴할 수 있다. 위 표는 logical 과금 기준이다.

**쿼리 비용 단위**: on-demand 쿼리 비용은 **$6.25/TiB** (tebibyte = 1,099,511,627,776 bytes)다. TB(terabyte = 1,000,000,000,000 bytes)와 혼동하기 쉬운데, TiB 기준이므로 동일 데이터에 대해 TB 기준으로 환산하면 약 $5.68/TB 정도가 된다. BQ를 API 서빙 레이어로 쓴다면 쿼리 패턴에 따라 이 비용이 크게 달라질 수 있다. Materialized View, 파티션, 클러스터링으로 스캔량을 줄이는 것이 핵심이다.

**Load Job 일일 한도**: "일 1,500 job"은 **프로젝트 전체가 아니라 테이블당** 제한이다. 100개 테이블을 각각 일 10회 적재하는 것은 전혀 문제없다.

### 실제 비용 추정: 50GB 규모 프로젝트

프로젝트의 데이터 규모는 다음과 같다.

- 파생 지표 테이블: 약 100개
- 전체 데이터: 약 50GB (테이블 기준 대형 테이블 기준)
- 월간 incremental: ~1-2GB (신규 데이터 적재)
- Init (1회성): ~50GB write

이 규모에서의 비용 추정:

| 항목 | 추정 비용 | 근거 |
|------|-----------|------|
| Storage Write API (init 50GB) | 무료 | 2TB/월 한도 내 |
| Storage Write API (incremental 1-2GB/월) | 무료 | 2TB/월 한도 내 |
| BQ Storage (50GB active) | ~$1/월 | $0.02/GB x 50GB |
| Query 비용 | 별도 추산 필요 | 사용 패턴에 따라 상이 |

**결론: 쿼리를 제외하면 월 $1-5 수준.** 스케일이 수백 GB를 넘어가면 `indirect` 방식으로 Load Job(무료)을 활용하는 편이 Storage Write API 과금 구간을 피할 수 있다. 단, 2TB/월 무료 한도는 init + incremental 합산이므로, 매월 init을 반복하지 않는 한 50GB 규모에서 초과할 일은 거의 없다.

### 직접 구현하며 마주친 이슈들

#### 1. 스키마 불일치 시 direct write 실패

`direct` 방식에서 BQ 테이블 스키마와 DataFrame 스키마가 다르면, connector가 기존 테이블 스키마를 보존하려고 시도한다. 컬럼 타입이 호환되지 않으면 write가 실패하는데, 에러 메시지가 불명확한 경우가 있다.

가장 안전한 패턴은 init 시 Python SDK로 테이블을 명시적으로 DROP + CREATE한 뒤 write하는 것이다.

```python
from google.cloud import bigquery

client = bigquery.Client(credentials=gcp_credentials, project=BQ_PROJECT)

# 1) 명시적 DROP + CREATE (스키마 보장)
client.delete_table(BQ_TARGET, not_found_ok=True)
table = bigquery.Table(BQ_TARGET, schema=bq_schema)
table.time_partitioning = bigquery.TimePartitioning(field="timestamp")  # 필요 시
table.clustering_fields = ["partition_key"]  # 필요 시
client.create_table(table)

# 2) Storage Write API로 적재
df.write.format("bigquery") \
    .option("writeMethod", "direct") \
    .option("credentials", bq_credentials_b64) \
    .option("writeDisposition", "WRITE_TRUNCATE") \
    .mode("overwrite") \
    .save(BQ_TARGET)
```

DROP 직후 바로 Storage Write API를 호출하면 eventual consistency 문제로 "테이블을 찾을 수 없음" 에러가 날 수 있다. CREATE까지 완료된 뒤 write하면 이 문제를 회피할 수 있다.

#### 2. 언더스코어(`_`) 접두사 컬럼 충돌

Databricks 내부에서 `_partition_date` 같은 `_`로 시작하는 메타데이터 컬럼이 DataFrame에 붙어 있을 수 있다. BQ에서는 `_`로 시작하는 컬럼명 중 일부가 시스템 예약어이므로 적재 시 에러가 발생한다.

```python
# write 전에 메타 컬럼 제거
meta_cols = [c for c in df.columns if c.startswith("_")]
if meta_cols:
    df = df.drop(*meta_cols)
```

#### 3. `DECIMAL(38, 18)` -- BQ NUMERIC 변환 실패

Spark의 `DECIMAL(38, 18)` 타입은 BQ `NUMERIC` 타입으로 직접 매핑이 안 된다. BQ `NUMERIC`은 precision 38, **scale 9**까지만 지원하기 때문이다. `BIGNUMERIC`은 precision ~76, scale 38까지 지원하지만, Spark Connector가 자동으로 `BIGNUMERIC`을 선택하지 않는 경우가 있다.

해결 방법은 두 가지다.

| 방법 | 적합한 경우 | 코드 |
|------|------------|------|
| BQ 스키마에서 `BIGNUMERIC` 명시 | 정밀도가 중요한 금액 컬럼 | `bigquery.SchemaField("value", "BIGNUMERIC")` |
| write 전 `DOUBLE`/`STRING` 캐스팅 | 지표성 수치 (소수점 이하 9자리 이내) | `df.withColumn("col", col("col").cast("double"))` |

정밀도가 중요한 고정밀 금액 컬럼이라면 `BIGNUMERIC`을, 파생 지표(value_ratio, profit_ratio 등)라면 `DOUBLE` 캐스팅이 간단하다.

#### 4. Incremental 적재: CDF 기반 MERGE 패턴

Delta Lake CDF(Change Data Feed)를 활용한 incremental 적재는 staging table 경유 MERGE 패턴을 사용한다.

```python
## 1) CDF 읽기 -> BQ staging table에 direct write
cdf_df = spark.read.format("delta") \
    .option("readChangeData", "true") \
    .option("startingVersion", last_version) \
    .table("{catalog}.{schema}.{table}")

cdf_df.write.format("bigquery") \
    .option("writeMethod", "direct") \
    .option("credentials", bq_credentials_b64) \
    .mode("overwrite") \
    .save(f"{BQ_PROJECT}.{BQ_DATASET}.{table_name}_staging")

## 2) Python SDK로 MERGE INTO (update + insert + delete)
merge_query = f"""
MERGE `{BQ_TARGET}` T
USING `{BQ_STAGING}` S ON T.partition_key = S.partition_key
WHEN MATCHED AND S._change_type = 'delete' THEN DELETE
WHEN MATCHED AND S._change_type IN ('update_postimage') THEN
  UPDATE SET ...
WHEN NOT MATCHED AND S._change_type = 'insert' THEN
  INSERT ...
"""
client.query(merge_query).result()

## 3) staging table 정리
client.delete_table(BQ_STAGING, not_found_ok=True)
```

`_change_type` 컬럼은 CDF가 자동으로 붙여주는 컬럼이다. `update_preimage`(수정 전 값)와 `update_postimage`(수정 후 값)로 분리되므로, MERGE에서는 `update_postimage`만 처리하면 된다.

> **주의**: Delta Lake에서 `replaceWhere`로 overwrite하면 CDF에 동일 commit에서 delete + insert가 동시에 생긴다. BQ MERGE에서 이를 처리할 때 `_change_type` 기반 우선순위 로직이 필요할 수 있다.

### writeMethod 선택 기준 정리

| 상황 | 권장 방식 | 이유 |
|------|-----------|------|
| Init (수십 GB, 1회성) | `direct` | 2TB 무료 한도 내, GCS 불필요 |
| 월간 incremental (수 GB) | `direct` | 무료 구간 내, 레이턴시 낮음 |
| 대용량 배치 (수백 GB 이상) | `indirect` | Load Job 무료, 2TB 한도 회피 |
| 스키마/파티션 변경이 잦음 | `indirect` | 파티션 옵션 지원, 스키마 유연 |
| near-realtime 스트리밍 | `direct` | 레이턴시 최소화 |

이벤트 기반 데이터처럼 배치 단위 incremental이 소량(수십 MB/회)이고 init이 수십 GB 수준인 경우, **전량 `direct` 방식이 비용 효율적**이다. 2TB 무료 구간을 초과할 일이 거의 없기 때문이다.

### 흔한 실수와 주의 사항

**Storage Write API quota 초과**: `direct`만 사용하고 `indirect` fallback이 없으면, quota 초과 시 직접 에러가 난다. 대규모 병렬 적재 시 [quota 현황](https://cloud.google.com/bigquery/quotas)을 반드시 확인하자.

**BQ 쿼리 비용이 진짜 변수**: Storage Write API 비용은 이 규모에서 사실상 무료지만, BQ를 API 서빙 레이어로 쓰기 시작하면 스캔 비용이 급증할 수 있다. 파티션(예: `DATE(timestamp)`)과 클러스터링(예: `partition_key`) 설정을 테이블 생성 시점부터 잡아두는 것이 중요하다.

**Databricks Serverless에서 GCP credentials**: Serverless compute는 AWS IAM role을 사용하지 않는다. GCP credentials를 `dbutils.secrets`에서 읽어 `spark.conf`에 주입하거나, 노트북 레벨에서 `google-auth` 라이브러리로 직접 로드해야 한다.

**long-term storage 자동 전환**: 90일 이상 수정하지 않은 테이블/파티션은 자동으로 long-term($0.01/GB)으로 전환된다. 단순 쿼리(SELECT)는 "수정"에 해당하지 않으므로 타이머가 리셋되지 않는다. 파티션 단위로 적용되기 때문에, 오래된 파티션은 자연스럽게 비용이 절반으로 줄어든다.

### Reference

- [BigQuery pricing](https://cloud.google.com/bigquery/pricing) -- Storage Write API, Storage, Query 전체 비용
- [BigQuery data ingestion pricing](https://cloud.google.com/bigquery/pricing#data_ingestion_pricing) -- Load Job(무료) vs Storage Write API 비교
- [Spark BigQuery Connector -- GitHub](https://github.com/GoogleCloudDataproc/spark-bigquery-connector) -- writeMethod, 버전별 주의사항
- [BigQuery quotas and limits](https://cloud.google.com/bigquery/quotas) -- Load Job 일일 한도, Storage Write API quota
- [BigQuery data types](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types) -- NUMERIC(scale 9) vs BIGNUMERIC(scale 38) 상세
- [BigQuery Storage Write API 소개](https://cloud.google.com/bigquery/docs/write-api) -- API 동작 원리, exactly-once semantics
