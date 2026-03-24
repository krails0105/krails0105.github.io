---
title: "[PostgreSQL] 트랜잭션과 동시성 제어 - ACID, Isolation Level, MVCC 완전 정리"
categories:
  - Postgres
tags: [PostgreSQL, MySQL, ACID, MVCC, Transaction, InnoDB, Isolation Level]
---

## Introduction

---

데이터베이스를 사용하다 보면 "트랜잭션", "격리 수준", "MVCC" 같은 용어를 자주 마주칩니다. 각각 따로 외우면 금방 잊어버리기 쉬운데, 이 개념들은 사실 하나의 흐름으로 연결되어 있습니다.

이 포스트에서는 다음 순서로 정리합니다.

1. **ACID** -- 트랜잭션이 보장해야 하는 4가지 속성
2. **Isolation Level** -- 격리성을 얼마나 완화할 것인가
3. **MVCC** -- 격리 수준을 구현하는 핵심 메커니즘 (PostgreSQL vs MySQL/InnoDB)
4. **VACUUM** -- MVCC 부산물인 dead tuple 정리

읽고 나면 "왜 PostgreSQL 기본 격리 수준이 Read Committed인지", "MVCC에서 스냅샷이 어떤 원리로 동작하는지", "PostgreSQL과 InnoDB가 내부적으로 어떻게 다른지"를 설명할 수 있게 됩니다.

## 1. 배경 -- 동시성 문제

---

여러 사용자가 동시에 데이터베이스를 사용할 때 문제가 생깁니다. 예를 들어 A가 잔액을 읽는 도중 B가 값을 수정하면, A는 이미 바뀐 값을 읽어야 할까요, 아니면 수정 전 값을 읽어야 할까요?

락(Lock)으로 막으면 안전하지만 성능이 크게 떨어집니다. 현대 데이터베이스는 이 문제를 **트랜잭션 격리 수준**과 **MVCC**로 해결합니다. 이 두 가지를 이해하려면 먼저 트랜잭션의 기본 속성인 ACID부터 짚고 넘어가야 합니다.

## 2. ACID -- 트랜잭션의 4가지 속성

---

**ACID**는 트랜잭션이 보장해야 하는 4가지 속성의 첫 글자입니다. 계좌 이체(A 계좌에서 10만원 빼서 B 계좌에 넣기)를 예시로 설명합니다.

| 속성 | 의미 | 계좌 이체 예시 |
|------|------|----------------|
| **Atomicity** (원자성) | 모두 성공하거나, 모두 실패 | A에서 출금만 되고 B에 입금이 안 되는 중간 상태는 존재하지 않음 |
| **Consistency** (일관성) | 트랜잭션 전후로 데이터가 유효한 상태 유지 | 이체 전 A+B = 30만원이면, 이체 후에도 30만원 |
| **Isolation** (격리성) | 동시 실행 중인 트랜잭션은 서로 간섭하지 않음 | 이체 중 다른 트랜잭션이 A 잔액을 읽으면 무엇을 봐야 하는가? |
| **Durability** (지속성) | COMMIT된 데이터는 시스템 장애에도 유실되지 않음 | WAL(Write-Ahead Log) 등으로 보장 |

이 중 **Isolation(격리성)**이 동시성 제어의 핵심입니다. 격리성을 100% 보장하면(= Serializable) 안전하지만 성능이 크게 떨어지기 때문에, 표준 SQL은 4단계 격리 수준을 정의했습니다.

## 3. 이상 현상 (Anomaly) 3가지

---

격리 수준을 이해하려면 먼저 어떤 이상 현상이 발생할 수 있는지 알아야 합니다.

### Dirty Read

아직 **COMMIT되지 않은** 다른 트랜잭션의 변경값을 읽는 것입니다.

```
TX-A: UPDATE account SET balance = 50 WHERE id = 1;  -- 아직 COMMIT 안 함
TX-B: SELECT balance FROM account WHERE id = 1;       -- 50 읽음 (Dirty Read)
TX-A: ROLLBACK;                                        -- TX-B가 읽은 50은 존재한 적 없는 값
```

