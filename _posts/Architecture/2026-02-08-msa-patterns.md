---
title: "[Architecture] MSA 핵심 패턴 - Circuit Breaker, Saga, Event Sourcing"
categories:
  - Architecture
tags:
  - [MSA, Microservices, CircuitBreaker, Saga, EventSourcing]
---

# Introduction

---

마이크로서비스 아키텍처(MSA)는 서비스를 작게 나눠 독립적으로 배포/확장할 수 있게 합니다. 하지만 분산 시스템의 복잡성도 함께 가져옵니다. **서비스 간 통신 장애**, **분산 트랜잭션**, **데이터 일관성** 같은 문제를 해결하기 위한 패턴이 필요합니다.

이 글은 MSA에서 자주 사용되는 핵심 패턴을 정리합니다.

# 1. MSA 개요

---

## 모놀리식 vs MSA

```text
모놀리식:
┌─────────────────────────────────────────┐
│            Single Application            │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│  │User │ │Order│ │Pay  │ │Ship │       │
│  └─────┘ └─────┘ └─────┘ └─────┘       │
│           Single Database                │
└─────────────────────────────────────────┘

마이크로서비스:
┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐
│ User │   │Order │   │ Pay  │   │ Ship │
│  DB  │   │  DB  │   │  DB  │   │  DB  │
└──────┘   └──────┘   └──────┘   └──────┘
    │          │          │          │
    └──────────┴──────────┴──────────┘
                Message Bus
```

## 장단점

```text
장점:
- 독립적 배포/확장
- 기술 스택 자유
- 장애 격리
- 팀 자율성

단점:
- 분산 시스템 복잡성
- 네트워크 지연/장애
- 분산 트랜잭션 어려움
- 운영 복잡도 증가
```

# 2. Circuit Breaker

---

## 문제

```text
서비스 A → 서비스 B 호출

서비스 B가 느려지거나 장애 발생 시:
- 서비스 A도 대기 → 스레드 고갈
- 연쇄 장애 (Cascading Failure)
- 전체 시스템 다운
```

## 해결: Circuit Breaker

전기 회로의 차단기처럼, 장애가 감지되면 호출을 차단합니다.

```text
상태 전이:

     성공           실패 임계치 도달
CLOSED ────────────────▶ OPEN
  ▲                        │
  │                        │ 대기 시간 후
  │   성공                  ▼
  └─────────────────── HALF_OPEN
         실패 시 다시 OPEN

CLOSED: 정상 상태, 모든 요청 통과
OPEN: 장애 상태, 요청 즉시 실패 (Fallback)
HALF_OPEN: 테스트 상태, 일부 요청만 통과
```

## Resilience4j 구현

```java
// 의존성
// implementation 'io.github.resilience4j:resilience4j-spring-boot3'

@Service
public class PaymentService {

    private final PaymentClient paymentClient;

    @CircuitBreaker(name = "payment", fallbackMethod = "paymentFallback")
    public PaymentResult processPayment(PaymentRequest request) {
        return paymentClient.pay(request);
    }

    // Fallback 메서드
    public PaymentResult paymentFallback(PaymentRequest request, Exception e) {
        log.warn("Payment service unavailable, using fallback: {}", e.getMessage());
        return PaymentResult.pending(request.getOrderId(), "결제 서비스 일시 장애");
    }
}
```

## 설정

```yaml
resilience4j:
  circuitbreaker:
    instances:
      payment:
        sliding-window-size: 10              # 최근 10개 요청 기준
        failure-rate-threshold: 50           # 50% 실패 시 OPEN
        wait-duration-in-open-state: 10000   # 10초 후 HALF_OPEN
        permitted-number-of-calls-in-half-open-state: 3  # 테스트 요청 3개
        slow-call-rate-threshold: 80         # 80% 느린 호출 시 OPEN
        slow-call-duration-threshold: 2000   # 2초 이상이면 느린 호출
```

## 함께 사용하는 패턴

