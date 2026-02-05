---
title: "[Spring] AOP(관점 지향 프로그래밍) - @Aspect, Proxy, 횡단 관심사 분리"
categories:
  - Spring
tags:
  - [Java, Spring, AOP, Aspect, Proxy, CrossCuttingConcern]
---

# Introduction

---

서비스 로직마다 로깅, 트랜잭션, 인증 체크, 성능 측정 같은 **공통 관심사(Cross-Cutting Concern)**를 매번 작성하면 코드가 중복됩니다. AOP(Aspect-Oriented Programming)는 이런 **횡단 관심사를 핵심 로직에서 분리**하여 모듈화하는 프로그래밍 패러다임입니다.

# 1. AOP 핵심 용어

---

| 용어 | 설명 | 예시 |
|------|------|------|
| **Aspect** | 횡단 관심사를 모듈화한 클래스 | 로깅 Aspect, 트랜잭션 Aspect |
| **Join Point** | Advice가 적용될 수 있는 지점 | 메서드 실행, 예외 발생 |
| **Advice** | Join Point에서 실행되는 코드 | @Before, @After, @Around |
| **Pointcut** | Advice가 적용될 Join Point를 선정하는 표현식 | `execution(* com.example.service.*.*(..))` |
| **Target** | Advice가 적용되는 실제 객체 | OrderService |
| **Proxy** | Target을 감싸는 대리 객체 | Spring이 자동 생성 |

```text
흐름:
  클라이언트 → Proxy → Advice 실행 → Target 메서드 실행 → Advice 후처리 → 반환
```

# 2. Advice 종류

---

```java
import org.aspectj.lang.annotation.*;
import org.aspectj.lang.ProceedingJoinPoint;

@Aspect
@Component
public class LoggingAspect {

    // 메서드 실행 전
    @Before("execution(* com.example.service.*.*(..))")
    public void beforeLog(JoinPoint joinPoint) {
        log.info("호출: {}", joinPoint.getSignature().getName());
    }

    // 메서드 정상 반환 후
    @AfterReturning(pointcut = "execution(* com.example.service.*.*(..))",
                    returning = "result")
    public void afterReturningLog(JoinPoint joinPoint, Object result) {
        log.info("반환: {} → {}", joinPoint.getSignature().getName(), result);
    }

    // 예외 발생 시
    @AfterThrowing(pointcut = "execution(* com.example.service.*.*(..))",
                   throwing = "ex")
    public void afterThrowingLog(JoinPoint joinPoint, Exception ex) {
        log.error("예외: {} → {}", joinPoint.getSignature().getName(), ex.getMessage());
    }

    // 메서드 실행 전후를 모두 제어 (가장 강력)
    @Around("execution(* com.example.service.*.*(..))")
    public Object aroundLog(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        try {
            Object result = pjp.proceed(); // Target 메서드 실행
            return result;
        } finally {
            long elapsed = System.currentTimeMillis() - start;
            log.info("{} 실행시간: {}ms", pjp.getSignature().getName(), elapsed);
        }
    }
}
```

| Advice | 시점 | proceed() 제어 | 용도 |
|--------|------|---------------|------|
| @Before | 메서드 실행 전 | X | 파라미터 검증, 로깅 |
| @AfterReturning | 정상 반환 후 | X | 결과 로깅 |
| @AfterThrowing | 예외 발생 시 | X | 에러 로깅/알림 |
| @After | 항상 (finally) | X | 리소스 정리 |
| @Around | 전후 모두 | O | 성능 측정, 트랜잭션, 캐시 |

# 3. Pointcut 표현식

---

```text
execution(접근제어자? 반환타입 선언타입?.메서드명(파라미터) 예외?)
```

```java
// 모든 public 메서드
@Pointcut("execution(public * *(..))")

// com.example.service 패키지의 모든 클래스, 모든 메서드
@Pointcut("execution(* com.example.service.*.*(..))")

// 하위 패키지 포함
@Pointcut("execution(* com.example.service..*.*(..))")

// 특정 어노테이션이 붙은 메서드
@Pointcut("@annotation(com.example.annotation.LogExecutionTime)")

// 특정 어노테이션이 붙은 클래스의 모든 메서드
@Pointcut("@within(org.springframework.stereotype.Service)")

// Pointcut 재사용 (이름 부여)
@Pointcut("execution(* com.example.service.*.*(..))")
public void serviceLayer() {}

@Before("serviceLayer()")
public void beforeService(JoinPoint jp) { /* ... */ }
```

