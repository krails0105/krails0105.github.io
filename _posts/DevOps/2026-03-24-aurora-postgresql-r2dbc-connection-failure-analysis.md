---
title: "Aurora PostgreSQL Reader 장애 분석 — Writer 대량 쓰기가 Reader R2DBC 커넥션을 죽이는 메커니즘"
categories:
  - DevOps
tags:
  - Aurora
  - PostgreSQL
  - R2DBC
  - AWS
  - RDS
  - 장애분석
  - ConnectionPool
date: 2026-03-24
---

# Introduction

---

2026-03-23 17:51 UTC, API 서비스의 주요 엔드포인트 전체에서 약 13초간 HTTP 500이 쏟아졌다. 에러 메시지는 `Failed to obtain R2DBC Connection`. 쿼리가 느렸던 것도 아니고, DB가 죽은 것도 아니었다. **Writer가 다른 테이블에 대량 쓰기를 하는 동안 Reader가 일시적으로 응답 불가 상태에 빠진 것이었다.**

이 장애의 핵심은 "Writer가 건드린 테이블과 API가 읽는 테이블이 완전히 다른데도, Reader 쪽 모든 엔드포인트가 동시에 실패했다"는 점이다. 원인을 이해하려면 Aurora PostgreSQL의 내부 아키텍처, 특히 redo log 스트리밍과 buffer pool의 동작 방식을 알아야 한다.

이 포스트는 그 메커니즘을 Aurora 내부 구조에서부터 R2DBC 커넥션 풀 실패까지 단계적으로 추적한 분석 기록이다. 읽고 나면 다음을 이해할 수 있다.

- Aurora Reader가 Writer의 대량 쓰기에 영향받는 구조적 이유
- 관계없는 테이블의 읽기 쿼리까지 동시에 실패하는 메커니즘
- 이 유형의 장애를 진단하고 예방하기 위한 구체적인 설정과 전략

#### 사전 지식

- Aurora PostgreSQL의 Writer/Reader 구성 개념
- R2DBC 커넥션 풀 기본 개념 (reactive 환경에서의 DB 커넥션 관리)
- CloudWatch, Performance Insights 등 AWS 모니터링 도구 기본 사용법

# 장애 요약

---

| 항목 | 내용 |
|---|---|
| 에러 | `Failed to obtain R2DBC Connection` |
| 발생 시간 | 17:51:22 ~ 17:51:35 UTC (약 13초) |
| 영향 범위 | user-data, order-history, dashboard, reports 전 엔드포인트 |
| 영향 스레드 | reactor-tcp-nio-1, 2, 3, 4 전 스레드 |
| 클라이언트 응답 | HTTP 500 |
| 복구 | 자연 복구 (자동) |

특이한 점은 **Writer가 쓴 테이블과 API가 읽는 테이블이 서로 달랐음에도** 관계없는 엔드포인트 전체가 동시에 실패했다는 것이다. 이 이유를 이해하려면 Aurora의 스토리지 아키텍처부터 봐야 한다.

# Aurora PostgreSQL 아키텍처

---

Aurora는 표준 PostgreSQL과 다르다. WAL shipping 방식이 아닌 **shared storage + redo log 스트리밍** 구조다. 이 차이가 장애 메커니즘의 출발점이다.

```
Writer Instance                      Reader Instance
+---------------+                    +---------------+
| Buffer Pool   |                    | Buffer Pool   |
| (메모리)       |                    | (메모리)       |
+-------+-------+                    +-------+-------+
        | write                                | read
        v                                      v
+-----------------------------------------------------------+
|            Aurora Shared Storage (6 copies, 3 AZ)          |
+-----------------------------------------------------------+
        |
        | redo log record (실시간 스트리밍)
        +----------------------------------------------> Reader
```

표준 PostgreSQL Standby와 Aurora Reader의 차이를 정리하면 아래와 같다.

| 표준 PostgreSQL Standby | Aurora PostgreSQL Reader |
|---|---|
| WAL 파일을 받아 직접 replay | Shared storage에서 최신 데이터 직접 읽음. Writer가 보내는 redo log로 **buffer cache만 갱신** |
| Standby가 디스크에 WAL 적용 | Storage layer가 redo 적용. Reader는 디스크 쓰기 없음 |
| wal_sender로 WAL 전송 | Aurora 내부 프로토콜로 redo record 실시간 전송 |

핵심 포인트는 redo log record가 **COMMIT 시점이 아닌 생성 즉시** Reader에 전송된다는 것이다. Writer가 대량 INSERT를 실행하는 중에도 Reader는 지속적으로 invalidation을 받는다. COMMIT은 변경사항의 가시성(visibility)만 확정할 뿐이다.

