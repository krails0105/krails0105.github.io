---
title: "[Spark Structured Streaming] Watermark, Output Mode, Exactly-Once 정리"
categories:
  - Spark
tags: [Spark, Structured Streaming, Watermark, Output Mode, Exactly-Once, 2PC, Idempotent]
---

## Introduction

---

Spark Structured Streaming으로 실시간 집계를 구현할 때 반드시 부딪히는 세 가지 질문이 있습니다.

1. 늦게 도착한 데이터를 얼마나 기다려야 하는가? -- **Watermark**
2. 결과를 어떤 방식으로 내보낼 것인가? -- **Output Mode**
3. 장애가 나도 중복 없이 정확히 한 번만 처리할 수 있는가? -- **Exactly-Once**

이 세 가지는 서로 연결되어 있습니다. Watermark를 잘못 이해하면 Output Mode 선택이 꼬이고, Output Mode를 잘못 고르면 Exactly-Once 보장이 무너집니다.

이 글에서는 각 개념의 동작 원리를 살펴본 뒤, 세 가지가 어떻게 맞물리는지 코드와 함께 정리합니다.

### 사전 지식

- Spark DataFrame / SQL 기본 사용법
- 스트리밍의 기본 개념 (이벤트 시각, 처리 시각)
- Kafka의 기본 구조 (토픽, 파티션, 오프셋)를 알면 3~4장 이해가 수월합니다

## 1. Watermark -- "여기까지만 기다리겠다"

---

스트리밍 데이터는 항상 순서대로 도착하지 않습니다. 네트워크 지연, 클라이언트 재전송 등으로 이벤트 시각이 5분, 10분 뒤처진 데이터가 들어올 수 있습니다. 이때 Spark가 "과거 모든 시간대"의 집계 상태를 메모리에 유지하면 결국 OOM이 발생합니다.

Watermark는 이를 막는 기준선입니다. **"MAX(eventTime) - 허용 지연"** 을 watermark로 설정하고, 그 이전 이벤트는 버립니다.

### 1.1 기본 사용법

```python
from pyspark.sql.functions import window

# events: eventTime 컬럼을 가진 스트리밍 DataFrame
windowed = (
    events
    .withWatermark("eventTime", "10 minutes")   # 최대 10분 지연 허용
    .groupBy(window("eventTime", "5 minutes"), "userId")
    .count()
)
```

`withWatermark`는 반드시 `groupBy` 이전에 호출해야 합니다. 순서가 바뀌면 Spark가 watermark를 인식하지 못합니다.

### 1.2 동작 방식

Watermark는 trigger마다 갱신됩니다. 구체적인 흐름은 다음과 같습니다.

1. 현재 micro-batch에서 Spark가 관찰한 MAX(eventTime)을 확인합니다
2. `watermark = MAX(eventTime) - 허용 지연`을 계산합니다
3. watermark 이전에 속하는 윈도우는 상태(state)에서 제거합니다
4. watermark 이후 이벤트는 계속 집계합니다

예를 들어 MAX(eventTime)이 `12:30`이고 허용 지연이 10분이면:

| 조건 | 결과 |
|------|------|
| watermark | `12:20` |
| `12:18`에 속하는 이벤트 | 버림 (watermark 이전) |
| `12:22`에 속하는 이벤트 | 집계에 포함 |
| `12:15~12:20` 윈도우의 상태 | 메모리에서 제거 |

### 1.3 Watermark를 설정하지 않으면

Watermark 없이 집계를 하면 Spark는 시작부터의 모든 윈도우 상태를 메모리에 보관합니다. 단시간 테스트에서는 문제없어 보여도, **장기 실행 잡에서는 상태가 무한히 증가하여 반드시 OOM이 발생합니다.** 스트리밍 집계에는 Watermark 설정이 필수라고 보면 됩니다.

### 1.4 여러 스트림을 조인하는 경우

스트림-스트림 조인에서는 각 입력 스트림에 개별 watermark를 설정할 수 있습니다.

```python
from pyspark.sql.functions import expr

# 각 스트림에 서로 다른 허용 지연을 설정
joined = (
    stream1.withWatermark("eventTime1", "1 hour")
    .join(
        stream2.withWatermark("eventTime2", "2 hours"),
        expr("eventTime1 >= eventTime2 AND eventTime1 <= eventTime2 + interval 1 hour")
    )
)
```

Spark는 여러 watermark 중 **가장 느린 watermark(min)**를 글로벌 watermark로 사용합니다. 이 정책은 `spark.sql.streaming.multipleWatermarkPolicy` 설정으로 변경할 수 있으며, 기본값은 `min`입니다. `max`로 설정하면 빠른 스트림 기준으로 동작하지만, 느린 스트림의 데이터 유실 가능성이 커집니다.

