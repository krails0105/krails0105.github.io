---
title: "Flink TaskManager 메모리 모델 해부 -- Web UI로 읽는 각 영역의 의미"
categories:
  - Flink
tags: [Flink, Memory, TaskManager, RocksDB, JVM, Heap, Off-Heap, Managed Memory]
---

## 개요

Flink 잡을 EKS에 배포하고 Web UI(`:8081`)를 열면 TaskManager 탭에서 아래와 같은 메모리 지표가 보인다.

```
Physical Memory   JVM Heap Size   Flink Managed Memory   Free/All Slots   CPU Cores
1024 MB           149 MB          230 MB                 0 / 1            1
```

처음 보면 영역이 너무 많아서 무엇을 봐야 할지 모른다. 특히 **Managed Memory 100%** 같은 숫자는 잡이 죽기 직전인 것처럼 보이지만, 실제로는 정상이다. 이 글에서는 각 메모리 영역이 어떤 역할을 하는지, 언제 이상 신호인지, 튜닝 포인트는 어디인지를 정리한다.

**이 글을 읽고 나면** Web UI의 메모리 지표를 보고 정상/이상을 판단할 수 있고, 상황별로 어떤 설정을 조정해야 하는지 알 수 있다.

---

## 사전 지식 -- Heap vs Off-Heap

Flink 메모리를 이해하려면 JVM의 두 가지 메모리 공간을 먼저 구분해야 한다.

| 구분 | 설명 | GC 대상 |
|------|------|---------|
| **Heap** | `new Object()`로 할당되는 공간. JVM이 관리한다. | O |
| **Off-Heap** | JVM 바깥의 네이티브 메모리. `ByteBuffer.allocateDirect()`나 C++ 라이브러리가 직접 사용한다. | X |

**왜 Off-Heap을 쓸까?** RocksDB는 C++ 라이브러리다. 대용량 상태를 Heap에 올리면 GC의 Stop-the-World(STW)가 발생해 처리 지연이 튄다. Off-Heap에 올리면 GC 영향 없이 안정적인 레이턴시를 유지할 수 있다.

---

## TaskManager 메모리 구조 전체 그림

Flink 공식 문서 기준으로, TaskManager 메모리는 아래 구조로 구성된다.

```
+-----------------------------------------------------------+
|                   Total Process Memory                    |
|  +------------------------------+  +-------------------+  |
|  |       Total Flink Memory     |  |  JVM Metaspace    |  |
|  |  +----------+-------------+  |  |  JVM Overhead     |  |
|  |  | JVM Heap | Off-Heap    |  |  +-------------------+  |
|  |  |          |             |  |                          |
|  |  | Framework| Framework   |  |                          |
|  |  |   Heap   |  Off-Heap   |  |                          |
|  |  +----------+-------------+  |                          |
|  |  |  Task    |    Task     |  |                          |
|  |  |   Heap   |  Off-Heap   |  |                          |
|  |  +----------+-------------+  |                          |
|  |  +-------------------------+ |                          |
|  |  |    Managed Memory       | |                          |
|  |  |    (RocksDB 등)         | |                          |
|  |  +-------------------------+ |                          |
|  |  |    Network Memory       | |                          |
|  |  +-------------------------+ |                          |
|  +------------------------------+                          |
+-----------------------------------------------------------+
```

핵심 관계를 정리하면 다음과 같다.

- **Total Process Memory** = Total Flink Memory + JVM Metaspace + JVM Overhead
- **Total Flink Memory** = (Framework Heap + Task Heap) + (Framework Off-Heap + Task Off-Heap) + Managed Memory + Network Memory
- **JVM `-Xmx`** = Framework Heap + Task Heap (Web UI의 "JVM Heap Size"가 이 값이다)
- **JVM `-XX:MaxDirectMemorySize`** = Framework Off-Heap + Task Off-Heap + Network Memory

바깥부터 안으로 들어가며 각 영역을 살펴보자.

---

## 각 메모리 영역 상세

### Framework Heap -- 128 MB (기본값), 35.4% 사용

**역할**: Flink 프레임워크 자체가 쓰는 Heap. 네트워크 스택, 체크포인트 코디네이션 등 Flink 내부 코드가 여기서 동작한다.

