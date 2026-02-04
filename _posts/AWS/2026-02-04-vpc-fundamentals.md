---
title: "[AWS VPC] 앱 개발자를 위한 핵심 - 서브넷, 라우팅, NAT, 보안그룹"
categories:
  - AWS
tags:
  - [AWS, VPC, Networking, Subnet, SecurityGroup, NAT]
---

# Introduction

---

VPC는 네트워크를 "리소스"가 아니라 **"경로"**로 이해하면 빨라집니다.

이 글은 앱 개발자가 운영에서 자주 마주치는 포인트만 정리합니다:
- 서브넷 (퍼블릭/프라이빗)
- 라우팅 테이블
- NAT Gateway
- 보안그룹/네트워크 ACL

# 1. VPC 기본 구조

---

```
VPC (10.0.0.0/16)
├── Public Subnet (10.0.1.0/24)
│   ├── Internet Gateway 연결
│   └── EC2 (Public IP)
├── Private Subnet (10.0.2.0/24)
│   ├── NAT Gateway 경유
│   └── RDS, Lambda, EKS Nodes
└── Isolated Subnet (10.0.3.0/24)
    └── 인터넷 접근 없음
```

# 2. 퍼블릭 vs 프라이빗 서브넷

---

**핵심:** 서브넷의 퍼블릭/프라이빗은 **라우팅 테이블**이 결정합니다.

## 퍼블릭 서브넷

```
라우팅 테이블:
0.0.0.0/0 → Internet Gateway (igw-xxx)
10.0.0.0/16 → local
```

- IGW(Internet Gateway)로 직접 나가는 경로
- Public IP 또는 Elastic IP 필요
- 인터넷에서 직접 접근 가능

## 프라이빗 서브넷

```
라우팅 테이블:
0.0.0.0/0 → NAT Gateway (nat-xxx)
10.0.0.0/16 → local
```

- NAT Gateway를 통해서만 인터넷 접근
- 인터넷에서 직접 접근 불가 (Inbound 차단)
- 대부분의 백엔드 리소스가 여기에 위치

# 3. NAT Gateway

---

**역할:** 프라이빗 서브넷의 리소스가 인터넷으로 **나가게(Outbound)** 해줌

```
Private EC2 → NAT Gateway → Internet
  (10.0.2.x)    (10.0.1.x)
                (Public IP)
```

## 주의사항

- **Inbound는 차단**: 인터넷에서 프라이빗 서브넷으로 직접 들어오기 불가
- **비용 발생**: 시간당 + 데이터 전송량
- **가용영역당 1개** 권장 (고가용성)

## 언제 필요한가?

```
□ 프라이빗 서브넷에서 패키지 다운로드 (apt, yum, pip)
□ 외부 API 호출
□ AWS 서비스 접근 (S3, SQS 등 - VPC Endpoint 대안)
```

# 4. 보안그룹 (Security Group)

---

**특징:** Stateful, 인스턴스 단위

## Stateful의 의미

```
인바운드 허용 시 → 응답 아웃바운드 자동 허용
```

예시:
- 인바운드: 80 포트 허용
- 응답 트래픽은 자동 허용 (별도 아웃바운드 규칙 불필요)

## 기본 규칙

```yaml
# 웹 서버 보안그룹
Inbound:
  - Port 80 from 0.0.0.0/0
  - Port 443 from 0.0.0.0/0
  - Port 22 from 10.0.0.0/16  # VPC 내부만

Outbound:
  - All traffic (기본 허용)
```

```yaml
# DB 보안그룹
Inbound:
  - Port 5432 from sg-webserver  # 웹서버 보안그룹에서만

Outbound:
  - All traffic
```

## 보안그룹 참조

```yaml
# 보안그룹 ID로 참조 (IP 대신)
Inbound:
  - Port 5432 from sg-0123456789abcdef0
```

- IP가 변해도 자동 반영
- 더 안전하고 관리 용이

# 5. 네트워크 ACL (NACL)

---

**특징:** Stateless, 서브넷 단위

## Stateless의 의미

```
인바운드 허용해도 → 아웃바운드 별도 허용 필요
```

## 보안그룹 vs NACL

| 항목 | 보안그룹 | NACL |
|------|----------|------|
| 상태 | Stateful | Stateless |
| 적용 | 인스턴스 | 서브넷 |
| 규칙 | 허용만 | 허용/거부 |
| 평가 | 모든 규칙 | 순서대로 |

## 언제 NACL을 쓰나?

- 특정 IP 차단 (블랙리스트)
- 규정/컴플라이언스 요구
- 서브넷 레벨 격리

# 6. 통신 경로 그리기

---

## 예시: EC2 → RDS

```
EC2 (Private Subnet A)
  ↓
Local 라우팅 (10.0.0.0/16 → local)
  ↓
RDS 보안그룹 확인 (5432 from EC2 SG?)
  ↓
RDS (Private Subnet B)
```

## 예시: Lambda → 외부 API

```
Lambda (VPC 연결, Private Subnet)
  ↓
NAT Gateway 라우팅 (0.0.0.0/0 → NAT)
  ↓
Internet Gateway
  ↓
외부 API
```

## 예시: 인터넷 → ALB → EC2

```
인터넷
  ↓
ALB (Public Subnet)
  ↓
ALB 보안그룹 (80/443 from 0.0.0.0/0)
  ↓
EC2 보안그룹 (80 from ALB SG)
  ↓
EC2 (Private Subnet)
```

# 7. 자주 묻는 질문

---

**Q: 프라이빗 서브넷이면 외부 API 호출은 못 하나요?**

A: NAT Gateway가 있으면 **Outbound는 가능**합니다.

**Q: 보안그룹 인바운드만 열면 되나요?**

A: Stateful이라 **아웃바운드 응답은 자동 허용**됩니다. 단, 아웃바운드를 직접 제한한 경우는 별도 확인 필요.

**Q: VPC 피어링/Transit Gateway는 언제?**

A: 다른 VPC나 온프레미스와 연결할 때 사용합니다.

# 8. 체크리스트

---

```
□ "어디에서 어디로" 통신해야 하는지 경로를 그릴 수 있는가?
□ 프라이빗 리소스가 인터넷 접근이 필요하면 NAT가 있는가?
□ 보안그룹 인바운드/아웃바운드가 올바른가?
□ 서브넷 라우팅 테이블이 의도대로 설정되어 있는가?
□ 보안그룹은 IP보다 보안그룹 참조를 사용했는가?
```

# 9. 유용한 명령

---

```bash
# 서브넷 정보
aws ec2 describe-subnets --filters "Name=vpc-id,Values=vpc-xxx"

# 라우팅 테이블
aws ec2 describe-route-tables --filters "Name=vpc-id,Values=vpc-xxx"

# 보안그룹 규칙
aws ec2 describe-security-groups --group-ids sg-xxx

# NAT Gateway
aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=vpc-xxx"
```

# Reference

---

- [VPC User Guide](https://docs.aws.amazon.com/vpc/latest/userguide/)
- [Security Groups](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html)
- [NAT Gateway](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [VPC Best Practices](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-best-practices.html)
