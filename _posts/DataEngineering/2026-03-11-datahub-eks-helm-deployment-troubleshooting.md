---
layout: post
title: "DataHub EKS Helm 배포 트러블슈팅 -- 9가지 문제와 해결 과정"
categories: [DataEngineering]
tags: [DataHub, EKS, Helm, Kubernetes, IRSA, Kafka, DataCatalog, DevOps, StorageClass, OpenSearch]
date: 2026-03-11
toc: true
---

## 이 글에서 다루는 것

데이터 카탈로그/리니지/DQ 플랫폼인 **DataHub**를 기존 EKS 클러스터에 Helm으로 배포하는 과정에서 만난 **9가지 문제와 해결 방법**을 정리한다.

공식 문서대로 `helm install`을 실행하면 바로 될 것 같지만, 실제로는 StorageClass 미지정, IRSA 미설정, Helm hook 순서 문제 같은 함정들이 연달아 나타난다. 이 글은 그 삽질 기록이자, 같은 상황을 만났을 때 빠르게 원인을 파악하고 해결하기 위한 실전 가이드다.

**이 글을 읽고 나면:**
- DataHub Helm 차트의 2단계 설치 구조(prerequisites + datahub)를 이해할 수 있다
- EKS 환경에서 흔히 발생하는 PVC, IRSA, Helm hook 관련 문제를 진단하고 해결할 수 있다
- 재현 가능한 배포 스크립트로 처음부터 끝까지 자동화할 수 있다

### 환경

| 항목 | 값 |
|---|---|
| 클러스터 | EKS (us-east-1), 69개 노드 |
| DataHub | `datahub-prerequisites` + `datahub` Helm 차트 |
| Kafka 모드 | Zookeeper (차트 기본값) |
| StorageClass | gp3 (EBS CSI Driver) |
| Helm 버전 | 3.x |

---

## 배경: DataHub의 분산 아키텍처

DataHub는 단독 컨테이너가 아니라 **여러 인프라 컴포넌트를 묶은 분산 시스템**이다. 공식 Helm 차트는 아래 두 단계로 나뉜다.

```
datahub-prerequisites 차트          datahub 차트
  ├── MySQL       (메타데이터 저장)    ├── datahub-gms        (REST API 서버)
  ├── Kafka       (이벤트 스트리밍)    ├── datahub-frontend   (React UI)
  └── OpenSearch  (검색 인덱스)       ├── datahub-actions    (이벤트 처리 워커)
                                     └── datahub-system-update (DB 초기화 Job)
```

각 컴포넌트가 PVC, Secret, ServiceAccount를 요구하고, **설치 순서가 잘못되면 줄줄이 실패**한다. 특히 `datahub` 차트의 `datahub-system-update` Job은 `pre-install` Hook으로 실행되는데, 이것이 핵심 트러블의 원인이 된다(문제 6~8에서 상세히 다룬다).

---

## 사전 준비

아래 항목이 갖춰져 있어야 이 글의 내용을 따라할 수 있다.

- **EKS 클러스터**: kubectl로 접근 가능한 상태
- **Helm 3.x**: `helm version`으로 확인
- **EBS CSI Driver**: 클러스터에 설치되어 있어야 함 (`kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-ebs-csi-driver`)
- **gp3 StorageClass**: `kubectl get sc gp3`로 존재 여부 확인. 없으면 먼저 생성해야 한다
- **AWS CLI**: IRSA 설정에 필요 (`aws --version`)

---

## 9가지 문제와 해결 과정

### 문제 1: KRaft + Zookeeper 동시 활성화 충돌

**에러 메시지:**
```
Both Zookeeper and KRaft modes have been configured simultaneously.
Please choose one.
```

**원인:** Bitnami Kafka Helm 차트의 기본 모드는 Zookeeper다. 여기에 KRaft 설정을 수동으로 추가하면 두 모드가 동시에 활성화된다. 차트 기본값을 확인하지 않고 다른 가이드에서 복사한 KRaft 설정을 붙여넣으면 이 충돌이 발생한다.

**해결:** `helm show values`로 기본값을 먼저 확인하고, Kafka 섹션에서 KRaft 관련 설정을 모두 제거한다. Zookeeper 기본값을 그대로 사용하면 충돌이 없다.