```java
@Service
public class OrderService {

    @CircuitBreaker(name = "inventory", fallbackMethod = "fallback")
    @Retry(name = "inventory")           // 재시도
    @Bulkhead(name = "inventory")        // 동시 요청 제한
    @TimeLimiter(name = "inventory")     // 타임아웃
    public Mono<InventoryResponse> checkInventory(Long productId) {
        return inventoryClient.check(productId);
    }
}
```

# 3. Saga Pattern

---

## 문제

```text
모놀리식에서는:
@Transactional
public void order() {
    orderRepository.save(order);
    paymentService.pay(order);
    inventoryService.reserve(order);
    shippingService.create(order);
    // 하나라도 실패하면 전체 롤백
}

MSA에서는:
- 각 서비스가 별도 DB
- 분산 트랜잭션 (2PC) 비용 높음
- 서비스 간 강결합
```

## 해결: Saga

긴 트랜잭션을 로컬 트랜잭션의 연속으로 나누고, 실패 시 **보상 트랜잭션(Compensating Transaction)**을 실행합니다.

```text
주문 생성 Saga:

정상 흐름:
Order Service → Payment Service → Inventory Service → Shipping Service
  주문 생성        결제 처리         재고 차감           배송 생성

실패 시 보상:
Order Service ← Payment Service ← Inventory Service
  주문 취소        결제 취소         재고 복원
```

## Choreography (이벤트 기반)

각 서비스가 이벤트를 발행하고, 다음 서비스가 구독합니다.

```text
┌─────────┐    OrderCreated    ┌─────────┐
│  Order  │ ─────────────────▶ │ Payment │
└─────────┘                    └─────────┘
                                    │
     PaymentCompleted               │
     ◀──────────────────────────────┘
     │
     ▼
┌───────────┐  InventoryReserved  ┌──────────┐
│ Inventory │ ──────────────────▶ │ Shipping │
└───────────┘                     └──────────┘
```

```java
// Order Service
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderRepository orderRepository;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    @Transactional
    public Order createOrder(CreateOrderRequest request) {
        Order order = orderRepository.save(new Order(request));
        kafkaTemplate.send("order-events", new OrderCreatedEvent(order));
        return order;
    }

    @KafkaListener(topics = "payment-events")
    public void handlePaymentEvent(PaymentEvent event) {
        if (event instanceof PaymentFailedEvent) {
            // 보상: 주문 취소
            orderRepository.cancel(event.getOrderId());
        }
    }
}

// Payment Service
@Service
public class PaymentService {

    @KafkaListener(topics = "order-events")
    public void handleOrderCreated(OrderCreatedEvent event) {
        try {
            paymentRepository.save(new Payment(event.getOrderId()));
            kafkaTemplate.send("payment-events", new PaymentCompletedEvent(...));
        } catch (Exception e) {
            kafkaTemplate.send("payment-events", new PaymentFailedEvent(...));
        }
    }
}
```

## Orchestration (중앙 조정자)

Saga Orchestrator가 전체 흐름을 관리합니다.

```text
                    ┌─────────────────┐
                    │ Saga Orchestrator│
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐        ┌─────────┐        ┌─────────┐
    │ Payment │        │Inventory│        │Shipping │
    └─────────┘        └─────────┘        └─────────┘
```

```java
@Service
@RequiredArgsConstructor
public class OrderSagaOrchestrator {

    private final PaymentClient paymentClient;
    private final InventoryClient inventoryClient;
    private final ShippingClient shippingClient;
    private final OrderRepository orderRepository;

    public void executeSaga(Order order) {
        try {
            // Step 1: 결제
            PaymentResult payment = paymentClient.pay(order);
            if (!payment.isSuccess()) {
                throw new PaymentException();
            }

            // Step 2: 재고 차감
            InventoryResult inventory = inventoryClient.reserve(order);
            if (!inventory.isSuccess()) {
                // 보상: 결제 취소
                paymentClient.cancel(payment.getPaymentId());
                throw new InventoryException();
            }

            // Step 3: 배송 생성
            ShippingResult shipping = shippingClient.create(order);
            if (!shipping.isSuccess()) {
                // 보상: 재고 복원, 결제 취소
                inventoryClient.release(inventory.getReservationId());
                paymentClient.cancel(payment.getPaymentId());
                throw new ShippingException();
            }

            // 성공
            orderRepository.complete(order.getId());

        } catch (Exception e) {
            orderRepository.fail(order.getId(), e.getMessage());
        }
    }
}
```

