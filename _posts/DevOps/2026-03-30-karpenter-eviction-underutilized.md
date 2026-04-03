---
title: "Karpenter가 파드를 갑자기 죽이는 이유: Consolidation에 의한 Eviction 분석과 대응"
categories:
  - DevOps
tags: [Karpenter, EKS, Kubernetes, Flink, Consolidation, PodDisruptionBudget, Spot, NodePool]
date: 2026-03-30
---

## 개요

EKS에 Flink Kubernetes Operator를 배포한 뒤, Operator 파드가 아무 에러 없이 주기적으로 재시작되는 상황이 발생했다. `kubectl get events`를 열어보니 익숙하지 않은 메시지가 찍혀 있었다.

```
Evicted pod: Underutilized
Killing
```

같은 파드가 5분 간격으로 두 번 eviction당했고, 흥미롭게도 Flink Job 파드(JobManager, TaskManager)는 아무 영향 없이 Running 상태를 유지했다. 원인은 Karpenter의 **Consolidation** 기능이었다.

이 글에서는 Karpenter Consolidation이 왜 파드를 evict하는지, 어떤 정책 옵션이 있는지, 그리고 중요한 파드를 보호하는 구체적인 방법을 정리한다.

## 전제 조건

- Amazon EKS 클러스터에 Karpenter가 설치되어 있는 환경
- Karpenter v1 (apiVersion: `karpenter.sh/v1`) 기준으로 설명한다. v1beta1 이하 버전에서는 일부 필드명이 다를 수 있다
- Kubernetes의 Pod, Deployment, Node 개념에 대한 기본적인 이해

## 원인: Karpenter Consolidation이란

Karpenter는 노드 비용을 최적화하기 위해 사용률이 낮은 노드를 정리하는 **Consolidation** 기능을 제공한다. 동작 방식은 다음과 같다.

1. 노드에 리소스 여유가 생김 (파드가 줄었거나 요청량 대비 사용률이 낮음)
2. Karpenter가 "이 파드들을 더 적은 수의 노드로 합칠 수 있다"고 판단
3. 대상 파드를 evict하고, 다른 노드에 재스케줄링
4. 빈 노드를 제거해 비용 절감

Operator 파드는 리소스 요청량이 작고 중요도가 낮아 보여서 Consolidation의 주요 타깃이 되었다. Deployment로 배포되어 있었기 때문에 eviction 즉시 새 파드가 생성되어 겉으로는 "가끔 재시작되는 파드"처럼만 보였다.

## Consolidation Policy 옵션

NodePool 리소스의 `spec.disruption`에서 Consolidation 동작 방식을 제어한다.

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  disruption:
    # 기본값: 비어있거나 사용률 낮은 노드를 통합
    consolidationPolicy: WhenEmptyOrUnderutilized
    # 노드가 완전히 빌 때만 제거하려면 아래 사용
    # consolidationPolicy: WhenEmpty
    consolidateAfter: 0s  # 기본값: 즉시 consolidation 시작
```

| 정책 | 설명 | 특징 |
|---|---|---|
| `WhenEmptyOrUnderutilized` | 빈 노드 또는 사용률 낮은 노드를 통합 (기본값) | 비용 절감 효과가 크지만, 파드 eviction이 빈번할 수 있음 |
| `WhenEmpty` | 노드가 완전히 비었을 때만 제거 | 파드 eviction이 거의 없지만, 비용 절감 효과가 줄어듦 |

> **참고**: Karpenter v1beta1에서는 `WhenUnderutilized`라는 이름이었으나, v1에서 `WhenEmptyOrUnderutilized`로 변경되었다. v1beta1에서 마이그레이션하는 경우 정책 이름을 업데이트해야 한다.

`consolidateAfter`를 `Never`로 설정하면 Consolidation 자체를 비활성화할 수 있다.

## 대응 방법

### 1. `karpenter.sh/do-not-disrupt` Annotation으로 특정 파드 보호

가장 직접적인 방법이다. Karpenter가 해당 파드를 eviction 대상에서 완전히 제외한다.

```yaml
# Deployment의 podTemplate에 annotation 추가
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flink-kubernetes-operator
spec:
  template:
    metadata:
      annotations:
        karpenter.sh/do-not-disrupt: "true"  # 이 파드는 Consolidation 대상에서 제외
    spec:
      containers:
        - name: operator
          # ...
```

Helm Chart로 배포하는 경우 values 파일에서 설정한다.

```yaml
# Helm values 예시
podAnnotations:
  karpenter.sh/do-not-disrupt: "true"
```

이 annotation은 **Pod 레벨**과 **Node 레벨** 모두 지원한다.

| 적용 레벨 | 효과 |
|---|---|
| Pod | 해당 파드만 보호. 같은 노드의 다른 파드는 eviction 가능 |
| Node | 노드 전체를 보호. 해당 노드의 모든 파드가 eviction 대상에서 제외 |

`kubectl annotate`로 직접 붙이면 파드 재시작 시 사라지므로, 반드시 Deployment나 Helm values의 podTemplate에 넣어서 영구 적용해야 한다.

### 2. PodDisruptionBudget으로 최소 가용 파드 보장

PDB를 설정하면 Karpenter는 eviction 전에 PDB 조건을 확인한다.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: flink-operator-pdb
spec:
  minAvailable: 1           # 최소 1개 파드는 항상 Running 상태여야 함
  selector:
    matchLabels:
      app: flink-kubernetes-operator
```

`minAvailable: 1`이면 실행 중인 파드가 1개뿐일 때 eviction을 허용하지 않는다. Replica가 2 이상인 Deployment에서 특히 유용하다.