```bash
# 차트 기본값 확인 -- 설치 전에 항상 먼저 실행할 것
helm show values datahub/datahub-prerequisites > prereqs-defaults.yaml

# prereqs-defaults.yaml에서 kafka 섹션의 kraft/zookeeper 설정을 확인한다
# kraft.enabled: false 이고 zookeeper.enabled: true 이면 기본값 그대로 사용
```

> **교훈:** Helm 차트를 설치하기 전에 `helm show values`를 반드시 실행하라. 기본값을 모르면 불필요한 설정을 추가하다 충돌이 생긴다.

---

### 문제 2: PVC Pending -- StorageClass 미지정

**에러 메시지:**
```
no persistent volumes available for this claim and no storage class is set
```

**원인:** `global.storageClass`를 지정하지 않으면 PVC가 StorageClass 없이 생성된다. EKS에서는 기본 StorageClass가 없거나 gp2로 설정된 경우, gp3를 사용하려면 명시적으로 지정해야 한다. 지정하지 않으면 PVC가 Pending 상태에 머문다.

**진단:**
```bash
# PVC 상태 확인
kubectl get pvc -n datahub
# STATUS = Pending이면 문제

# 상세 원인 확인
kubectl describe pvc <pvc-name> -n datahub
# Events 섹션에서 "no storage class is set" 메시지 확인
```

**해결:**
```bash
# prerequisites 설치 시 gp3 StorageClass를 두 군데 모두 지정
helm install datahub-prereqs datahub/datahub-prerequisites \
  --set global.storageClass="gp3" \
  --set elasticsearch.volumeClaimTemplate.storageClassName="gp3"
```

OpenSearch(차트 내부에서는 `elasticsearch`라는 키를 사용한다)는 `global.storageClass`와 별도의 설정값(`volumeClaimTemplate.storageClassName`)을 사용하므로, **두 군데 모두 지정**해야 한다. 하나만 지정하면 OpenSearch PVC만 Pending에 빠진다.

---

### 문제 3: EBS CSI Driver IRSA 미설정

**에러 메시지:**
```
failed to refresh cached credentials, no EC2 IMDS role found,
no ECS container credentials endpoint found
```

**원인:** EBS CSI Driver가 EBS 볼륨을 생성/연결하려면 AWS IAM 권한이 필요하다. EKS에서는 IRSA(IAM Roles for Service Accounts)로 Pod에 IAM 역할을 부여하는데, `ebs-csi-controller-sa` ServiceAccount에 IAM Role 어노테이션이 없으면 권한이 없어서 볼륨 생성에 실패한다.

**진단:**
```bash
kubectl describe sa ebs-csi-controller-sa -n kube-system
# Annotations 항목 확인
# eks.amazonaws.com/role-arn 어노테이션이 없으면 IRSA 미설정
```

**해결 스크립트 (`setup-ebs-csi-irsa.sh`):**

```bash
#!/bin/bash
# setup-ebs-csi-irsa.sh
# EBS CSI Driver에 IRSA를 설정하는 스크립트
set -euo pipefail

CLUSTER_NAME="Tech-EKS-Prod"    # 본인의 클러스터 이름으로 변경
REGION="us-east-1"               # 본인의 리전으로 변경
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="AmazonEKS_EBS_CSI_DriverRole"

# 1. OIDC Provider URL 조회
OIDC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" \
  --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')

echo "OIDC Provider: $OIDC_ID"

# 2. Trust Policy 생성
#    이 정책은 ebs-csi-controller-sa ServiceAccount만 이 Role을 assume할 수 있게 제한한다
cat > /tmp/ebs-csi-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_ID}"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "${OIDC_ID}:aud": "sts.amazonaws.com",
        "${OIDC_ID}:sub": "system:serviceaccount:kube-system:ebs-csi-controller-sa"
      }
    }
  }]
}
EOF

# 3. IAM Role 생성 + AmazonEBSCSIDriverPolicy 연결
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/ebs-csi-trust.json
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy

# 4. ServiceAccount에 IRSA 어노테이션 추가
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
kubectl annotate sa ebs-csi-controller-sa -n kube-system \
  "eks.amazonaws.com/role-arn=${ROLE_ARN}" --overwrite

# 5. EBS CSI Controller Pod 재시작 (새 어노테이션 적용)
kubectl rollout restart deployment ebs-csi-controller -n kube-system
kubectl rollout status deployment ebs-csi-controller -n kube-system

echo "IRSA 설정 완료: $ROLE_ARN"
```

