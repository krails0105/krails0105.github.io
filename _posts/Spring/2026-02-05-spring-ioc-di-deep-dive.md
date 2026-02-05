---
title: "[Spring] IoC와 DI 동작 원리 Deep Dive - Bean 생명주기, @Component vs @Bean"
categories:
  - Spring
tags:
  - [Java, Spring, IoC, DI, Bean, Container]
---

# Introduction

---

Spring의 핵심은 **IoC(Inversion of Control)** 컨테이너와 **DI(Dependency Injection)**입니다. 기초 포스트에서 `@Autowired`로 빈을 주입받는 방법을 다뤘지만, 이 글에서는 컨테이너가 내부적으로 어떻게 빈을 관리하는지, `@Component`와 `@Bean`의 차이, 빈의 생명주기, Scope 등을 정리합니다.

# 1. IoC(Inversion of Control)란?

---

```text
전통적 방식 (개발자가 직접 의존성 생성):
  OrderService가 OrderRepository를 직접 new로 생성
  → OrderService가 "어떤 구현체를 쓸지" 결정

IoC (제어의 역전):
  Spring 컨테이너가 OrderRepository를 생성하여 OrderService에 주입
  → "어떤 구현체를 쓸지"는 컨테이너(설정)가 결정
  → OrderService는 인터페이스에만 의존
```

```java
// Before: 직접 생성 (결합도 높음)
public class OrderService {
    private final OrderRepository repo = new JpaOrderRepository(); // 구체 클래스에 의존
}

// After: DI (결합도 낮음)
public class OrderService {
    private final OrderRepository repo; // 인터페이스에만 의존

    public OrderService(OrderRepository repo) { // 생성자 주입
        this.repo = repo;
    }
}
```

# 2. DI 방식 비교

---

## 생성자 주입 (권장)

```java
@Service
public class OrderService {
    private final OrderRepository orderRepository;

    // 생성자가 1개일 때 @Autowired 생략 가능
    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }
}
```

```text
권장 이유:
  - 필드를 final로 선언 가능 → 불변 보장
  - 필수 의존성 누락 시 컴파일 에러 (null 방지)
  - 테스트 시 Mock 주입 용이
  - 순환 참조를 애플리케이션 시작 시 즉시 감지
```

## 필드 주입 (비권장)

```java
@Service
public class OrderService {
    @Autowired
    private OrderRepository orderRepository; // final 불가, 테스트 어려움
}
```

## Setter 주입 (선택적 의존성에만)

```java
@Service
public class OrderService {
    private OrderRepository orderRepository;

    @Autowired(required = false) // 선택적 의존성
    public void setOrderRepository(OrderRepository repo) {
        this.orderRepository = repo;
    }
}
```

# 3. @Component vs @Bean

---

```java
// @Component: 클래스 레벨에 선언, 컴포넌트 스캔으로 자동 등록
@Component
public class OrderValidator {
    // Spring이 이 클래스를 찾아서 빈으로 등록
}

// @Bean: 메서드 레벨에 선언, @Configuration 클래스 안에서 수동 등록
@Configuration
public class AppConfig {
    @Bean
    public RestTemplate restTemplate() {
        return new RestTemplate(); // 외부 라이브러리 클래스를 빈으로 등록
    }
}
```

| 항목 | @Component | @Bean |
|------|-----------|-------|
| 선언 위치 | 클래스 | 메서드 (@Configuration 내부) |
| 등록 방식 | 컴포넌트 스캔 자동 | 수동 |
| 대상 | 내가 만든 클래스 | 외부 라이브러리 클래스 |
| 파생 어노테이션 | @Service, @Repository, @Controller | 없음 |

## @Component 파생 어노테이션

```text
@Component    → 일반 컴포넌트
@Service      → 비즈니스 로직 계층
@Repository   → 데이터 접근 계층 (JPA 예외 변환 추가)
@Controller   → 웹 요청 처리 계층
@RestController → @Controller + @ResponseBody
```

기능적 차이보다는 **계층을 명시**하여 코드 가독성과 AOP 포인트컷 지정에 활용합니다.

# 4. Bean 생명주기

---

```text
1. 빈 정의 읽기 (BeanDefinition)
   ↓
2. 빈 인스턴스 생성 (new)
   ↓
3. 의존성 주입 (@Autowired, 생성자 주입)
   ↓
4. 초기화 콜백
   - @PostConstruct
   - InitializingBean.afterPropertiesSet()
   - @Bean(initMethod = "init")
   ↓
5. 사용 (빈이 요청되면 반환)
   ↓
6. 소멸 콜백 (컨테이너 종료 시)
   - @PreDestroy
   - DisposableBean.destroy()
   - @Bean(destroyMethod = "cleanup")
   ↓
7. 빈 소멸
```

