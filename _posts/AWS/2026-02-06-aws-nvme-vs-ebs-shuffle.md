---
title: "[AWS] NVMe vs EBS - Spark 셔플 성능에 로컬 디스크가 중요한 이유"
categories:
  - AWS
tags:
  - [AWS, EC2, NVMe, EBS, Spark, Shuffle, Spill, DiskIO]
---

# Introduction

---

Spark는 "인메모리 처리 엔진"이지만, 실제로는 **로컬 디스크를 빈번하게 사용**합니다. 셔플(Shuffle)과 스필(Spill) 과정에서 로컬 디스크 I/O가 발생하며, 이 디스크가 NVMe SSD인지 EBS 볼륨인지에 따라 성능이 **수 배~수십 배** 차이납니다.

이 글은 NVMe가 무엇인지, Spark에서 왜 중요한지, 그리고 어떤 워크로드에서 NVMe가 필수인지를 정리합니다.

# 1. NVMe란?

---

**NVMe (Non-Volatile Memory Express)**는 SSD를 CPU에 직접 연결하는 프로토콜입니다.

```text
EBS 방식 (원격 스토리지):
  CPU ──→ 네트워크 카드 ──→ AWS 네트워크 ──→ EBS 볼륨 (원격 SSD)

NVMe 방식 (로컬 스토리지):
  CPU ──→ PCIe 버스 ──→ NVMe SSD (같은 서버에 물리적으로 장착)
```

핵심 차이는 **네트워크를 경유하느냐(EBS), CPU에서 PCIe로 직접 접근하느냐(NVMe)**입니다. 비유하면 EBS는 택배로 물건을 받는 것이고, NVMe는 내 서랍에서 바로 꺼내는 것입니다. 이 경로 차이가 latency와 throughput에 직접적으로 반영됩니다.

# 2. 성능 비교: NVMe vs EBS

---

```text
                    NVMe SSD (i3.2xlarge)     EBS gp3 (r5.2xlarge)
─────────────────────────────────────────────────────────────────
IOPS (랜덤 읽기)    ~200,000+                 3,000 (기본)
                                              16,000 (최대 provisioned)

Throughput (순차)    ~1.85 GB/s                125 MB/s (기본)
                                              1,000 MB/s (최대 provisioned)

Latency             ~100 μs                   ~1 ms (1,000 μs)
─────────────────────────────────────────────────────────────────
IOPS 차이:          12~66배
Throughput 차이:    2~15배
Latency 차이:      10배
```

EBS gp3는 provisioned IOPS/throughput을 올릴 수 있지만, 추가 비용이 발생하고 NVMe의 기본 성능에 미치지 못합니다.

# 3. Spark에서 로컬 디스크를 쓰는 두 가지 경우

---

## 셔플 (Shuffle)

```text
GROUP BY, JOIN, ORDER BY, DISTINCT, Window 함수 등은
데이터를 키 기준으로 재분배(repartition)해야 합니다.

  Executor A                     Executor B
  ┌────────────┐                ┌────────────┐
  │ 데이터 처리   │                │ 데이터 처리   │
  │     ↓       │                │     ↓       │
  │ 셔플 Write   │ ──네트워크──→  │ 셔플 Read    │
  │ (로컬 디스크) │               │ (로컬 디스크) │
  └────────────┘                └────────────┘

1. Shuffle Write: 각 executor가 데이터를 키별로 분류하여 로컬 디스크에 씀
2. Network Transfer: 다른 executor로 데이터 전송
3. Shuffle Read: 받은 데이터를 로컬 디스크에서 읽어 처리
```

이 과정에서 **로컬 디스크 I/O가 집중적으로 발생**합니다. 셔플 데이터가 클수록 디스크 성능이 직접적으로 stage 실행 시간에 영향을 줍니다.

## 스필 (Spill)

```text
Executor의 Execution Memory가 부족하면:

  Executor JVM Memory
  ┌──────────────────────┐
  │ 정렬 버퍼, 해시 테이블   │ ← 메모리에 안 들어감
  │          ↓            │
  │    디스크로 "쏟아냄"     │ ← Spill
  └──────────────────────┘
           ↓
  ┌──────────────────────┐
  │ 로컬 디스크              │ ← 임시 저장
  │ (이후 다시 읽어야 함)     │
  └──────────────────────┘
```

Spill은 메모리에서 처리하지 못한 데이터를 디스크에 임시 저장했다가 다시 읽는 과정입니다. 메모리 대비 디스크 I/O는 수십~수백 배 느리지만, NVMe면 그 격차를 크게 줄일 수 있습니다.

# 4. 실제 성능 차이 예시

---

## 셔플 50GB인 stage

```text
NVMe (i3.2xlarge):
  Write: 50 GB / 1.85 GB/s ≈ 27초
  Read:  50 GB / 1.85 GB/s ≈ 27초
  총: ~54초

EBS gp3 기본 (r5.2xlarge):
  Write: 50 GB / 125 MB/s ≈ 400초 (6.7분)
  Read:  50 GB / 125 MB/s ≈ 400초 (6.7분)
  총: ~800초 (13.3분)

→ 같은 작업이 54초 vs 13분
```