> **참고:** `aws iam create-role`은 이미 Role이 존재하면 에러를 낸다. 기존 Role이 있다면 `create-role` 대신 `update-assume-role-policy`로 Trust Policy만 업데이트한다.

---

### 문제 4: IRSA Trust Policy 리전 불일치

**에러 메시지:**
```
AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

**원인:** 기존에 다른 리전(us-west-1)용으로 만들어진 IAM Role이 있었는데, Trust Policy에 us-west-1 OIDC Provider만 등록되어 있었다. 현재 클러스터는 us-east-1이므로 STS가 요청을 거부한다.

OIDC Provider는 리전별로 다른 URL을 가지므로, 멀티 리전 클러스터 환경에서는 Trust Policy에 각 리전의 OIDC Provider를 모두 등록해야 한다.

**진단:**
```bash
# Trust Policy 확인 -- Federated ARN의 리전 확인
aws iam get-role --role-name AmazonEKS_EBS_CSI_DriverRole \
  --query "Role.AssumeRolePolicyDocument" --output json

# 출력에서 oidc-provider URL에 us-west-1이 포함되어 있으면
# us-east-1 클러스터에서는 사용할 수 없다
```

**해결:** Trust Policy에 us-east-1 OIDC Statement를 추가한다.

```bash
# 1. 현재 Trust Policy를 파일로 저장
aws iam get-role --role-name AmazonEKS_EBS_CSI_DriverRole \
  --query "Role.AssumeRolePolicyDocument" --output json > /tmp/current-trust.json

# 2. /tmp/current-trust.json 편집:
#    Statement 배열에 us-east-1 OIDC Provider를 사용하는 새 Statement 추가

# 3. 수정된 Trust Policy 적용
aws iam update-assume-role-policy \
  --role-name AmazonEKS_EBS_CSI_DriverRole \
  --policy-document file:///tmp/updated-trust.json
```

> **주의:** Trust Policy를 업데이트할 때 기존 Statement를 지우지 않도록 주의한다. 기존 리전의 클러스터에서도 계속 사용해야 하기 때문이다.

---

### 문제 5: MySQL Secret 미생성

**에러 메시지:**
```
secret "mysql-secrets" not found
```

**원인:** `datahub` 차트가 `mysql-secrets`라는 Secret을 참조하는데, prerequisites 차트를 기본값으로 설치하면 `mysql.auth.existingSecret`이 설정되어 있어 차트가 Secret을 직접 생성하지 않는다.

**해결:**
```bash
# existingSecret을 빈 문자열로 오버라이드하면
# 차트가 mysql-root-password를 자동 생성한다
helm install datahub-prereqs datahub/datahub-prerequisites \
  --set mysql.auth.existingSecret=""
```

이 설정은 뒤의 "전체 배포 스크립트"에 이미 포함되어 있다.

---

### 문제 6~8: Helm pre-install Hook 순서 문제 (핵심 트러블)

이 세 문제는 동일한 근본 원인에서 비롯된다. DataHub EKS 배포에서 **가장 까다롭고 시간을 많이 잡아먹는 부분**이므로 상세히 다룬다.

**에러 메시지들:**
```
serviceaccount "datahub-operator-sa" not found        ← 문제 6
secret "datahub-auth-secrets" not found               ← 문제 7
invalid ownership metadata; label validation error:
  missing key "app.kubernetes.io/managed-by"           ← 문제 8
cannot reuse a name that is still in use
  (+ helm uninstall → release: not found)             ← 문제 8 후속
