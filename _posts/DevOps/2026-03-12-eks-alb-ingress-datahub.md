---
layout: post
title: "[EKS] ALB Ingress로 DataHub 외부 접속 설정하기"
categories:
  - DevOps
tags:
  - EKS
  - Kubernetes
  - ALB
  - Ingress
  - DataHub
  - AWS
  - Load Balancer Controller
toc: true
toc_sticky: true
date: 2026-03-12
---

## 들어가며

DataHub를 EKS에 배포하고 나면 초기에는 `kubectl port-forward`로 로컬에서 접속하는 경우가 많습니다. 개발 초기에는 충분하지만, 팀원과 공유하거나 CI 연동이 필요해지면 한계가 드러납니다.

이 글에서는 **AWS Load Balancer Controller**와 **ALB Ingress**를 이용해 DataHub 프론트엔드를 외부에 노출하는 과정을 정리합니다. 글을 끝까지 따라가면 다음을 할 수 있게 됩니다.

- EKS 클러스터에 ALB Ingress 리소스를 배포하여 DataHub를 외부에 공개
- `target-type: ip` 방식의 트래픽 흐름을 이해
- 운영 환경을 위한 HTTPS, 도메인, 인증 적용 방향을 파악

### 사전 지식

- EKS 클러스터가 구축되어 있고, `kubectl` 접근이 가능한 상태
- AWS Load Balancer Controller가 설치되어 있는 상태 (설치 방법은 이 글의 범위 밖)
- Kubernetes Ingress 리소스의 기본 개념

---

## 배경: port-forward의 한계

`kubectl port-forward`는 kubectl이 로컬 TCP 소켓을 클러스터 내 서비스로 터널링해주는 디버그 도구입니다. 빠르게 동작 확인을 할 때는 편리하지만, 운영 환경으로 사용하기에는 구조적인 문제가 있습니다.

- **단일 TCP 프록시**: 연결이 불안정하고 부하가 조금만 걸려도 끊어집니다.
- **로컬 전용**: 실행한 사람의 PC에서만 접근 가능합니다.
- **kubectl 프로세스 의존**: kubectl 프로세스가 죽으면 연결도 끊어집니다.

팀원들이 DataHub에 접근하려면 각자 `port-forward`를 실행해야 하는데, 이는 현실적이지 않습니다. 따라서 ALB Ingress를 통한 외부 노출로 전환했습니다.

---

## Step 1. AWS Load Balancer Controller 설치 확인

ALB Ingress가 동작하려면 EKS 클러스터에 **AWS Load Balancer Controller**가 설치되어 있어야 합니다. 이 컨트롤러는 Kubernetes Ingress 리소스를 감시하다가, `ingressClassName: alb`인 Ingress가 생성되면 자동으로 AWS ALB를 프로비저닝합니다.

설치 여부를 먼저 확인합니다.

```bash
kubectl get deployment -n kube-system | grep -i -E "alb|ingress|load-balancer"
```

```
# 예상 출력
aws-load-balancer-controller   2/2     2            2           203d
```

IngressClass도 확인합니다.

```bash
kubectl get ingressclass
```

```
# 예상 출력
NAME   CONTROLLER            PARAMETERS   AGE
alb    ingress.k8s.aws/alb   <none>       203d
```

`alb` IngressClass가 있다면 준비 완료입니다. 없다면 [공식 설치 가이드](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/deploy/installation/)를 참고하여 Helm으로 설치합니다.

---

## Step 2. DataHub 서비스 포트 확인

Ingress는 클러스터 내부의 Service를 백엔드로 참조합니다. Ingress 생성 전에 DataHub 프론트엔드 서비스가 어떤 포트를 노출하고 있는지 확인합니다.

```bash
kubectl get svc -n datahub datahub-datahub-frontend -o jsonpath='{.spec.ports[*].port}'
```

```
# 예상 출력
9002 4318
```

- **9002**: DataHub 프론트엔드 UI 포트
- **4318**: OpenTelemetry 수집 포트