**모니터링 포인트**: 평소에는 건드릴 일이 없다. 사용률이 비정상적으로 높거나 계속 올라간다면 Flink 내부 이슈일 가능성이 크다. 사용자 코드 문제가 아니므로 Flink 버전이나 설정을 점검한다.

**튜닝**: 기본값(128 MB)을 유지하는 것이 원칙이다.

```yaml
# 변경이 필요한 경우에만 (권장하지 않음)
taskmanager.memory.framework.heap.size: 128m
```

---

### Task Heap -- 사용자 코드의 핵심 영역

**역할**: 실제 사용자 코드가 쓰는 Heap. 우리가 작성한 `MapFunction`, `ProcessFunction`, 내부 HashMap, 이벤트 객체 등이 모두 여기에 올라간다.

Web UI에서 "JVM Heap Size"는 Framework Heap + Task Heap을 합산해서 표시한다. 예를 들어 `52.7 MB / 149 MB`라면 Task Heap 여유가 아직 넉넉하다는 뜻이다.

> Task Heap 크기를 명시적으로 지정하지 않으면, Flink가 Total Flink Memory에서 다른 영역을 모두 빼고 남은 부분을 자동으로 할당한다.

**모니터링 포인트**: 사용률이 지속적으로 높거나 GC가 잦아지면 Task Heap이 부족하다는 신호다. 이 상태가 계속되면 `OutOfMemoryError: Java heap space`로 잡이 죽는다.

**튜닝**:

```yaml
# 방법 1: Task Heap을 명시적으로 지정
taskmanager.memory.task.heap.size: 512m

# 방법 2: TM 전체 메모리를 늘려서 Task Heap 비율도 함께 늘림
taskmanager.memory.process.size: 2048m
```

> 공식 문서에서는 Task Heap과 Managed Memory를 동시에 명시적으로 지정하고, Total Process Memory나 Total Flink Memory는 설정하지 않는 방식을 권장한다. 이렇게 하면 다른 영역과의 충돌을 방지할 수 있다.

---

### Managed Memory -- 230 MB, 100%는 정상이다

**역할**: RocksDB State Backend의 Off-Heap 전용 공간. `state.backend.rocksdb.memory.managed` 옵션이 `true`(기본값)이면, Flink가 이 Managed Memory 예산 안에서 RocksDB의 메모리를 자동으로 관리한다.

구체적으로 Managed Memory는 다음 세 가지 용도로 나뉜다.

| 용도 | 비율 (기본값) | 설정 키 |
|------|---------------|---------|
| Write Buffer (쓰기 버퍼) | 50% | `state.backend.rocksdb.memory.write-buffer-ratio` |
| High-Priority Pool (인덱스/필터) | 10% | `state.backend.rocksdb.memory.high-prio-pool-ratio` |
| Block Cache (읽기 캐시) | 나머지 40% | (자동 계산) |

**100%가 정상인 이유**: `state.backend.rocksdb.memory.managed: true`일 때, Flink는 Managed Memory 전체를 RocksDB에 할당한다. RocksDB의 Block Cache, Write Buffer, 인덱스/필터용 메모리가 시작 시점에 예약되기 때문에, 실제 키-값 데이터가 많지 않아도 Web UI에서는 100%로 보인다. 잡이 정상 동작 중이라면 걱정하지 않아도 된다.

**언제 늘려야 하나**: State에 저장하는 키 수가 매우 많아지거나, RocksDB compaction이 느려지기 시작하면 늘린다.

```yaml
# 크기를 직접 지정
taskmanager.memory.managed.size: 512m

# 또는 Total Flink Memory 대비 비율로 지정 (기본값 0.4)
taskmanager.memory.managed.fraction: 0.4
```

> **참고**: `state.backend.rocksdb.memory.fixed-per-slot`을 설정하면 Managed Memory 대신 슬롯별 고정 메모리를 사용할 수도 있다. 이 옵션은 `managed` 설정보다 우선한다.

---

### Framework Off-Heap -- 128 MB

**역할**: Flink 프레임워크의 Off-Heap 메모리. Netty 기반 네트워크 통신 등 Flink 내부에서 Direct Memory를 사용하는 부분이 해당된다.

