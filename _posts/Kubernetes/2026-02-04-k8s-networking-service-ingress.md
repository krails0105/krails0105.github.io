---
title: "[Kubernetes] Service와 Ingress - ClusterIP, NodePort, LoadBalancer 이해하기"
categories:
  - Kubernetes
tags:
  - [Kubernetes, Service, Ingress, Networking, LoadBalancer]
---

# Introduction

---

쿠버네티스 네트워킹에서 가장 중요한 것은:

- **Service**가 "L4 연결"을 어떻게 제공하는지
- **Ingress**가 "L7 라우팅"을 어떻게 제공하는지

를 구분하는 것입니다.

# 1. Service 타입

---

## ClusterIP (기본값)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  type: ClusterIP  # 생략 가능 (기본값)
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

- **클러스터 내부**에서만 접근 가능
- 가상 IP(ClusterIP)로 파드들에 로드밸런싱
- 다른 파드에서 `my-service:80`으로 접근

## NodePort

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  type: NodePort
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080  # 30000-32767 범위
```

- 모든 노드의 특정 포트로 외부 노출
- `<노드IP>:30080`으로 접근
- 직접 운영은 비추천 (보안, 관리 복잡)

## LoadBalancer

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-service
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

- 클라우드 로드밸런서 자동 생성 (EKS: ALB/NLB)
- 외부에서 LB 주소로 접근
- 비용 발생 (LB당 과금)

## ExternalName

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-db
spec:
  type: ExternalName
  externalName: db.example.com
```

- 외부 DNS 이름을 서비스로 매핑
- 클러스터 내에서 `external-db`로 외부 리소스 접근

# 2. Service 비교

---

| 타입 | 접근 범위 | 용도 |
|------|----------|------|
| ClusterIP | 클러스터 내부 | 내부 서비스 간 통신 |
| NodePort | 노드 IP:포트 | 테스트/개발 |
| LoadBalancer | 클라우드 LB | 프로덕션 외부 노출 |
| ExternalName | DNS alias | 외부 서비스 연결 |

# 3. Ingress

---

Ingress는 **L7(HTTP/HTTPS) 라우팅**을 제공합니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    kubernetes.io/ingress.class: nginx
spec:
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-service
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-service
                port:
                  number: 80
  tls:
    - hosts:
        - app.example.com
      secretName: tls-secret
```

## Ingress 기능

| 기능 | 설명 |
|------|------|
| 호스트 기반 라우팅 | `api.example.com` → API 서비스 |
| 패스 기반 라우팅 | `/api/*` → API, `/` → 웹 |
| TLS 종료 | HTTPS 처리 |
| 여러 서비스 통합 | 하나의 LB로 여러 서비스 |

## Service vs Ingress

| 항목 | Service (LB) | Ingress |
|------|--------------|---------|
| 계층 | L4 (TCP/UDP) | L7 (HTTP/HTTPS) |
| 라우팅 | 포트 기반 | 호스트/패스 기반 |
| TLS | 앱에서 처리 | Ingress에서 종료 |
| 비용 | 서비스당 LB | 하나의 LB로 통합 가능 |

# 4. EKS에서 Ingress 설정

---

## AWS Load Balancer Controller

```bash
# 설치 (Helm)
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=my-cluster
```

## ALB Ingress 예시

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:...
spec:
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
```

# 5. EKS에서 흔한 이슈

---

## 문제 1: LB가 안 생김

**원인:** 서브넷 태그 누락

```bash
# 퍼블릭 서브넷 태그
kubernetes.io/role/elb = 1

# 프라이빗 서브넷 태그
kubernetes.io/role/internal-elb = 1
```

## 문제 2: Target unhealthy

**원인:** 헬스체크 실패

```yaml
# 헬스체크 설정 확인
annotations:
  alb.ingress.kubernetes.io/healthcheck-path: /health
  alb.ingress.kubernetes.io/healthcheck-port: "8080"
```

## 문제 3: 503 에러

**원인:** 엔드포인트 없음

```bash
# 엔드포인트 확인
kubectl get endpoints my-service

# 파드 readiness 확인
kubectl get pods -l app=my-app
```

# 6. 디버깅 순서

---

```
1. kubectl get endpoints <service>
   → 서비스에 연결된 파드 IP 확인

2. kubectl get pods -l app=myapp
   → 파드 상태/readiness 확인

3. kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
   → Ingress 컨트롤러 로그

4. AWS 콘솔 → Target Groups → Targets
   → LB 타겟 헬스 확인

5. 보안그룹/NACL 확인
   → 네트워크 경로 확인
```

# 7. 체크리스트

---

```
□ Service 타입이 요구사항(L4/L7)에 맞는가?
□ 헬스체크 path/port가 실제 앱과 일치하는가?
□ 보안그룹/서브넷 태그가 맞는가?
□ Ingress 컨트롤러가 설치되어 있는가?
□ TLS 인증서가 유효한가?
□ DNS가 LB를 가리키는가?
```

# Reference

---

- [Kubernetes Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Kubernetes Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- [EKS Networking Best Practices](https://aws.github.io/aws-eks-best-practices/networking/)
