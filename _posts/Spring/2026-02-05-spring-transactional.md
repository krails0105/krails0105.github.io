---
title: "[Spring] @Transactional 완전 정복 - 전파(Propagation), 격리(Isolation), 프록시 함정"
categories:
  - Spring
tags:
  - [Java, Spring, Transaction, Transactional, JPA, Database]
---

# Introduction

---

`@Transactional`은 Spring에서 가장 많이 사용하는 어노테이션 중 하나입니다. 메서드에 붙이면 자동으로 트랜잭션을 시작하고, 성공 시 커밋, 예외 시 롤백합니다. 하지만 전파(Propagation) 설정, 격리 수준, 프록시 동작 원리를 모르면 **"어노테이션을 붙였는데 롤백이 안 된다"**는 문제를 만나게 됩니다.

# 1. @Transactional 기본 동작

---

```java
@Service
public class OrderService {

    @Transactional
    public void createOrder(OrderRequest request) {
        orderRepository.save(new Order(request));  // INSERT
        paymentService.processPayment(request);    // 외부 호출
        // 예외 발생 시 → 위의 INSERT도 롤백됨
    }
}
```

```text
동작 흐름:
  1. 프록시가 메서드 호출을 가로챔
  2. TransactionManager가 트랜잭션 시작 (BEGIN)
  3. Target 메서드 실행
  4. 정상 완료 → COMMIT
  5. RuntimeException 발생 → ROLLBACK
```

# 2. 롤백 규칙

---

```text
기본 규칙:
  ✅ RuntimeException (언체크 예외) → 롤백
  ✅ Error → 롤백
  ❌ Checked Exception (IOException 등) → 롤백하지 않음 (커밋!)
```

```java
// Checked Exception도 롤백하려면:
@Transactional(rollbackFor = Exception.class)
public void createOrder() throws IOException {
    // IOException 발생해도 롤백됨
}

// 특정 예외만 롤백 제외:
@Transactional(noRollbackFor = CustomException.class)
public void createOrder() {
    // CustomException 발생해도 커밋됨
}
```

```text
실무 권장:
  비즈니스 예외도 롤백이 필요한 경우가 대부분
  → @Transactional(rollbackFor = Exception.class)를 기본으로 사용
```

# 3. 전파(Propagation) - 트랜잭션 간 관계

---

이미 트랜잭션이 진행 중일 때, 새로운 `@Transactional` 메서드가 호출되면 어떻게 할지를 결정합니다.

| Propagation | 기존 트랜잭션 있을 때 | 없을 때 | 용도 |
|------------|-------------------|--------|------|
| **REQUIRED** (기본) | 기존에 참여 | 새로 생성 | 일반적인 경우 |
| **REQUIRES_NEW** | 기존 중단, 새로 생성 | 새로 생성 | 독립적 트랜잭션 필요 |
| **NESTED** | 세이브포인트 생성 | 새로 생성 | 부분 롤백 |
| **SUPPORTS** | 기존에 참여 | 트랜잭션 없이 실행 | 읽기 전용 |
| **NOT_SUPPORTED** | 기존 중단, 비트랜잭션 | 트랜잭션 없이 실행 | 트랜잭션 불필요한 작업 |
| **MANDATORY** | 기존에 참여 | 예외 발생 | 반드시 트랜잭션 내에서 |
| **NEVER** | 예외 발생 | 트랜잭션 없이 실행 | 트랜잭션 금지 |

## REQUIRED vs REQUIRES_NEW

```java
@Service
public class OrderService {
    @Transactional // REQUIRED (기본)
    public void createOrder() {
        orderRepository.save(order);
        logService.saveLog("주문 생성"); // 같은 트랜잭션에 참여
        // 여기서 예외 → order, log 모두 롤백
    }
}

@Service
public class LogService {
    @Transactional(propagation = Propagation.REQUIRES_NEW) // 별도 트랜잭션
    public void saveLog(String message) {
        logRepository.save(new Log(message));
        // 이 트랜잭션은 독립적 → order 롤백과 무관하게 커밋 가능
    }
}
```

```text
REQUIRES_NEW 사용 시나리오:
  - 로그/감사 기록: 비즈니스 실패와 무관하게 반드시 저장
  - 알림 발송 이력: 메인 트랜잭션과 독립적으로 관리
  비유: 메인 작업이 실패해도 CCTV 녹화(로그)는 독립적으로 계속 저장되는 것과 같습니다.
```

# 4. 격리 수준(Isolation Level)