**모니터링**: Web UI에서 "unmeasurable"로 표시되는 경우가 많다. 직접 튜닝할 일은 거의 없다.

---

### Task Off-Heap -- 0 B (기본값)

**역할**: 사용자 코드가 직접 Off-Heap을 쓸 때 할당되는 영역. 일반적인 Java 코드는 Off-Heap을 직접 다루지 않으므로 대부분 0 B다.

**언제 필요한가**: `ByteBuffer.allocateDirect()`를 쓰거나 JNI 라이브러리를 호출하는 경우. 이런 경우에만 아래 설정을 추가한다.

```yaml
taskmanager.memory.task.off-heap.size: 256m
```

---

### Network Memory -- 64 MB, 0.88% 사용

**역할**: Operator 간 데이터 셔플에 사용하는 네트워크 버퍼 풀. 업스트림 Operator가 생산한 데이터를 다운스트림으로 넘길 때 잠시 여기에 쌓인다.

**현재 0.88%인 이유**: parallelism=1이면 Operator 간 네트워크 전송이 거의 발생하지 않는다. 같은 TM 안에서 직접 전달(local exchange)되기 때문이다.

**튜닝**: parallelism을 높이거나 Operator가 많아지면 Network 사용률이 올라간다. 버퍼 부족 시 `IOException: Insufficient number of network buffers`가 발생하며 backpressure로 이어진다.

```yaml
taskmanager.memory.network.fraction: 0.1   # 기본값 0.1
taskmanager.memory.network.min: 64mb       # 기본값 64 MB
taskmanager.memory.network.max: 1gb        # 기본값 1 GB
```

---

### JVM Metaspace -- 256 MB (기본값), 42.84% 사용

**역할**: 클래스 메타데이터 저장 공간. 로드된 클래스 수에 비례해 사용량이 올라간다.

**모니터링 포인트**: 장시간 실행에서 사용률이 계속 증가하면 클래스 로더 누수(classloader leak)를 의심한다. 일반적인 잡에서는 안정적인 편이다.

**튜닝**: UDF가 많거나 외부 라이브러리를 많이 쓰는 잡은 늘려야 할 수 있다.

```yaml
taskmanager.memory.jvm-metaspace.size: 512m
```

---

### JVM Overhead -- 192 MB

**역할**: GC 메타데이터, 스레드 스택, JVM 내부 구조물 등. JVM이 직접 관리하므로 Flink에서 측정하기 어렵다.

JVM Overhead는 Total Process Memory의 일정 비율로 설정되며, min/max 범위 내에서 결정된다.

```yaml
taskmanager.memory.jvm-overhead.fraction: 0.1   # 기본값 0.1
taskmanager.memory.jvm-overhead.min: 192mb      # 기본값 192 MB
taskmanager.memory.jvm-overhead.max: 1gb        # 기본값 1 GB
```

**모니터링**: `jstat`, `jcmd` 같은 JVM 진단 도구로 확인 가능하지만 Web UI에서는 보이지 않는다.

---

## 요약 -- 어디를 봐야 하나

| 영역 | 정상 신호 | 주의 신호 |
|------|-----------|-----------|
| Task Heap | 사용률 안정, GC 간헐적 | 사용률 지속 상승, Full GC 빈발 |
| Managed Memory | 100% (RocksDB 사전 예약) | OOM 또는 compaction 지연 |
| Network | parallelism 낮으면 한 자릿수% | backpressure 발생, 버퍼 부족 에러 |
| JVM Metaspace | 40~50% 수준 안정 | 장시간 계속 증가 (클래스 로더 누수) |
| Framework Heap | 30~40% 수준 | 비정상 급증 |

**Web UI Top 섹션 해석**:

| 항목 | 의미 |
|------|------|
| Physical Memory | K8s Pod에 할당된 전체 메모리 (예: 1024 MB) |
| JVM Heap Size | Framework Heap + Task Heap 합산 (`-Xmx` 값) |
| Flink Managed Memory | RocksDB 전용 예약 공간 |
| Free/All Slots | `0/1`이면 슬롯 1개를 잡이 점유 중 (정상) |
| CPU Cores | TM에 할당된 vCPU 수 |

---

## 튜닝 시나리오별 가이드

### 시나리오 1: Task Heap OOM

