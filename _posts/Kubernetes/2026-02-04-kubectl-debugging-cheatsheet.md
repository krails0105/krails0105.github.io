---
title: "[kubectl] 디버깅 치트시트 - 이벤트, 로그, exec, 리소스 확인"
categories:
  - Kubernetes
tags:
  - [Kubernetes, kubectl, Debugging, Troubleshooting, DevOps]
---

# Introduction

---

쿠버네티스 장애 대응은 **"관측 순서"**가 중요합니다. 이 글은 현장에서 가장 자주 쓰는 kubectl 디버깅 명령을 "어디부터 볼지" 기준으로 정리한 치트시트입니다.

# 1. 이벤트부터 보기 (가장 빠른 힌트)

---

```bash
# 최근 이벤트 정렬해서 보기
kubectl get events --sort-by=.lastTimestamp

# 특정 네임스페이스
kubectl get events -n my-namespace --sort-by=.lastTimestamp

# 특정 파드 관련 이벤트
kubectl describe pod <pod-name>
```

## 자주 보이는 이벤트

| 이벤트 | 의미 | 다음 확인 |
|--------|------|----------|
| `FailedScheduling` | 스케줄링 실패 | 리소스 부족, taint/toleration |
| `ImagePullBackOff` | 이미지 pull 실패 | 이미지명, 레지스트리 인증 |
| `CrashLoopBackOff` | 컨테이너 반복 실패 | 로그 확인 |
| `OOMKilled` | 메모리 초과 | limit 증가 또는 최적화 |
| `Unhealthy` | 헬스체크 실패 | probe 설정, 앱 상태 |

# 2. 파드 상태 확인

---

```bash
# 파드 목록
kubectl get pods
kubectl get pods -o wide  # 노드 정보 포함

# 파드 상세 정보
kubectl describe pod <pod-name>

# 파드 YAML 확인
kubectl get pod <pod-name> -o yaml
```

## 파드 상태별 대응

| 상태 | 원인 | 조치 |
|------|------|------|
| `Pending` | 스케줄링 대기 | 리소스, node selector 확인 |
| `ContainerCreating` | 컨테이너 생성 중 | 이미지 pull, volume mount 확인 |
| `Running` | 정상 실행 | 앱 로그 확인 |
| `CrashLoopBackOff` | 반복 실패 | 로그 + 이전 로그 확인 |
| `Error` | 실행 오류 | describe + 로그 확인 |
| `Completed` | 완료 (Job 등) | 정상 |
| `Terminating` | 종료 중 | finalizer, graceful shutdown 확인 |

# 3. 로그 확인

---

```bash
# 기본 로그
kubectl logs <pod-name>

# 특정 컨테이너 (멀티컨테이너 파드)
kubectl logs <pod-name> -c <container-name>

# 실시간 로그 (tail -f)
kubectl logs -f <pod-name>

# 이전 컨테이너 로그 (CrashLoop 시)
kubectl logs <pod-name> --previous

# 최근 N줄
kubectl logs <pod-name> --tail=100

# 시간 범위
kubectl logs <pod-name> --since=1h
```

## 여러 파드 로그

```bash
# 레이블로 여러 파드 로그
kubectl logs -l app=myapp --all-containers

# stern 사용 (더 편리)
stern myapp -n my-namespace
```

# 4. 컨테이너 접속 (exec)

---

```bash
# 쉘 접속
kubectl exec -it <pod-name> -- /bin/sh
kubectl exec -it <pod-name> -- /bin/bash

# 특정 컨테이너
kubectl exec -it <pod-name> -c <container-name> -- /bin/sh

# 단일 명령 실행
kubectl exec <pod-name> -- ls -la
kubectl exec <pod-name> -- cat /etc/config/app.yaml
kubectl exec <pod-name> -- env | grep MY_VAR
```

## 네트워크 디버깅

