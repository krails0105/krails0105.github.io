---
title: "[Spark] EC2 인스턴스 타입 선택 - Spark 워크로드별 i3 vs r vs c 판단 기준"
categories:
  - Spark
tags:
  - [Spark, AWS, EC2, Performance, Shuffle, Memory, Infrastructure]
---

# Introduction

---

Spark 클러스터를 AWS에서 운영할 때, EC2 인스턴스 타입 선택은 성능과 비용에 직접적인 영향을 줍니다. "메모리가 부족하니까 r-type", "I/O가 느리니까 i-type"처럼 직관적으로 고르기 쉽지만, Spark의 내부 동작을 이해하면 **실제 병목에 맞는 선택**을 할 수 있습니다.

이 글은 Spark 워크로드에서 발생하는 세 가지 주요 병목(셔플, 메모리, 컴퓨트)과 각 병목에 적합한 인스턴스 타입을 정리합니다.

# 1. Spark의 리소스 사용 구조

---

Spark executor가 사용하는 리소스를 분해하면:

```text
┌─────────────────────────────────────────┐
│  Executor JVM Memory                      │
│  ┌─────────────────────────────────────┐ │
│  │  Unified Memory (spark.memory.fraction = 0.6)  │ │
│  │  ┌────────────────┬────────────────┐│ │
│  │  │ Execution (50%)│ Storage (50%)  ││ │
│  │  │ 셔플 버퍼       │ cache/persist  ││ │
│  │  │ 조인 해시 테이블 │ broadcast 변수 ││ │
│  │  │ 정렬 버퍼       │               ││ │
│  │  │ → 부족 시 spill │ → 부족 시 evict││ │
│  │  └────────────────┴────────────────┘│ │
│  │  (서로 여유 공간을 빌려 쓸 수 있음)     │ │
│  ├─────────────────────────────────────┤ │
│  │  User Memory (40%) + Reserved (300MB) │ │
│  │  - 사용자 데이터 구조, 내부 메타데이터  │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
          ↕ spill 발생 시
┌─────────────────────────────────────────┐
│  Local Disk (Shuffle / Spill)             │
│  - NVMe SSD (i3, r6id 등)                │
│  - EBS (r5, r6i, c5 등)                  │
│  → 셔플 write/read, 정렬 spill           │
└─────────────────────────────────────────┘
          ↕ 데이터 읽기/쓰기
┌─────────────────────────────────────────┐
│  Remote Storage (S3 / ADLS)               │
│  - Delta 테이블, Parquet 파일             │
│  → 높은 throughput, 높은 latency          │
└─────────────────────────────────────────┘
```

**핵심**: 병목이 어느 계층에서 발생하느냐에 따라 최적의 인스턴스가 달라집니다.

# 2. 세 가지 병목과 인스턴스 타입

---

## 병목 1: Shuffle / Disk I/O → Storage Optimized (i3, i4i, r6id)

### 셔플이 뭔가?

```text
GROUP BY, JOIN, DISTINCT, ORDER BY, Window 함수 등은
데이터를 키 기준으로 재분배(repartition)해야 합니다.

1. Shuffle Write: 각 executor가 데이터를 키별로 분류하여 로컬 디스크에 쓰기
2. Network Transfer: 다른 executor로 데이터 전송
3. Shuffle Read: 받은 데이터를 로컬 디스크에서 읽어 처리
```

이 과정에서 로컬 디스크 I/O가 집중적으로 발생합니다.

### Spill이 뭔가?

```text
Execution Memory가 부족하면:
  - 정렬 버퍼, 해시 테이블 등을 디스크로 "쏟아냄" (spill)
  - 이후 필요할 때 디스크에서 다시 읽음
  - 메모리 대비 디스크 I/O는 수십~수백 배 느림

비유: 책상(메모리)이 좁아서 서류를 바닥(디스크)에 내려놓고,
      필요할 때마다 다시 주워 올리는 것 → 당연히 느려짐
```

### 로컬 NVMe vs EBS

```text
NVMe SSD (i3.2xlarge 기준):
  - IOPS: ~200,000+ (random read)
  - Throughput: ~1.85 GB/s (sequential)
  - Latency: ~100μs

EBS gp3 (r5.2xlarge 기준):
  - IOPS: 3,000 (기본, 최대 16,000 provisioned)
  - Throughput: 125 MB/s (기본, 최대 1,000 MB/s provisioned)
  - Latency: ~1ms (네트워크 경유)
```

**NVMe는 EBS 대비 IOPS 10~60배, throughput 2~15배, latency 10배** 차이가 납니다. 셔플/spill이 큰 워크로드에서 이 차이는 직접적으로 stage 실행 시간에 반영됩니다.