```
Writer가 INSERT/UPDATE/DELETE 수행
    |
    v
Redo Log Record 생성: "page X를 이렇게 바꿨다"
    |
    +---> Shared Storage에 기록 (6 copies, 내구성 보장)
    |         Storage layer가 redo를 적용하여 데이터 페이지 갱신
    |
    +---> Reader에 실시간 스트리밍 (COMMIT과 무관하게 계속 전송)
          Reader는 이 redo를 보고:
          "page X가 바뀌었다 → 내 buffer pool에 캐시된 page X는 무효"
          → buffer cache invalidation
```

이 구조를 이해했으면, 이제 이것이 어떻게 장애로 이어지는지 단계별로 살펴보자.

# 장애 메커니즘: 3단계 연쇄

---

## Step 1 — Writer 대량 쓰기

```
Writer: 테이블 X에 대량 INSERT/UPDATE  (API가 읽는 테이블이 아님)
        -> 수천 개 페이지 수정
        -> 수천 개 redo log record가 Reader에 실시간 스트리밍
                                      |
                                      v
Reader: buffer pool에 캐시된 테이블 X 페이지들을 무효화 처리해야 함
        이 과정에서 Reader 내부 리소스 경합 발생
        → API가 읽는 테이블 Y, Z 쿼리도 영향받음
```

## Step 2 — Reader 내부 리소스 경합

Reader가 대량의 redo record를 처리하면서 **buffer pool 관리에 내부 리소스를 집중**한다. AWS 문서에서 확인되는 동작은 다음과 같다.

- Writer 대량 쓰기 시 **Reader 성능 저하 발생** (documented)
- `AuroraReplicaLag` 증가 (documented)
- Reader의 buffer cache 갱신 과정이 읽기 쿼리에 영향 (documented)

```
Reader 내부 cache 갱신 프로세스:
  대량 redo record 수신 → buffer pool 페이지 무효화 처리 중
  → 내부 리소스(메모리 구조체 접근, I/O 등) 경합
                          ^
Query Process 1:     대기 또는 지연...
Query Process 2:     대기 또는 지연...
새 Connection:       대기 또는 지연...
```

쿼리가 느린 것이 아니라, Reader가 redo 처리에 리소스를 쓰면서 **새 요청 처리 자체가 지연되거나 응답 불가**한 순간이 생긴다. 이 미묘한 차이가 진단을 어렵게 만드는 요인이다.

## Step 3 — R2DBC 커넥션 풀 실패

Reader가 응답하지 못하는 동안, 애플리케이션 측의 R2DBC 커넥션 풀은 새 커넥션을 획득하려 시도하지만 시간 내에 성공하지 못한다.

```
Reader 일시 응답 지연/불가
    |
    v
R2DBC Pool: 커넥션 acquire 시도 -> timeout (maxAcquireTime 초과)
    |
    v
Failed to obtain R2DBC Connection -> HTTP 500
```

참고로 r2dbc-pool의 `maxAcquireTime` 기본값은 **no timeout** (무제한 대기)이다. 만약 커스텀으로 `maxAcquireTime`을 설정해 두었다면 (예: 30초) 그 시간이 지나면 `PoolAcquireTimeoutException`이 발생한다. 반대로 설정하지 않았다면 timeout 대신 커넥션 풀이 가용 커넥션을 기다리며 무한 대기하게 되므로, 어느 쪽이든 서비스 장애로 이어진다.

# 왜 다른 테이블인데도 전 엔드포인트가 동시에 실패하나

---

이 장애에서 가장 혼란스러운 부분이다. Writer가 건드린 테이블과 API가 읽는 테이블은 완전히 다른데, 왜 전부 실패할까?

Reader의 buffer pool은 **모든 테이블의 페이지를 하나의 공유 메모리 공간**에 캐시한다. 테이블별로 분리되지 않는다.

```
Reader Buffer Pool (공유 메모리, 단일 구조)
+--------+--------+--------+--------+--------+
| page   | page   | page   | page   | page   |
| 테이블 A | 테이블 B | 테이블 C | 테이블 A | 테이블 D |
+--------+--------+--------+--------+--------+
  ↑ 전부 같은 메모리 구조체 안에 있음
```

시나리오를 구체적으로 보면 이렇다.