# 4. Spring AOP의 Proxy 동작 원리

---

```text
Spring AOP는 런타임에 프록시 객체를 생성하여 Advice를 적용합니다.

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Controller  │ ──→ │    Proxy     │ ──→ │   Service    │
│              │     │  (AOP 적용)  │     │   (Target)   │
└──────────────┘     └──────────────┘     └──────────────┘
                      Before Advice
                      proceed()
                      After Advice
```

## JDK Dynamic Proxy vs CGLIB

```text
JDK Dynamic Proxy:
  - 인터페이스 기반
  - 대상 클래스가 인터페이스를 구현해야 함
  - Reflection 사용

CGLIB (기본):
  - 클래스 기반 (상속)
  - 인터페이스 없어도 프록시 생성 가능
  - 바이트코드를 조작하여 서브클래스 생성
  - Spring Boot 기본값

Spring Boot는 기본적으로 CGLIB 프록시를 사용합니다.
spring.aop.proxy-target-class=true (기본값)
```

## 프록시의 함정: 내부 호출 문제

```java
@Service
public class OrderService {

    @LogExecutionTime // AOP 적용됨
    public void createOrder() {
        // ...
        validateOrder(); // 내부 호출 → AOP 적용 안 됨!
    }

    @LogExecutionTime
    public void validateOrder() {
        // 이 메서드는 createOrder()에서 this로 호출되므로
        // 프록시를 거치지 않음 → Advice가 실행되지 않음
    }
}
```

```text
원인: this.validateOrder()는 프록시가 아닌 Target 객체의 메서드를 직접 호출
      비유: 비서(프록시)를 거쳐야 기록이 되는데, 동료에게 직접 말하면 비서가 모릅니다.
해결:
  1. 별도 빈으로 분리 (권장)
  2. 자기 자신을 주입받아 호출 (순환 참조 주의)
  3. AopContext.currentProxy() 사용
```

# 5. 실전 활용: 커스텀 어노테이션 + AOP

---

```java
// 1. 커스텀 어노테이션 정의
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface LogExecutionTime {}

// 2. Aspect 구현
@Aspect
@Component
public class ExecutionTimeAspect {
    @Around("@annotation(LogExecutionTime)")
    public Object measureTime(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.nanoTime();
        try {
            return pjp.proceed();
        } finally {
            long elapsed = (System.nanoTime() - start) / 1_000_000;
            log.info("[{}] {}ms", pjp.getSignature().toShortString(), elapsed);
        }
    }
}

// 3. 사용: 메서드에 어노테이션만 추가
@Service
public class OrderService {
    @LogExecutionTime
    public Order createOrder(OrderRequest request) {
        // 비즈니스 로직 (AOP 코드 없이 깔끔)
    }
}
```

# 6. 정리

---

| 개념 | 설명 |
|------|------|
| **AOP** | 횡단 관심사(로깅, 트랜잭션 등)를 핵심 로직에서 분리 |
| **@Aspect** | 횡단 관심사를 모듈화한 클래스 |
| **@Around** | 메서드 실행 전후를 모두 제어하는 가장 강력한 Advice |
| **Pointcut** | Advice 적용 대상을 지정하는 표현식 |
| **Proxy** | Spring이 런타임에 생성하는 대리 객체 (CGLIB 기본) |
| **내부 호출 문제** | this로 호출하면 프록시를 거치지 않아 AOP 미적용 |

```text
핵심:
  AOP = 횡단 관심사를 어노테이션 하나로 적용
  Spring AOP = 프록시 기반 (런타임)
  @Around가 가장 범용적, proceed()로 Target 실행 제어
  내부 메서드 호출(this.method())에는 AOP가 적용되지 않음에 주의
```

# Reference

---

- [Spring Framework - AOP](https://docs.spring.io/spring-framework/reference/core/aop.html)
- [Spring Framework - AOP Proxying](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html)
- [Baeldung - Introduction to Spring AOP](https://www.baeldung.com/spring-aop)
