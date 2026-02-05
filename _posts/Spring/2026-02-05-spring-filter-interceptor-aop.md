---
title: "[Spring] Filter vs Interceptor vs AOP - 요청 처리 파이프라인과 적합한 사용처"
categories:
  - Spring
tags:
  - [Java, Spring, Filter, Interceptor, AOP, RequestPipeline]
---

# Introduction

---

Spring 웹 애플리케이션에서 공통 처리(인증, 로깅, 인코딩 등)를 구현할 때 **Filter**, **Interceptor**, **AOP** 중 무엇을 쓸지 결정해야 합니다. 세 가지 모두 "공통 로직을 분리한다"는 목적은 같지만, **동작 계층**, **접근할 수 있는 정보**, **적용 범위**가 다릅니다.

# 1. 요청 처리 흐름 전체 그림

---

```text
HTTP 요청
  │
  ▼
┌──────────────────────┐
│  Filter (Servlet)     │  ← Servlet Container 레벨
│  - 인코딩, CORS, 인증 │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  DispatcherServlet   │  ← Spring MVC 진입점
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Interceptor         │  ← Spring MVC 레벨
│  - preHandle         │
│  - postHandle        │
│  - afterCompletion   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Controller          │
│    ↓                 │
│  AOP (Proxy)         │  ← Spring Bean 레벨
│    ↓                 │
│  Service             │
│    ↓                 │
│  Repository          │
└──────────────────────┘
```

# 2. Filter - Servlet Container 레벨

---

```java
import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;

@Component
public class RequestLoggingFilter implements Filter {

    @Override
    public void doFilter(ServletRequest request, ServletResponse response,
                         FilterChain chain) throws IOException, ServletException {
        HttpServletRequest httpReq = (HttpServletRequest) request;
        long start = System.currentTimeMillis();

        log.info("[Filter] {} {}", httpReq.getMethod(), httpReq.getRequestURI());

        chain.doFilter(request, response); // 다음 필터 또는 서블릿으로 전달

        long elapsed = System.currentTimeMillis() - start;
        log.info("[Filter] 응답 시간: {}ms", elapsed);
    }
}
```

```text
특징:
  - Servlet 스펙 (javax/jakarta.servlet.Filter)
  - DispatcherServlet 이전에 실행
  - Spring Context 외부 (빈 주입은 가능하지만 제한적)
  - ServletRequest/Response 접근 가능 (요청 본문 읽기/수정)
  - 모든 요청에 적용 (정적 리소스 포함)

적합한 용도:
  - 인코딩 설정 (CharacterEncodingFilter)
  - CORS 처리
  - XSS 방어 (요청 본문 검사/치환)
  - 요청/응답 본문 로깅
  - 인증 토큰 파싱 (Spring Security의 FilterChain)
```

## Filter 등록

```java
// 방법 1: @Component (모든 URL에 적용)
@Component
public class MyFilter implements Filter { ... }

// 방법 2: FilterRegistrationBean (URL 패턴 지정)
@Configuration
public class FilterConfig {
    @Bean
    public FilterRegistrationBean<MyFilter> myFilter() {
        FilterRegistrationBean<MyFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new MyFilter());
        registration.addUrlPatterns("/api/*");
        registration.setOrder(1); // 실행 순서
        return registration;
    }
}
```

# 3. Interceptor - Spring MVC 레벨

---

```java
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.ModelAndView;

@Component
public class AuthInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response, Object handler) {
        // Controller 실행 전
        String token = request.getHeader("Authorization");
        if (token == null) {
            response.setStatus(401);
            return false; // false 반환 → Controller 실행하지 않음
        }
        return true;
    }

    @Override
    public void postHandle(HttpServletRequest request,
                           HttpServletResponse response, Object handler,
                           ModelAndView modelAndView) {
        // Controller 실행 후, View 렌더링 전
    }

    @Override
    public void afterCompletion(HttpServletRequest request,
                                HttpServletResponse response, Object handler,
                                Exception ex) {
        // View 렌더링 후 (항상 실행, finally와 유사)
    }
}
```

```text
특징:
  - Spring MVC 스펙 (HandlerInterceptor)
  - DispatcherServlet 이후, Controller 실행 전후에 동작
  - Spring Context 내부 → 빈 주입 자유로움
  - handler 파라미터로 실행될 Controller 메서드 정보 접근 가능
  - 정적 리소스에는 적용되지 않음 (DispatcherServlet이 처리하는 요청만)

적합한 용도:
  - API 인증/인가 체크
  - Controller별 로깅
  - API 호출 횟수 제한
  - 요청 처리 시간 측정
```