## 2. Output Mode -- 결과를 어떻게 내보낼 것인가

---

Structured Streaming은 세 가지 Output Mode를 제공합니다. 각 mode는 **"어떤 행을 싱크로 전달하는가"** 를 결정합니다.

| Mode | 출력 내용 | 집계 필요 여부 | 적합한 싱크 |
|------|-----------|---------------|------------|
| **Complete** | 매 trigger마다 전체 결과 테이블 | 필수 | 대시보드, 인메모리 테이블 |
| **Append** | watermark를 지나 확정된 행만 (한 번) | 집계 시 Watermark 필수 | 파일, Kafka, 외부 DB |
| **Update** | 변경된 행만 | 선택 | DB(upsert), Kafka |

### 2.1 Complete Mode

```python
query = (
    windowed
    .writeStream
    .outputMode("complete")
    .format("memory")         # 인메모리 테이블로 출력
    .queryName("dashboard")
    .start()
)
```

매 micro-batch마다 집계 결과 **전체**를 다시 씁니다. 집계 없이는 사용할 수 없습니다(전체 원본 데이터를 메모리에 유지해야 하기 때문). 대시보드처럼 "현재 시점의 전체 집계"가 필요한 경우에 적합합니다.

**주의사항**: Complete Mode에서는 Watermark를 설정해도 오래된 상태가 제거되지 않습니다. 전체 결과를 매번 출력해야 하므로 모든 상태를 유지해야 하기 때문입니다.

### 2.2 Append Mode

```python
query = (
    windowed
    .writeStream
    .outputMode("append")
    .format("parquet")
    .option("path", "/output/path")
    .option("checkpointLocation", "/checkpoint/path")
    .start()
)
```

**Watermark를 지나 확정된 윈도우**만 한 번 출력합니다. 파일이나 Kafka처럼 "한 번 쓴 데이터는 수정할 수 없는" 싱크에 적합합니다.

집계와 함께 사용할 경우 Watermark가 반드시 있어야 합니다. Watermark가 없으면 Spark가 윈도우가 언제 확정되는지 판단할 수 없어 `AnalysisException`이 발생합니다. 집계 없는 단순 필터/변환에는 Watermark 없이도 Append Mode를 사용할 수 있습니다.

### 2.3 Update Mode

```python
query = (
    windowed
    .writeStream
    .outputMode("update")
    .foreachBatch(upsert_to_db)   # foreachBatch로 커스텀 쓰기 로직
    .start()
)
```

변경(신규 + 갱신)된 행만 출력합니다. DB에 upsert하는 패턴에 자주 쓰입니다. Complete보다 출력량이 적고, Append처럼 확정 대기 없이 즉시 결과를 반영할 수 있습니다.

집계가 없는 쿼리에서 Update Mode를 사용하면 Append Mode와 동일하게 동작합니다.

### 2.4 Output Mode 선택 기준 요약

| 상황 | 권장 Mode | 비고 |
|------|-----------|------|
| 집계 없음 (필터/변환만) | Append | Watermark 불필요 |
| 집계 + 실시간 업데이트 필요 | Update | DB upsert와 조합 |
| 집계 + 전체 결과 필요 | Complete | 상태 무한 증가 주의 |
| 집계 + 파일/Kafka 출력 | Append | Watermark 필수 |

### 2.5 Output Mode와 Watermark 관계

Output Mode와 Watermark의 관계를 정리하면 다음과 같습니다.

| Mode | Watermark 유무 | 상태 정리 | 출력 시점 |
|------|---------------|-----------|-----------|
| Complete | 무관 | 정리 안 됨 (전체 유지) | 매 trigger |
| Append + 집계 | 필수 | watermark 이전 정리 | 윈도우 확정 시 |
| Append + 비집계 | 불필요 | 상태 없음 | 즉시 |
| Update | 선택 | watermark 있으면 정리 | 변경 시 |

## 3. Exactly-Once -- 진짜 한 번이 아니라 멱등성

---

분산 시스템에서 "물리적으로 정확히 한 번만 실행"은 불가능합니다. 장애가 나면 태스크는 재시도됩니다. Exactly-Once가 실제로 의미하는 것은 **"여러 번 실행해도 한 번 실행한 것과 같은 결과"**, 즉 멱등성(idempotency)입니다.

Structured Streaming에서 Exactly-Once는 세 가지 요소의 조합으로 보장합니다.

```
Exactly-Once = Replayable Source + Idempotent Sink + Checkpointing
```

각 요소의 역할은 다음과 같습니다.

