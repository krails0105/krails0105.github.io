---
title: "[Streaming] Flink vs Spark Streaming - 어떤 엔진을 선택할까?"
categories:
  - Streaming
tags:
  - [Flink, Spark, Streaming, Comparison, Architecture]
---

# Introduction

---

스트리밍 엔진을 비교할 때 "누가 더 빠르다"보다 중요한 건 **어떤 운영 요구사항에 맞는가**입니다.

이 글은 Flink와 Spark Structured Streaming을 다음 축으로 비교합니다:
- 처리 모델(레코드 기반 vs 마이크로배치)
- 지연(latency) 특성
- 상태(state) 관리
- Exactly-once/체크포인트
- 운영 편의성

# 1. 처리 모델

---

## Flink

**진정한 스트리밍** - 레코드/이벤트 단위로 처리합니다.

```
이벤트 → 연산자 → 이벤트 → 연산자 → 결과
        (레코드 하나씩 흐름)
```

- 낮은 지연에 강함
- 이벤트 시간 처리가 정교함

## Spark Structured Streaming

**마이크로배치** - 주기적으로 작은 배치를 처리합니다.

```
[이벤트 묶음] → 배치 처리 → 결과
  (10초마다)
```

- 배치 생태계(Spark SQL, Delta 등)와 통합이 강함
- 배치와 스트리밍 코드 일관성

## 비교

| 항목 | Flink | Spark Structured Streaming |
|------|-------|---------------------------|
| 모델 | 레코드 단위 스트리밍 | 마이크로배치 |
| 최소 지연 | 수십~수백 ms | 수백 ms~수초 |
| 배치 통합 | 별도 관리 필요 | 동일 API (Spark SQL) |

# 2. 지연과 처리량

---

## 지연 요구사항 기준

| 요구사항 | 권장 엔진 |
|----------|----------|
| 수십 ms 실시간 | Flink |
| 수백 ms~수초 | 둘 다 가능 |
| 수초~분 허용 | Spark (배치 생태계 활용) |

## 처리량 관점

- **Flink**: 레코드 단위 처리로 오버헤드가 있지만, 파이프라인 병렬화로 높은 처리량 가능
- **Spark**: 배치 처리 최적화로 대량 데이터에 강함

## 실제 선택 시

```
"초저지연(수백 ms 미만)이 정말 필요한가?"
├─ Yes → Flink 우선 고려
└─ No → 기존 스택/생태계 기준으로 선택
```

# 3. 상태(State) 관리

---

둘 다 Stateful 연산을 지원하지만, 상태 저장 모델이 다릅니다.

## Flink State

```java
// Flink 상태 예시
ValueState<Long> countState = getRuntimeContext()
    .getState(new ValueStateDescriptor<>("count", Long.class));

Long current = countState.value();
countState.update(current + 1);
```

- **State Backend**: RocksDB, FsState, Memory
- RocksDB로 대용량 상태를 디스크에 저장 가능
- Checkpoint 시 상태 스냅샷

## Spark State

```python
# Spark Structured Streaming 상태 예시
def update_state(key, values, state):
    current = state.get() or 0
    new_count = current + sum(values)
    state.update(new_count)
    return (key, new_count)

df.groupByKey(lambda x: x.user_id) \
  .mapGroupsWithState(update_state, outputMode="update")
```

- **State Store**: HDFS/Cloud Storage 기반
- 마이크로배치 커밋 시 상태 저장
- Checkpoint + WAL(Write-Ahead Log)

## 비교

| 항목 | Flink | Spark |
|------|-------|-------|
| Backend | RocksDB, Memory | HDFS-based |
| 대용량 상태 | RocksDB로 디스크 활용 | 메모리 기반 (제한적) |
| 저장 시점 | Checkpoint 주기 | 마이크로배치 커밋 |

# 4. Exactly-Once / Checkpoint

---

## Flink Checkpoint