```bash
# DNS 확인
kubectl exec <pod-name> -- nslookup my-service

# 연결 테스트
kubectl exec <pod-name> -- curl -v http://my-service:8080/health
kubectl exec <pod-name> -- wget -qO- http://my-service:8080/health
```

# 5. 리소스 사용량 확인

---

```bash
# 파드 리소스 사용량
kubectl top pod
kubectl top pod -n my-namespace

# 노드 리소스 사용량
kubectl top node

# 특정 노드 상세
kubectl describe node <node-name>
```

## 리소스 관련 확인

```bash
# 파드 requests/limits 확인
kubectl get pod <pod-name> -o jsonpath='{.spec.containers[*].resources}'

# 노드 할당 가능 리소스
kubectl describe node <node-name> | grep -A5 Allocatable
```

# 6. 포트 포워딩

---

```bash
# 파드로 직접
kubectl port-forward pod/<pod-name> 8080:80

# 서비스로
kubectl port-forward svc/<service-name> 8080:80

# 백그라운드 실행
kubectl port-forward svc/myservice 8080:80 &
```

## 로컬에서 테스트

```bash
# 포트포워딩 후
curl http://localhost:8080/health
```

# 7. 서비스/엔드포인트 확인

---

```bash
# 서비스 목록
kubectl get svc

# 서비스 상세 (selector, endpoints)
kubectl describe svc <service-name>

# 엔드포인트 확인 (연결된 파드 IP)
kubectl get endpoints <service-name>
```

## 엔드포인트가 없는 경우

```bash
# 파드 레이블 확인
kubectl get pods --show-labels

# 서비스 selector와 파드 레이블 비교
kubectl get svc <service-name> -o jsonpath='{.spec.selector}'
```

# 8. 빠른 디버깅 순서

---

```
1. kubectl get events --sort-by=.lastTimestamp
   → 최근 문제 힌트

2. kubectl get pods
   → 파드 상태 확인

3. kubectl describe pod <pod>
   → 상세 이벤트, 조건

4. kubectl logs <pod> [--previous]
   → 앱 로그

5. kubectl exec -it <pod> -- sh
   → 컨테이너 내부 확인

6. kubectl top pod/node
   → 리소스 확인
```

# 9. 케이스별 빠른 처방

---

## CrashLoopBackOff

```bash
kubectl logs <pod-name> --previous
kubectl describe pod <pod-name>
# → 앱 에러, probe 설정, 환경변수 확인
```

## ImagePullBackOff

```bash
kubectl describe pod <pod-name> | grep -A5 "Events"
# → 이미지명, 레지스트리 인증, 네트워크
```

## FailedScheduling

```bash
kubectl describe pod <pod-name>
kubectl describe node <node-name>
# → 리소스 부족, taint/toleration, node selector
```

## OOMKilled

```bash
kubectl describe pod <pod-name> | grep -i oom
kubectl top pod <pod-name>
# → memory limit 상향 또는 메모리 사용 최적화
```

## 서비스 연결 안 됨

```bash
kubectl get endpoints <service-name>
kubectl describe svc <service-name>
kubectl get pods -l app=myapp
# → selector 매칭, 파드 readiness 확인
```

# 10. 유용한 Alias

---

```bash
# ~/.bashrc 또는 ~/.zshrc
alias k='kubectl'
alias kg='kubectl get'
alias kd='kubectl describe'
alias kl='kubectl logs'
alias ke='kubectl exec -it'
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kge='kubectl get events --sort-by=.lastTimestamp'
```

# 11. 체크리스트

---

```
□ events에서 FailedScheduling/Probe 실패를 확인했는가?
□ 로그에 "원인 에러"가 있는가?
□ 리소스(cpu/mem) 부족이 아닌가?
□ 네트워크/DNS 문제가 아닌가?
□ 이미지/레지스트리 접근이 가능한가?
□ probe 설정이 앱 상태와 맞는가?
```

# Reference

---

- [kubectl Cheat Sheet](https://kubernetes.io/docs/reference/kubectl/cheatsheet/)
- [Debugging Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Debugging Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