### 적합한 경우

```text
✅ 대규모 셔플 (shuffle write/read > 수십 GB per stage)
✅ Spill (Disk)가 빈번 (Spark UI에서 확인)
✅ 대규모 range join, GROUP BY, Window 함수
✅ 대규모 UNION ALL 후 재집계
```

## 병목 2: Memory → Memory Optimized (r5, r6i, r7i)

### 메모리가 부족하면?

```text
Execution Memory 부족:
  → 디스크 spill 발생 → 느려짐
  → 극단적이면 OOM (OutOfMemoryError) → task 실패

Storage Memory 부족:
  → cache된 데이터가 eviction됨 → 다음 접근 시 재계산
  → broadcast 변수가 안 올라감 → BroadcastHashJoin 불가 → SortMergeJoin으로 퇴화
```

### 적합한 경우

```text
✅ cacheTable/persist 대상이 크고 재사용 빈번
✅ broadcast join에서 작은쪽 테이블이 경계값(10MB 기본)에 근접
✅ OOM이 간헐적으로 발생
✅ executor 메모리 대비 데이터 크기가 빡빡한 경우
```

### 메모리 최적화의 함정

```text
메모리를 늘려도 해결이 안 되는 경우:
  - 데이터 skew (특정 키에 데이터 집중) → 메모리가 아니라 파티션 전략 문제
  - 드라이버 OOM → executor 메모리가 아니라 driver 메모리 문제
  - Broadcast 실패 → 테이블이 너무 커서 broadcast 자체가 부적절
```

## 병목 3: CPU Compute → Compute Optimized (c5, c6i, c7i)

### 적합한 경우

```text
✅ UDF (User Defined Function) 연산이 많은 경우
✅ 복잡한 정규표현식, JSON 파싱, 암호화 연산
✅ ML 피처 엔지니어링 (수학 연산 집약)
✅ 셔플/메모리는 여유인데 CPU utilization이 높은 경우
```

대부분의 Spark SQL 워크로드(조인, 집계, 필터)는 I/O-bound이지 CPU-bound가 아닙니다. c-type이 적합한 경우는 상대적으로 드뭅니다.

# 3. 주요 인스턴스 비교 (2xlarge 기준)

---

| 인스턴스 | vCPU | RAM | 로컬 스토리지 | 네트워크 | 시간당 비용 | 특성 |
|---------|------|-----|-------------|---------|-----------|------|
| **i3.2xlarge** | 8 | 61 GB | 1.9 TB NVMe | ~10 Gbps | ~$0.624 | 대용량 NVMe |
| **r5.2xlarge** | 8 | 64 GB | EBS only | ~10 Gbps | ~$0.504 | 메모리 최적화 |
| **r6i.2xlarge** | 8 | 64 GB | EBS only | ~12.5 Gbps | ~$0.504 | r5 후속, 네트워크 개선 |
| **r6id.2xlarge** | 8 | 64 GB | 474 GB NVMe | ~12.5 Gbps | ~$0.576 | **메모리 + NVMe** |
| **c5.2xlarge** | 8 | 16 GB | EBS only | ~10 Gbps | ~$0.340 | CPU 최적화 |

> 가격은 us-east-1 on-demand 기준 참고값이며, 리전/결제 방식에 따라 다릅니다.

# 4. 같은 2xlarge에서 타입만 바꾸면?

---

i3.2xlarge → r5.2xlarge로 바꾸는 경우:

```text
RAM: 61 GB → 64 GB (+3 GB, 의미 없는 수준)
NVMe: 1.9 TB → 없음 (EBS로 대체)
비용: $0.624 → $0.504 (19% 절감)
```

**RAM 차이가 거의 없으므로**, 같은 사이즈에서 r-type으로 가는 건 "NVMe를 포기하고 비용을 절감"하는 것입니다. 셔플이 큰 워크로드라면 오히려 느려질 수 있습니다.

### r-type 전환이 의미 있으려면: 사이즈 업

```text
i3.2xlarge × 20대: 160 vCPU, 1,220 GB RAM, 38 TB NVMe → $12.48/hr
r5.4xlarge × 10대: 160 vCPU, 1,280 GB RAM, EBS only   → $10.08/hr

→ 같은 총 리소스, 19% 비용 절감
→ 단, NVMe 없으므로 셔플 성능 확인 필요
```

# 5. r6id: 메모리 + NVMe의 조합

---

r-type 중 **d 접미사**가 붙은 인스턴스(r6id, r7iz 등)는 로컬 NVMe SSD를 포함합니다.

```text
r6id.2xlarge: 8 vCPU, 64 GB RAM, 474 GB NVMe
r6id.4xlarge: 16 vCPU, 128 GB RAM, 950 GB NVMe
```