**증상**: `java.lang.OutOfMemoryError: Java heap space`, 잡 재시작 반복.

**원인**: 사용자 코드에서 생성하는 객체가 Task Heap을 초과. 대용량 컬렉션, 캐싱, 또는 State Backend가 HashMapStateBackend인 경우 State가 Heap에 쌓인다.

```yaml
# 총 TM 메모리를 먼저 올리고
taskmanager.memory.process.size: 2g
# Task Heap 명시적으로 지정
taskmanager.memory.task.heap.size: 512m
```

---

### 시나리오 2: RocksDB State 증가로 처리 지연

**증상**: State 키 수 증가, RocksDB compaction 빈도 증가, 처리량 감소.

**원인**: Managed Memory가 부족해 RocksDB의 Block Cache와 Write Buffer가 작아지면, 디스크 I/O가 늘어나면서 compaction이 느려진다.

```yaml
# Managed Memory 크기 증가
taskmanager.memory.managed.size: 1g

# (선택) Write Buffer 비율을 높여 쓰기 성능 개선
state.backend.rocksdb.memory.write-buffer-ratio: 0.6
```

---

### 시나리오 3: parallelism 증가 후 backpressure

**증상**: parallelism을 4에서 8로 올렸을 때 Network 버퍼 부족으로 backpressure 발생. `IOException: Insufficient number of network buffers` 로그가 보일 수 있다.

```yaml
taskmanager.memory.network.fraction: 0.15
taskmanager.memory.network.max: 2gb
```

---

### 시나리오 4: UDF가 많은 잡의 Metaspace OOM

**증상**: `java.lang.OutOfMemoryError: Metaspace`.

**원인**: 외부 라이브러리가 많거나, 동적 클래스 생성이 빈번한 경우.

```yaml
taskmanager.memory.jvm-metaspace.size: 512m
```

---

## 주의할 점과 흔한 실수

1. **`process.size`와 `task.heap.size`를 동시에 설정할 때 주의**: `process.size`를 지정하면 Flink가 나머지 영역을 자동 계산한다. `task.heap.size`까지 명시하면 계산이 맞지 않아 시작 시 에러가 날 수 있다. 공식 문서에서는 `task.heap.size` + `managed.size`를 명시하고 `process.size`는 생략하는 방식을 권장한다.

2. **Managed Memory 100%를 보고 메모리를 늘리는 실수**: 앞서 설명한 대로, RocksDB가 사전 예약하기 때문에 100%는 정상이다. 실제 문제는 compaction 지연이나 읽기 지연으로 나타난다.

3. **컨테이너 환경에서 `process.size`를 Pod 메모리와 동일하게 설정하는 실수**: JVM Overhead와 OS 레벨 메모리를 고려해 Pod 메모리보다 약간 작게 설정해야 한다. 그렇지 않으면 K8s OOMKilled가 발생한다.

---

## 정리

Flink TaskManager 메모리는 크게 세 덩어리로 나눌 수 있다.

1. **JVM Heap** (Framework + Task): 사용자 코드와 Flink 내부 코드가 사용. GC 영향을 받는다.
2. **Off-Heap** (Managed + Network + Framework/Task Off-Heap): RocksDB, 네트워크 셔플, Direct Memory 등. GC 영향을 받지 않는다.
3. **JVM Metaspace + Overhead**: JVM 내부 관리 공간. 일반적으로 안정적이다.

Web UI를 열었을 때 **Task Heap 사용률과 GC 빈도**, **Network의 backpressure 여부** 두 가지만 챙겨도 대부분의 메모리 이슈를 조기에 잡을 수 있다.

---

## Reference

- [Apache Flink -- Set up TaskManager Memory](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/memory/mem_setup_tm/)
- [Apache Flink -- Memory Configuration](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/#taskmanager-memory)
- [Apache Flink -- RocksDB State Backend Tuning](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/large_state_tuning/)
- [Apache Flink -- State Backends (RocksDB Memory Management)](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/state_backends/#memory-management)
- [Apache Flink -- Memory Troubleshooting](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/memory/mem_trouble/)
- 관련 포스트: [Flink + Kinesis EKS 배포 디버깅]({% post_url /Flink/2026-03-30-flink-kinesis-eks-deployment-debugging %})
