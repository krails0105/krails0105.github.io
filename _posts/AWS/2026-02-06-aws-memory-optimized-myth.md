---
title: "[AWS] Memory Optimized의 실체 - r-type은 메모리가 빠른 게 아니라 많은 것"
categories:
  - AWS
tags:
  - [AWS, EC2, MemoryOptimized, InstanceType, Hardware, Performance]
---

# Introduction

---

AWS EC2에서 r-type 인스턴스를 "Memory Optimized"라고 부릅니다. 이 이름 때문에 **메모리 연산 자체가 더 빠를 것**이라고 오해하기 쉽습니다. "메모리 최적화니까 메모리 접근 속도가 빠르겠지?"라는 직관은 틀렸습니다.

이 글은 같은 세대의 c/m/r-type이 하드웨어 수준에서 어떻게 다른지, "Memory Optimized"가 실제로 무엇을 의미하는지를 정리합니다.

# 1. 같은 세대 = 같은 프로세서, 같은 메모리 기술

---

같은 세대(generation) 내에서 c/m/r-type은 **동일한 프로세서 아키텍처와 메모리 기술**을 사용합니다.

## 5세대 (Intel Skylake-SP)

```text
             프로세서                 메모리 기술       메모리 채널
c5          Xeon Platinum 8124M     DDR4-2666        6채널/소켓
m5          Xeon Platinum 8175M     DDR4-2666        6채널/소켓
r5          Xeon Platinum 8175M     DDR4-2666        6채널/소켓
i3          Xeon Platinum 8175M     DDR4-2666        6채널/소켓

→ 같은 DDR4-2666, 같은 6채널 아키텍처
→ 메모리 대역폭 기술 자체는 동일
```

## 7세대 (AWS Graviton3)

```text
             프로세서         메모리 기술
c7g         Graviton3        DDR5
m7g         Graviton3        DDR5
r7g         Graviton3        DDR5

→ 같은 Graviton3, 같은 DDR5
→ DDR5는 DDR4 대비 50% 높은 대역폭 (세대 간 차이는 있음)
→ 같은 세대 내 타입 간 차이는 없음
```

# 2. 차이는 "비율"뿐

---

```text
c-type:  1 vCPU : 2 GiB    (Compute Optimized)
m-type:  1 vCPU : 4 GiB    (General Purpose)
r-type:  1 vCPU : 8 GiB    (Memory Optimized)
```

2xlarge (8 vCPU) 기준으로 비교하면:

```text
c5.2xlarge:  8 vCPU,  16 GB RAM  → $0.340/hr
m5.2xlarge:  8 vCPU,  32 GB RAM  → $0.384/hr
r5.2xlarge:  8 vCPU,  64 GB RAM  → $0.504/hr
i3.2xlarge:  8 vCPU,  61 GB RAM  → $0.624/hr

CPU 성능은 거의 동일 (c5만 클럭이 약간 높음: 3.4 GHz vs 3.1 GHz)
메모리 속도도 동일 (같은 DDR4-2666, 같은 채널 수)
차이는 오직 "메모리 용량"과 "가격"
```

**"Memory Optimized" = 같은 vCPU 수에 메모리를 더 많이 제공**하는 것이지, 메모리가 더 빠른 것이 아닙니다. 같은 엔진(CPU)과 같은 도로(DDR4)를 쓰지만, r-type은 짐칸(메모리)이 더 큰 트럭인 셈입니다.

# 3. per-core 메모리 대역폭은 오히려 c-type이 약간 높음

---

STREAM 벤치마크(메모리 대역폭 측정) 결과:

```text
c5: per-core 메모리 대역폭이 r5 대비 약 8% 높음
```

이유:

```text
c5.2xlarge:  18코어 소켓에서 8 vCPU 사용 → 메모리 채널 경쟁 적음
r5.2xlarge:  24코어 소켓에서 8 vCPU 사용 → 메모리 채널 경쟁 많음

같은 6채널 메모리를 더 적은 코어가 나눠 쓰면
→ 코어당 가용 대역폭이 높아짐
```