```

#### 근본 원인: Helm Hook 라이프사이클

Helm의 `pre-install` Hook은 **템플릿 렌더링 후, 리소스 생성 전**에 실행된다(Helm 공식 문서 기준). DataHub `datahub` 차트는 `datahub-system-update` Job을 `pre-install` Hook으로 정의하고 있다. 이 Job은 DB 스키마 초기화 등을 수행하는데, 실행에 필요한 ServiceAccount(`datahub-operator-sa`)와 Secret(`datahub-auth-secrets` 등)이 아직 생성되지 않은 상태에서 먼저 실행된다.

```
Helm install 실행 흐름 (문제 상황):

  1. helm install 시작
  2. 템플릿 렌더링 완료
  3. pre-install hook 실행 → datahub-system-update Job 시작
  4. Job이 datahub-operator-sa ServiceAccount 참조 → Not Found
  5. Hook 실패 → Helm이 실패 상태로 중단 (리소스는 생성되지 않음)
  6. helm uninstall 시도 → "release: not found" (Helm 상태 불일치)
  7. helm install 재시도 → "cannot reuse a name" (잔여 리소스 충돌)
```

이 상태에 빠지면 설치도, 삭제도, 재설치도 안 되는 **교착 상태(deadlock)**가 된다.

#### 1단계: Helm 유령 상태 제거

Helm 3는 릴리스 상태를 해당 네임스페이스의 Kubernetes Secret으로 저장한다. 실패한 릴리스의 잔여 Secret을 삭제하면 Helm이 깨끗한 상태로 돌아간다.

```bash
# Helm 릴리스 상태 Secret 삭제
kubectl delete secret -n datahub -l owner=helm,name=datahub

# 실패한 Hook Job이 남아있다면 삭제
kubectl delete job -n datahub -l app.kubernetes.io/managed-by=Helm
```

#### 2단계: SA와 Secret을 Helm보다 먼저 수동 생성

해결 원리는 단순하다. Hook이 필요로 하는 리소스를 Helm `install` 이전에 미리 만들어 두면 된다. 단, **Helm이 관리하는 리소스처럼 보이게** 라벨과 어노테이션을 반드시 추가해야 한다. 없으면 Helm이 "이 리소스는 내가 관리하는 게 아닌데 같은 이름이 이미 있다"는 ownership 충돌 에러를 낸다.

필요한 Helm 메타데이터 두 가지:
- **라벨:** `app.kubernetes.io/managed-by: Helm`
- **어노테이션:** `meta.helm.sh/release-name`, `meta.helm.sh/release-namespace`

```bash
#!/bin/bash
# install-datahub.sh -- SA/Secret 사전 생성 후 Helm install

NAMESPACE="datahub"
RELEASE_NAME="datahub"

# --- ServiceAccount 사전 생성 ---
kubectl create serviceaccount datahub-operator-sa -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

# Helm 메타데이터 추가 (이것이 없으면 ownership 충돌)
kubectl label sa datahub-operator-sa -n "$NAMESPACE" \
  "app.kubernetes.io/managed-by=Helm" --overwrite
kubectl annotate sa datahub-operator-sa -n "$NAMESPACE" \
  "meta.helm.sh/release-name=${RELEASE_NAME}" \
  "meta.helm.sh/release-namespace=${NAMESPACE}" --overwrite

# --- 필수 Secret 4개 사전 생성 ---
# datahub-auth-secrets: 메타데이터 서비스 인증에 사용
#   (DataHub 차트의 기본 secretRef = "datahub-auth-secrets")
AUTH_SECRET=$(openssl rand -base64 32)
TOKEN_KEY=$(openssl rand -base64 32)
TOKEN_SALT=$(openssl rand -base64 32)

kubectl create secret generic datahub-auth-secrets -n "$NAMESPACE" \
  --from-literal=system_client_secret="$AUTH_SECRET" \
  --from-literal=token_service_signing_key="$TOKEN_KEY" \
  --from-literal=token_service_salt="$TOKEN_SALT" \
  --dry-run=client -o yaml | kubectl apply -f -

# datahub-gms-secret: GMS 내부 통신용 시크릿
GMS_SECRET=$(openssl rand -base64 32)
kubectl create secret generic datahub-gms-secret -n "$NAMESPACE" \
  --from-literal="datahub.gms.secret=$GMS_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# datahub-encryption-secrets: 저장 데이터 암호화 키
ENC_KEY=$(openssl rand -base64 32)
kubectl create secret generic datahub-encryption-secrets -n "$NAMESPACE" \
  --from-literal=encryption_key_secret="$ENC_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# mysql-secrets: MySQL 루트/사용자 패스워드
