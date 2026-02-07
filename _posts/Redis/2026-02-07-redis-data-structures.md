---
title: "[Redis] 자료구조와 사용 패턴 - String, Hash, List, Set, Sorted Set"
categories:
  - Redis
tags:
  - [Redis, DataStructure, String, Hash, List, Set, SortedSet]
---

# Introduction

---

Redis는 단순한 Key-Value 저장소가 아니라 **다양한 자료구조를 지원하는 인메모리 데이터베이스**입니다. String, Hash, List, Set, Sorted Set 등 각 자료구조는 특정 사용 사례에 최적화되어 있습니다. 자료구조를 잘 선택하면 복잡한 로직을 단순한 Redis 명령어로 처리할 수 있습니다.

이 글은 Redis의 핵심 자료구조와 실무에서 자주 쓰이는 패턴을 정리합니다.

# 1. Redis 개요

---

## 특징

```text
- 인메모리: 모든 데이터를 메모리에 저장 → 초고속 (평균 1ms 미만)
- 자료구조: 단순 Key-Value가 아닌 다양한 데이터 타입 지원
- 단일 스레드: 명령어가 순차 처리됨 → 원자성 보장
- 영속성: RDB(스냅샷), AOF(로그) 방식으로 디스크 저장 가능
- 복제/클러스터: 고가용성과 수평 확장 지원
```

## 주요 사용 사례

| 사용 사례 | 설명 |
|----------|------|
| **캐시** | DB 조회 결과 캐싱 (가장 흔함) |
| **세션 저장소** | 사용자 세션 데이터 |
| **Rate Limiting** | API 호출 횟수 제한 |
| **리더보드** | 점수 기반 순위 |
| **큐** | 작업 큐, 메시지 브로커 |
| **실시간 분석** | 카운터, 통계 |

# 2. String - 기본 타입

---

가장 단순한 Key-Value 구조입니다. 값은 문자열, 숫자, 직렬화된 객체 등 무엇이든 될 수 있습니다.

## 기본 명령어

```bash
# 저장
SET user:1:name "홍길동"

# 조회
GET user:1:name
# "홍길동"

# 만료 시간과 함께 저장 (10초 후 삭제)
SET session:abc123 "user_data" EX 10

# 존재하지 않을 때만 저장 (분산 락)
SET lock:resource "owner123" NX EX 30

# 삭제
DEL user:1:name
```

## 숫자 연산

```bash
SET counter 0

# 증가
INCR counter        # 1
INCRBY counter 5    # 6

# 감소
DECR counter        # 5
DECRBY counter 3    # 2
```

## 사용 패턴

### 캐싱

```bash
# 조회 결과 캐싱 (JSON 직렬화)
SET cache:user:1 '{"id":1,"name":"홍길동"}' EX 300
```

### Rate Limiting

```python
# Python 예시
def check_rate_limit(user_id, limit=100, window=60):
    key = f"rate:{user_id}"
    current = redis.incr(key)
    if current == 1:
        redis.expire(key, window)  # 첫 요청 시 만료 설정
    return current <= limit
```

### 분산 락

```python
# 간단한 분산 락
def acquire_lock(resource, owner, timeout=30):
    key = f"lock:{resource}"
    return redis.set(key, owner, nx=True, ex=timeout)

def release_lock(resource, owner):
    key = f"lock:{resource}"
    if redis.get(key) == owner:
        redis.delete(key)
```

# 3. Hash - 객체 저장

---

필드-값 쌍의 집합으로, **객체를 저장**하기에 적합합니다. 개별 필드만 조회/수정할 수 있어 메모리 효율적입니다.

## 기본 명령어

```bash
# 필드 저장
HSET user:1 name "홍길동" age 30 email "hong@example.com"

# 필드 조회
HGET user:1 name
# "홍길동"

# 여러 필드 조회
HMGET user:1 name email
# 1) "홍길동"
# 2) "hong@example.com"

# 전체 조회
HGETALL user:1
# 1) "name"
# 2) "홍길동"
# 3) "age"
# 4) "30"
# 5) "email"
# 6) "hong@example.com"

# 필드 존재 확인
HEXISTS user:1 name
# 1

# 필드 삭제
HDEL user:1 email

# 숫자 필드 증가
HINCRBY user:1 age 1
# 31
```

## 사용 패턴

### 사용자 프로필