## EBS Provisioned로 올리면?

```text
EBS gp3 최대 provisioned (1,000 MB/s):
  Write: 50 GB / 1 GB/s ≈ 50초
  Read:  50 GB / 1 GB/s ≈ 50초
  총: ~100초

→ NVMe(54초)에 근접하지만, IOPS에서 여전히 12배 차이
→ Provisioned 비용 추가 ($0.065/GB/month + $0.006/IOPS)
→ 랜덤 I/O 패턴에서는 throughput보다 IOPS가 병목
```

셔플은 순차 I/O와 랜덤 I/O가 혼재하므로, throughput만으로 성능을 판단할 수 없습니다. IOPS 차이(200K vs 16K)가 체감 성능에 더 크게 영향을 줍니다.

# 5. NVMe가 있는 EC2 인스턴스

---

| 인스턴스 | 유형 | NVMe 용량 | 특성 |
|---------|------|----------|------|
| **i3.2xlarge** | Storage Optimized | 1.9 TB | 대용량 NVMe, 셔플 집약 워크로드 |
| **i4i.2xlarge** | Storage Optimized | 1.875 TB | i3 후속, Nitro 기반 |
| **r6id.2xlarge** | Memory Optimized + NVMe | 474 GB | 메모리 + NVMe 조합 |
| **r6id.4xlarge** | Memory Optimized + NVMe | 950 GB | 대규모 메모리 + 충분한 NVMe |
| **c6id.2xlarge** | Compute Optimized + NVMe | 474 GB | CPU + NVMe 조합 |

> **d 접미사**: 인스턴스 이름에 `d`가 붙으면 로컬 NVMe SSD가 포함됩니다. (예: r6i**d**, c6i**d**)

## 셔플 규모별 인스턴스 선택

```text
셔플 데이터가 노드당 수백 GB:  i3 (1.9 TB) 필요
셔플 데이터가 노드당 수십~백 GB: r6id (474 GB~950 GB) 충분
셔플 데이터가 노드당 수 GB:     EBS로도 OK (r5/r6i)
```

# 6. NVMe의 주의사항

---

## 데이터 휘발성

```text
NVMe SSD는 "로컬" 디스크:
  인스턴스 Stop/Terminate → 데이터 삭제됨
  인스턴스 재부팅         → 데이터 유지

→ 영구 저장이 필요한 데이터는 S3/EBS에 저장해야 함
→ Spark 셔플/Spill은 임시 데이터이므로 NVMe에 적합
```

## 용량 관리

```text
NVMe 용량은 고정 (EBS처럼 늘릴 수 없음):
  i3.2xlarge:   1.9 TB 고정
  r6id.2xlarge: 474 GB 고정

셔플 데이터가 NVMe 용량을 초과하면:
  → "No space left on device" 에러
  → spark.local.dir을 NVMe + EBS 복합 경로로 설정하는 방법도 있음
```

# 7. 비용 관점

---

```text
i3.2xlarge × 20대, 3시간 작업:
  비용: $0.624 × 20 × 3 = $37.44

r5.2xlarge × 20대, 셔플 느려서 6시간:
  비용: $0.504 × 20 × 6 = $60.48
  → 시간당 단가가 싸지만, 작업 시간이 늘어 총비용 증가

r6id.2xlarge × 20대, 3시간 (NVMe로 셔플 유지):
  비용: $0.576 × 20 × 3 = $34.56
  → i3 대비 7% 절감, 셔플 성능은 유사
```

인스턴스 단가만 비교하면 r5가 싸지만, **셔플이 큰 워크로드에서는 작업 시간 증가로 총비용이 더 커질 수 있습니다.**

# 8. 정리

---

| 항목 | NVMe (로컬 SSD) | EBS (원격 SSD) |
|------|----------------|---------------|
| 연결 | PCIe 직접 연결 | 네트워크 경유 |
| IOPS | ~200,000+ | 3,000~16,000 |
| Throughput | ~1.85 GB/s | 125 MB/s~1 GB/s |
| Latency | ~100 μs | ~1 ms |
| 용량 | 고정 (인스턴스 사이즈에 따라) | 가변 (원하는 만큼) |
| 데이터 영속성 | Stop 시 삭제 | 영구 보존 |
| Spark 용도 | 셔플, Spill (임시 데이터) | 영구 데이터 저장 |

```text
핵심:
  NVMe = 서버에 물리적으로 장착된 초고속 SSD
  EBS  = 네트워크를 통해 접근하는 원격 SSD

  Spark의 셔플/Spill은 로컬 디스크 I/O 집약적
  → NVMe면 빠르고, EBS면 느림
  → 셔플이 큰 워크로드에서 NVMe 유무가 성능을 결정
```

# Reference

---

- [AWS EC2 Instance Types](https://aws.amazon.com/ec2/instance-types/)
- [AWS EBS Volume Types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [Spark Configuration - Local Storage](https://spark.apache.org/docs/latest/configuration.html#local-storage)
- [NVMe Specification](https://nvmexpress.org/specifications/)