### Non-Repeatable Read

같은 트랜잭션 안에서 같은 row를 두 번 읽었는데 **값이 달라지는** 것입니다.

```
TX-A: SELECT balance FROM account WHERE id = 1;  -- 100
TX-B: UPDATE account SET balance = 90 WHERE id = 1; COMMIT;
TX-A: SELECT balance FROM account WHERE id = 1;  -- 90 (같은 row인데 값이 바뀜)
```

### Phantom Read

같은 트랜잭션 안에서 같은 조건으로 두 번 조회했는데 **행 수가 달라지는** 것입니다.

```
TX-A: SELECT COUNT(*) FROM account WHERE balance > 50;  -- 3건
TX-B: INSERT INTO account(id, balance) VALUES(99, 80); COMMIT;
TX-A: SELECT COUNT(*) FROM account WHERE balance > 50;  -- 4건 (유령 행 등장)
```

## 4. 격리 수준 (Isolation Level)

---

아래 표는 각 격리 수준에서 이상 현상 허용 여부입니다.

| 격리 수준 | Dirty Read | Non-Repeatable Read | Phantom Read |
|---|---|---|---|
| **Read Uncommitted** | 허용 | 허용 | 허용 |
| **Read Committed** | 방지 | 허용 | 허용 |
| **Repeatable Read** | 방지 | 방지 | 허용 (SQL 표준상) |
| **Serializable** | 방지 | 방지 | 방지 |

**DB별 기본 격리 수준**

| DB | 기본 격리 수준 |
|----|---------------|
| PostgreSQL | **Read Committed** |
| MySQL (InnoDB) | **Repeatable Read** |

### 4-1. Read Uncommitted

COMMIT되지 않은 데이터도 읽습니다. Dirty Read가 발생할 수 있어 실무에서 거의 사용하지 않습니다.

**PostgreSQL 특이사항**: `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`로 설정해도 내부적으로 **Read Committed와 동일하게** 동작합니다. PostgreSQL은 설계상 Dirty Read를 의도적으로 허용하지 않습니다.

### 4-2. Read Committed

**SELECT를 실행할 때마다 새로운 스냅샷을 찍습니다.** 따라서 같은 트랜잭션 안에서도 다른 트랜잭션의 COMMIT이 반영됩니다.

```sql
-- 트랜잭션 A (Read Committed)
BEGIN;
SELECT balance FROM account WHERE id = 1;  -- 100만원 반환
-- (이 시점에 트랜잭션 B가 balance를 90만원으로 변경하고 COMMIT)
SELECT balance FROM account WHERE id = 1;  -- 90만원 반환 (Non-Repeatable Read 발생)
COMMIT;
```

COMMIT된 것만 보이므로 Dirty Read는 방지되지만, 같은 row를 두 번 읽었을 때 값이 달라질 수 있습니다.

### 4-3. Repeatable Read

**트랜잭션의 첫 번째 비트랜잭션 제어 명령문(SELECT, UPDATE 등) 시점에 스냅샷을 한 번 찍고 고정합니다.** 이후 다른 트랜잭션이 COMMIT해도 내가 찍은 스냅샷에는 반영되지 않습니다.

```sql
-- 트랜잭션 A (Repeatable Read)
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM account WHERE id = 1;  -- 100만원 (여기서 스냅샷 고정)
-- (트랜잭션 B가 balance를 90만원으로 변경하고 COMMIT)
SELECT balance FROM account WHERE id = 1;  -- 여전히 100만원 (스냅샷 고정)
COMMIT;
```

**PostgreSQL의 Repeatable Read는 SQL 표준보다 강합니다.** 표준에서는 Phantom Read를 허용하지만, PostgreSQL은 MVCC 스냅샷 방식 덕분에 Repeatable Read에서도 Phantom Read를 방지합니다.

단, **쓰기 충돌**은 별도로 처리됩니다. 같은 row를 내가 수정하려는데 다른 트랜잭션이 이미 수정했다면 직렬화 실패 에러가 발생합니다.

```
ERROR: could not serialize access due to concurrent update
```