Ingress에서는 **9002**만 사용합니다.

---

## Step 3. Ingress 리소스 생성

아래 YAML을 적용하면 AWS Load Balancer Controller가 ALB를 자동으로 프로비저닝합니다.

```yaml
# datahub/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: datahub-frontend
  namespace: datahub
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing       # public ALB
    alb.ingress.kubernetes.io/target-type: ip                # Pod IP 직접 라우팅
    alb.ingress.kubernetes.io/healthcheck-path: /            # 헬스체크 경로
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'  # 수신 포트
spec:
  ingressClassName: alb   # AWS Load Balancer Controller가 처리
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: datahub-datahub-frontend
                port:
                  number: 9002
```

적용 후 Ingress 상태를 확인합니다.

```bash
kubectl apply -f datahub/ingress.yaml
kubectl get ingress -n datahub
```

```
# 예상 출력
NAME               CLASS   HOSTS   ADDRESS                                                                  PORTS   AGE
datahub-frontend   alb     *       k8s-datahub-datahubf-4810a34c5a-1209928355.us-east-1.elb.amazonaws.com   80      4s
```

`ADDRESS` 컬럼에 ALB DNS 주소가 나타나면 성공입니다.

> **참고**: 새로 생성된 ALB는 워밍업 시간(수 분)이 필요합니다. 즉시 접속해도 503 에러나 타임아웃이 발생할 수 있으며, 이는 정상 동작입니다.

---

## 핵심 어노테이션 설명

각 어노테이션이 ALB의 어떤 동작을 제어하는지 정리합니다.

| 어노테이션 | 값 | 설명 |
|---|---|---|
| `scheme` | `internet-facing` | 인터넷에서 접근 가능한 **public ALB**를 생성합니다. public subnet에 배치됩니다. 내부 접근만 필요하면 `internal`을 사용합니다. |
| `target-type` | `ip` | Pod IP로 직접 라우팅합니다. `instance` 모드는 NodePort를 경유하므로 한 번의 홉이 추가됩니다. `ip` 모드는 Pod로 바로 도달하여 레이턴시가 낮고, ALB의 sticky session도 `ip` 모드에서만 동작합니다. |
| `healthcheck-path` | `/` | ALB가 대상 Pod의 헬스를 확인하는 HTTP 경로입니다. DataHub 프론트엔드는 `/`에서 200을 반환하므로 이 값을 사용합니다. |
| `listen-ports` | `[{"HTTP":80}]` | ALB가 수신할 포트와 프로토콜입니다. HTTPS를 추가하려면 `[{"HTTP":80},{"HTTPS":443}]`으로 설정합니다. |

### target-type: ip vs instance

두 모드의 트래픽 경로를 비교하면 다음과 같습니다.

```
[instance 모드]
ALB → EC2 NodePort → kube-proxy → Pod

[ip 모드]
ALB → Pod IP (ENI secondary IP)
```

`ip` 모드를 사용하려면 **VPC CNI 플러그인**이 ENI의 secondary IP를 Pod에 할당하고 있어야 합니다. EKS의 기본 네트워크 플러그인(`aws-vpc-cni`)이 이 방식을 사용하므로, 별도 설정 없이 동작합니다.

### 보안 그룹 관리

`target-type: ip`를 사용하면 ALB에서 Pod 포트(9002)로의 인바운드 트래픽이 허용되어야 합니다. AWS Load Balancer Controller는 `security-groups` 어노테이션을 지정하지 않은 경우 **자동으로 보안 그룹을 생성하고 관리**합니다. 직접 보안 그룹을 지정한 경우에는 노드/Pod로의 인바운드 규칙을 수동으로 관리해야 합니다.

---

## 트래픽 흐름

전체적인 트래픽 흐름을 다이어그램으로 나타내면 다음과 같습니다.

```
인터넷 사용자
    |
    v
AWS ALB (internet-facing, public subnet)
  - HTTP:80 리스너
  - Target Group: Pod IP 기반 (target-type=ip)
    |  (VPC 내부, ENI secondary IP로 직접 라우팅)
    v
EKS Pod: datahub-frontend:9002
```

