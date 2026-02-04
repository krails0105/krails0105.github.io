---
title: "[PostgreSQL] InFailedSqlTransaction 에러 - 원인과 해결"
categories:
  - Postgres
tags:
  - [PostgreSQL, Transaction, Error, Troubleshooting]
---

# Introduction

---

PostgreSQL에서 자주 보는 에러:

```
psycopg2.errors.InFailedSqlTransaction:
current transaction is aborted, commands ignored until end of transaction block
```

이 에러는 **트랜잭션 안에서 에러가 발생한 후**, 롤백 없이 계속 쿼리를 실행하려 할 때 발생합니다.

# 1. 원인 이해

---

## PostgreSQL 트랜잭션 특성

```sql
BEGIN;
SELECT * FROM users;        -- 성공
SELECT * FROM nonexistent;  -- 에러! 테이블 없음
SELECT * FROM orders;       -- InFailedSqlTransaction!
```

PostgreSQL은 트랜잭션 내 에러 발생 시 **해당 트랜잭션 전체를 "실패" 상태**로 표시합니다.

```
정상 트랜잭션: BEGIN → 쿼리들 → COMMIT
실패 트랜잭션: BEGIN → 쿼리 → 에러 → (추가 쿼리 불가) → ROLLBACK 필요
```

# 2. 해결 방법

---

## 방법 1: 명시적 ROLLBACK

```python
import psycopg2

conn = psycopg2.connect(...)
cur = conn.cursor()

try:
    cur.execute("SELECT * FROM nonexistent")
except psycopg2.Error as e:
    conn.rollback()  # 트랜잭션 롤백
    print(f"에러 발생, 롤백: {e}")

# 이제 새 쿼리 실행 가능
cur.execute("SELECT * FROM users")
```

## 방법 2: autocommit 모드

```python
conn = psycopg2.connect(...)
conn.autocommit = True  # 각 쿼리가 자동 커밋

cur = conn.cursor()
try:
    cur.execute("SELECT * FROM nonexistent")
except psycopg2.Error:
    pass  # 트랜잭션 없으므로 롤백 불필요

cur.execute("SELECT * FROM users")  # 정상 실행
```

## 방법 3: context manager 사용

```python
import psycopg2
from contextlib import contextmanager

@contextmanager
def get_cursor(conn):
    cur = conn.cursor()
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()

# 사용
conn = psycopg2.connect(...)
with get_cursor(conn) as cur:
    cur.execute("SELECT * FROM users")
    # 에러 시 자동 롤백
```

# 3. SQLAlchemy에서의 처리

---

## 세션 롤백

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine("postgresql://...")
Session = sessionmaker(bind=engine)
session = Session()

try:
    session.execute("SELECT * FROM nonexistent")
except Exception:
    session.rollback()  # 세션 롤백
    # 또는
    # session.close()  # 세션 닫기

# 새 쿼리 실행
result = session.execute("SELECT * FROM users")
```

## autoflush와 autocommit

```python
Session = sessionmaker(
    bind=engine,
    autoflush=False,  # 명시적 flush만
    autocommit=False  # 명시적 commit만
)
```

## scoped_session 패턴

```python
from sqlalchemy.orm import scoped_session, sessionmaker

Session = scoped_session(sessionmaker(bind=engine))

try:
    Session.execute("...")
except:
    Session.rollback()
finally:
    Session.remove()  # 스레드-로컬 세션 정리
```

# 4. Django에서의 처리

---

## atomic 데코레이터

```python
from django.db import transaction

@transaction.atomic
def my_view(request):
    # 이 블록 안에서 에러 → 자동 롤백
    Model.objects.create(...)
    # 에러 발생 시 전체 롤백
```

## 수동 트랜잭션 관리

```python
from django.db import connection

try:
    with connection.cursor() as cursor:
        cursor.execute("SELECT ...")
except Exception:
    # Django는 자동으로 롤백하지만 명시적으로
    connection.rollback()