`maxUnavailable` 필드를 대신 사용할 수도 있다. Kubernetes 공식 문서에서는 replica 수 변경에 자동으로 대응하는 `maxUnavailable` 사용을 권장한다.

```yaml
spec:
  maxUnavailable: 1          # 동시에 최대 1개까지만 unavailable 허용
  selector:
    matchLabels:
      app: flink-kubernetes-operator
```

> **주의**: `maxUnavailable: 0`으로 설정하면 롤링 업데이트까지 막힐 수 있으므로 주의한다.

### 3. On-Demand 노드에 고정 배치

Consolidation은 주로 Spot 노드에서 빈번하게 발생한다. 중요 파드를 On-Demand 노드풀에 고정하면 영향을 최소화할 수 있다.

```yaml
# Deployment spec에 nodeSelector 추가
spec:
  template:
    spec:
      nodeSelector:
        karpenter.sh/capacity-type: on-demand
```

### 4. Consolidation Policy를 WhenEmpty로 변경

NodePool의 정책 자체를 바꾸는 방법이다. 노드가 완전히 빌 때만 정리하므로 파드 eviction 빈도가 크게 줄어든다. 단, 비용 절감 효과도 줄어든다.

```yaml
spec:
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s
```

### 5. Disruption Budgets로 세밀하게 제어 (Karpenter v1)

Karpenter v1에서는 `budgets` 필드를 통해 Consolidation 속도와 범위를 세밀하게 제어할 수 있다. 특정 시간대에 disruption을 차단하거나, 동시에 disruption되는 노드 수를 제한할 수 있다.

```yaml
spec:
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    budgets:
      - nodes: "20%"                  # 동시에 전체 노드의 20%까지만 disruption 허용
      - nodes: "0"                    # 아래 스케줄 동안에는 disruption 완전 차단
        schedule: "0 9 * * mon-fri"   # 평일 오전 9시부터
        duration: 8h                  # 8시간 동안 (업무시간)
        reasons:
          - "Underutilized"           # Underutilized에 의한 disruption만 차단
```

이 방법은 Consolidation 자체를 끄지 않으면서도, 업무 시간이나 트래픽 피크 시간대에는 파드 eviction을 방지할 수 있어 실용적이다.

## 실제 영향 분석

Flink Kubernetes Operator의 역할을 생각해보면, Operator가 재시작해도 이미 실행 중인 Flink Job은 영향을 받지 않는다. Flink Job(JobManager, TaskManager)은 Kubernetes 리소스로 독립적으로 실행되기 때문에 Operator 없이도 계속 동작한다.

Operator가 다시 뜨면 `FlinkDeployment` CR을 다시 Watch하면서 상태를 reconcile한다. 잠깐의 reconcile 루프 중단이 있을 뿐, 실제 서비스 중단은 없었다.

이번 케이스에서는 서비스 영향이 없었지만, 다음과 같은 잠재적 문제가 있다.

- 로그가 지저분해지고 모니터링 알람이 오작동할 수 있다
- Operator가 중요한 상태 변경(Job 업그레이드, Savepoint 등)을 처리하는 도중에 eviction당하면 문제가 될 수 있다
- 반복적인 재시작으로 인해 Operator의 인메모리 캐시가 매번 초기화된다

결론적으로, PDB 또는 `do-not-disrupt` annotation으로 보호해두는 것이 안전하다.

## 트러블슈팅 팁

### Eviction 원인이 Karpenter인지 확인하는 방법

`kubectl get events`의 Eviction 메시지만으로는 Karpenter인지 Cluster Autoscaler인지 구분하기 어렵다. 다음 방법으로 확인할 수 있다.

```bash
# 노드에 Karpenter 관련 annotation이 있는지 확인
kubectl describe node <node-name> | grep karpenter

# Karpenter 컨트롤러 로그에서 disruption 이벤트 확인
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter --tail=100 | grep -i "disruption\|consolidat"
```

### do-not-disrupt를 남용하지 않기

`do-not-disrupt: "true"`를 너무 많은 파드에 붙이면 Consolidation이 전혀 동작하지 않아 비용 절감 효과를 잃는다. 정말 중요한 파드(Operator, 상태를 가진 컨트롤러 등)에만 선택적으로 적용한다.

## 정리

| 대응 방법 | 적용 범위 | 비용 영향 | 권장 상황 |
|---|---|---|---|
| `do-not-disrupt` annotation | 특정 파드/노드 | 없음 | 재시작 비용이 큰 단일 파드 보호 |
| PodDisruptionBudget | 특정 워크로드 | 없음 | replica가 2개 이상인 워크로드 |
| On-Demand 노드 고정 | 특정 파드 | 비용 증가 | Spot 회수 + Consolidation 모두 방지 |
| WhenEmpty 정책 | NodePool 전체 | 비용 증가 | 파드 안정성이 비용보다 중요한 경우 |
| Disruption Budgets | NodePool 전체 (시간/사유별) | 최소 | 업무시간 보호 등 세밀한 제어 필요 시 |

Karpenter Consolidation은 비용 절감에 효과적이지만, 무방비 상태로 두면 중요 파드가 예기치 않게 eviction될 수 있다. 워크로드 특성에 맞는 보호 전략을 미리 설정해두는 것이 좋다.

## Reference

- [Karpenter Disruption 공식 문서](https://karpenter.sh/docs/concepts/disruption/)
- [Karpenter NodePool API](https://karpenter.sh/docs/concepts/nodepools/)
- [Kubernetes PodDisruptionBudget 문서](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [Kubernetes PDB API Reference](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/pod-disruption-budget-v1/)