```
1. Writer가 테이블 X에 bulk insert
   -> 테이블 X 관련 redo record가 Reader에 스트리밍

2. Reader가 buffer pool에서 테이블 X 페이지를 찾아 무효화 처리
   -> 이 과정에서 buffer pool 공유 구조체에 대한 접근이 발생

3. 이 순간 테이블 Y를 읽는 쿼리도 같은 buffer pool 구조체 접근 필요 -> 지연
   이 순간 테이블 Z를 읽는 쿼리도 같은 buffer pool 구조체 접근 필요 -> 지연
   이 순간 새 커넥션 수립도 → 지연
```

한 가지 오해를 짚어두자면, Writer가 Reader에 lock을 거는 것이 아니다. Writer는 **redo record만 보내고**, Reader 내부의 cache 갱신 프로세스가 buffer pool을 정리하면서 **자기 내부에서 리소스 경합이 발생**하는 것이다. 그래서 전혀 관계없는 엔드포인트들이 동시에 전부 실패한 것이다.

# Performance Insights 데이터와의 일치

---

이론적인 분석만으로는 확신하기 어렵다. 실제 PI(Performance Insights) 데이터가 위 메커니즘과 일치하는지 확인해 보자.

| PI 관찰 | 설명 |
|---|---|
| Reader AAS spike가 **짧음** | redo 처리 부하는 일시적 → 처리 끝나면 바로 정상화 |
| spike가 **I/O wait** 위주 | invalidation 후 storage에서 페이지 re-read 시 I/O 발생 |
| **느린 쿼리가 안 보임** | 쿼리 실행 자체가 block됨 → PI에 쿼리로 잡히지 않음 |
| Writer **Commit/SyncRep** 높음 | Writer가 대량 redo 생성 중 = Reader에 대량 invalidation 전달 |

"느린 쿼리가 보이지 않는다"는 점이 이 장애 유형을 진단하기 어렵게 만드는 핵심 요인이다. 쿼리 실행 자체가 block되므로 PI의 쿼리 통계에 잡히지 않는다. 따라서 PI에서 "쿼리 문제 없음"으로 보이더라도, AAS spike와 I/O wait 패턴을 함께 확인해야 한다.

# 왜 항상이 아니라 가끔만 발생하나

---

이 장애가 더 까다로운 이유는 재현이 어렵다는 점이다. 매번 발생하는 것이 아니라 특정 조건이 겹칠 때만 나타난다.

```
평소:     소규모 write -> redo record 소량 -> Reader 즉시 처리 -> 문제 없음

특정 순간: 대규모 batch / VACUUM / 대량 UPDATE
           -> redo record 대량 생성
           -> Reader cache 갱신 부하 급증
           -> 읽기 요청 처리 불가 구간 발생
```

배치 파이프라인이 특정 시간대에 집중 실행되거나 VACUUM이 겹치는 경우에만 발생하므로, 평소에는 정상이다가 특정 타이밍에만 재현된다. 이런 간헐적 특성 때문에 "일시적 네트워크 이슈"로 오진하기 쉬운 장애 유형이다.

# RDS Proxy를 쓰면 해결되나

---

**아니오. RDS Proxy를 써도 동일한 문제가 발생한다.**

```
[AS-IS]      App ──────────────────────> Reader (내부 리소스 경합 중, 응답 불가)
                                           X 실패

[WITH PROXY] App ───> RDS Proxy ───> Reader (내부 리소스 경합 중, 응답 불가)
                                           X 똑같이 실패
```

| RDS Proxy 기능 | 이번 장애와 관련성 |
|---|---|
| 커넥션 다중화 (앱 N개 → DB 커넥션 M개) | 무관 — 커넥션 수 문제가 아님 |
| 커넥션 재사용 (생성 오버헤드 감소) | 무관 — 커넥션 생성이 느린 게 아님 |
| Failover 시 커넥션 유지 | 무관 — failover가 발생한 것이 아님 |

RDS Proxy는 **커넥션 관리 계층**이다. 이번 문제는 Reader **내부의 리소스 경합**으로 DB 프로세스 자체가 응답을 못 하는 것이므로, 그 앞에 Proxy를 넣어도 Proxy → Reader 구간에서 동일하게 막힌다. 이 점을 이해하면 불필요한 인프라 변경을 피할 수 있다.

# 확인해야 할 CloudWatch 지표

---

이 유형의 장애가 의심될 때, 다음 CloudWatch 지표를 에러 발생 시점과 대조하면 원인을 확정할 수 있다.

