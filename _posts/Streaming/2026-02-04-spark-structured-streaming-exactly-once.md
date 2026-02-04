---
title: "[Spark Structured Streaming] Exactly-Once 보장 이해하기"
categories:
  - Streaming
tags:
  - [Spark, StructuredStreaming, ExactlyOnce, Checkpoint, Streaming]
---

# Introduction

---

Spark Structured Streaming에서 "Exactly-once"는 배치처럼 "한 번만 처리"가 아니라, **장애/재시도 상황에서도 결과가 논리적으로 한 번만 반영되게** 하는 보장입니다.

하지만 이 보장은 **조건부**입니다. 어떤 sink를 쓰는지, checkpoint를 어떻게 두는지에 따라 달라집니다.

# 1. Exactly-Once의 핵심

---

스트리밍은 장애가 나면 같은 데이터를 다시 처리할 수밖에 없습니다.

따라서 Exactly-once는:
- **재처리(replay)**가 발생해도
- 결과가 **중복으로 반영되지 않도록**
- 진행 상태(offset/commit)와 결과 반영을 결합하는 개념입니다.

```
장애 발생 시:
1. 마지막 성공 checkpoint에서 복구
2. 그 시점부터 다시 처리
3. 결과는 논리적으로 한 번만 반영됨
```

# 2. Checkpoint가 하는 일

---

Structured Streaming의 checkpoint에는 두 가지가 저장됩니다:

| 저장 내용 | 설명 |
|----------|------|
| Source offset | 어디까지 읽었는지 (Kafka offset 등) |
| State metadata | Stateful 연산의 상태 (집계, 윈도우 등) |

```python
# Checkpoint 설정
query = df.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "/path/to/checkpoint") \
    .start()
```

## Checkpoint가 없으면?

- 장애 복구가 "처음부터" 시작됨
- 중복 처리 가능성 증가
- 상태(state)가 유실됨

## Checkpoint 저장소 권장

```python
# 안정적인 분산 스토리지 사용
# S3, ADLS, GCS 등
.option("checkpointLocation", "s3://bucket/checkpoints/job-name")
```

# 3. Sink가 Exactly-Once를 좌우한다

---

Spark의 Exactly-once는 sink가 **idempotent/transactional** 할수록 강해집니다.

| Sink 유형 | Exactly-Once 지원 |
|----------|-------------------|
| Delta Lake | **강함** (commit protocol) |
| Parquet/파일 | 강함 (atomic commit) |
| Kafka | 트랜잭션 설정 필요 |
| JDBC/외부 DB | **멱등 처리 필수** |
| HTTP/API | **at-least-once + 멱등 설계** |

## 외부 DB 예시

```python
# 멱등 처리 설계
def write_to_db(batch_df, batch_id):
    # UPSERT로 중복 방지
    batch_df.createOrReplaceTempView("batch_data")
    spark.sql("""
        MERGE INTO target t
        USING batch_data s ON t.id = s.id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
    """)

df.writeStream \
    .foreachBatch(write_to_db) \
    .option("checkpointLocation", "/path/to/checkpoint") \
    .start()
```

# 4. Trigger 이해하기

---

Trigger는 마이크로배치 실행 주기를 결정합니다.

```python
from pyspark.sql.streaming import Trigger

# 주기 기반 (기본)
.trigger(processingTime="10 seconds")

# 한 번만 실행
.trigger(once=True)

# 현재 데이터만 처리하고 종료 (Spark 3.3+)
.trigger(availableNow=True)

# 연속 처리 (실험적)
.trigger(continuous="1 second")
```

| Trigger | 용도 |
|---------|------|
| processingTime | 일반 스트리밍 |
| once | 백필/테스트 |
| availableNow | 배치 스타일 증분 |

**중요:** Trigger는 latency/리소스에 영향을 주지만, Exactly-once의 본질은 checkpoint + sink에서 결정됩니다.

# 5. Watermark와 Late Data

---

Watermark는 이벤트 시간 기반 집계에서 늦게 도착한 데이터를 어떻게 처리할지 결정합니다.

```python
from pyspark.sql.functions import window, col

df.withWatermark("event_time", "10 minutes") \
  .groupBy(
      window(col("event_time"), "5 minutes"),
      col("user_id")
  ).count()
```

## Watermark의 역할

| 역할 | 설명 |
|------|------|
| Late data 통제 | 지정 시간 초과 데이터 무시 |
| State 정리 | 오래된 상태 메모리 해제 |
| 진행 추적 | 어느 시점까지 완료되었는지 |

## 주의사항

```python
# Watermark가 너무 짧으면: 정상 데이터도 버려짐
.withWatermark("event_time", "1 second")  # 위험!

# Watermark가 너무 길면: 상태가 커져 OOM
.withWatermark("event_time", "7 days")  # 메모리 주의
```

# 6. Output Mode

---

```python
# Append: 새 row만 출력 (watermark 필요)
.outputMode("append")

# Complete: 전체 결과 출력 (집계에서)
.outputMode("complete")

# Update: 변경된 row만 출력
.outputMode("update")
```

| Mode | 용도 | 제약 |
|------|------|------|
| append | 로그/이벤트 적재 | watermark 필요(집계 시) |
| complete | 대시보드/리포트 | 결과가 작을 때 |
| update | 증분 업데이트 | 일부 sink만 지원 |

# 7. 실전 예제: Kafka → Delta

---

```python
# Kafka에서 읽기
kafka_df = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .option("startingOffsets", "earliest") \
    .load()

# 파싱
from pyspark.sql.functions import from_json, col
from pyspark.sql.types import StructType, StringType, TimestampType

schema = StructType() \
    .add("event_id", StringType()) \
    .add("user_id", StringType()) \
    .add("event_time", TimestampType()) \
    .add("data", StringType())

parsed = kafka_df \
    .select(from_json(col("value").cast("string"), schema).alias("event")) \
    .select("event.*")

# Watermark + 집계
aggregated = parsed \
    .withWatermark("event_time", "10 minutes") \
    .groupBy(
        window(col("event_time"), "1 hour"),
        col("user_id")
    ).count()

# Delta에 쓰기
query = aggregated.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "/checkpoints/kafka-to-delta") \
    .start("/warehouse/event_counts")
```

# 8. 장애 복구 테스트

---

```python
# 1. 스트림 시작
query = df.writeStream...start()

# 2. 일부 데이터 처리 후 강제 종료
query.stop()

# 3. 동일 checkpoint로 재시작
query = df.writeStream \
    .option("checkpointLocation", "/same/checkpoint") \
    .start()

# 4. 결과 검증
# - 중복 없이 이어서 처리되는지 확인
# - 상태가 복구되는지 확인
```

# 9. 체크리스트

---

```
□ Checkpoint 경로가 안정적인 저장소(S3/ADLS/GCS)에 있는가?
□ Sink가 idempotent/transactional 한가?
   → 아니면 멱등 설계(UPSERT/멱등키)를 했는가?
□ Watermark/상태 TTL 설정으로 state가 무한정 커지지 않게 했는가?
□ 장애 복구 시 중복/유실이 없는지 테스트했는가?
□ Checkpoint 저장소에 충분한 용량과 권한이 있는가?
```

# Reference

---

- [Spark Structured Streaming Guide](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html)
- [Checkpointing](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#recovering-from-failures-with-checkpointing)
- [Watermark](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#handling-late-data-and-watermarking)