이 에러를 받으면 트랜잭션을 롤백하고 **재시도**해야 합니다. 이것은 애플리케이션 코드에서 처리해야 하는 부분입니다.

### 4-4. Serializable

모든 이상 현상을 방지합니다. PostgreSQL에서는 **SSI(Serializable Snapshot Isolation)** 기법으로 구현하며, 트랜잭션 간의 읽기/쓰기 의존성을 추적하여 직렬화 불가능한 경우 에러를 발생시킵니다.

## 5. MVCC -- 락 없는 동시성 처리

---

격리 수준을 구현하는 핵심 메커니즘이 **MVCC(Multi-Version Concurrency Control)**입니다.

**핵심 아이디어**: 하나의 row에 **여러 버전**을 유지하여, 읽기가 쓰기를 막지 않고 쓰기가 읽기를 막지 않습니다.

### 5-1. PostgreSQL의 MVCC 구현

PostgreSQL은 모든 row(tuple)에 두 개의 숨겨진 시스템 컬럼을 가집니다.

| 시스템 컬럼 | 의미 |
|------------|------|
| `xmin` | 이 row 버전을 **생성(INSERT/UPDATE)**한 트랜잭션 ID |
| `xmax` | 이 row 버전을 **삭제(DELETE/UPDATE)**한 트랜잭션 ID (없으면 0) |

UPDATE를 하면 기존 row의 `xmax`에 현재 트랜잭션 ID를 기록하고, 새로운 버전의 row를 추가합니다. 즉, **UPDATE = 기존 버전 삭제 표시 + 새 버전 INSERT**입니다.

```
-- UPDATE account SET balance = 90 WHERE id = 1 실행 후 내부 상태 (txid=200)

xmin   xmax   id   balance
-----  -----  ---  -------
100    200    1    100만원    <-- 트랜잭션 200이 삭제 표시한 이전 버전
200    0      1    90만원     <-- 트랜잭션 200이 생성한 새 버전
```

실제로 `xmin`, `xmax` 값을 확인할 수도 있습니다.

```sql
SELECT xmin, xmax, * FROM account WHERE id = 1;
```

### 5-2. 스냅샷과 가시성 판단

어떤 row가 "내 눈에 보이는가"는 **스냅샷(snapshot)**으로 판단합니다. PostgreSQL의 스냅샷은 세 가지 정보를 담고 있습니다.

| 구성 요소 | 의미 |
|----------|------|
| `xmin` | 스냅샷 시점에 아직 **활성 상태**였던 가장 작은 트랜잭션 ID |
| `xmax` | 스냅샷 시점에 완료된 가장 큰 트랜잭션 ID + 1 |
| `xip_list` | 스냅샷 시점에 **진행 중**이었던 트랜잭션 ID 목록 |

가시성 규칙을 단순화하면 다음과 같습니다.

```
1. xmin이 COMMIT된 트랜잭션이어야 보임 (진행 중이거나 ABORT된 것은 안 보임)
2. xmax가 없거나(0), xmax를 설정한 트랜잭션이 아직 COMMIT 안 되었으면 보임
3. xip_list에 있는 트랜잭션이 만든 row는 (그 트랜잭션이 COMMIT했더라도) 안 보임
```

세 번째 규칙이 중요합니다. 스냅샷을 찍는 시점에 진행 중이었던 트랜잭션은, 이후에 COMMIT하더라도 해당 스냅샷에서는 보이지 않습니다.

**3명 동시 작업 예시**

```
시간 -->
         t1         t2         t3         t4
TX-100:  BEGIN      UPDATE     COMMIT
TX-101:  BEGIN                            SELECT (Read Committed)
TX-102:                        BEGIN      SELECT (Repeatable Read)
```

| 트랜잭션 | txid | t4 시점에서 보는 잔액 | 이유 |
|----------|------|----------------------|------|
| TX-101 | 101 | **90만원** (변경값) | Read Committed: t4 시점에 새 스냅샷 찍음. TX-100은 이미 COMMIT 완료 |
| TX-102 | 102 | **90만원** (변경값) | Repeatable Read: t3에서 스냅샷 찍음. 그 시점에 TX-100은 이미 COMMIT 완료 |