```java
@Component
public class DatabaseConnection {

    @PostConstruct
    public void init() {
        System.out.println("커넥션 풀 초기화");
    }

    @PreDestroy
    public void cleanup() {
        System.out.println("커넥션 풀 해제");
    }
}
```

# 5. Bean Scope

---

| Scope | 설명 | 생명주기 |
|-------|------|---------|
| **singleton** (기본) | 컨테이너당 1개 인스턴스 | 컨테이너 시작 ~ 종료 |
| **prototype** | 요청할 때마다 새 인스턴스 | 생성 후 컨테이너가 관리 안 함 |
| **request** | HTTP 요청당 1개 | 요청 시작 ~ 응답 |
| **session** | HTTP 세션당 1개 | 세션 생성 ~ 만료 |

```java
@Component
@Scope("prototype")
public class PrototypeBean {
    // 주입받을 때마다 새 인스턴스 생성
}
```

## Singleton + Prototype 주의점

```java
@Component // 기본 singleton
public class SingletonService {
    private final PrototypeBean prototypeBean;

    public SingletonService(PrototypeBean prototypeBean) {
        this.prototypeBean = prototypeBean;
        // 문제: singleton 생성 시점에 한 번만 주입됨
        // → prototypeBean이 사실상 singleton처럼 동작
        // 비유: 매번 새 종이컵을 받아야 하는데, 처음 받은 컵 하나만 계속 쓰는 상황
    }
}

// 해결: ObjectProvider 사용
@Component
public class SingletonService {
    private final ObjectProvider<PrototypeBean> provider;

    public SingletonService(ObjectProvider<PrototypeBean> provider) {
        this.provider = provider;
    }

    public void logic() {
        PrototypeBean bean = provider.getObject(); // 호출할 때마다 새 인스턴스
    }
}
```

# 6. @Configuration의 동작 원리

---

```java
@Configuration
public class AppConfig {
    @Bean
    public MemberRepository memberRepository() {
        return new MemoryMemberRepository();
    }

    @Bean
    public MemberService memberService() {
        return new MemberServiceImpl(memberRepository());
    }

    @Bean
    public OrderService orderService() {
        return new OrderServiceImpl(memberRepository());
    }
}
```

```text
memberRepository()가 3번 호출되지만 인스턴스는 1개만 생성됩니다.

원리: Spring이 @Configuration 클래스를 CGLIB 프록시로 감싸서,
@Bean 메서드 호출 시 이미 빈이 존재하면 기존 빈을 반환합니다.

@Configuration(proxyBeanMethods = false):
  CGLIB 프록시를 생성하지 않음 → 메서드 호출마다 새 인스턴스 생성
  빈 간 의존이 없을 때 사용하면 시작 속도 향상
```

# 7. 의존성 충돌 해결

---

같은 인터페이스를 구현한 빈이 2개 이상일 때:

```java
public interface DiscountPolicy {}

@Component
public class FixDiscount implements DiscountPolicy {}
@Component
public class RateDiscount implements DiscountPolicy {}
```

```java
// 1. @Primary: 기본 후보 지정
@Component
@Primary
public class RateDiscount implements DiscountPolicy {}

// 2. @Qualifier: 이름으로 지정
@Component
@Qualifier("fixDiscount")
public class FixDiscount implements DiscountPolicy {}

@Service
public class OrderService {
    public OrderService(@Qualifier("fixDiscount") DiscountPolicy policy) {}
}

// 3. 필드/파라미터명 매칭 (관례)
@Service
public class OrderService {
    public OrderService(DiscountPolicy rateDiscount) {} // 빈 이름과 파라미터명 매칭
}
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **IoC** | 객체 생성/관리 책임을 프레임워크(컨테이너)에 위임 |
| **DI** | 의존성을 외부에서 주입, 생성자 주입 권장 |
| **@Component** | 클래스 자동 스캔 등록 (내가 만든 클래스) |
| **@Bean** | 메서드 수동 등록 (외부 라이브러리 클래스) |
| **Bean 생명주기** | 생성 → 주입 → @PostConstruct → 사용 → @PreDestroy → 소멸 |
| **Scope** | singleton(기본), prototype, request, session |
| **@Configuration** | CGLIB 프록시로 @Bean 메서드의 싱글톤 보장 |

```text
핵심:
  생성자 주입 + final 필드 = 불변 + 필수 의존성 보장
  @Component = 자동 스캔, @Bean = 수동 등록
  singleton 빈에 prototype을 주입하면 함정 → ObjectProvider로 해결
```

# Reference

---

- [Spring Framework - IoC Container](https://docs.spring.io/spring-framework/reference/core/beans.html)
- [Spring Framework - Bean Scopes](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)
- [Baeldung - Spring Bean Lifecycle](https://www.baeldung.com/spring-bean)
