---
title: "[AWS Elastic Beanstalk] 무중단 배포 설정 - Rolling, Immutable, 헬스체크"
categories:
  - AWS
tags:
  - [AWS, ElasticBeanstalk, Deployment, AutoScaling, DevOps]
---

# Introduction

---

Elastic Beanstalk에서 배포/장애 시 **"인스턴스 한 대 내려가면 서비스가 끊긴다"**는 문제는 대부분 설정으로 예방 가능합니다.

핵심은 3가지입니다:

1. **최소 인스턴스 수 (Min)**
2. **배포 전략 (Rolling vs Immutable)**
3. **헬스체크/배치 사이즈**

# 1. 최소 인스턴스 수 = 2 이상

---

**가장 중요한 설정**입니다.

```
인스턴스 1대 → 내려가는 순간 다운타임
인스턴스 2대 이상 → 한 대 교체 중에도 다른 한 대가 서비스 유지
```

## 설정 방법

```yaml
# .ebextensions/autoscaling.config
option_settings:
  aws:autoscaling:asg:
    MinSize: 2
    MaxSize: 4
```

## AWS 콘솔에서

```
환경 → Configuration → Capacity → Auto Scaling Group
→ Minimum instances: 2
```

# 2. 배포 전략

---

## All at Once (기본값)

```
모든 인스턴스 동시 배포
→ 가장 빠르지만 다운타임 발생
→ 개발 환경에서만 사용
```

## Rolling

```
1. 배치 단위로 인스턴스 교체
2. 일부가 새 버전으로 전환되는 동안 나머지가 서비스
3. 순차적으로 전체 완료
```

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Rolling
    BatchSizeType: Percentage
    BatchSize: 25  # 25%씩 교체
```

**장점:** 비용 추가 없음, 빠름
**단점:** 배포 중 혼재 상태 (일부 구버전, 일부 신버전)

## Rolling with Additional Batch

```
1. 새 인스턴스 추가 생성 (배치 크기만큼)
2. 새 인스턴스에 신버전 배포
3. 신버전 정상 시 구버전 인스턴스 제거
```

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: RollingWithAdditionalBatch
    BatchSize: 1
```

**장점:** 배포 중에도 전체 용량 유지
**단점:** 일시적 비용 증가

## Immutable

```
1. 새 ASG(Auto Scaling Group)에 신버전 인스턴스 생성
2. 헬스체크 통과 시 트래픽 전환
3. 구버전 ASG 삭제
```

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable
```

**장점:** 가장 안전, 롤백 빠름
**단점:** 비용 높음, 시간 오래 걸림

## 전략 비교

| 전략 | 다운타임 | 속도 | 비용 | 롤백 |
|------|---------|------|------|------|
| All at Once | O | 빠름 | 없음 | 재배포 |
| Rolling | X | 중간 | 없음 | 재배포 |
| Rolling + Batch | X | 중간 | 일시적 | 재배포 |
| Immutable | X | 느림 | 높음 | 빠름 |

# 3. 헬스체크 설정

---

## ELB 헬스체크

```yaml
option_settings:
  aws:elasticbeanstalk:application:
    Application Healthcheck URL: /health

  aws:elb:healthcheck:
    HealthyThreshold: 3
    Interval: 10
    Timeout: 5
    UnhealthyThreshold: 5
```

## 헬스체크 엔드포인트

```python
# Flask 예시
@app.route('/health')
def health():
    # DB 연결, 캐시 등 확인
    try:
        db.session.execute('SELECT 1')
        return jsonify(status='healthy'), 200
    except Exception as e:
        return jsonify(status='unhealthy', error=str(e)), 500
```

```java
// Spring Boot 예시 (Actuator)
@RestController
public class HealthController {
    @GetMapping("/health")
    public ResponseEntity<String> health() {
        return ResponseEntity.ok("OK");
    }
}
```

## Readiness vs Liveness

| 구분 | 역할 |
|------|------|
| Liveness | 살아있는가? (재시작 필요?) |
| Readiness | 트래픽 받을 준비 됐는가? |

EB에서는 주로 Readiness 개념의 헬스체크 사용

# 4. 배치 사이즈 설정

---

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Rolling
    BatchSizeType: Fixed  # 또는 Percentage
    BatchSize: 1  # 한 번에 1개씩 교체
```

## 주의사항

```
배치 사이즈가 크면:
- 교체 중 가용 인스턴스 부족
- 용량 50% 이하로 떨어질 수 있음

배치 사이즈가 작으면:
- 배포 시간 길어짐
- 안정성 높음
```

# 5. 배포 중 헬스가 빨갛게 되는 이유

---

## 원인 1: 헬스체크 경로 문제

```
헬스체크: /health
실제 앱: /api/health

→ 404 반환 → Unhealthy
```

## 원인 2: 앱 시작 시간

```
JVM warm-up, 캐시 로딩 등으로 시작이 느림
→ 헬스체크 실패 → Unhealthy
```

**해결:**
```yaml
option_settings:
  aws:elasticbeanstalk:environment:process:default:
    HealthCheckInterval: 30
    HealthCheckTimeout: 20
```

## 원인 3: 배치 사이즈 과다

```
인스턴스 4대 중 2대 동시 교체
→ 가용 인스턴스 2대
→ 부하 집중 → Unhealthy
```

# 6. 롤백 설정

---

```yaml
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable
    RollbackOnDeploymentFailure: true
```

## 수동 롤백

```bash
# 이전 버전으로 롤백
aws elasticbeanstalk update-environment \
    --environment-name my-env \
    --version-label v1.2.3
```

## 롤백 체크리스트

```
□ 이전 버전 라벨을 알고 있는가?
□ DB 마이그레이션 롤백이 필요한가?
□ 외부 서비스 호환성은 괜찮은가?
```

# 7. 프로덕션 권장 설정

---

```yaml
# .ebextensions/production.config
option_settings:
  # 최소 2대
  aws:autoscaling:asg:
    MinSize: 2
    MaxSize: 6

  # Immutable 배포
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable

  # 헬스체크
  aws:elasticbeanstalk:application:
    Application Healthcheck URL: /health

  aws:elb:healthcheck:
    HealthyThreshold: 2
    Interval: 10
    Timeout: 5
    UnhealthyThreshold: 3

  # 로깅
  aws:elasticbeanstalk:cloudwatch:logs:
    StreamLogs: true
    DeleteOnTerminate: false
    RetentionInDays: 30
```

# 8. 체크리스트

---

```
□ Min=2 이상인가?
□ 배포 중 헬스체크가 정확한가?
□ Rolling의 배치 사이즈/타임아웃이 과격하지 않은가?
□ 장애 시 롤백 절차가 준비되어 있는가?
□ 헬스체크 엔드포인트가 앱 상태를 정확히 반영하는가?
□ 배포 전 테스트 환경에서 검증했는가?
```

# Reference

---

- [EB Deployment Policies](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/using-features.rolling-version-deploy.html)
- [EB Health Checks](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/health-enhanced.html)
- [EB Best Practices](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/concepts.concepts.design.html)