port-forward와 달리 ALB는 클러스터 외부의 실제 로드 밸런서입니다. 여러 Pod에 걸쳐 트래픽을 분산하고, 헬스체크에 실패한 Pod는 자동으로 제외합니다.

---

## 주의할 점

### ALB 워밍업 시간

새로 생성된 ALB는 AWS 내부에서 리소스를 프로비저닝하는 데 수 분이 걸립니다. 첫 몇 분간 503 에러나 타임아웃이 발생할 수 있으며, 시간이 지나면 안정됩니다.

### HTTP만 사용 중

현재 설정은 HTTP 80만 열려 있어 암호화되지 않은 연결입니다. 팀 내부용 도구라도 인터넷에 노출되는 엔드포인트라면 HTTPS 설정을 권장합니다. ACM 인증서를 발급한 뒤 아래처럼 어노테이션을 추가하면 됩니다.

```yaml
annotations:
  alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
  alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:us-east-1:123456789:certificate/xxxxx
  alb.ingress.kubernetes.io/ssl-redirect: "443"  # HTTP → HTTPS 자동 리다이렉트
```

### ALB URL이 길고 기억하기 어려움

ALB DNS 주소는 `k8s-datahub-datahubf-4810a34c5a-1209928355.us-east-1.elb.amazonaws.com`처럼 길고 기억하기 어렵습니다. Route53에서 CNAME 레코드로 `datahub.example.com` 같은 도메인을 연결하면 훨씬 편합니다.

---

## 다음 단계

현재 설정은 동작하지만 프로덕션 수준으로 가려면 몇 가지 개선이 필요합니다.

1. **HTTPS 적용**: ACM(AWS Certificate Manager)에서 인증서를 발급하고 `alb.ingress.kubernetes.io/certificate-arn` 어노테이션으로 연결
2. **HTTP 리다이렉트**: `alb.ingress.kubernetes.io/ssl-redirect: "443"` 어노테이션으로 HTTP를 HTTPS로 자동 전환
3. **커스텀 도메인**: Route53에서 CNAME(또는 Alias) 레코드로 ALB DNS 주소를 연결
4. **내부 ALB 전환**: 팀 내부 도구라면 `scheme: internal`로 바꾸고 VPN을 통해 접근하면 보안이 더 강화됨
5. **ALB 레벨 인증**: Cognito 또는 OIDC를 연동해 ALB에서 로그인 처리 가능 (`alb.ingress.kubernetes.io/auth-type` 어노테이션)
6. **IP 제한**: `alb.ingress.kubernetes.io/inbound-cidrs` 어노테이션 또는 보안 그룹으로 접근 가능한 IP 대역을 제한

---

## 요약

| 항목 | port-forward | ALB Ingress |
|---|---|---|
| 접근 범위 | 로컬 PC만 | 인터넷 또는 VPC 내부 |
| 안정성 | kubectl 프로세스에 의존 | AWS 관리형 로드 밸런서 |
| 로드 밸런싱 | 없음 | 여러 Pod에 자동 분산 |
| 헬스체크 | 없음 | ALB가 자동으로 수행 |
| 설정 난이도 | 명령어 한 줄 | Ingress YAML + Controller 필요 |
| 적합한 용도 | 로컬 디버깅 | 팀 공유, CI 연동, 운영 |

AWS Load Balancer Controller가 이미 설치된 EKS 클러스터라면, Ingress YAML 하나로 ALB를 프로비저닝할 수 있습니다. `target-type: ip`로 Pod에 직접 라우팅하면 NodePort를 거치지 않아 네트워크 경로가 단순해지고, 운영 시 트러블슈팅도 쉬워집니다.

---

## Reference

- [AWS Load Balancer Controller 공식 문서](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [ALB Ingress Annotations 레퍼런스](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/)
- [Kubernetes Ingress 개념](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [DataHub Kubernetes 배포 가이드](https://datahubproject.io/docs/deploy/kubernetes)