i3 대비 NVMe 용량은 작지만, Spark 셔플/spill 용도로는 충분한 경우가 많습니다:

```text
셔플 데이터가 노드당 수백 GB 수준: i3 (1.9TB) 필요
셔플 데이터가 노드당 수십~백 GB:  r6id (474GB~950GB) 충분
셔플 데이터가 노드당 수 GB:       EBS로도 OK (r5/r6i)
```

# 6. Spark UI에서 병목 확인하는 법

---

인스턴스를 바꾸기 전에, 현재 병목이 어디인지 확인해야 합니다.

## Shuffle 확인

```text
Spark UI → Stages 탭 → 특정 Stage 클릭

확인할 값:
  Shuffle Write Size: 이 stage가 쓴 셔플 데이터 크기
  Shuffle Read Size:  이 stage가 읽은 셔플 데이터 크기

판단:
  stage당 수십 GB 이상 → 셔플이 큰 워크로드
  stage당 수 GB 이하  → 셔플은 병목 아닐 가능성
```

## Spill 확인

```text
Spark UI → Stages 탭 → 특정 Stage → Task 목록

확인할 값:
  Spill (Memory): 메모리에서 spill된 데이터 크기 (직렬화 전)
  Spill (Disk):   디스크에 spill된 데이터 크기 (직렬화 후)

판단:
  Spill (Disk) > 0      → 메모리 부족으로 디스크 I/O 발생 중
  Spill (Disk) >> 셔플   → NVMe가 매우 중요
  Spill (Disk) = 0       → 메모리 충분, NVMe 덜 중요
```

## Memory 확인

```text
Spark UI → Executors 탭

확인할 값:
  Storage Memory: Used / Total → 캐시 사용률
  Peak JVM Memory Usage → 메모리 피크

판단:
  Storage Memory 90%+ → 캐시 eviction 발생 가능
  executor 빈번 재시작 → OOM 가능성
```

## 판단 흐름

```text
Spill (Disk) 크다?
  ├─ Yes → 로컬 NVMe 필요 (i3, r6id)
  └─ No
      ├─ Storage Memory 꽉 찼다? → RAM 늘리기 (r-type 사이즈 업)
      ├─ CPU utilization 높다?   → c-type 고려
      └─ 셔플 자체가 크다?       → 파티션 수 조정, pre-aggregation 먼저
```

# 7. 비용 최적화 조합

---

## Spot 인스턴스 활용

```text
History backfill은 중단 허용 가능 → Spot 적합

i3.2xlarge Spot: ~$0.19/hr (on-demand의 ~30%)
r5.2xlarge Spot: ~$0.15/hr

20대 × 수 시간 실행이면 Spot으로 70% 절감 가능
단, Spot 회수 시 체크포인트 필요 (Delta 테이블로 중간 결과 저장)
```

## 노드 수 vs 사이즈

```text
작은 노드 많이 vs 큰 노드 적게:
  - 작은 노드: 셔플 시 네트워크 전송 많음 (노드 간 통신)
  - 큰 노드: 셔플 데이터가 같은 노드 내에서 처리될 확률 높음
  - 큰 노드: broadcast join에서 메모리 여유

경험칙:
  4xlarge × 10대 > 2xlarge × 20대 (같은 총 리소스, 셔플 효율 상승)
```

# 8. 정리

---

| 병목 | 증상 | 적합한 인스턴스 |
|------|------|---------------|
| **Shuffle / Spill** | Spill (Disk) 큼, stage 시간 김 | i3, r6id (NVMe) |
| **Memory** | OOM, 캐시 eviction, broadcast 실패 | r5/r6i (사이즈 업) |
| **CPU** | CPU utilization 높음 | c5/c6i |
| **균형** | 셔플도 메모리도 적당 | r6id (NVMe + 메모리) |

```text
핵심:
  같은 사이즈에서 타입만 바꾸면 효과 제한적 (RAM 차이 미미)
  전환하려면 사이즈 업 + 노드 수 감소 조합이 실효적
  NVMe 유무는 셔플/spill 성능에 직접적 영향
  전환 전에 반드시 Spark UI로 현재 병목 확인
```

# Reference

---

- [AWS EC2 Instance Types](https://aws.amazon.com/ec2/instance-types/)
- [Spark Memory Management](https://spark.apache.org/docs/latest/tuning.html#memory-management-overview)
- [Databricks Cluster Configuration Best Practices](https://docs.databricks.com/en/clusters/cluster-config-best-practices.html)
- [Spark Monitoring - Web UI](https://spark.apache.org/docs/latest/monitoring.html)