| 요소 | 역할 | 예시 |
|------|------|------|
| **Replayable Source** | "어디서부터 다시 읽을지" 기록 가능한 소스 | Kafka offset, 파일 목록 |
| **Idempotent Sink** | 같은 데이터를 여러 번 써도 결과가 같은 싱크 | UPSERT, 파일 덮어쓰기 |
| **Checkpointing** | 처리 진행 상태(offset, watermark)를 저장 | HDFS/S3의 checkpoint 디렉토리 |

Spark 공식 문서에 따르면, 모든 스트리밍 소스는 오프셋(Kafka offset, Kinesis sequence number 등)을 가지며, 엔진은 checkpointing과 write-ahead log를 사용하여 각 trigger에서 처리하는 데이터의 오프셋 범위를 기록합니다.

### 3.1 멱등성 쓰기 구현 패턴

| 방식 | 멱등 여부 | 이유 |
|------|-----------|------|
| UPSERT (ON CONFLICT UPDATE) | O | 같은 키로 여러 번 써도 최종 값 동일 |
| Kafka produce (같은 키) | O | 같은 키 + idempotent producer 설정 시 |
| 파일 덮어쓰기 (같은 경로) | O | 같은 경로에 쓰면 내용 교체 |
| INSERT (PK 없이) | X | 재시도마다 행 추가 |
| `count += 1` 누적 | X | 재시도마다 증가 |
| 파일 append | X | 재시도마다 중복 행 추가 |

### 3.2 foreachBatch에서 batchId를 활용한 멱등성 확보

실무에서는 `foreachBatch`의 `batchId`를 활용하여 중복 처리를 방지합니다. 같은 batchId가 재시도로 다시 들어오면 skip하는 방식입니다.

```python
def upsert_to_db(batch_df, batch_id):
    """
    foreachBatch 콜백 함수.
    batch_id: Spark가 부여하는 micro-batch 고유 ID.
              장애 후 재시도 시 같은 batch_id로 다시 호출됨.
    """
    # 이미 처리한 batch_id이면 skip (멱등성 보장)
    if already_processed(batch_id):
        return

    # UPSERT 처리 (DB 테이블에 ON CONFLICT UPDATE)
    batch_df.write \
        .format("jdbc") \
        .option("url", "jdbc:postgresql://host:5432/mydb") \
        .option("dbtable", "target_table") \
        .option("batchsize", 1000) \
        .mode("append") \
        .save()

    # batch_id를 처리 완료로 기록
    mark_processed(batch_id)
```

**주의**: JDBC `.mode("overwrite")`는 테이블 전체를 DROP 후 재생성하므로 UPSERT와는 다릅니다. 실제 UPSERT를 구현하려면 JDBC 드라이버의 dialect를 커스터마이징하거나, `batch_df.collect()` 후 직접 SQL을 실행하는 방식을 사용해야 합니다.

## 4. 2-Phase Commit (2PC) -- Exactly-Once를 구현하는 프로토콜

---

Kafka sink나 파일 sink에서 Exactly-Once를 구현하는 데 2-Phase Commit 프로토콜이 사용됩니다. 이름 그대로 두 단계로 나뉩니다.

### Phase 1: Pre-commit (Write)

각 Task가 임시 영역에 데이터를 씁니다. 아직 확정하지 않습니다.

- **Kafka**: `transaction.begin()` -- 메시지를 트랜잭션 버퍼에 쓰기
- **File**: 임시 경로(`_temporary/`)에 파일 쓰기

### Phase 2: Commit or Abort

모든 Task가 성공했으면 확정, 하나라도 실패했으면 전체 롤백합니다.

- **Kafka**: `transaction.commit()` / `transaction.abort()`
- **File**: 임시 경로에서 최종 경로로 atomic rename / 실패 시 삭제

### 4.1 ForeachWriter로 2PC 패턴 구현하기

Spark의 `foreach` 싱크에서 커스텀 쓰기 로직을 구현할 때 `ForeachWriter` 클래스를 사용합니다. `open`, `process`, `close` 세 메서드가 2PC 구조에 대응됩니다.

```python
class MyExactlyOnceSink:
    """
    ForeachWriter 인터페이스 구현.
    open/process/close가 2PC의 각 단계에 대응됩니다.
    """

    def open(self, partition_id, epoch_id):
        """
        Phase 1 시작: 트랜잭션 열기.
        partition_id: 이 태스크가 담당하는 파티션 번호
        epoch_id: micro-batch ID (재시도 시 같은 값)
        -- epoch_id를 활용하면 멱등성을 보장할 수 있음
        """
        self.txn = begin_transaction()
        return True  # False를 반환하면 이 파티션을 skip

    def process(self, row):
        """임시 영역에 쓰기 (아직 commit 전)"""
        self.txn.write(row)

    def close(self, error):
        """
        Phase 2: 확정 또는 롤백.
        error가 None이면 commit, 아니면 abort.
        """
        if error is None:
            self.txn.commit()   # 확정
        else:
            self.txn.abort()    # 롤백

# 사용
query = (
    streamingDF.writeStream
    .foreach(MyExactlyOnceSink())
    .outputMode("update")
    .option("checkpointLocation", "/checkpoint/path")
    .start()
)
```

