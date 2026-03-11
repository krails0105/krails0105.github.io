---
layout: post
title: "DataHub EKS 배포 중 배운 Kafka, Kubernetes, Helm 핵심 개념 정리"
categories: [DataEngineering]
tags: [Kafka, Kubernetes, EKS, IRSA, CSI, Helm, OIDC, KRaft]
date: 2026-03-11
toc: true
---

## 이 글에서 다루는 것

DataHub를 EKS에 배포하다 보면 Kafka, Kubernetes 스토리지, IAM 권한, Helm 내부 동작에 대한 질문이 연달아 튀어나온다. 배포는 결국 성공했지만, 그 과정에서 "왜 이렇게 동작하는가"를 제대로 이해하지 못하면 다음 번에도 같은 곳에서 막힌다.

이 글은 배포 트러블슈팅 과정에서 만난 핵심 개념들을 정리한 기술 학습 노트다. 각 개념을 독립적으로 설명한 뒤, 마지막에 실제 배포 흐름 안에서 어떻게 연결되는지 보여준다.

### 사전 지식

- Docker 컨테이너와 Kubernetes Pod의 기본 개념
- AWS IAM Role/Policy의 기초
- `kubectl`, `helm` CLI 사용 경험

---

## 1. Kafka 아키텍처: KRaft vs Zookeeper

### Zookeeper 방식 (레거시)

Kafka 초기부터 사용된 방식이다. Kafka 브로커가 스스로 상태를 관리하지 못하고 **Zookeeper라는 별도 클러스터**에 의존한다.

```
[Zookeeper 클러스터]         [Kafka 브로커 클러스터]
  ZK-1                         Broker-1
  ZK-2  <-- 메타데이터 관리 --> Broker-2
  ZK-3                         Broker-3

총 6개 프로세스
```

Zookeeper가 담당하는 것:
- 브로커 목록 관리 (어떤 브로커가 살아있는지)
- 파티션 리더 선출 (장애 발생 시 새 리더 결정)
- 토픽/파티션 메타데이터 저장

문제는 운영 복잡도다. Kafka와 Zookeeper를 **따로** 모니터링, 스케일링, 백업해야 한다.

### KRaft 방식 (Kafka 3.3+)