## Interceptor 등록

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final AuthInterceptor authInterceptor;

    public WebConfig(AuthInterceptor authInterceptor) {
        this.authInterceptor = authInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
            .addPathPatterns("/api/**")       // 적용할 경로
            .excludePathPatterns("/api/auth/**"); // 제외할 경로
    }
}
```

# 4. AOP - Spring Bean 레벨

---

```java
@Aspect
@Component
public class ServiceLoggingAspect {

    @Around("execution(* com.example.service.*.*(..))")
    public Object logServiceCall(ProceedingJoinPoint pjp) throws Throwable {
        String methodName = pjp.getSignature().toShortString();
        Object[] args = pjp.getArgs();
        log.info("[AOP] 호출: {} args={}", methodName, Arrays.toString(args));

        Object result = pjp.proceed();

        log.info("[AOP] 반환: {} → {}", methodName, result);
        return result;
    }
}
```

```text
특징:
  - Spring AOP (프록시 기반)
  - HTTP 요청과 무관하게 모든 빈의 메서드에 적용 가능
  - HttpServletRequest 접근 불가 (직접적으로는)
  - 메서드 파라미터, 반환값, 예외에 접근 가능
  - 포인트컷으로 세밀한 대상 지정

적합한 용도:
  - 비즈니스 로직 실행 시간 측정
  - 트랜잭션 관리 (@Transactional이 AOP)
  - 메서드 레벨 로깅
  - 메서드 레벨 캐싱 (@Cacheable이 AOP)
  - 예외 변환
```

# 5. 비교 정리

---

| 항목 | Filter | Interceptor | AOP |
|------|--------|------------|-----|
| 스펙 | Servlet | Spring MVC | Spring AOP |
| 동작 계층 | Servlet Container | DispatcherServlet ↔ Controller | Bean 메서드 |
| 실행 시점 | DispatcherServlet 전후 | Controller 전후 | 메서드 전후 |
| HttpServletRequest | O | O | X (직접 접근 불가) |
| Controller 정보 | X | O (handler) | O (JoinPoint) |
| 메서드 파라미터 | X | X | O (args) |
| 반환값 접근 | X | X | O |
| Spring 빈 | 제한적 | O | O |
| 적용 범위 | 모든 요청 (정적 포함) | DispatcherServlet 요청 | 모든 빈 메서드 |

# 6. 선택 기준

---

```text
HTTP 요청/응답 본문을 읽거나 수정해야 한다
  → Filter (request body는 한 번만 읽을 수 있으므로)

URL 패턴별로 Controller 실행 전에 인증/인가를 체크한다
  → Interceptor (handler 정보 접근 가능, 경로 패턴 지정 용이)

특정 Service 메서드의 실행 시간을 측정한다
  → AOP (메서드 레벨 제어, HTTP와 무관)

Spring Security를 사용한다
  → Filter 체인 기반 (내부적으로 여러 Filter가 순서대로 실행)

트랜잭션 관리
  → AOP (@Transactional이 AOP 기반)
```

# 7. 실행 순서 시뮬레이션

---

```text
요청: GET /api/orders

[Filter] doFilter 시작
  [Interceptor] preHandle
    [AOP] @Around Before
      [Controller] getOrders() 실행
      [Service] findAll() 실행
    [AOP] @Around After
  [Interceptor] postHandle
  [Interceptor] afterCompletion
[Filter] doFilter 종료
```

# 8. 정리

---

| 개념 | 한 줄 정리 |
|------|-----------|
| **Filter** | Servlet 레벨, 요청/응답 본문 접근, 인코딩/CORS/보안 |
| **Interceptor** | Spring MVC 레벨, Controller 전후, 인증/로깅 |
| **AOP** | Bean 레벨, 메서드 전후, 트랜잭션/성능측정/캐싱 |

```text
핵심:
  Filter → Interceptor → AOP 순으로 안쪽으로 들어감
  바깥쪽일수록 HTTP에 가까움 (요청/응답 본문)
  안쪽일수록 비즈니스에 가까움 (메서드 파라미터, 반환값)
  어디서 처리할지는 "무엇에 접근해야 하는가"로 결정
```

# Reference

---

- [Spring Framework - Web MVC Filters](https://docs.spring.io/spring-framework/reference/web/webmvc/filters.html)
- [Spring Framework - Handler Interceptors](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/interceptors.html)
- [Spring Framework - AOP](https://docs.spring.io/spring-framework/reference/core/aop.html)
- [Baeldung - Filter vs Interceptor](https://www.baeldung.com/spring-mvc-handlerinterceptor-vs-filter)
