---
title: "[PostgreSQL] 커넥션 풀 기초 - PgBouncer, SQLAlchemy, HikariCP"
categories:
  - Postgres
tags:
  - [PostgreSQL, ConnectionPool, PgBouncer, Performance]
---

# Introduction

---

PostgreSQL 연결은 **비용이 큽니다**. 각 연결은 새 프로세스를 생성합니다.

```
연결 1개 → ~10MB 메모리
100개 연결 → ~1GB 메모리 + 컨텍스트 스위칭 오버헤드
```

커넥션 풀은 **연결을 재사용**하여 이 비용을 줄입니다.

# 1. 왜 커넥션 풀이 필요한가?

---

## 연결 없이

```
요청 1: 연결 생성 → 쿼리 → 연결 종료 (50ms)
요청 2: 연결 생성 → 쿼리 → 연결 종료 (50ms)
→ 연결 생성에 대부분의 시간 소모
```

## 커넥션 풀 사용

```
요청 1: 풀에서 연결 가져옴 → 쿼리 → 반환 (5ms)
요청 2: 풀에서 연결 가져옴 → 쿼리 → 반환 (5ms)
→ 연결 재사용으로 속도 향상
```

# 2. PostgreSQL max_connections

---

## 확인

```sql
SHOW max_connections;  -- 기본: 100
```

## 설정 (postgresql.conf)

```
max_connections = 200
```

## 주의사항

```
max_connections 높이면:
- 메모리 사용량 증가
- 성능 저하 가능

권장: 커넥션 풀 사용 + max_connections 적정 유지
```

# 3. PgBouncer (외부 풀러)

---

## 아키텍처

```
앱 → PgBouncer → PostgreSQL
      (6432)     (5432)
```

## 설치 및 설정

```bash
# 설치 (Ubuntu)
apt-get install pgbouncer

# 설정 파일
/etc/pgbouncer/pgbouncer.ini
```

```ini
[databases]
mydb = host=localhost port=5432 dbname=mydb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction    # 트랜잭션 단위 풀링
default_pool_size = 20     # DB당 기본 연결 수
max_client_conn = 1000     # 최대 클라이언트 연결
```

## Pool Mode

| 모드 | 설명 | 사용 |
|------|------|------|
| session | 세션 동안 연결 점유 | prepared statements |
| transaction | 트랜잭션 동안 연결 점유 | 일반적인 웹 앱 |
| statement | 쿼리 단위 연결 | 단순 쿼리 (autocommit) |

## userlist.txt

```
"myuser" "md5password_hash"
```

```bash
# 패스워드 해시 생성
echo -n "md5$(echo -n 'password''myuser' | md5sum | cut -d' ' -f1)"
```

# 4. SQLAlchemy 커넥션 풀

---

## 기본 설정

```python
from sqlalchemy import create_engine

engine = create_engine(
    "postgresql://user:pass@localhost/mydb",
    pool_size=5,          # 기본 연결 수
    max_overflow=10,      # 추가 연결 수
    pool_timeout=30,      # 연결 대기 시간
    pool_recycle=1800,    # 연결 재생성 주기 (초)
    pool_pre_ping=True    # 사용 전 연결 확인
)
```

## 풀 동작

```
pool_size=5, max_overflow=10 이면:
- 최소 연결: 5개 (항상 유지)
- 최대 연결: 15개 (5 + 10)
- 15개 초과 요청 → pool_timeout만큼 대기 → TimeoutError
```

## QueuePool (기본)

```python
from sqlalchemy.pool import QueuePool

engine = create_engine(
    "...",
    poolclass=QueuePool,
    pool_size=10
)
```

## NullPool (풀링 없음)

```python
from sqlalchemy.pool import NullPool

# 서버리스 환경에서 사용
engine = create_engine(
    "...",
    poolclass=NullPool  # 매번 새 연결
)
```

## 풀 이벤트

```python
from sqlalchemy import event

@event.listens_for(engine, "checkout")
def on_checkout(dbapi_conn, connection_record, connection_proxy):
    print("Connection checked out from pool")

@event.listens_for(engine, "checkin")
def on_checkin(dbapi_conn, connection_record):
    print("Connection returned to pool")
```