`epoch_id`는 Spark가 부여하는 micro-batch ID로, 장애 후 재시도 시에도 같은 값이 전달됩니다. 이를 활용하면 "이미 commit한 epoch이면 skip"하는 방식으로 멱등성을 보장할 수 있습니다.

### 4.2 장애 발생 시 복구 흐름

Phase 1에서 쓰고 Phase 2에서 commit하기 전에 장애가 나면 다음과 같이 복구됩니다.

```
1. Phase 1 완료, Phase 2 (commit) 전에 장애 발생
2. Spark가 checkpoint에서 마지막 성공 offset을 확인
3. 같은 데이터를 같은 epoch_id로 다시 Phase 1부터 수행
4. 임시 영역은 이미 정리(abort)되었거나 새 데이터로 덮어씌워짐
5. 중복 발생하지 않음
```

## 5. 전체 흐름 -- Watermark, Output Mode, Exactly-Once의 연결

---

세 가지 개념이 실제 스트리밍 파이프라인에서 어떻게 맞물리는지 정리합니다.

```
[Kafka Source] --읽기--> [Watermark 적용] --집계--> [Output Mode 결정] --쓰기--> [Idempotent Sink]
     |                       |                          |                           |
  Replayable            늦은 데이터 처리             어떤 행을 보낼지           멱등성 보장
  (offset 기록)         (상태 정리)                  결정                     (2PC / UPSERT)
                                                                                   |
                                              [Checkpoint] <--- 진행 상태 저장 ------+
```

| 단계 | 잘못된 설정 | 결과 |
|------|------------|------|
| Watermark 없이 집계 | 상태 무한 증가 | OOM |
| 집계 + Append인데 Watermark 없음 | 윈도우 확정 불가 | AnalysisException |
| Sink가 멱등하지 않음 | 재시도 시 중복 | Exactly-Once 깨짐 |
| Checkpoint 없음 | 재시작 시 처음부터 | 중복 처리 |

## 6. 핵심 정리

---

| 개념 | 핵심 한 줄 |
|------|-----------|
| Watermark | MAX(eventTime) - 허용 지연 이전 상태는 제거, OOM 방지 |
| Complete Mode | 전체 집계를 매 trigger마다 다시 씀, 집계 필수, 상태 정리 안 됨 |
| Append Mode | 확정된 윈도우만 한 번 씀, 집계 시 Watermark 필수 |
| Update Mode | 변경된 행만 씀, DB upsert에 적합, 비집계 시 Append와 동일 |
| Exactly-Once | 물리적 한 번 실행이 아닌 멱등성 보장 (Replayable + Idempotent + Checkpoint) |
| 2PC | Pre-commit(임시 쓰기) -- Commit/Abort(확정/롤백) |
| Idempotent Write | UPSERT, 파일 덮어쓰기, batchId/epochId 기반 중복 체크 |

## 7. 실무에서 자주 만나는 함정

---

| 함정 | 증상 | 해결 |
|------|------|------|
| `withWatermark`를 `groupBy` 뒤에 호출 | Watermark 미적용, 상태 무한 증가 | `withWatermark`는 반드시 `groupBy` 이전에 호출 |
| Complete Mode에서 Watermark로 메모리 절약 기대 | 상태가 줄지 않음 | Complete는 전체를 출력하므로 상태 정리 불가. Update 또는 Append 검토 |
| JDBC `.mode("overwrite")`를 UPSERT로 착각 | 테이블 전체 DROP 후 재생성 | 실제 UPSERT는 별도 구현 필요 |
| Checkpoint 경로를 변경 | 이전 진행 상태 소실, 처음부터 재처리 | Checkpoint 경로는 쿼리 생명주기 동안 고정 |
| 여러 쿼리가 같은 checkpoint 경로 사용 | 상태 충돌, 예측 불가 동작 | 쿼리마다 고유한 checkpoint 경로 할당 |

## Reference

---

- [Spark Structured Streaming Programming Guide -- Output Modes](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#output-modes)
- [Spark Structured Streaming -- Handling Late Data and Watermarking](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#handling-late-data-and-watermarking)
- [Spark Structured Streaming -- Fault Tolerance Semantics](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#fault-tolerance-semantics)
- [Spark Structured Streaming -- Using Foreach and ForeachBatch](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html#using-foreach-and-foreachbatch)