---

동시에 실행되는 트랜잭션 간 데이터 가시성을 결정합니다.

| Isolation | Dirty Read | Non-Repeatable Read | Phantom Read | 설명 |
|-----------|-----------|-------------------|-------------|------|
| READ_UNCOMMITTED | O | O | O | 커밋 안 된 데이터도 읽음 |
| READ_COMMITTED | X | O | O | 커밋된 데이터만 읽음 |
| REPEATABLE_READ | X | X | O | 같은 행을 다시 읽어도 같은 값 |
| SERIALIZABLE | X | X | X | 완전 직렬화 (성능 최저) |

```text
용어:
  Dirty Read: 다른 트랜잭션이 커밋하지 않은 변경을 읽음
  Non-Repeatable Read: 같은 행을 다시 읽었는데 값이 바뀜
  Phantom Read: 같은 조건으로 조회했는데 행이 추가/삭제됨

실무 기본:
  DB별 기본값이 다름 (MySQL InnoDB = REPEATABLE_READ, PostgreSQL = READ_COMMITTED)
  보통 DB 기본값을 따르고, 특수한 경우에만 변경
```

```java
@Transactional(isolation = Isolation.READ_COMMITTED)
public void readData() {
    // READ_COMMITTED 격리 수준으로 실행
}
```

# 5. 읽기 전용 트랜잭션

---

```java
@Transactional(readOnly = true)
public List<Order> getOrders() {
    return orderRepository.findAll();
}
```

```text
readOnly = true의 효과:
  1. JPA: 영속성 컨텍스트의 변경 감지(dirty checking) 비활성화 → 성능 향상
  2. DB: 일부 DB는 읽기 전용 힌트로 최적화
  3. 의도 명시: 이 메서드는 데이터를 변경하지 않음을 선언
```

# 6. @Transactional이 동작하지 않는 경우 (함정)

---

## 함정 1: 같은 클래스 내부 호출

```java
@Service
public class OrderService {

    public void process() {
        createOrder(); // 내부 호출 → @Transactional 무시!
    }

    @Transactional
    public void createOrder() {
        // 이 메서드는 프록시를 거치지 않으므로 트랜잭션이 적용되지 않음
    }
}
```

```text
원인: Spring AOP는 프록시 기반이므로, this로 호출하면 프록시를 거치지 않음
해결: 별도 빈으로 분리하여 주입받아 호출
```

## 함정 2: private 메서드

```java
@Transactional
private void createOrder() { // 동작하지 않음!
    // CGLIB 프록시는 메서드를 오버라이드해야 하므로 private은 불가
}
```

## 함정 3: Checked Exception

```java
@Transactional
public void createOrder() throws IOException {
    orderRepository.save(order);
    throw new IOException("파일 에러");
    // IOException은 Checked → 기본적으로 롤백되지 않음!
}
```

## 함정 4: try-catch로 예외 삼키기

```java
@Transactional
public void createOrder() {
    try {
        orderRepository.save(order);
        externalService.call(); // RuntimeException 발생
    } catch (Exception e) {
        log.error("에러", e); // 예외를 잡아버림 → 롤백되지 않음
    }
}
```

```text
정리: @Transactional이 롤백하려면 예외가 프록시까지 전파되어야 함
catch에서 잡으면 프록시 입장에서는 정상 완료 → 커밋
```

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **기본 동작** | RuntimeException → 롤백, Checked → 커밋 |
| **rollbackFor** | Checked Exception도 롤백 대상에 포함 |
| **REQUIRED** | 기존 트랜잭션 참여 (기본값) |
| **REQUIRES_NEW** | 항상 새 트랜잭션 (독립적 커밋/롤백) |
| **readOnly** | 변경 감지 비활성화, 읽기 최적화 |
| **내부 호출 함정** | this.method()는 프록시를 거치지 않음 → 빈 분리로 해결 |
| **private 함정** | private 메서드에는 @Transactional 적용 불가 |

```text
핵심:
  @Transactional = AOP 프록시 기반
  → 프록시를 거쳐야 동작함 (내부 호출 X, private X)
  → 예외가 프록시까지 전파되어야 롤백됨 (catch로 삼키면 X)
  → 실무에서는 rollbackFor = Exception.class를 기본으로 사용
```

# Reference

---

- [Spring Framework - Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)
- [Spring Framework - @Transactional](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html)
- [Baeldung - @Transactional](https://www.baeldung.com/transaction-configuration-with-jpa-and-spring)