만약 TX-102가 t1에서 시작했다면, TX-100이 `xip_list`에 포함되어 TX-100의 변경이 보이지 않으므로 **100만원**을 반환합니다.

### 5-3. Read Committed vs Repeatable Read -- 스냅샷 차이

| 항목 | Read Committed | Repeatable Read |
|------|---------------|-----------------|
| 스냅샷 시점 | **매 SELECT마다** 새로 찍음 | **첫 번째 쿼리 시점**에 한 번 찍고 고정 |
| 다른 TX의 COMMIT 반영 | 반영됨 (매번 새 스냅샷) | 반영 안 됨 (고정 스냅샷) |
| Non-Repeatable Read | 발생 가능 | 방지 |

## 6. DELETE와 VACUUM

---

DELETE도 MVCC 방식으로 동작합니다. 실제로 row를 물리적으로 삭제하지 않고, `xmax`에 삭제한 트랜잭션 ID를 기록할 뿐입니다.

이렇게 더 이상 어떤 트랜잭션의 스냅샷에도 보이지 않게 된 row를 **dead tuple**이라고 합니다. dead tuple은 디스크 공간을 계속 차지하므로 주기적으로 정리해야 합니다. 이 작업이 **VACUUM**입니다.

### 6-1. VACUUM의 두 가지 모드

| 모드 | 동작 | 락 | 운영 체제에 공간 반환 |
|------|------|----|--------------------|
| `VACUUM` (일반) | dead tuple 공간을 재사용 가능하게 표시 | 읽기/쓰기와 동시 실행 가능 | 대부분 반환하지 않음 (테이블 내 재사용) |
| `VACUUM FULL` | 테이블 전체를 새 파일로 다시 씀 | **ACCESS EXCLUSIVE 락** (테이블 전체 잠금) | 반환함 |

```sql
-- 일반 VACUUM + 통계 갱신 (보통 autovacuum에 맡김)
VACUUM ANALYZE account;

-- 공간을 OS에 반환해야 할 때 (운영 중 사용 주의 -- 테이블 잠금 발생)
VACUUM FULL account;
```

### 6-2. Autovacuum

PostgreSQL은 기본적으로 **autovacuum**이 활성화되어 있어 백그라운드에서 자동으로 dead tuple을 정리합니다. autovacuum이 트리거되는 기본 조건은 다음과 같습니다.

- 삭제/수정된 tuple 수가 `autovacuum_vacuum_threshold`(기본 50) + 테이블 크기 x `autovacuum_vacuum_scale_factor`(기본 0.2)를 넘을 때
- INSERT만 있는 경우에도 `autovacuum_vacuum_insert_threshold`(기본 1000) 이상 삽입되면 트리거

쓰기가 많은 환경에서는 autovacuum 파라미터 튜닝이 중요한 운영 포인트가 됩니다.

## 7. PostgreSQL vs InnoDB -- MVCC 구현 차이

---

두 데이터베이스 모두 MVCC를 사용하지만 구현 방식이 다릅니다.

| 항목 | PostgreSQL | MySQL (InnoDB) |
|------|-----------|----------------|
| 새 버전 저장 위치 | **테이블에 새 row 추가** (기존 row에 xmax 표시) | **원본 row를 직접 수정** + undo log에 이전값 보관 |
| 이전 버전 정리 | **VACUUM** (autovacuum 또는 수동) | **purge thread**가 자동 정리 |
| 읽기 방식 | 테이블(heap)에서 직접 읽음 | 필요하면 **undo log 체인**을 역방향 탐색 |
| 장점 | 읽기 시 추가 비용 없음 | VACUUM 같은 별도 정리 불필요 |
| 단점 | dead tuple 누적 시 테이블 팽창(bloat) | 긴 트랜잭션이 있으면 undo log 체인이 길어져 읽기 느려짐 |

### InnoDB의 Undo Log