## Choreography vs Orchestration

| 항목 | Choreography | Orchestration |
|------|--------------|---------------|
| **결합도** | 낮음 | 중간 (Orchestrator) |
| **가시성** | 흐름 파악 어려움 | 명확 |
| **복잡도** | 단순한 Saga | 복잡한 Saga |
| **단일 장애점** | 없음 | Orchestrator |

# 4. Event Sourcing

---

## 문제

```text
일반적인 CRUD:
- 현재 상태만 저장
- 어떻게 이 상태가 되었는지 모름
- 과거 상태 복원 불가

예: 잔액 10000원
  - 입금 50000원 → 출금 40000원? 입금 20000원 → 출금 10000원?
```

## 해결: Event Sourcing

상태 변경을 **이벤트**로 저장하고, 이벤트를 재생하여 현재 상태를 계산합니다.

```text
Event Store:
───────────────────────────────────────────────────────────────
│ AccountCreated(id=1, balance=0)                              │
│ MoneyDeposited(id=1, amount=50000)     → 잔액: 50000         │
│ MoneyWithdrawn(id=1, amount=20000)     → 잔액: 30000         │
│ MoneyDeposited(id=1, amount=10000)     → 잔액: 40000         │
───────────────────────────────────────────────────────────────

현재 상태 = 이벤트 재생 결과
```

## 구조

```text
Write Side (Command):
  Command → Aggregate → Event → Event Store
                 ↓
             Validation

Read Side (Query):
  Event Store → Projection → Read DB → Query
```

## 구현 예시

```java
// 이벤트 정의
public sealed interface AccountEvent {
    record AccountCreated(String accountId, BigDecimal initialBalance) implements AccountEvent {}
    record MoneyDeposited(String accountId, BigDecimal amount) implements AccountEvent {}
    record MoneyWithdrawn(String accountId, BigDecimal amount) implements AccountEvent {}
}

// Aggregate (도메인 모델)
public class Account {
    private String id;
    private BigDecimal balance;
    private List<AccountEvent> uncommittedEvents = new ArrayList<>();

    // 이벤트로부터 상태 재구성
    public static Account reconstitute(List<AccountEvent> events) {
        Account account = new Account();
        events.forEach(account::apply);
        return account;
    }

    // 커맨드 처리
    public void deposit(BigDecimal amount) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new IllegalArgumentException("Amount must be positive");
        }
        apply(new MoneyDeposited(id, amount));
        uncommittedEvents.add(new MoneyDeposited(id, amount));
    }

    public void withdraw(BigDecimal amount) {
        if (balance.compareTo(amount) < 0) {
            throw new InsufficientBalanceException();
        }
        apply(new MoneyWithdrawn(id, amount));
        uncommittedEvents.add(new MoneyWithdrawn(id, amount));
    }

    // 이벤트 적용
    private void apply(AccountEvent event) {
        switch (event) {
            case AccountCreated e -> {
                this.id = e.accountId();
                this.balance = e.initialBalance();
            }
            case MoneyDeposited e -> this.balance = balance.add(e.amount());
            case MoneyWithdrawn e -> this.balance = balance.subtract(e.amount());
        }
    }
}

// Event Store
@Repository
public class AccountEventStore {

    private final JdbcTemplate jdbc;

    public void save(String accountId, List<AccountEvent> events) {
        for (AccountEvent event : events) {
            jdbc.update(
                "INSERT INTO account_events (account_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?)",
                accountId,
                event.getClass().getSimpleName(),
                objectMapper.writeValueAsString(event),
                Instant.now()
            );
        }
    }

    public List<AccountEvent> load(String accountId) {
        return jdbc.query(
            "SELECT * FROM account_events WHERE account_id = ? ORDER BY created_at",
            (rs, rowNum) -> deserialize(rs.getString("event_type"), rs.getString("event_data")),
            accountId
        );
    }
}

// Application Service
@Service
@RequiredArgsConstructor
public class AccountService {

    private final AccountEventStore eventStore;

    @Transactional
    public void deposit(String accountId, BigDecimal amount) {
        List<AccountEvent> events = eventStore.load(accountId);
        Account account = Account.reconstitute(events);

        account.deposit(amount);

        eventStore.save(accountId, account.getUncommittedEvents());
    }
}
```