# 5. HikariCP (Java)

---

## 설정

```java
HikariConfig config = new HikariConfig();
config.setJdbcUrl("jdbc:postgresql://localhost/mydb");
config.setUsername("user");
config.setPassword("pass");

// 풀 설정
config.setMaximumPoolSize(10);
config.setMinimumIdle(5);
config.setIdleTimeout(300000);     // 5분
config.setMaxLifetime(1800000);    // 30분
config.setConnectionTimeout(30000); // 30초

HikariDataSource ds = new HikariDataSource(config);
```

## Spring Boot 설정

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 10
      minimum-idle: 5
      idle-timeout: 300000
      max-lifetime: 1800000
      connection-timeout: 30000
```

## 적정 풀 크기 공식

```
connections = ((core_count * 2) + effective_spindle_count)

예: 4코어 SSD(spindle=1)
connections = (4 * 2) + 1 = 9
```

# 6. psycopg2 풀

---

## SimpleConnectionPool

```python
from psycopg2 import pool

# 풀 생성
conn_pool = pool.SimpleConnectionPool(
    minconn=1,
    maxconn=10,
    host="localhost",
    database="mydb",
    user="user",
    password="pass"
)

# 연결 가져오기
conn = conn_pool.getconn()

try:
    cur = conn.cursor()
    cur.execute("SELECT 1")
finally:
    conn_pool.putconn(conn)  # 반환!

# 풀 종료
conn_pool.closeall()
```

## ThreadedConnectionPool

```python
from psycopg2 import pool

# 스레드 안전
conn_pool = pool.ThreadedConnectionPool(
    minconn=5,
    maxconn=20,
    ...
)
```

# 7. 모니터링

---

## PostgreSQL 연결 확인

```sql
-- 현재 연결 수
SELECT count(*) FROM pg_stat_activity;

-- 연결 상태별
SELECT state, count(*)
FROM pg_stat_activity
GROUP BY state;

-- 대기 중인 연결
SELECT * FROM pg_stat_activity WHERE state = 'idle';

-- 오래된 idle 연결
SELECT pid, now() - state_change as idle_time, query
FROM pg_stat_activity
WHERE state = 'idle'
ORDER BY idle_time DESC;
```

## PgBouncer 상태

```sql
-- pgbouncer에 연결 후
SHOW POOLS;
SHOW CLIENTS;
SHOW SERVERS;
SHOW STATS;
```

# 8. 트러블슈팅

---

## 문제 1: 연결 부족

```
에러: "too many connections" 또는 "connection pool exhausted"
```

**해결:**
```python
# 풀 크기 증가
pool_size=10 → pool_size=20

# 또는 max_overflow 증가
max_overflow=10 → max_overflow=20
```

## 문제 2: 연결 누수

```python
# 잘못된 코드 - 연결 반환 안 함
conn = pool.getconn()
cur = conn.cursor()
cur.execute("SELECT 1")
# putconn() 누락!

# 올바른 코드
conn = pool.getconn()
try:
    cur = conn.cursor()
    cur.execute("SELECT 1")
finally:
    pool.putconn(conn)
```

## 문제 3: 끊어진 연결 사용

```python
# pool_pre_ping으로 사용 전 확인
engine = create_engine(
    "...",
    pool_pre_ping=True
)
```

## 문제 4: 트랜잭션 상태 문제

```python
# 반환 전 롤백
@event.listens_for(engine, "reset")
def on_reset(dbapi_conn, connection_record):
    dbapi_conn.rollback()
```

# 9. 체크리스트

---

```
□ 커넥션 풀을 사용하고 있는가?
□ 풀 크기가 DB max_connections 이하인가?
□ pool_pre_ping으로 끊어진 연결을 감지하는가?
□ 연결을 확실히 반환하고 있는가?
□ 반환 전 트랜잭션 상태를 정리하는가?
□ 풀 모니터링을 하고 있는가?
```

# Reference

---

- [PgBouncer Documentation](https://www.pgbouncer.org/)
- [SQLAlchemy Connection Pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html)
- [HikariCP](https://github.com/brettwooldridge/HikariCP)
- [PostgreSQL Connection Management](https://www.postgresql.org/docs/current/runtime-config-connection.html)