KRaft는 **Kafka + Raft**의 합성어다. Zookeeper를 제거하고 Kafka 자체적으로 [Raft 합의 알고리즘](https://raft.github.io/)을 사용해 메타데이터를 관리한다.

```
[Kafka 클러스터 (KRaft)]
  Node-1 (Controller + Broker)
  Node-2 (Controller + Broker)
  Node-3 (Controller + Broker)

총 3개 프로세스 (절반)
```

변화 포인트:
- 외부 의존성 제거 -- Zookeeper 클러스터를 별도로 운영할 필요가 없다
- 리더 선출 속도 향상 -- 수십 초에서 수 초 수준으로 단축
- **Kafka 4.0에서 Zookeeper 지원이 완전히 제거되었다** (예정이 아니라 이미 적용됨)

KRaft 모드는 Kafka 3.3에서 처음 프로덕션 레디(production-ready) 상태로 도입되었고, 3.3 이전 버전에서 4.0으로 업그레이드하려면 반드시 먼저 3.3~3.9.x로 올린 뒤 KRaft로 마이그레이션해야 한다.

| 항목 | Zookeeper 방식 | KRaft 방식 |
|------|---------------|-----------|
| 외부 의존성 | ZK 클러스터 필요 | 없음 |
| 최소 프로세스 수 | 6개 (ZK 3 + Broker 3) | 3개 |
| 운영 복잡도 | 높음 | 낮음 |
| 상태 | Kafka 4.0에서 제거됨 | 기본값 (3.3+ production-ready) |
| 리더 선출 | 수십 초 | 수 초 |

> **실무 팁:** DataHub Helm 차트 기본값이 Zookeeper 방식이다. KRaft로 전환 시 `kraft.enabled=true`만 추가하면 두 모드가 동시에 활성화되어 에러가 난다. 반드시 Zookeeper 설정을 명시적으로 비활성화(`zookeeper.enabled=false`)하는 작업을 함께 해야 한다.

---

## 2. Kafka Broker vs Controller

KRaft를 이해하려면 Kafka 내부의 역할 구분을 먼저 알아야 한다.

### Controller: 관제탑

```
Controller
  |- 파티션 리더 선출 (브로커 장애 시)
  |- 메타데이터 관리 (토픽/파티션 정보)
  +- 브로커 상태 추적 (누가 살아있는지)
```

비행기로 치면 **관제탑**이다. 직접 짐을 나르지 않고, 누가 어디로 가야 하는지 지시한다. KRaft 모드에서는 Controller끼리 Raft 프로토콜로 합의하며, `controller.listener.names` 설정으로 통신 채널을 지정한다.

### Broker: 화물 창고

```
Broker
  |- 프로듀서로부터 메시지 수신
  |- 파티션 로그에 메시지 저장
  +- 컨슈머에게 메시지 전달
```

실제 **메시지를 저장하고 전달하는 일꾼**이다.

### 운영 패턴

| 규모 | 배포 방식 | 설명 |
|------|----------|------|
| 대규모 | 분리 운영 | Controller N대 + Broker M대 별도 배포 |
| 소규모 | Combined 모드 | 한 노드가 Controller + Broker 겸임 |

DataHub처럼 **내부 메시지 버스 용도**라면 Combined 모드 1대로 충분하다. 외부 서비스에 Kafka를 노출하거나 처리량이 클 때만 분리를 검토한다.

---

## 3. Kubernetes CSI: 스토리지를 붙이는 표준 인터페이스

### 왜 CSI가 필요한가

Kubernetes Pod는 컨테이너 특성상 재시작하면 데이터가 사라진다. MySQL이나 Kafka처럼 데이터를 영속적으로 보관해야 하는 컴포넌트는 **외부 디스크**를 붙여야 한다.

CSI(Container Storage Interface)는 Kubernetes와 스토리지 시스템(AWS EBS, GCP PD, Azure Disk 등) 사이의 **표준 인터페이스**다. 예전에는 각 스토리지 드라이버가 Kubernetes 코어에 직접 내장(in-tree)되어 있었지만, CSI를 통해 외부 플러그인으로 분리되었다.

### 요청 흐름

```
Pod 생성 요청
    |
PVC (PersistentVolumeClaim) 생성
    |
StorageClass -> CSI Driver 호출
    |
CSI Driver -> AWS API (CreateVolume)
    |
EBS 디스크 생성
    |
Pod에 마운트
```

### in-tree(gp2) vs CSI(gp3)

AWS EBS를 예로 들면, 기존 in-tree 방식(`kubernetes.io/aws-ebs`)은 deprecated 상태이며 `ebs.csi.aws.com` CSI 드라이버로 리다이렉트된다. Kubernetes 공식 문서에서도 기존 in-tree PV/PVC는 CSIMigration 기능을 통해 대응하는 CSI 드라이버로 자동 전환된다고 명시하고 있다.

| 항목 | in-tree (gp2) | CSI (gp3) |
|------|--------------|-----------|
| Provisioner | `kubernetes.io/aws-ebs` | `ebs.csi.aws.com` |
| 방식 | K8s 코어 내장 (레거시) | 외부 플러그인 (표준) |
| 볼륨 타입 | gp2 고정 | gp3, io2 등 선택 가능 |
| 상태 | Deprecated (CSI로 리다이렉트) | 권장 |

**StorageClass 예시:**

```yaml
# gp3 StorageClass (CSI 방식)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com  # CSI 드라이버 지정
parameters:
  type: gp3                     # EBS 볼륨 타입
  fsType: ext4                  # 파일시스템 종류
volumeBindingMode: WaitForFirstConsumer  # Pod가 스케줄링될 때 볼륨 생성
```

> **실무 팁:** EKS 클러스터에 gp3 StorageClass가 없으면 DataHub의 MySQL, Kafka 모두 PVC pending 상태로 뜬다. `kubectl get storageclass`로 먼저 확인하고, EBS CSI Driver 설치 여부(`kubectl get pods -n kube-system | grep ebs-csi`)도 함께 체크해야 한다.

---

## 4. OIDC와 IRSA: Pod 단위 AWS 권한 부여

### 문제: EC2는 되는데 K8s Pod는 왜 안 되나

EC2 인스턴스에 IAM role을 붙이는 것은 간단하다. 인스턴스 1개에 role 1개를 매핑하면 끝이다.

하지만 K8s에서는 **여러 Pod가 한 노드 위에 뜬다.** EBS CSI Pod, DataHub Pod, 모니터링 Pod가 같은 노드에 있을 때, 노드에 IAM role을 붙이면 모든 Pod가 동일한 권한을 갖게 된다. 최소 권한 원칙(Principle of Least Privilege) 위반이다.

```
[EC2 노드]
  |- ebs-csi-controller Pod  <- EBS 생성 권한 필요
  |- datahub-gms Pod         <- S3 접근 권한 필요
  +- monitoring Pod          <- CloudWatch 권한 필요

노드에 모든 권한을 부여하면 -> 보안 위반
```

### OIDC: 신원 증명 프로토콜

OIDC(OpenID Connect)는 Pod가 AWS 서비스를 호출할 때 "나는 누구"라고 증명하는 프로토콜이다. OAuth 2.0 위에 구축된 인증 계층으로, EKS가 발급하는 JWT 토큰을 AWS IAM이 검증하는 데 사용된다.

```
Pod
  | "나는 kube-system:ebs-csi-controller-sa 입니다"
  | (JWT 토큰 제시)
OIDC Provider (EKS에 등록)
  | 토큰 서명 검증
AWS IAM (AssumeRoleWithWebIdentity)
  | 조건(Condition) 일치 확인
IAM Role 임시 자격 증명 발급
```

### IRSA: OIDC를 K8s에 연결하는 EKS 기능

IRSA(IAM Roles for Service Accounts)는 K8s ServiceAccount에 IAM Role을 매핑하는 EKS 고유 기능이다. 핵심은 세 가지 구성요소의 연결이다:

1. **ServiceAccount** -- Pod가 사용하는 K8s 인증 주체
2. **IAM Role** -- AWS 리소스 접근 권한
3. **OIDC Provider** -- 둘을 연결하는 신뢰 체인

**설정 방법:**

```bash
# 1. ServiceAccount에 IAM Role ARN 어노테이션 추가
kubectl annotate serviceaccount ebs-csi-controller-sa \
  -n kube-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789:role/AmazonEKS_EBS_CSI_DriverRole
```

```json
// 2. IAM Trust Policy: 특정 SA만 assume 허용
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::123456789:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/XXXX"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.us-east-1.amazonaws.com/id/XXXX:sub": "system:serviceaccount:kube-system:ebs-csi-controller-sa"
      }
    }
  }]
}
```

```bash
# 3. 어노테이션 적용 후 Pod 재시작 필수 (새 JWT 토큰 주입)
kubectl rollout restart deployment ebs-csi-controller -n kube-system
```

> **실무 팁:** IRSA 설정 후 `kubectl rollout restart`를 빠뜨리면 권한이 적용되지 않는다. K8s는 Pod 생성 시점에 JWT 토큰을 Projected Volume으로 주입하므로, 기존에 뜬 Pod는 재시작해야 새 토큰을 받는다.

---

## 5. Helm 핵심 개념

### Chart, Release, Values 관계

Helm에서 가장 중요한 세 가지 개념의 관계를 먼저 이해해야 한다.

```
Chart (패키지 정의)
  |- templates/     <- K8s 리소스 템플릿 (Deployment, Service, ...)
  |- values.yaml    <- 기본값
  +- Chart.yaml     <- 메타데이터 (이름, 버전, 의존성)

        | helm install --values custom.yaml
        v

Release (설치 인스턴스)
  = Chart + Values가 합쳐져 렌더링된 결과
  = K8s 리소스들의 집합
```

같은 Chart를 다른 이름으로 여러 번 설치할 수 있다. `helm install datahub-dev datahub/datahub`와 `helm install datahub-prod datahub/datahub`는 독립적인 Release다.

### Hook: 생명주기 이벤트 처리

Hook은 Helm 설치/업그레이드 전후에 특정 Job을 실행하는 기능이다. Helm 공식 문서에 따르면, `pre-install` hook은 **템플릿이 렌더링된 후, 리소스가 생성되기 전에** 실행된다.

```yaml
# pre-install hook 예시
apiVersion: batch/v1
kind: Job
metadata:
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "0"        # 낮을수록 먼저 실행
    "helm.sh/hook-delete-policy": hook-succeeded  # 성공 시 자동 삭제
```

자주 사용되는 Hook 종류:

| Hook 종류 | 실행 시점 |
|----------|----------|
| `pre-install` | 템플릿 렌더링 후, 리소스 생성 전 |
| `post-install` | 모든 리소스 로드 후 (`--wait` 시 Ready 상태 확인 후) |
| `pre-upgrade` | 업그레이드 시 리소스 업데이트 전 |
| `post-upgrade` | 업그레이드 완료 후 |
| `pre-delete` | 삭제 요청 시, 리소스 제거 전 |

> **실무 함정:** Hook은 Deployment나 ServiceAccount보다 **먼저 실행될 수 있다.** DataHub의 경우 pre-install hook이 아직 생성되지 않은 ServiceAccount를 참조하려다 실패하는 경우가 있다. 이럴 때 `--no-hooks` 플래그로 hook을 건너뛰고, SA를 먼저 수동 생성한 뒤 재설치하는 것이 해결책이다.

### Release 상태가 저장되는 위치

Helm 3은 Release 상태를 **K8s Secret**에 저장한다 (Helm 2에서는 ConfigMap을 사용했다).

```bash
# Release 상태 Secret 확인
kubectl get secrets -n datahub | grep helm.release
# sh.helm.release.v1.datahub.v1  (1번째 설치)
# sh.helm.release.v1.datahub.v2  (첫 번째 업그레이드)
```

**유령 Release 문제:** `helm uninstall`이 중간에 실패하면 K8s 리소스는 삭제됐는데 Secret은 남는다. 다음 `helm install` 시 "already exists" 에러가 발생한다. 이때는 Secret을 수동으로 삭제해야 한다.

```bash
# 유령 Release Secret 정리
kubectl delete secret sh.helm.release.v1.datahub.v1 -n datahub
```

### 디버깅에 유용한 플래그

```bash
# 렌더링된 매니페스트 확인 (실제 설치 전 미리보기)
helm install datahub datahub/datahub --debug --dry-run

# 상세 에러 출력과 함께 설치
helm install datahub datahub/datahub --debug

# hook 건너뛰기 (SA/Secret 선행 생성 시 유용)
helm install datahub datahub/datahub --no-hooks

# 설치 또는 업그레이드를 하나의 명령으로
helm upgrade --install datahub datahub/datahub --values custom.yaml
```

---

## 6. kubectl 핵심 명령어

배포 과정에서 자주 쓴 명령어들을 정리했다.

### rollout restart: 이미지 변경 없이 Pod 재생성

```bash
# SA 어노테이션 변경, ConfigMap 업데이트 후 Pod 재시작 시
kubectl rollout restart deployment datahub-gms -n datahub
kubectl rollout restart deployment ebs-csi-controller -n kube-system
```

`kubectl delete pod`로 하나씩 삭제하는 것과 달리, rollout restart는 **Rolling Update 전략에 따라 순차적으로 재시작**하여 서비스 중단 없이 적용된다.

### annotate: 리소스에 메타데이터 추가

```bash
# IRSA 설정: SA에 IAM Role ARN 어노테이션
kubectl annotate serviceaccount ebs-csi-controller-sa \
  -n kube-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789:role/MyRole

# 덮어쓰기 (이미 있는 어노테이션 변경)
kubectl annotate serviceaccount ebs-csi-controller-sa \
  -n kube-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789:role/MyRole \
  --overwrite
```

### describe: 디버깅의 핵심

```bash
# Pod 상세 정보 + Events 확인
kubectl describe pod datahub-gms-xxxxx -n datahub

# PVC가 pending인 이유 확인
kubectl describe pvc mysql-data -n datahub

# 노드 상태 확인
kubectl describe node ip-10-0-1-100
```

출력 맨 아래 **Events** 섹션이 핵심이다. "왜 이 Pod가 Pending인가"의 답이 여기 있다. `FailedScheduling`, `ProvisioningFailed` 같은 이벤트 타입으로 원인을 빠르게 좁힐 수 있다.

### port-forward: 로컬에서 K8s 서비스 접속

```bash
# DataHub UI를 로컬 9002로 포워딩
kubectl port-forward svc/datahub-datahub-frontend 9002:9002 -n datahub

# MySQL 로컬 접속
kubectl port-forward svc/prerequisites-mysql 3306:3306 -n datahub
```

LoadBalancer나 Ingress 없이도 로컬에서 서비스에 접속할 수 있다. 디버깅과 개발 환경에서 유용하다.

---

## 흔한 실수와 트러블슈팅

배포 과정에서 겪기 쉬운 문제들을 정리했다.

| 증상 | 원인 | 해결 |
|------|------|------|
| PVC가 Pending 상태 | StorageClass 미등록 또는 CSI Driver 미설치 | `kubectl get sc`, CSI Driver Pod 확인 |
| CSI Driver의 EBS 생성 실패 | IRSA 미설정 또는 Pod 미재시작 | SA 어노테이션 확인 후 `rollout restart` |
| `helm install` "already exists" | 이전 Release Secret 잔존 | Secret 수동 삭제 후 재설치 |
| Hook이 SA를 못 찾음 | pre-install이 리소스보다 먼저 실행 | `--no-hooks`로 설치 후 수동 처리 |
| KRaft + Zookeeper 동시 에러 | `kraft.enabled=true`만 설정 | `zookeeper.enabled=false` 추가 |

---

## 개념 연결 정리

이 글의 개념들이 실제 배포에서 어떻게 연결되는지 흐름으로 정리하면:

```
[helm install datahub-prerequisites]
        |
  Hook 실행 (pre-install) -- 5. Helm Hook
        |
  Kafka Pod 생성 -- 1. KRaft or Zookeeper 선택
        |
  PVC 요청 -> StorageClass(gp3) -> CSI Driver -> EBS 생성  -- 3. CSI
        |
  CSI Driver Pod의 EBS API 호출
        |
  IRSA: SA 어노테이션 -> OIDC 검증 -> IAM Role -> EBS 권한 부여  -- 4. OIDC/IRSA
        |
  EBS 마운트 완료 -> Pod Running
```

각 단계에서 한 가지라도 빠지면 Pod는 Pending이나 Error 상태로 남는다. `kubectl describe`로 Events를 보면 어느 단계에서 막혔는지 바로 확인할 수 있다.

---

## 핵심 요약

| 개념 | 한 줄 정리 |
|------|-----------|
| KRaft | Zookeeper 없이 Kafka 자체 Raft 합의로 메타데이터 관리 (4.0에서 ZK 제거) |
| CSI | K8s와 스토리지 시스템 사이의 표준 플러그인 인터페이스 |
| OIDC + IRSA | Pod 단위로 AWS IAM 권한을 부여하는 EKS 인증 체계 |
| Helm Hook | Release 생명주기 중 특정 시점에 Job을 실행하는 메커니즘 |
| Helm Release | Chart + Values의 설치 인스턴스, Secret에 상태 저장 |

---

## Reference

- 관련 포스트: [DataHub를 EKS에 Helm으로 배포하다 -- 9가지 트러블슈팅 완전 정리](/DataEngineering/2026/03/11/datahub-eks-helm-deployment-troubleshooting.html)
- [Apache Kafka KRaft 공식 문서](https://kafka.apache.org/documentation/#kraft)
- [Kafka 4.0 마이그레이션 가이드 (ZooKeeper to KRaft)](https://kafka.apache.org/documentation/#upgrade_4_0)
- [Kubernetes CSI -- Volume Migration](https://kubernetes.io/docs/concepts/storage/volumes/#migrating-to-csi-drivers-from-in-tree-plugins)
- [Amazon EKS EBS CSI Driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
- [IAM Roles for Service Accounts (IRSA)](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
- [Helm Hooks 공식 문서](https://helm.sh/docs/topics/charts_hooks/)