## CQRS (Command Query Responsibility Segregation)

Event Sourcing과 함께 자주 사용됩니다.

```text
Command Side (쓰기):
  Event Store에 이벤트 저장

Query Side (읽기):
  이벤트를 구독하여 읽기 전용 DB에 Projection

┌─────────┐        ┌─────────────┐        ┌──────────┐
│ Command │ ─────▶ │ Event Store │ ─────▶ │Projection│
└─────────┘        └─────────────┘        └──────────┘
                                                │
                         Query                  ▼
                   ◀──────────────────── ┌──────────┐
                                         │ Read DB  │
                                         └──────────┘
```

## 장단점

```text
장점:
- 완전한 감사 로그
- 과거 어떤 시점으로든 복원 가능
- 이벤트 기반 통합 용이
- 버그 재현 쉬움

단점:
- 복잡도 증가
- 이벤트 스키마 변경 어려움
- 최종 일관성 (Eventual Consistency)
- 학습 곡선
```

# 5. 기타 패턴

---

## API Gateway

```text
┌─────────┐
│ Client  │
└────┬────┘
     │
     ▼
┌─────────────┐
│ API Gateway │  - 인증/인가
└─────┬───────┘  - Rate Limiting
      │          - 로깅
      ├──────────▶ User Service
      ├──────────▶ Order Service
      └──────────▶ Product Service
```

## Service Discovery

```text
서비스 인스턴스가 동적으로 변할 때:

┌─────────────────┐
│ Service Registry│  (Eureka, Consul)
│   user: [A, B]  │
│  order: [C, D, E]
└────────┬────────┘
         │
    등록/조회
         │
         ▼
┌─────────┐     ┌─────────┐
│ User A  │     │ User B  │
└─────────┘     └─────────┘
```

## Sidecar / Service Mesh

```text
┌─────────────────────────┐
│         Pod             │
│  ┌─────────┐ ┌───────┐ │
│  │  App    │ │Sidecar│ │  (Envoy, Istio)
│  └─────────┘ └───────┘ │
└─────────────────────────┘

Sidecar가 담당:
- 서비스 간 통신
- mTLS (보안)
- 트래픽 관리
- 관측성
```

# 6. 정리

---

| 패턴 | 해결하는 문제 |
|------|--------------|
| **Circuit Breaker** | 연쇄 장애 방지 |
| **Saga** | 분산 트랜잭션 |
| **Event Sourcing** | 상태 변경 이력, 감사 |
| **CQRS** | 읽기/쓰기 분리, 성능 |
| **API Gateway** | 진입점 통합, 횡단 관심사 |
| **Service Discovery** | 동적 서비스 위치 |

```text
핵심:
  MSA = 독립적 배포/확장, 분산 시스템 복잡성.
  Circuit Breaker = 장애 전파 차단.
  Saga = 보상 트랜잭션으로 일관성 유지.
  Event Sourcing = 상태가 아닌 이벤트 저장.
  패턴은 트레이드오프 - 필요한 곳에만 적용.
```

# Reference

---

- [Microservices Patterns (Chris Richardson)](https://microservices.io/patterns/)
- [Resilience4j Documentation](https://resilience4j.readme.io/)
- [Martin Fowler - Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [Microsoft - Cloud Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/patterns/)
