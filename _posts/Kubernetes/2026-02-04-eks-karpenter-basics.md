---
title: "[EKS] Karpenter vs Cluster Autoscaler - 노드 프로비저닝 이해하기"
categories:
  - Kubernetes
tags:
  - [Kubernetes, EKS, Karpenter, Autoscaling, AWS]
---

# Introduction

---

EKS에서 워크로드가 늘면 결국 **노드가 늘어나야** 합니다. 그때 선택지는 크게 두 가지:

- **(전통)** Cluster Autoscaler + NodeGroup
- **(신규)** Karpenter

이 글은 두 방식의 차이와 Karpenter 도입 시 자주 만나는 운영 이슈를 정리합니다.

# 1. Cluster Autoscaler vs Karpenter

---

## Cluster Autoscaler

```yaml
# ASG(Auto Scaling Group) 기반
# 노드그룹 단위로 스케일
```

- NodeGroup(ASG) 단위로 스케일
- 노드 타입이 고정적
- 구성이 단순하지만 유연성 부족

## Karpenter

```yaml
# 파드 요구사항 기반 동적 프로비저닝
# 최적의 인스턴스 타입 자동 선택
```

- 파드 요구사항(cpu/mem/taint/arch)을 보고 조건에 맞는 인스턴스를 동적으로 선택
- 스팟/온디맨드 믹스 최적화
- 더 유연하지만 설정이 복잡

## 비교

| 항목 | Cluster Autoscaler | Karpenter |
|------|-------------------|-----------|
| 스케일 단위 | NodeGroup(ASG) | 개별 노드 |
| 인스턴스 선택 | 고정 (NodeGroup에 정의) | 동적 (요구사항 기반) |
| 스팟 지원 | NodeGroup별 설정 | 통합 관리 |
| 복잡도 | 낮음 | 중간~높음 |
| 유연성 | 낮음 | 높음 |

# 2. Karpenter가 유리한 상황

---

```
□ 다양한 인스턴스 타입을 유연하게 쓰고 싶을 때
□ 스팟/온디맨드 믹스를 최적화하고 싶을 때
□ 워크로드 패턴이 가변적일 때
□ 비용 최적화가 중요할 때
□ GPU/ARM 등 다양한 아키텍처가 필요할 때
```

# 3. Karpenter 기본 개념

---

## Provisioner (v0.x) / NodePool (v1beta1+)

```yaml
# NodePool 예시 (Karpenter v1beta1+)
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: node.kubernetes.io/instance-type
          operator: In
          values: ["m5.large", "m5.xlarge", "m5.2xlarge"]
      nodeClassRef:
        name: default
  limits:
    cpu: 1000
  disruption:
    consolidationPolicy: WhenUnderutilized
```

## EC2NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: AL2
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: my-cluster
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: my-cluster
  instanceProfile: KarpenterNodeInstanceProfile-my-cluster
```

# 4. 가장 흔한 실패 포인트

---

## 문제 1: 노드가 안 뜸

**원인:** VPC 서브넷/보안그룹 태그가 맞지 않음

```bash
# 서브넷 태그 확인
aws ec2 describe-subnets --filters "Name=tag:karpenter.sh/discovery,Values=my-cluster"

# 보안그룹 태그 확인
aws ec2 describe-security-groups --filters "Name=tag:karpenter.sh/discovery,Values=my-cluster"
```

**해결:** 태그 추가
```bash
aws ec2 create-tags --resources subnet-xxx --tags Key=karpenter.sh/discovery,Value=my-cluster
```

## 문제 2: IAM 권한 부족

**원인:** Karpenter 컨트롤러 또는 노드 IAM 권한 누락

```json
// 필요한 권한 예시
{
  "Effect": "Allow",
  "Action": [
    "ec2:CreateFleet",
    "ec2:RunInstances",
    "ec2:CreateLaunchTemplate",
    "ec2:DescribeInstances",
    "ec2:TerminateInstances"
  ],
  "Resource": "*"
}
```

## 문제 3: 인스턴스 타입/용량 제약

**원인:** 요청한 인스턴스 타입이 해당 AZ에 없음

**해결:** 더 많은 인스턴스 타입 허용
```yaml
requirements:
  - key: node.kubernetes.io/instance-type
    operator: In
    values: ["m5.large", "m5.xlarge", "m6i.large", "m6i.xlarge", "c5.large", "c5.xlarge"]
```

## 문제 4: CNI/IP 부족

**원인:** 노드가 떠도 파드에 할당할 IP가 없음

```bash
# 노드의 할당 가능 IP 확인
kubectl describe node <node-name> | grep -A5 "Allocatable"
```

**해결:**
- 서브넷 CIDR 확장
- VPC CNI prefix delegation 활성화
- Secondary CIDR 추가

# 5. 스팟 인스턴스 사용 시 주의

---

```yaml
# 스팟 인터럽션 대응
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
```

## 인터럽션 대응

```yaml
# 파드에 PDB(Pod Disruption Budget) 설정
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-app-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-app
```

- Karpenter가 인터럽션 감지 시 graceful 드레이닝
- 충분한 온디맨드 fallback 확보

# 6. 모니터링

---

```bash
# Karpenter 로그 확인
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f

# 프로비저닝 이벤트
kubectl get events --field-selector reason=Provisioned

# 노드 상태
kubectl get nodes -L karpenter.sh/provisioner-name,node.kubernetes.io/instance-type
```

## 주요 메트릭

| 메트릭 | 설명 |
|--------|------|
| `karpenter_nodes_created` | 생성된 노드 수 |
| `karpenter_nodes_terminated` | 종료된 노드 수 |
| `karpenter_pods_state` | 파드 상태 |

# 7. 체크리스트

---

```
□ 서브넷/보안그룹 태그와 Karpenter 요구사항이 맞는가?
□ IAM 권한(노드/컨트롤러)이 충분한가?
□ 스팟 사용 시 인터럽션 대응(드레이닝/재스케줄)이 준비됐는가?
□ IP/CNI 용량이 충분한가?
□ 인스턴스 타입을 충분히 다양하게 허용했는가?
□ NodePool limits(cpu/memory)를 설정했는가?
```

# Reference

---

- [Karpenter Documentation](https://karpenter.sh/docs/)
- [EKS Best Practices - Karpenter](https://aws.github.io/aws-eks-best-practices/karpenter/)
- [Cluster Autoscaler vs Karpenter](https://aws.amazon.com/blogs/containers/karpenter-graduates-to-beta/)