| 지표 | 확인 내용 | 의미 |
|---|---|---|
| `AuroraReplicaLag` | 에러 시점에 lag 급증 여부 | Reader가 Writer를 따라잡지 못함 |
| `DatabaseConnections` (Reader) | 커넥션 수 급감 vs 유지 | 기존 커넥션도 끊김 vs 새 커넥션만 실패 |
| `EngineUptime` (Reader) | 값 리셋 여부 | Reader restart 발생 여부 (lag 과다 시 Aurora가 자동 재시작할 수 있음) |
| `BufferCacheHitRatio` (Reader) | 에러 시점 급락 여부 | invalidation으로 cache가 날아간 것 |
| `AuroraReplicaLagMaximum` | 최대 lag 크기 | redo 처리 지연 정도 |
| `DMLLatency` / `DMLThroughput` (Writer) | 에러 시점의 write 규모 | Writer burst 규모 확인 |

특히 `AuroraReplicaLag` spike와 애플리케이션 에러 발생 시점이 정확히 겹치는지가 핵심 판단 기준이다.

# 해결 방안

---

## A. Writer 쓰기 패턴 개선 (근본 원인)

목표는 Reader에 전달되는 redo record의 **순간 유량을 줄여서** Reader가 처리할 수 있는 속도로 분산하는 것이다.

Aurora에서 redo record는 COMMIT과 무관하게 **생성 즉시 Reader에 스트리밍**된다. 따라서 단순히 COMMIT을 나누는 것만으로는 부족할 수 있으며, **쓰기 속도 자체를 조절**하는 것이 핵심이다.

```
[AS-IS] 대량 INSERT를 빠르게 연속 실행
  INSERT 10만 건 (고속) → redo record가 Reader에 한꺼번에 몰림

[TO-BE] Chunk 분할 + 간격 두기
  INSERT 1만 건 → 100~500ms 대기 → INSERT 1만 건 → 대기 → ...
  = redo record 유량 분산 → Reader가 소화할 시간 확보
```

| 방법 | AS-IS | TO-BE |
|---|---|---|
| **Chunk 분할 + 대기** | 대량 INSERT 연속 실행 = redo 한꺼번에 몰림 | 소규모 chunk + 사이에 `100~500ms` sleep = redo 유량 분산 |
| **병렬 쓰기 제한** | 여러 파이프라인 동시 bulk insert | 동시 bulk insert 수 제한 또는 시간대를 분산 |

## B. Aurora 파라미터 그룹 설정

근본 원인 해소와 별개로, 장애 발생 시 **피해 범위를 제한**하기 위한 파라미터 설정이다.

**Reader 전용 파라미터** (DB Instance Parameter Group):

| 파라미터 | Aurora PG 기본값 | 권장값 | 효과 |
|---|---|---|---|
| `statement_timeout` | `0` (무제한) | `30000` (30s) | Reader 지연 시 쿼리가 무한 대기하지 않도록 강제 종료. 커넥션 반환 보장 |
| `tcp_keepalives_idle` | `300` (5분) | `60` (1분) | 유휴 커넥션의 TCP 생존 확인 시작 시간 단축. 죽은 커넥션 빠른 감지 |
| `tcp_keepalives_interval` | `30` (초) | `10` (초) | keepalive probe 재전송 간격 단축 |
| `tcp_keepalives_count` | `2` | `3` | 감지 시간: 60 + (10 x 3) = 90초 (기본: 300 + (30 x 2) = 360초) |
| `log_min_duration_statement` | `-1` (비활성) | `3000` (3s) | 3초 이상 걸린 쿼리 로깅. 장애 시점 분석용 |

**Writer + Reader 공통** (DB Cluster Parameter Group):

| 파라미터 | Aurora PG 기본값 | 권장값 | 효과 |
|---|---|---|---|
| `idle_in_transaction_session_timeout` | `86400000` (24시간) | `60000` (60s) | 트랜잭션 열어놓고 방치된 세션 종료. 기본값 24시간은 너무 김 |

**Writer 전용** (DB Instance Parameter Group):

| 파라미터 | Aurora PG 기본값 | 권장값 | 효과 |
|---|---|---|---|
| `log_min_duration_statement` | `-1` (비활성) | `5000` (5s) | Writer 쪽 느린 쿼리 추적. 장애 시점 어떤 쓰기가 실행 중이었는지 확인 |

> `statement_timeout`과 TCP keepalive 파라미터는 **동적 파라미터**로, 변경 시 인스턴스 재부팅이 필요하지 않다. 적용하면 기존 세션에는 영향 없이 새로운 세션부터 반영된다.

## C. R2DBC 커넥션 풀 설정 점검

애플리케이션 측에서도 장애 시 빠른 실패(fail-fast)와 복구를 위해 커넥션 풀 설정을 점검해야 한다.