MYSQL_ROOT_PW=$(openssl rand -base64 16)
kubectl create secret generic mysql-secrets -n "$NAMESPACE" \
  --from-literal=mysql-root-password="$MYSQL_ROOT_PW" \
  --from-literal=mysql-password="$MYSQL_ROOT_PW" \
  --dry-run=client -o yaml | kubectl apply -f -

# 모든 Secret에 Helm 메타데이터 추가
for secret in datahub-auth-secrets datahub-gms-secret \
              datahub-encryption-secrets mysql-secrets; do
  kubectl label secret "$secret" -n "$NAMESPACE" \
    "app.kubernetes.io/managed-by=Helm" --overwrite
  kubectl annotate secret "$secret" -n "$NAMESPACE" \
    "meta.helm.sh/release-name=${RELEASE_NAME}" \
    "meta.helm.sh/release-namespace=${NAMESPACE}" --overwrite
done

# --- Helm install 실행 ---
helm install "$RELEASE_NAME" datahub/datahub \
  -n "$NAMESPACE" \
  --set global.credentialsAndCertsSecrets.name=datahub-auth-secrets \
  --set datahub-gms.secret.name=datahub-gms-secret \
  --set global.kafka.bootstrap.server="datahub-prereqs-kafka:9092" \
  --set global.elasticsearch.host="datahub-prereqs-elasticsearch" \
  --set global.sql.datasource.host="datahub-prereqs-mysql" \
  --wait --timeout 20m
```

> **`--dry-run=client -o yaml | kubectl apply -f -` 패턴을 사용하는 이유:**
> `kubectl create`는 이미 존재하면 에러를 내지만, 이 패턴은 없으면 생성하고 있으면 업데이트한다. 스크립트를 여러 번 실행해도 안전하다(멱등성).

---

### 문제 9: 문제 6~8의 반복 -- 유령 리소스 정리

문제 6~8을 해결하는 과정에서 실패와 재시도를 반복하면, Kubernetes에 이전 시도의 잔여 리소스가 남아서 다음 설치를 방해한다.

**증상:**
- `helm install` 시 `cannot reuse a name that is still in use`
- `helm uninstall` 시 `release: not found`
- 이전 시도에서 생성된 Job, ConfigMap 등이 남아있음

**정리 스크립트:**
```bash
# 1. Helm 릴리스 상태 Secret 삭제
kubectl delete secret -n datahub -l owner=helm,name=datahub

# 2. 잔여 Hook Job 삭제
kubectl delete job -n datahub datahub-datahub-system-update --ignore-not-found

# 3. 잔여 리소스 확인
kubectl get all -n datahub -l app.kubernetes.io/instance=datahub

# 4. 정리 완료 후 install-datahub.sh 재실행
```

---

## 전체 배포 스크립트

위 9가지 문제를 모두 반영한 전체 배포 절차를 아래에 정리한다.

### Step 1: IRSA 설정 (최초 1회)

EBS CSI Driver IRSA가 설정되어 있지 않다면 `setup-ebs-csi-irsa.sh`(문제 3 참조)를 먼저 실행한다.

```bash
# IRSA 설정 여부 확인
kubectl describe sa ebs-csi-controller-sa -n kube-system | grep "eks.amazonaws.com/role-arn"
# 출력이 없으면 setup-ebs-csi-irsa.sh 실행 필요
```

### Step 2: Prerequisites 설치

```bash
# Helm 리포지터리 등록
helm repo add datahub https://helm.datahubproject.io/
helm repo update

# 네임스페이스 생성 (멱등)
kubectl create namespace datahub --dry-run=client -o yaml | kubectl apply -f -

# Prerequisites 설치 (MySQL, Kafka, OpenSearch)
helm install datahub-prereqs datahub/datahub-prerequisites \
  -n datahub \
  --set global.storageClass="gp3" \
  --set elasticsearch.volumeClaimTemplate.storageClassName="gp3" \
  --set mysql.auth.existingSecret="" \
  --wait --timeout 15m

# 모든 Pod이 Running인지 확인
kubectl get pods -n datahub
```

### Step 3: DataHub 설치

SA/Secret 사전 생성 + `helm install` 실행 -- 상세 스크립트는 문제 6~8의 `install-datahub.sh` 참조.

### 상태 확인

```bash
echo "=== Pods ==="
kubectl get pods -n datahub

