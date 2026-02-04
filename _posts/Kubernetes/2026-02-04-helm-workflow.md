---
title: "[Helm] 배포 워크플로우 - values, template, upgrade, rollback"
categories:
  - Kubernetes
tags:
  - [Kubernetes, Helm, Deployment, DevOps, CICD]
---

# Introduction

---

Helm은 "Kubernetes YAML 패키지 매니저"입니다. 하지만 진짜 가치는 **업그레이드/롤백 루틴을 표준화**하는 데 있습니다.

# 1. Helm 기본 개념

---

| 개념 | 설명 |
|------|------|
| **Chart** | 템플릿 + 기본 values (패키지) |
| **values.yaml** | 환경별 설정 주입 |
| **Release** | 특정 네임스페이스에 설치된 인스턴스 |
| **Repository** | Chart 저장소 |

## 디렉토리 구조

```
my-chart/
├── Chart.yaml          # 차트 메타데이터
├── values.yaml         # 기본 설정값
├── templates/          # K8s 매니페스트 템플릿
│   ├── deployment.yaml
│   ├── service.yaml
│   └── ingress.yaml
└── charts/             # 의존 차트
```

# 2. 자주 쓰는 명령

---

## 개발/검증

```bash
# 차트 문법 검증
helm lint ./my-chart

# 템플릿 렌더링 미리보기 (실제 설치 안 함)
helm template ./my-chart -f values-prod.yaml

# 특정 템플릿만 확인
helm template ./my-chart -s templates/deployment.yaml
```

## 설치/업그레이드

```bash
# 설치 (없으면 생성, 있으면 실패)
helm install myapp ./my-chart -f values-prod.yaml

# 업그레이드 (없으면 설치)
helm upgrade --install myapp ./my-chart -f values-prod.yaml

# 네임스페이스 지정
helm upgrade --install myapp ./my-chart -f values-prod.yaml -n production
```

## 상태 확인

```bash
# 릴리스 목록
helm list

# 릴리스 히스토리
helm history myapp

# 릴리스 상태
helm status myapp

# 현재 적용된 values 확인
helm get values myapp
```

## 롤백

```bash
# 이전 버전으로 롤백
helm rollback myapp 3

# 롤백 전 히스토리 확인
helm history myapp
```

## 삭제

```bash
# 릴리스 삭제
helm uninstall myapp

# 삭제하되 히스토리 유지
helm uninstall myapp --keep-history
```

# 3. 환경별 Values 관리

---

## 파일 분리

```
values/
├── values.yaml         # 공통 기본값
├── values-dev.yaml     # 개발 환경
├── values-staging.yaml # 스테이징
└── values-prod.yaml    # 프로덕션
```

## 사용

```bash
# 기본 + 환경별 values 조합
helm upgrade --install myapp ./my-chart \
  -f values.yaml \
  -f values-prod.yaml
```

## 예시: values-prod.yaml

```yaml
replicaCount: 3

image:
  repository: myregistry/myapp
  tag: v1.2.3

resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1Gi

ingress:
  enabled: true
  hosts:
    - myapp.example.com
```

# 4. 안전한 배포 옵션

---

## --atomic

```bash
# 실패 시 자동 롤백
helm upgrade --install myapp ./my-chart -f values-prod.yaml --atomic
```

- 배포 실패 시 이전 버전으로 자동 롤백
- 프로덕션 배포에 권장

## --wait

```bash
# 리소스가 준비될 때까지 대기
helm upgrade --install myapp ./my-chart -f values-prod.yaml --wait
```

- Deployment의 모든 파드가 Ready가 될 때까지 대기
- CI/CD 파이프라인에서 유용

## --timeout

```bash
# 타임아웃 설정
helm upgrade --install myapp ./my-chart -f values-prod.yaml --wait --timeout 5m
```

## 권장 조합

```bash
helm upgrade --install myapp ./my-chart \
  -f values-prod.yaml \
  --atomic \
  --wait \
  --timeout 5m
```

# 5. Dry Run과 Diff

---

## Dry Run

```bash
# 실제 적용 없이 시뮬레이션
helm upgrade --install myapp ./my-chart -f values-prod.yaml --dry-run
```

## Helm Diff 플러그인

```bash
# 플러그인 설치
helm plugin install https://github.com/databus23/helm-diff

# 변경 사항 미리 확인
helm diff upgrade myapp ./my-chart -f values-prod.yaml
```

# 6. CI/CD 파이프라인 예시

---

```yaml
# GitHub Actions 예시
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}

      - name: Helm Lint
        run: helm lint ./my-chart

      - name: Helm Template (Validation)
        run: helm template ./my-chart -f values-prod.yaml > /dev/null

      - name: Helm Diff
        run: helm diff upgrade myapp ./my-chart -f values-prod.yaml || true

      - name: Helm Deploy
        run: |
          helm upgrade --install myapp ./my-chart \
            -f values-prod.yaml \
            --atomic \
            --wait \
            --timeout 5m
```

# 7. 롤백 시 주의사항

---

## DB 마이그레이션

```
배포 v1 → v2 (DB 스키마 변경)
롤백 v2 → v1 (스키마는 이미 v2 상태!)
```

- 롤백해도 DB 마이그레이션은 되돌리기 어려움
- **Backward compatible** 마이그레이션 설계 필요

## 롤백 안전 체크리스트

```
□ DB 스키마 변경이 있었는가?
□ 새 버전에서 생성된 리소스(ConfigMap, Secret)가 있는가?
□ 외부 서비스 연동에 breaking change가 있는가?
```

# 8. 유용한 팁

---

## 시크릿 관리

```bash
# Helm Secrets 플러그인
helm plugin install https://github.com/jkroepke/helm-secrets

# 암호화된 values 사용
helm secrets upgrade --install myapp ./my-chart -f secrets.yaml
```

## 릴리스 네이밍

```bash
# 환경 + 앱 조합
helm upgrade --install prod-myapp ./my-chart -n production
helm upgrade --install staging-myapp ./my-chart -n staging
```

## 차트 의존성

```yaml
# Chart.yaml
dependencies:
  - name: postgresql
    version: "12.x.x"
    repository: "https://charts.bitnami.com/bitnami"
```

```bash
# 의존성 업데이트
helm dependency update ./my-chart
```

# 9. 체크리스트

---

```
□ template 렌더링을 CI에서 검증하는가?
□ values가 환경별로 분리되어 있는가?
□ --atomic, --wait 옵션을 사용하는가?
□ 롤백 시 DB 마이그레이션 영향이 없는가?
□ helm diff로 변경 사항을 미리 확인하는가?
□ 시크릿을 안전하게 관리하는가?
```

# Reference

---

- [Helm Documentation](https://helm.sh/docs/)
- [Helm Best Practices](https://helm.sh/docs/chart_best_practices/)
- [Helm Diff Plugin](https://github.com/databus23/helm-diff)
- [Helm Secrets](https://github.com/jkroepke/helm-secrets)