```bash
HSET user:1 name "홍길동" email "hong@example.com" login_count 0

# 로그인 시 카운트 증가
HINCRBY user:1 login_count 1
```

### 세션 저장

```bash
HSET session:abc123 user_id 1 created_at "2024-01-15T10:00:00" ip "1.2.3.4"
EXPIRE session:abc123 3600  # 1시간 후 만료
```

### 장바구니

```bash
# 상품 추가
HSET cart:user:1 product:100 2  # 상품 100번 2개
HSET cart:user:1 product:200 1  # 상품 200번 1개

# 수량 변경
HINCRBY cart:user:1 product:100 1  # 3개로 증가

# 전체 조회
HGETALL cart:user:1
```

## String vs Hash

```text
String (JSON 직렬화):
  SET user:1 '{"name":"홍길동","age":30}'
  - 전체를 읽고 써야 함
  - 단순 조회용에 적합

Hash:
  HSET user:1 name "홍길동" age 30
  - 개별 필드 읽기/쓰기 가능
  - 객체 속성을 자주 수정할 때 적합
  - 메모리 효율적 (작은 해시는 ziplist로 저장)
```

# 4. List - 순서 있는 컬렉션

---

**양방향 연결 리스트**로 구현되어 있어 양쪽 끝에서의 삽입/삭제가 O(1)입니다. 스택, 큐로 활용할 수 있습니다.

## 기본 명령어

```bash
# 왼쪽에 삽입 (스택처럼)
LPUSH tasks "task1" "task2" "task3"
# [task3, task2, task1]

# 오른쪽에 삽입 (큐처럼)
RPUSH tasks "task4"
# [task3, task2, task1, task4]

# 왼쪽에서 꺼내기
LPOP tasks
# "task3"

# 오른쪽에서 꺼내기
RPOP tasks
# "task4"

# 범위 조회 (0부터 시작, -1은 마지막)
LRANGE tasks 0 -1
# 1) "task2"
# 2) "task1"

# 길이
LLEN tasks
# 2

# 블로킹 팝 (큐 대기)
BLPOP tasks 30  # 최대 30초 대기
```

## 사용 패턴

### 작업 큐

```bash
# 생산자: 오른쪽에 추가
RPUSH work_queue '{"job":"send_email","to":"user@example.com"}'

# 소비자: 왼쪽에서 꺼냄 (블로킹)
BLPOP work_queue 0  # 무한 대기
```

### 최근 활동 로그

```bash
# 새 활동 추가
LPUSH user:1:activity "login:2024-01-15T10:00:00"
LPUSH user:1:activity "view_product:2024-01-15T10:05:00"

# 최근 10개만 유지
LTRIM user:1:activity 0 9

# 최근 활동 조회
LRANGE user:1:activity 0 9
```

### 스택 (LIFO)

```bash
# 푸시
LPUSH stack "item1"
LPUSH stack "item2"

# 팝 (마지막에 넣은 것 먼저)
LPOP stack  # "item2"
```

# 5. Set - 중복 없는 집합

---

**순서 없는 고유한 문자열 집합**입니다. 멤버 존재 확인이 O(1)이고, 집합 연산(교집합, 합집합, 차집합)을 지원합니다.

## 기본 명령어

```bash
# 멤버 추가
SADD tags:post:1 "redis" "database" "nosql"

# 멤버 확인
SISMEMBER tags:post:1 "redis"
# 1

# 전체 조회
SMEMBERS tags:post:1
# 1) "redis"
# 2) "database"
# 3) "nosql"

# 멤버 수
SCARD tags:post:1
# 3

# 멤버 삭제
SREM tags:post:1 "nosql"

# 랜덤 멤버
SRANDMEMBER tags:post:1 2  # 2개 랜덤 조회
SPOP tags:post:1           # 1개 랜덤 꺼내기
```

## 집합 연산

```bash
SADD set1 "a" "b" "c"
SADD set2 "b" "c" "d"

# 교집합
SINTER set1 set2
# 1) "b"
# 2) "c"

# 합집합
SUNION set1 set2
# 1) "a"
# 2) "b"
# 3) "c"
# 4) "d"

# 차집합
SDIFF set1 set2  # set1에만 있는 것
# 1) "a"
```

## 사용 패턴

### 태그/카테고리

```bash
# 게시물에 태그 추가
SADD post:1:tags "redis" "database"
SADD post:2:tags "redis" "java"

# "redis" 태그가 있는 게시물
SADD tag:redis:posts 1 2

# 공통 태그를 가진 게시물 찾기
SINTER post:1:tags post:2:tags
# "redis"
```