단, 이 차이는 8% 수준이므로 실무에서 체감하기는 어렵습니다. 핵심은 **r-type이라고 메모리가 빠르지 않다**는 점입니다.

# 4. r-type의 Aggregate 대역폭이 높은 이유

---

r-type이 "총 메모리 대역폭이 높다"고 언급되는 경우가 있습니다. 이는:

```text
r-type은 더 많은 DIMM 슬롯을 채움 (더 큰 용량이 필요하므로)
→ 더 많은 DIMM이 장착되면 채널당 대역폭이 더 잘 활용됨
→ Aggregate(총합) 대역폭은 높을 수 있음

하지만 이건 "메모리가 빨라서"가 아니라
"DIMM을 더 많이 꽂아서" 나오는 효과
```

이 효과는 **전체 메모리를 동시에 사용하는 워크로드**에서만 체감되며, 같은 vCPU 수(2xlarge)에서는 의미 없습니다.

# 5. 실제로 r-type이 필요한 경우

---

r-type이 "메모리 속도" 때문이 아니라 "메모리 용량" 때문에 필요한 시나리오:

```text
✅ Spark cache/persist 대상이 커서 메모리에 안 들어갈 때
✅ Broadcast Join에서 작은 테이블이 메모리 한계에 근접할 때
✅ OOM (OutOfMemoryError)이 간헐적으로 발생할 때
✅ In-memory 데이터베이스 (Redis, SAP HANA 등)

❌ "메모리 연산을 빠르게 하고 싶어서" → 효과 없음
❌ "셔플을 빠르게 하고 싶어서" → NVMe가 필요 (r6id, i3)
```

# 6. 같은 2xlarge에서 타입만 바꾸면?

---

```text
i3.2xlarge → r5.2xlarge:
  RAM: 61 GB → 64 GB  (+3 GB, 무의미한 수준)
  메모리 속도: 동일 (같은 DDR4-2666)
  CPU: 동일 수준 (3.1 GHz)
  NVMe: 1.9 TB → 없음 (EBS로 대체)
  비용: $0.624 → $0.504 (19% 절감)

→ 메모리 성능 향상: 없음
→ 잃는 것: NVMe (셔플/Spill 성능 저하)
→ 얻는 것: 시간당 $0.12 절감
```

r-type의 이점을 살리려면 **사이즈 업**이 필요합니다:

```text
i3.2xlarge × 20대: 160 vCPU, 1,220 GB RAM, 38 TB NVMe → $12.48/hr
r5.4xlarge × 10대: 160 vCPU, 1,280 GB RAM, EBS only   → $10.08/hr

→ 같은 총 리소스, 19% 비용 절감
→ 단, NVMe 없으므로 셔플 성능 확인 필요
```

# 7. 정리

---

| 오해 | 실제 |
|------|------|
| r-type은 메모리가 빠르다 | 같은 DDR, 같은 채널 수 (속도 동일) |
| r-type은 메모리 대역폭이 높다 | per-core 대역폭은 오히려 c-type이 ~8% 높음 |
| Memory Optimized = 메모리 최적화 | 정확히는 Memory Capacity Optimized (용량 최적화) |
| r-type으로 바꾸면 빨라진다 | 같은 사이즈면 속도 차이 없음, 사이즈 업해야 의미 있음 |

```text
핵심:
  같은 세대의 c/m/r/i-type은 같은 프로세서, 같은 DDR 기술 사용
  "Memory Optimized" = vCPU당 메모리 용량이 많다는 의미
  메모리 연산 속도는 타입이 아니라 세대(DDR4 vs DDR5)에 의해 결정
```

# Reference

---

- [AWS EC2 Instance Types](https://aws.amazon.com/ec2/instance-types/)
- [AWS EC2 R6i Instances](https://aws.amazon.com/ec2/instance-types/r6i/)
- [EC2 M5 vs R5 vs C5 Comparison](https://www.learnaws.org/2019/08/31/comparing-m5-r5-c5/)
- [Intel Xeon Platinum 8175M - WikiChip](https://en.wikichip.org/wiki/intel/xeon_platinum/8175m)
- [EC2 Instance Comparison - Vantage](https://instances.vantage.sh/)