| 설정 | r2dbc-pool 기본값 | 권장 검토 | 효과 |
|---|---|---|---|
| `maxAcquireTime` | no timeout (무제한) | 서비스 SLA에 맞게 설정 (예: 5~30s) | 커넥션 획득 대기 시간 제한. 무제한이면 Reader 응답 불가 시 전체 스레드가 무한 대기 |
| `maxCreateConnectionTime` | no timeout (무제한) | 서비스 SLA에 맞게 설정 (예: 5~10s) | 새 커넥션 생성 시간 제한 |
| `maxIdleTime` | 30분 | 환경에 맞게 조정 | 유휴 커넥션 정리 주기 |
| `initialSize` / `maxSize` | 10 / 10 | 부하에 맞게 조정 | 풀 크기. 너무 작으면 burst 트래픽 시 병목 |

특히 `maxAcquireTime`이 no timeout으로 되어 있으면, Reader 응답 불가 시 reactor 스레드가 전부 커넥션 대기로 묶이게 되므로 반드시 적절한 값을 설정해야 한다.

## D. 인스턴스 레벨 설정

| 항목 | 권장 | 이유 |
|---|---|---|
| **Reader 인스턴스 클래스** | buffer pool이 working set을 담을 수 있는 크기 | 메모리 클수록 invalidation 영향 감소 |
| **Reader 추가 (2대 이상)** | Reader endpoint에 2대 이상 | 모든 Reader가 동일한 invalidation을 받지만, **읽기 부하를 분산**하여 개별 Reader의 부담 감소 |
| **Enhanced Monitoring** | 1초 간격 활성화 | OS 레벨 CPU/메모리/I/O 상세 모니터링. Reader 부하 시점 정확히 포착 |

# 조치 우선순위

---

| 순위 | 조치 | 난이도 | 효과 |
|---|---|---|---|
| **1** | Reader 파라미터 그룹: `statement_timeout`, TCP keepalive | 즉시 가능 (재부팅 불필요) | Reader 지연 시 커넥션 무한 점유 방지 |
| **2** | R2DBC 풀: `maxAcquireTime` 설정 | 앱 설정 변경 + 배포 | 커넥션 획득 실패를 빠르게 감지하여 cascading failure 방지 |
| **3** | Writer 쓰기 속도 조절: chunk 분할 + 간격 | 파이프라인 수정 필요 | 근본 원인 해소 — redo 유량 분산 |
| **4** | CloudWatch 지표 확인: AuroraReplicaLag, BufferCacheHitRatio | 모니터링 설정 | 장애 원인 확정 + 재발 조기 감지 |
| **5** | Reader 인스턴스 추가 (읽기 부하 분산) | 비용 증가 | 개별 Reader 부담 감소 |
| **6** | Reader 스펙 업 | 비용 증가 | buffer pool 크기 증가 → invalidation 영향 감소 |

# 정리

---

이 장애의 본질은 **Aurora의 redo log 스트리밍이 테이블 단위가 아닌 buffer pool 전체에 영향을 준다**는 구조적 특성에 있다.

핵심 요점을 정리하면 다음과 같다.

- Aurora Reader는 WAL replay가 아닌 **redo log 기반 buffer cache invalidation**으로 동작한다.
- Redo log record는 **COMMIT과 무관하게 생성 즉시** Reader에 전송된다.
- Buffer pool은 **모든 테이블이 공유하는 단일 메모리 구조**이므로, 특정 테이블의 대량 쓰기가 관계없는 테이블의 읽기까지 영향을 준다.
- 이 유형의 장애는 **PI에서 느린 쿼리로 보이지 않으며**, `AuroraReplicaLag` spike와 I/O wait 패턴으로 진단해야 한다.
- RDS Proxy는 이 문제를 해결하지 못한다. Reader 내부의 리소스 경합이 근본 원인이기 때문이다.
- 근본 해결은 **Writer의 쓰기 속도를 조절**하는 것이고, 파라미터 그룹 설정과 R2DBC 풀 설정은 **피해 범위를 제한**하는 역할이다.

# Reference

---

- [Aurora PostgreSQL 공식 문서 — Replication](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html)
- [Amazon Aurora PostgreSQL — DB 파라미터 그룹](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Reference.ParameterGroups.html)
- [Aurora PostgreSQL — Dead Connection Handling](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Appendix.PostgreSQL.CommonDBATasks.DeadConnectionHandling.html)
- [Performance Insights for Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.html)
- [r2dbc-pool GitHub — ConnectionPoolConfiguration](https://github.com/r2dbc/r2dbc-pool)
- [Spring Boot R2DBC 설정 문서](https://docs.spring.io/spring-boot/reference/data/sql.html#data.sql.r2dbc)