```
Source → Barrier → Operator → Barrier → Sink
          ↓           ↓           ↓
      [Checkpoint Storage에 상태 저장]
```

- **Barrier Alignment**: 정확한 스냅샷
- Checkpoint 주기로 복구 지점 결정
- Two-Phase Commit으로 sink까지 exactly-once

## Spark Checkpoint

```
[마이크로배치 N] → 처리 → 커밋 → [Checkpoint]
                              ↓
                    [offset + state 저장]
```

- 배치 단위 커밋
- Sink 특성에 따라 exactly-once 수준 결정

## 비교

| 항목 | Flink | Spark |
|------|-------|-------|
| 메커니즘 | Barrier + 2PC | 배치 커밋 |
| 복구 단위 | Checkpoint | 마이크로배치 |
| Sink 요구 | 2PC 지원 필요 | Idempotent 권장 |

# 5. 운영 관점 비교

---

## 모니터링

| 항목 | Flink | Spark |
|------|-------|-------|
| Web UI | Flink Dashboard | Spark UI |
| 메트릭 | Prometheus 연동 | Spark Metrics |
| 상태 가시성 | State 크기 모니터링 | State Store 모니터링 |

## 배포/확장

| 항목 | Flink | Spark |
|------|-------|-------|
| 클러스터 | Standalone, YARN, K8s | Standalone, YARN, K8s |
| 동적 확장 | Reactive Mode (K8s) | Dynamic Allocation |
| 롤링 업데이트 | Savepoint 기반 | Checkpoint 기반 |

## 학습 곡선

| 항목 | Flink | Spark |
|------|-------|-------|
| API | DataStream, Table | DataFrame, SQL |
| 개념 | Process Function, State | 배치 개념 확장 |
| 기존 지식 | 별도 학습 필요 | Spark 경험 활용 |

# 6. 선택 가이드

---

## Spark가 유리한 경우

```
□ 이미 Spark/Delta 기반 레이크하우스 운영 중
□ 배치와 스트리밍 코드 일관성이 중요
□ 수초~분 단위 지연이 허용됨
□ SQL 기반 분석이 많음
□ 팀이 Spark에 익숙함
```

## Flink가 유리한 경우

```
□ 수백 ms 미만 초저지연 필수
□ 복잡한 이벤트 시간/윈도우 처리
□ 대용량 상태 관리 (RocksDB)
□ 세밀한 제어가 필요 (Process Function)
□ 실시간 알림/이상 탐지
```

## 결정 플로우차트

```
지연 SLA가 수백 ms 미만인가?
├─ Yes → Flink 우선 검토
└─ No → 기존 Spark 생태계가 있는가?
          ├─ Yes → Spark Structured Streaming
          └─ No → 팀 역량/선호도 기준 선택
```

# 7. 하이브리드 접근

---

많은 조직에서 둘 다 사용합니다:

```
실시간 알림/이상 탐지 → Flink
대용량 ETL/분석 → Spark Structured Streaming
레이크하우스 적재 → Spark + Delta
```

## 데이터 공유

- 둘 다 Kafka를 소스/싱크로 활용 가능
- Iceberg/Delta로 테이블 포맷 공유
- 상태는 각 엔진에서 독립 관리

# 8. 체크리스트

---

```
□ 요구 지연(SLA)이 얼마인가?
□ 이벤트 타임 윈도우/late data 처리가 얼마나 복잡한가?
□ 상태 크기가 얼마나 커질 수 있는가?
□ 운영 팀의 스택(Spark/Delta vs Flink)과 모니터링 역량은?
□ 장애 복구/재처리 전략을 명확히 했는가?
□ 배치/SQL 생태계와의 통합이 중요한가?
```

# Reference

---

- [Spark Structured Streaming](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html)
- [Flink Documentation](https://nightlies.apache.org/flink/flink-docs-stable/)
- [Flink vs Spark Streaming](https://flink.apache.org/what-is-flink/flink-vs-spark/)
