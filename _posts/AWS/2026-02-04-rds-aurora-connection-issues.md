---
title: "[AWS RDS/Aurora] Connection Reset 에러 - 원인과 해결"
categories:
  - AWS
tags:
  - [AWS, RDS, Aurora, PostgreSQL, ConnectionPool, Troubleshooting]
---

# Introduction

---

DB 로그에 `connection reset by peer`, `SSL error: BAD_DECRYPT` 같은 메시지가 보이면 원인은 크게 3갈래로 나뉩니다:

1. 클라이언트/애플리케이션 측 연결 관리 (풀/timeout)
2. 네트워크/LB/프록시 계층 idle timeout
3. TLS 설정/암호화 계층 문제 (드물지만 존재)

# 1. 가장 흔한 원인: 커넥션 풀 설정

---

## 문제 상황

```
앱 커넥션 풀 max_lifetime: 30분
네트워크 idle timeout: 5분

→ 5분 후 네트워크가 커넥션을 끊음
→ 앱은 끊긴 커넥션을 재사용
→ "connection reset by peer"
```

## 해결: max_lifetime을 idle timeout보다 짧게

```java
// HikariCP 예시
HikariConfig config = new HikariConfig();
config.setMaxLifetime(240000);  // 4분 (네트워크 timeout 5분보다 짧게)
config.setIdleTimeout(120000);   // 2분
config.setConnectionTimeout(30000);
```

```python
# SQLAlchemy 예시
engine = create_engine(
    "postgresql://...",
    pool_recycle=240,  # 4분
    pool_pre_ping=True  # 사용 전 연결 확인
)
```

## 핵심 공식

```
pool_max_lifetime < network_idle_timeout
```

# 2. 네트워크 계층 Idle Timeout

---

## AWS 네트워크 타임아웃

| 계층 | 기본 Idle Timeout |
|------|------------------|
| NAT Gateway | 350초 (5분 50초) |
| NLB | 350초 |
| ALB | 60초 |
| RDS Proxy | 설정 가능 |

## 확인 방법

```bash
# NAT Gateway 연결 추적 확인
aws ec2 describe-nat-gateways --nat-gateway-ids nat-xxx
```

## 해결 방안

1. **풀 설정 조정** (권장)
2. **TCP Keepalive 설정**

```python
# Python psycopg2 TCP keepalive
conn = psycopg2.connect(
    ...,
    keepalives=1,
    keepalives_idle=30,
    keepalives_interval=10,
    keepalives_count=5
)
```

# 3. TLS 관련 에러 (BAD_DECRYPT)

---

## 원인

- 중간 장비가 TLS 세션을 비정상 종료
- 클라이언트/서버 TLS 버전 불일치
- 암호화 설정 충돌

## 확인 포인트

```bash
# TLS 버전 확인
openssl s_client -connect mydb.xxx.rds.amazonaws.com:5432

# 클라이언트 라이브러리 버전 확인
python -c "import ssl; print(ssl.OPENSSL_VERSION)"
```

## 해결

```python
# TLS 버전 명시
engine = create_engine(
    "postgresql://...",
    connect_args={
        "sslmode": "require",
        "sslrootcert": "/path/to/rds-ca-2019-root.pem"
    }
)
```

# 4. RDS Proxy 사용 시

---

RDS Proxy는 커넥션 풀링과 장애 조치를 개선합니다.

```
App → RDS Proxy → Aurora
      (커넥션 관리)
```

## 장점

- 커넥션 풀링/재사용
- 장애 조치 시 커넥션 유지
- IAM 인증 지원

## Proxy 설정

```bash
# 연결 타임아웃 설정
aws rds modify-db-proxy \
    --db-proxy-name my-proxy \
    --idle-client-timeout 1800
```

# 5. 실전 점검 순서

---

```
1. 앱 로그에서 연결 재사용/풀 설정 확인
   → max_lifetime, idle_timeout

2. RDS/Aurora 지표 확인
   → DatabaseConnections, CPU, Memory

3. 네트워크 idle timeout 확인
   → NAT, LB, 보안그룹

4. TLS 버전/라이브러리 차이 확인
   → 특정 클라이언트에서만 발생?

5. 배포/스케일 이벤트와 시점 비교
   → 동시 발생?
```

# 6. Aurora 특화 이슈

---

## Failover 시 커넥션 끊김

```
Primary → Replica 승격
→ 기존 커넥션 모두 reset
```

**해결:**
- RDS Proxy 사용
- 앱에서 재시도 로직

```java
// Spring Retry 예시
@Retryable(value = SQLException.class, maxAttempts = 3)
public void executeQuery() {
    ...
}
```

## Reader/Writer 엔드포인트

```
Writer: mydb.cluster-xxx.region.rds.amazonaws.com
Reader: mydb.cluster-ro-xxx.region.rds.amazonaws.com
```

- 읽기 전용 쿼리는 Reader로 분산
- Failover 시 Reader → Writer 자동 전환

# 7. 모니터링

---

## CloudWatch 지표

| 지표 | 의미 |
|------|------|
| `DatabaseConnections` | 현재 연결 수 |
| `CPUUtilization` | CPU 사용률 |
| `FreeableMemory` | 가용 메모리 |
| `NetworkReceiveThroughput` | 네트워크 수신 |

## 알람 설정

```yaml
# 연결 수 급증 알람
AlarmName: HighDatabaseConnections
MetricName: DatabaseConnections
Threshold: 100
ComparisonOperator: GreaterThanThreshold
```

# 8. 체크리스트

---

```
□ pool max_lifetime/idle_timeout을 네트워크 idle timeout보다 짧게 맞췄는가?
□ 인스턴스 수 × pool 크기가 DB max_connections를 넘지 않는가?
□ TCP keepalive가 설정되어 있는가?
□ 특정 클라이언트/버전에 편향된 에러인가?
□ 배포/오토스케일 이벤트와 겹치는가?
□ RDS Proxy 도입을 고려했는가?
□ 재시도 로직이 구현되어 있는가?
```

# Reference

---

- [RDS Connection Timeout Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html)
- [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Aurora Failover](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html)
- [HikariCP Configuration](https://github.com/brettwooldridge/HikariCP#configuration-knobs-baby)