echo "=== PVCs ==="
kubectl get pvc -n datahub

echo "=== Services ==="
kubectl get svc -n datahub

echo "=== Helm Releases ==="
helm list -n datahub
```

---

## 최종 결과

모든 문제를 해결하고 나면 아래 8개 Pod이 정상 상태가 된다.

```
NAME                                     READY   STATUS      RESTARTS
datahub-prereqs-elasticsearch-0          1/1     Running     0
datahub-prereqs-kafka-broker-0           1/1     Running     0
datahub-prereqs-zookeeper-0              1/1     Running     0
datahub-prereqs-mysql-0                  1/1     Running     0
datahub-datahub-gms-xxx                  1/1     Running     0
datahub-datahub-frontend-xxx             1/1     Running     0
datahub-datahub-actions-xxx              1/1     Running     0
datahub-system-update-xxx                0/1     Completed   0
```

`datahub-system-update`는 DB 스키마 초기화가 목적인 일회성 Job이므로 `Completed` 상태가 정상이다.

**UI 접속:**
```bash
# port-forward로 로컬에서 접속
kubectl port-forward svc/datahub-datahub-frontend 9002:9002 -n datahub

# 브라우저에서 http://localhost:9002 접속
# 기본 계정: datahub / datahub
```

> **보안 주의:** 기본 계정(`datahub/datahub`)은 반드시 변경해야 한다. 프로덕션 환경에서는 OIDC 연동(다음 단계 참조)으로 대체하는 것을 권장한다.

---

## 핵심 교훈 정리 (Gotchas)

| # | 교훈 | 상세 |
|---|---|---|
| 1 | `helm show values`를 항상 먼저 실행하라 | 차트 기본값을 모르면 불필요한 설정을 추가하다 충돌이 생긴다 (문제 1) |
| 2 | StorageClass는 두 군데 지정해야 한다 | `global.storageClass` + `elasticsearch.volumeClaimTemplate.storageClassName` (문제 2) |
| 3 | IRSA는 배포 전에 반드시 검증하라 | `kubectl describe sa ebs-csi-controller-sa -n kube-system`으로 어노테이션 확인 (문제 3) |
| 4 | Trust Policy의 리전을 확인하라 | IAM Role 재사용 시 OIDC Provider ARN의 리전 불일치 주의 (문제 4) |
| 5 | Helm Hook 순서 문제는 차트 설계 이슈다 | `pre-install` Hook이 SA/Secret보다 먼저 실행되므로 사전 생성으로 우회 (문제 6~8) |
| 6 | 수동 생성 리소스에는 Helm 메타데이터 필수 | `app.kubernetes.io/managed-by=Helm` 라벨 + `meta.helm.sh/release-*` 어노테이션 (문제 8) |
| 7 | Helm 유령 상태는 Secret 삭제로 해결 | `kubectl delete secret -n datahub -l owner=helm,name=datahub` (문제 9) |

---

## 다음 단계

- **Ingress 설정**: ALB Ingress Controller로 외부 접속 허용 (현재는 port-forward만 가능)
- **OAuth 연동**: OIDC(Google/Okta)로 기업 계정 로그인 설정
- **자동 메타데이터 수집**: `datahub ingest` CLI로 Databricks Unity Catalog, Kafka 토픽 등 소스 연결
- **Python SDK로 Lineage 등록**: Spark Job 실행 시 DataHub에 lineage 자동 전송
- **모니터링**: DataHub GMS의 `/health` 엔드포인트 + Prometheus 메트릭 수집

---

## Reference

- [DataHub Helm 공식 배포 가이드](https://datahubproject.io/docs/deploy/kubernetes)
- [Helm 공식 문서: Chart Hooks](https://helm.sh/docs/topics/charts_hooks/) -- pre-install/post-install 라이프사이클 상세
- [EKS EBS CSI Driver IRSA 공식 문서](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)
- [Bitnami Kafka Helm 차트 (KRaft vs Zookeeper)](https://github.com/bitnami/charts/tree/main/bitnami/kafka)
- 관련 포스트: [DataHub 로컬 핸즈온 테스트]({{ site.baseurl }}/dataengineering/2026/03/10/datahub-hands-on-local-test.html)