InnoDB는 UPDATE 시 원본 row를 직접 수정하고, 이전 버전을 **undo log**에 저장합니다. undo log는 두 가지 역할을 합니다.

1. **롤백용**: 트랜잭션이 실패했을 때 이전 상태로 되돌림
2. **MVCC 읽기용**: 오래된 스냅샷이 필요한 트랜잭션은 undo log 체인을 역방향으로 따라가며 자신에게 보이는 버전을 찾음

```
테이블 row (최신 버전): balance = 90  (txid=200)
                          |
                          v  undo log pointer
                    undo log: balance = 100  (txid=100)
                          |
                          v
                    undo log: balance = 120  (txid=50)
```

오래된 스냅샷을 가진 트랜잭션일수록 undo log 체인을 더 깊이 탐색해야 하므로, **긴 트랜잭션이 성능 저하의 원인**이 될 수 있습니다.

## 8. 실무 주의사항

---

### 긴 트랜잭션을 피하라

- **PostgreSQL**: 긴 트랜잭션이 있으면 그 트랜잭션의 스냅샷이 참조하는 dead tuple을 VACUUM이 정리하지 못하여 테이블이 팽창(bloat)합니다.
- **InnoDB**: 긴 트랜잭션이 있으면 undo log를 purge할 수 없어 undo log가 커지고, 다른 트랜잭션의 읽기 성능이 저하됩니다.

### Repeatable Read 사용 시 재시도 로직 필수

PostgreSQL의 Repeatable Read에서 쓰기 충돌이 발생하면 `could not serialize access due to concurrent update` 에러가 반환됩니다. 애플리케이션에서 이 에러를 감지하고 트랜잭션 전체를 재시도하는 로직이 필요합니다.

```sql
-- 의사코드
LOOP
  BEGIN;
  SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
  -- 비즈니스 로직 수행
  COMMIT;
  EXIT;  -- 성공하면 루프 탈출
EXCEPTION WHEN serialization_failure THEN
  ROLLBACK;
  -- 재시도
END LOOP;
```

### VACUUM 모니터링

쓰기가 많은 테이블에서는 autovacuum이 제때 동작하는지 모니터링해야 합니다.

```sql
-- dead tuple 수와 마지막 autovacuum 시간 확인
SELECT
    relname,
    n_dead_tup,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

## 9. 정리

---

| 개념 | 핵심 |
|------|------|
| **ACID** | 트랜잭션의 4가지 보장: 원자성, 일관성, 격리성, 지속성 |
| **Isolation Level** | 격리성과 성능의 트레이드오프를 4단계로 조절 |
| **MVCC** | row의 여러 버전을 유지하여 락 없이 읽기/쓰기 동시 수행 |
| **PostgreSQL MVCC** | 테이블에 새 row 추가 방식. xmin/xmax + 스냅샷으로 가시성 판단. VACUUM 필수 |
| **InnoDB MVCC** | 원본 row 수정 + undo log 방식. purge thread가 자동 정리 |

## 다음 단계

---

- **락(Lock) 메커니즘**: MVCC로 해결 못하는 쓰기-쓰기 충돌은 락으로 처리합니다. Row-level lock, Advisory lock 등의 종류와 데드락 처리 방법
- **PostgreSQL VACUUM 튜닝**: autovacuum 파라미터 조정, bloat 모니터링, `pg_repack` 활용
- **Serializable Snapshot Isolation (SSI)**: PostgreSQL의 Serializable 격리 수준 내부 구현
- **분산 트랜잭션**: 여러 DB에 걸친 트랜잭션 처리 (2PC, Saga 패턴)

## Reference

---

- [PostgreSQL 공식 문서 - Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL 공식 문서 - MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL 공식 문서 - VACUUM](https://www.postgresql.org/docs/current/sql-vacuum.html)
- [PostgreSQL 공식 문서 - Transaction ID and Snapshot Functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT)
- [PostgreSQL 공식 문서 - Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [MySQL 공식 문서 - InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- [MySQL 공식 문서 - InnoDB Undo Logs](https://dev.mysql.com/doc/refman/8.0/en/innodb-undo-logs.html)