```

# 5. SAVEPOINT 활용

---

## 부분 롤백

```sql
BEGIN;
INSERT INTO users (name) VALUES ('Alice');
SAVEPOINT sp1;
INSERT INTO orders (user_id) VALUES (999);  -- 에러!
ROLLBACK TO SAVEPOINT sp1;                  -- sp1로 롤백
INSERT INTO orders (user_id) VALUES (1);    -- 계속 진행
COMMIT;
```

## Python에서 SAVEPOINT

```python
conn = psycopg2.connect(...)
cur = conn.cursor()

cur.execute("BEGIN")
cur.execute("INSERT INTO users (name) VALUES ('Alice')")
cur.execute("SAVEPOINT sp1")

try:
    cur.execute("INSERT INTO orders (user_id) VALUES (999)")
except psycopg2.Error:
    cur.execute("ROLLBACK TO SAVEPOINT sp1")

cur.execute("INSERT INTO orders (user_id) VALUES (1)")
cur.execute("COMMIT")
```

## SQLAlchemy SAVEPOINT

```python
with session.begin_nested():  # SAVEPOINT 생성
    session.add(some_object)
    # 이 블록 에러 시 SAVEPOINT로 롤백
# 성공 시 상위 트랜잭션에 포함
```

# 6. 연결 풀과 트랜잭션

---

## 문제: 더러운 커넥션 반환

```python
# 잘못된 예
def do_work(pool):
    conn = pool.getconn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM nonexistent")  # 에러!
    pool.putconn(conn)  # 실패 트랜잭션 상태로 반환!
```

## 해결: 반환 전 정리

```python
def do_work(pool):
    conn = pool.getconn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM nonexistent")
        conn.commit()
    except Exception:
        conn.rollback()  # 항상 롤백
    finally:
        pool.putconn(conn)  # 깨끗한 상태로 반환
```

## SQLAlchemy 커넥션 풀

```python
engine = create_engine(
    "postgresql://...",
    pool_pre_ping=True,  # 사용 전 연결 상태 확인
    pool_reset_on_return="rollback"  # 반환 시 롤백
)
```

# 7. 디버깅 팁

---

## 현재 트랜잭션 상태 확인

```sql
SELECT state FROM pg_stat_activity WHERE pid = pg_backend_pid();
-- idle: 트랜잭션 없음
-- idle in transaction: 트랜잭션 중
-- idle in transaction (aborted): 실패 상태!
```

## Python에서 상태 확인

```python
print(conn.status)
# STATUS_READY: 정상
# STATUS_BEGIN: 트랜잭션 중
# STATUS_IN_TRANSACTION: 트랜잭션 중
```

# 8. 예방 패턴

---

## 패턴 1: try-except-rollback

```python
def safe_execute(conn, query, params=None):
    cur = conn.cursor()
    try:
        cur.execute(query, params)
        conn.commit()
        return cur.fetchall()
    except Exception as e:
        conn.rollback()
        raise
    finally:
        cur.close()
```

## 패턴 2: context manager

```python
from contextlib import contextmanager

@contextmanager
def transaction(conn):
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
```

## 패턴 3: 데코레이터

```python
def with_transaction(func):
    def wrapper(conn, *args, **kwargs):
        try:
            result = func(conn, *args, **kwargs)
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
    return wrapper

@with_transaction
def create_user(conn, name):
    cur = conn.cursor()
    cur.execute("INSERT INTO users (name) VALUES (%s)", (name,))
```

# 9. 체크리스트

---

```
□ 에러 발생 시 rollback을 호출하는가?
□ 커넥션 풀 반환 전 트랜잭션을 정리하는가?
□ autocommit 사용 여부를 의도적으로 선택했는가?
□ ORM 세션의 에러 처리가 되어 있는가?
□ 필요한 경우 SAVEPOINT를 사용하는가?
```

# Reference

---

- [PostgreSQL Transaction Documentation](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [psycopg2 Transaction Handling](https://www.psycopg.org/docs/usage.html#transactions-control)
- [SQLAlchemy Session Basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)