### 온라인 사용자

```bash
# 로그인
SADD online_users "user1"

# 로그아웃
SREM online_users "user1"

# 온라인 확인
SISMEMBER online_users "user1"

# 온라인 사용자 수
SCARD online_users
```

### 좋아요 (중복 방지)

```bash
# 좋아요 추가 (중복 무시)
SADD post:1:likes "user1"
SADD post:1:likes "user1"  # 무시됨

# 좋아요 수
SCARD post:1:likes
```

# 6. Sorted Set - 점수 기반 정렬

---

Set과 유사하지만 각 멤버에 **점수(score)**가 있어 자동 정렬됩니다. **리더보드, 랭킹**에 최적입니다.

## 기본 명령어

```bash
# 멤버와 점수 추가
ZADD leaderboard 100 "user1" 200 "user2" 150 "user3"

# 점수 조회
ZSCORE leaderboard "user1"
# 100

# 점수 증가
ZINCRBY leaderboard 50 "user1"
# 150

# 순위 조회 (0부터 시작)
ZRANK leaderboard "user1"     # 낮은 점수 기준: 0
ZREVRANK leaderboard "user2"  # 높은 점수 기준: 0

# 범위 조회 (높은 점수순)
ZREVRANGE leaderboard 0 2 WITHSCORES
# 1) "user2"
# 2) "200"
# 3) "user1"
# 4) "150"
# 5) "user3"
# 6) "150"

# 점수 범위로 조회
ZRANGEBYSCORE leaderboard 100 200 WITHSCORES

# 멤버 수
ZCARD leaderboard
```

## 사용 패턴

### 리더보드

```bash
# 점수 갱신
ZADD game:leaderboard 1500 "player1"
ZINCRBY game:leaderboard 100 "player1"  # 승리 시 점수 추가

# 상위 10명
ZREVRANGE game:leaderboard 0 9 WITHSCORES

# 내 순위
ZREVRANK game:leaderboard "player1"
```

### 실시간 인기 검색어

```bash
# 검색 시 점수 증가
ZINCRBY search:trending 1 "redis"
ZINCRBY search:trending 1 "java"
ZINCRBY search:trending 1 "redis"

# 인기 검색어 10개
ZREVRANGE search:trending 0 9 WITHSCORES

# 일정 시간 후 점수 감소 (별도 배치)
# 또는 시간 기반 키 (search:trending:2024-01-15)
```

### 지연 작업 (Delayed Queue)

```bash
# 실행 시각을 점수로 저장 (Unix timestamp)
ZADD delayed_jobs 1705302000 '{"job":"send_reminder","user":1}'

# 현재 시각보다 작은 점수의 작업 조회
ZRANGEBYSCORE delayed_jobs 0 1705302000
```

# 7. 자료구조 선택 가이드

---

| 요구사항 | 자료구조 | 예시 |
|----------|----------|------|
| 단순 Key-Value | String | 캐시, 세션 |
| 객체 저장 (필드 수정) | Hash | 사용자 프로필, 장바구니 |
| 순서 있는 목록 | List | 작업 큐, 최근 활동 |
| 고유 멤버 집합 | Set | 태그, 좋아요, 온라인 사용자 |
| 점수 기반 정렬 | Sorted Set | 리더보드, 인기 검색어 |

# 8. 정리

---

| 자료구조 | 특징 | 주요 명령어 |
|----------|------|------------|
| **String** | 단순 Key-Value | GET, SET, INCR |
| **Hash** | 필드-값 쌍 (객체) | HGET, HSET, HINCRBY |
| **List** | 순서 있는 목록 | LPUSH, RPUSH, LPOP, LRANGE |
| **Set** | 고유 멤버 집합 | SADD, SISMEMBER, SINTER |
| **Sorted Set** | 점수 정렬 집합 | ZADD, ZRANK, ZRANGE |

```text
핵심:
  Redis = 인메모리 자료구조 서버.
  각 자료구조가 특정 패턴에 최적화됨.
  올바른 자료구조 선택이 성능과 코드 단순화의 핵심.
```

# Reference

---

- [Redis Data Types](https://redis.io/docs/data-types/)
- [Redis Commands](https://redis.io/commands/)
- [Redis Best Practices](https://redis.io/docs/management/optimization/)
