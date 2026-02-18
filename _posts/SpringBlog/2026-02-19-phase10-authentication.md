---
layout: single
title: "[SpringBlog] Phase 10 - Spring Security + JWT 인증 구현하기"
categories:
  - SpringBlog
tags:
  - [Spring Boot, Spring Security, JWT, JJWT, React, 인증, AuthContext]
---

# Introduction

---

블로그에 글을 작성하고 수정/삭제하는 기능은 **관리자만 사용할 수 있어야** 합니다. 아무나 글을 수정하거나 삭제할 수 있다면 블로그의 의미가 없기 때문입니다. 이번 Phase 10에서는 Spring Security와 JWT를 사용하여 백엔드 API 보호와 프론트엔드 로그인 흐름을 구현했습니다.

진행은 두 단계로 나뉩니다.

- **Phase 10A**: 세션 기반 인증으로 기본 구조를 잡고
- **Phase 10B**: JWT 기반으로 전환하여 Stateless 구조를 완성

**이 글에서 다루는 내용:**
- Spring Security 의존성 추가와 `SecurityFilterChain` 설정
- 세션 기반 인증과 JWT 기반 인증의 구조적 차이
- JJWT 라이브러리로 토큰 생성/검증 구현 (`JwtTokenProvider`)
- `OncePerRequestFilter`로 매 요청마다 JWT 검증 (`JwtAuthenticationFilter`)
- React에서 `localStorage` 기반 토큰 관리와 `AuthContext`로 전역 상태 공유

**사전 준비:**
- Spring Boot 3.x 프로젝트 (Spring Security 6.x 포함)
- React 프론트엔드 (Vite + React Router)
- Gradle 빌드 환경

# 1. 세션 vs JWT - 무엇이 다른가?

---

인증 방식을 선택하기 전에 두 방식의 구조적 차이를 이해해야 합니다.

| 항목 | 세션 기반 (Phase 10A) | JWT 기반 (Phase 10B) |
|------|----------------------|----------------------|
| 상태 관리 | Stateful (서버에 세션 저장) | Stateless (토큰 자체에 정보) |
| 전송 방식 | 쿠키 자동 전송 (JSESSIONID) | Authorization 헤더 수동 전송 |
| CORS 설정 | `allowCredentials(true)` 필요 | 불필요 |
| 로그아웃 | 서버에서 세션 파기 | 클라이언트에서 토큰 삭제 |
| 서버 확장 | 세션 공유 문제 발생 | 서버 증설에 유리 |

세션 방식은 서버가 로그인한 사용자 정보를 직접 저장합니다. 반면 JWT는 사용자 정보를 **토큰 자체에 담아** 클라이언트에게 넘깁니다. 서버는 토큰을 저장하지 않고 서명만 검증합니다.

> 참고: JWT의 Payload는 **암호화가 아니라 Base64 인코딩**입니다. 누구나 디코딩하여 내용을 볼 수 있으므로, 비밀번호 같은 민감한 정보를 Payload에 넣으면 안 됩니다. JWT가 보장하는 것은 **위변조 방지**(서명 검증)이지 **기밀성**이 아닙니다.

# 2. 세션 기반 인증 구현 (Phase 10A)

---

JWT로 전환하기 전에, 먼저 세션 기반 인증을 두 가지 방식으로 구현하면서 Spring Security의 인증 구조를 이해했습니다.

## 2-1. 방식 1: SecurityContextHolder 직접 설정

가장 단순한 방식입니다. 비밀번호를 직접 비교하고, Spring Security의 `SecurityContextHolder`에 인증 정보를 수동으로 설정합니다.

```java
@PostMapping("/login")
public ResponseEntity<LoginResponse> login(@RequestBody LoginRequest loginRequest,
                                            HttpSession session) {
    String username = loginRequest.getUsername();
    String password = loginRequest.getPassword();

    // 직접 비밀번호 비교
    if (adminUsername.equals(username) && adminPassword.equals(password)) {
        // Spring Security 인증 객체를 직접 생성
        // (principal, credentials, authorities)
        UsernamePasswordAuthenticationToken authentication =
            new UsernamePasswordAuthenticationToken(username, null, List.of());

        // SecurityContext에 인증 정보 설정
        SecurityContextHolder.getContext().setAuthentication(authentication);

        // 세션에 SecurityContext를 저장 (새로고침해도 로그인 유지)
        session.setAttribute("SPRING_SECURITY_CONTEXT",
            SecurityContextHolder.getContext());

        return ResponseEntity.ok(new LoginResponse(username, "Login Success"));
    }
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
}
```

**핵심 포인트:**
- `HttpSession`은 메서드 파라미터에 선언하면 Spring이 자동 주입 (`@RequestBody`와 같은 원리)
- `session.setAttribute("SPRING_SECURITY_CONTEXT", ...)`에서 `"SPRING_SECURITY_CONTEXT"`는 Spring Security가 세션에서 인증 정보를 찾는 **고정 키**
- `List.of()`는 빈 권한 목록 (특별한 역할 구분 없이 인증만 확인)

**이 방식의 한계:**
- 비밀번호를 **평문으로** 직접 비교 (암호화 없음)
- `SecurityContextHolder`를 직접 다루는 건 Spring Security의 일반적인 사용 패턴이 아님
- 인증 로직이 Controller에 섞여 있어 역할 분리가 안 됨

## 2-2. 방식 2: AuthenticationManager 위임

실무에서 세션 기반 인증을 구현할 때 사용하는 방식입니다. 인증 처리를 `AuthenticationManager`에게 **위임**합니다.

```text
AuthController
  → AuthenticationManager에게 인증 위임
    → UserDetailsService에서 사용자 정보 조회
    → PasswordEncoder로 비밀번호 비교 (BCrypt 암호화)
    → 성공하면 인증 객체 반환
```

**SecurityConfig에 Bean 3개 추가:**

```java
// 1) 비밀번호 암호화 도구 (BCrypt: 단방향 해시, 복호화 불가능)
@Bean
public PasswordEncoder passwordEncoder() {
    return new BCryptPasswordEncoder();
}

// 2) 사용자 정보 제공 (메모리에 관리자 1명 등록)
// InMemoryUserDetailsManager: DB 없이 메모리에 사용자 저장 (학습/테스트용)
@Bean
public UserDetailsService userDetailsService() {
    UserDetails admin = User.builder()
        .username(adminUsername)
        .password(passwordEncoder().encode(adminPassword))  // BCrypt로 암호화
        .roles("ADMIN")
        .build();
    return new InMemoryUserDetailsManager(admin);
}

// 3) 인증 처리 총괄 매니저
@Bean
public AuthenticationManager authenticationManager(
        AuthenticationConfiguration config) throws Exception {
    return config.getAuthenticationManager();
}
```

**AuthController 변경:**

```java
private final AuthenticationManager authenticationManager;

@PostMapping("/login")
public ResponseEntity<LoginResponse> login(@RequestBody LoginRequest loginRequest,
                                            HttpSession session) {
    String username = loginRequest.getUsername();
    String password = loginRequest.getPassword();

    try {
        // AuthenticationManager에게 인증 위임
        // 내부적으로 UserDetailsService + PasswordEncoder를 사용해서 검증
        Authentication authentication = authenticationManager.authenticate(
            new UsernamePasswordAuthenticationToken(username, password)
        );
        SecurityContextHolder.getContext().setAuthentication(authentication);
        session.setAttribute("SPRING_SECURITY_CONTEXT",
            SecurityContextHolder.getContext());

        return ResponseEntity.ok(new LoginResponse(username, "Login Success"));
    } catch (AuthenticationException e) {
        // 아이디 또는 비밀번호가 틀리면 예외 발생
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
    }
}
```

> **`@RequiredArgsConstructor`와 `final`**: Lombok의 `@RequiredArgsConstructor`는 **`final` 필드만** 생성자에 포함합니다. `private AuthenticationManager authenticationManager;`처럼 `final`이 없으면 주입이 안 되어 `NullPointerException`이 발생합니다.

**방식 1과의 차이:**

| 항목 | 방식 1 (직접 설정) | 방식 2 (AuthenticationManager) |
|------|-------------------|-------------------------------|
| 비밀번호 비교 | 평문 직접 비교 | BCrypt 암호화 비교 |
| 인증 로직 위치 | Controller 내부 | AuthenticationManager에 위임 |
| 사용자 정보 조회 | `@Value`로 직접 주입 | `UserDetailsService`가 담당 |
| 실무 적합성 | 학습/프로토타입 | 실무에서 권장 |

## 2-3. 세션 방식의 보안 이슈: 세션 하이재킹

세션 ID(JSESSIONID)를 탈취당하면 공격자가 로그인한 것처럼 행세할 수 있습니다. 이를 **세션 하이재킹(Session Hijacking)**이라 합니다.

```text
[정상 사용자]
브라우저 → Cookie: JSESSIONID=abc123 → 서버: "admin이구나, OK"

[공격자가 abc123을 탈취했다면]
공격자 → Cookie: JSESSIONID=abc123 → 서버: "admin이구나, OK" ← 구분 못함
```

| 방어 방법 | 설명 |
|-----------|------|
| HTTPS | 통신 암호화로 쿠키 가로채기 방지 |
| HttpOnly 쿠키 | JavaScript로 쿠키 접근 불가 (XSS 방어, Spring Boot 기본값) |
| Secure 쿠키 | HTTPS에서만 쿠키 전송 |
| 세션 만료 시간 | 탈취해도 오래 못 씀 |

세션은 서버에서 `session.invalidate()`로 즉시 무효화할 수 있다는 장점이 있습니다. JWT는 이후에 보겠지만, 발급된 토큰을 서버가 강제로 무효화하기 어렵습니다.

## 2-4. 프론트엔드 (세션 방식)

세션 방식에서는 브라우저가 쿠키를 **자동으로** 전송하므로, fetch 요청에 `credentials: 'include'`만 추가하면 됩니다.

```javascript
// 세션 방식의 API 호출 - 쿠키를 함께 보냄
const response = await fetch('/api/posts', {
  credentials: 'include',  // JSESSIONID 쿠키를 자동으로 포함
})
```

또한 백엔드 CORS 설정에 `allowCredentials(true)`가 필요합니다. 이 설정이 없으면 브라우저가 Cross-Origin 요청에 쿠키를 포함하지 않습니다.

```java
// WebConfig.java
registry.addMapping("/api/**")
    .allowedOriginPatterns("http://localhost:5173")
    .allowedMethods("GET", "POST", "PUT", "DELETE")
    .allowedHeaders("*")
    .allowCredentials(true);  // 쿠키 전송 허용
```

# 3. JWT 기반 인증으로 전환 (Phase 10B)

---

세션 기반 인증이 잘 동작하는 것을 확인한 후, JWT 기반으로 전환했습니다. 세션 방식에서 사용하던 `UserDetailsService`, `PasswordEncoder`, `AuthenticationManager` Bean은 제거하고, 대신 JWT 필터와 Stateless 설정을 추가합니다.

## 3-1. 의존성 추가

Spring Security는 Spring Boot BOM이 버전을 관리하므로 이름만 적으면 됩니다. JJWT는 외부 라이브러리이므로 버전을 직접 지정합니다.

```groovy
// backend/build.gradle

dependencies {
    // Spring Security - BOM이 버전 관리, 이름만 적으면 됨
    implementation 'org.springframework.boot:spring-boot-starter-security'

    // JJWT - 외부 라이브러리, 버전 직접 지정
    implementation 'io.jsonwebtoken:jjwt-api:0.12.6'       // API (컴파일 시 필요)
    runtimeOnly 'io.jsonwebtoken:jjwt-impl:0.12.6'         // 구현체 (런타임에만 필요)
    runtimeOnly 'io.jsonwebtoken:jjwt-jackson:0.12.6'      // JSON 직렬화 (런타임에만 필요)
}
```

JJWT는 API / 구현체 / JSON 직렬화 세 개의 모듈로 분리되어 있습니다. `jjwt-api`만 `implementation`이고 나머지는 `runtimeOnly`인 이유는, 코드에서 직접 참조하는 인터페이스(`Jwts`, `Keys` 등)는 `jjwt-api`에 있고, 실제 동작을 수행하는 구현체는 런타임에 자동으로 로드되기 때문입니다.

## 3-2. SecurityConfig

`SecurityFilterChain`을 `@Bean`으로 등록하면 Spring Security가 이를 자동으로 인식하여 보안 설정을 적용합니다. Spring Security 6.x부터는 `WebSecurityConfigurerAdapter`를 상속하는 방식이 제거되었고, 아래처럼 컴포넌트 기반 설정만 사용합니다.

```java
// backend/src/main/java/com/example/blog/config/SecurityConfig.java

@Configuration
@EnableWebSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthenticationFilter;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())  // REST API는 CSRF 불필요
            .authorizeHttpRequests(auth -> auth
                // GET /api/** 는 누구나 접근 가능 (글 읽기)
                .requestMatchers(HttpMethod.GET, "/api/**").permitAll()
                // 로그인/로그아웃은 누구나 가능
                .requestMatchers(HttpMethod.POST, "/api/auth/**").permitAll()
                // H2 콘솔 허용 (개발용)
                .requestMatchers("/h2-console/**").permitAll()
                // 나머지 (POST/PUT/DELETE 글 작성/수정/삭제)는 인증 필요
                .anyRequest().authenticated()
            )
            // JWT는 Stateless: 서버가 세션을 만들지 않음
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            // JWT 필터를 기본 인증 필터보다 먼저 실행
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
            .formLogin(form -> form.disable())   // 기본 로그인 폼 비활성화
            .httpBasic(basic -> basic.disable()); // 브라우저 팝업 인증 비활성화

        return http.build();
    }
}
```

이 설정의 핵심은 세 가지입니다.

1. **`authorizeHttpRequests`** -- URL별 접근 권한을 정의합니다. `requestMatchers()`에서 `*`는 경로 1단계만, `**`는 모든 하위 경로를 매칭합니다. `/api/**`는 `/api/posts`, `/api/posts/1`, `/api/categories` 등 `/api` 아래 모든 경로에 적용됩니다.
2. **`SessionCreationPolicy.STATELESS`** -- 서버가 `HttpSession`을 생성하지 않습니다. JWT를 사용하면 세션이 불필요하므로, 이 설정으로 세션 생성을 완전히 차단합니다.
3. **`addFilterBefore`** -- 커스텀 JWT 필터를 `UsernamePasswordAuthenticationFilter` 앞에 배치합니다. Spring Security의 기본 인증 처리 전에 JWT를 먼저 검증하여 `SecurityContext`에 인증 정보를 설정합니다.

## 3-3. JWT 설정값

```properties
# backend/src/main/resources/application-dev.properties

# 관리자 계정 (환경변수로 관리 권장)
blog.admin.username=admin
blog.admin.password=1234

# JWT 서명 키 (HMAC-SHA256, 32바이트 이상 필요)
jwt.secret=ThisIsASecretKeyForJwtTokenGenerationItMustBeLongEnough123456
# 토큰 만료 시간 (밀리초, 3600000 = 1시간)
jwt.expiration=3600000
```

`jwt.secret`은 HMAC-SHA256 서명에 사용됩니다. HMAC-SHA256은 최소 256비트(32바이트) 이상의 키를 요구합니다. 위 예제처럼 충분히 긴 문자열을 사용해야 합니다. 운영 환경에서는 이 값을 환경변수(`JWT_SECRET`)로 관리하고 소스코드에 포함하지 않아야 합니다.

# 4. JWT 구현

---

## 4-1. JwtTokenProvider - 토큰 생성/검증

```java
// backend/src/main/java/com/example/blog/security/JwtTokenProvider.java

@Component
public class JwtTokenProvider {

    @Value("${jwt.secret}")
    private String secret;

    @Value("${jwt.expiration}")
    private long expiration;

    // HMAC-SHA256 서명 키 생성
    private SecretKey getSigningKey() {
        return Keys.hmacShaKeyFor(secret.getBytes());
    }

    // 토큰 생성: username을 subject로 담아서 서명
    public String generateToken(String username) {
        Date now = new Date();
        Date expiryDate = new Date(now.getTime() + expiration);

        return Jwts.builder()
            .subject(username)       // Payload의 "sub" 클레임
            .issuedAt(now)           // Payload의 "iat" 클레임
            .expiration(expiryDate)  // Payload의 "exp" 클레임
            .signWith(getSigningKey())  // HMAC-SHA 서명
            .compact();              // 최종 JWT 문자열 생성
    }

    // 토큰에서 username 추출
    public String getUsername(String token) {
        return Jwts.parser()
            .verifyWith(getSigningKey())  // 서명 검증에 사용할 키 지정
            .build()
            .parseSignedClaims(token)     // 서명된 JWT(JWS)를 파싱
            .getPayload()                 // Claims 객체 반환
            .getSubject();                // "sub" 클레임 추출
    }

    // 토큰 유효성 검증 (만료, 위조 등)
    public boolean validateToken(String token) {
        try {
            Jwts.parser()
                .verifyWith(getSigningKey())
                .build()
                .parseSignedClaims(token);
            return true;
        } catch (JwtException e) {
            return false;  // 만료되었거나 위조된 토큰
        }
    }
}
```

JWT는 세 부분으로 구성됩니다: **Header**(알고리즘).**Payload**(데이터).**Signature**(서명). `generateToken()`은 `username`을 Payload의 `subject`에 담고, 비밀 키로 서명하여 토큰 문자열을 생성합니다. `validateToken()`은 서버의 비밀 키로 서명을 검증합니다. 비밀 키 없이는 위조가 불가능합니다.

JJWT 0.12.x에서 사용하는 주요 API를 정리하면 다음과 같습니다.

| 메서드 | 설명 |
|--------|------|
| `Jwts.builder()` | JWT 생성을 위한 빌더 반환 |
| `.subject(String)` | Payload의 `sub` 클레임 설정 |
| `.issuedAt(Date)` | Payload의 `iat` 클레임 설정 |
| `.expiration(Date)` | Payload의 `exp` 클레임 설정 |
| `.signWith(SecretKey)` | 키에 맞는 알고리즘을 자동 선택하여 서명 |
| `Jwts.parser()` | JWT 파싱을 위한 빌더 반환 (0.12.x 이상) |
| `.verifyWith(SecretKey)` | 서명 검증에 사용할 키 지정 |
| `.parseSignedClaims(String)` | 서명된 JWT(JWS)를 파싱하고 검증 |

## 4-2. JwtAuthenticationFilter - 매 요청마다 토큰 검증

```java
// backend/src/main/java/com/example/blog/security/JwtAuthenticationFilter.java

@Component
@RequiredArgsConstructor
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtTokenProvider jwtTokenProvider;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {

        // Authorization 헤더에서 토큰 추출
        String token = resolveToken(request);

        // 토큰이 유효하면 SecurityContext에 인증 정보 설정
        if (token != null && jwtTokenProvider.validateToken(token)) {
            String username = jwtTokenProvider.getUsername(token);

            // 인증 객체 생성: (principal, credentials, authorities)
            UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(username, null, List.of());
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }

        // 반드시 호출: 다음 필터로 요청을 넘김 (안 하면 요청이 멈춤)
        filterChain.doFilter(request, response);
    }

    // "Bearer 토큰값" 형식에서 토큰 부분만 추출
    private String resolveToken(HttpServletRequest request) {
        String bearer = request.getHeader("Authorization");
        if (bearer != null && bearer.startsWith("Bearer ")) {
            return bearer.substring(7);  // "Bearer " 7글자 제거
        }
        return null;
    }
}
```

`OncePerRequestFilter`를 상속하면 한 요청에 필터가 정확히 한 번만 실행됩니다. 이 필터의 동작 흐름은 다음과 같습니다.

```text
클라이언트 요청
  → JwtAuthenticationFilter.doFilterInternal()
    → Authorization 헤더에서 "Bearer xxx" 토큰 추출
    → JwtTokenProvider.validateToken()으로 서명/만료 검증
    → 유효하면 SecurityContext에 인증 객체 설정
    → filterChain.doFilter()로 다음 필터에 넘김
  → Spring Security의 AuthorizationFilter가 접근 권한 판단
  → Controller 도달
```

`filterChain.doFilter()`는 토큰이 없거나 유효하지 않은 경우에도 반드시 호출해야 합니다. 인증 여부에 따른 접근 차단은 이 필터의 역할이 아니라, 뒤에 있는 Spring Security의 `AuthorizationFilter`가 담당합니다.

## 4-3. AuthController (JWT용) - 로그인/로그아웃/상태 확인

```java
// backend/src/main/java/com/example/blog/controller/AuthController.java

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    @Value("${blog.admin.username}")
    private String adminUsername;

    @Value("${blog.admin.password}")
    private String adminPassword;

    private final JwtTokenProvider jwtTokenProvider;

    @PostMapping("/login")
    public ResponseEntity<LoginResponse> login(@RequestBody LoginRequest loginRequest) {
        String username = loginRequest.getUsername();
        String password = loginRequest.getPassword();

        if (adminUsername.equals(username) && adminPassword.equals(password)) {
            // 로그인 성공: JWT 토큰 발급
            String token = jwtTokenProvider.generateToken(username);
            return ResponseEntity.ok(new LoginResponse(username, "Login Success", token));
        } else {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
    }

    @PostMapping("/logout")
    public ResponseEntity<LoginResponse> logout() {
        // JWT는 서버가 할 일 없음 - 클라이언트가 토큰을 삭제
        return ResponseEntity.ok(new LoginResponse(null, "Logout Success", null));
    }

    @GetMapping("/status")
    public ResponseEntity<LoginResponse> status() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();

        // "anonymousUser" 체크 필수: Spring Security는 비인증 요청에도
        // isAuthenticated()가 true를 반환하는 AnonymousUser를 설정함
        if (authentication == null
                || !authentication.isAuthenticated()
                || "anonymousUser".equals(authentication.getPrincipal())) {
            return ResponseEntity.ok(new LoginResponse(null, "Not Login", null));
        }

        return ResponseEntity.ok(new LoginResponse(authentication.getName(), "Login", null));
    }
}
```

로그아웃은 서버에서 처리할 것이 없습니다. JWT는 서버에 저장되지 않으므로 클라이언트가 `localStorage`에서 토큰을 지우는 것이 로그아웃입니다.

`/status` 엔드포인트에서 `anonymousUser` 체크가 필요한 이유는, Spring Security가 인증되지 않은 요청에도 `AnonymousAuthenticationToken`을 설정하고 `isAuthenticated()`가 `true`를 반환하기 때문입니다. 이 동작은 Spring Security의 `AnonymousAuthenticationFilter`가 `SecurityContext`에 인증 객체가 없으면 자동으로 anonymous 토큰을 넣어주기 때문에 발생합니다.

# 5. 프론트엔드 구현 (JWT)

---

백엔드에서 JWT를 발급하고 검증하는 구조를 만들었으니, 이제 프론트엔드에서 이 토큰을 저장하고 매 요청에 실어 보내는 부분을 구현합니다.

## 5-1. authApi.js - localStorage 토큰 관리

```javascript
// frontend/src/api/authApi.js

// 로그인: 서버에서 JWT 토큰을 받아 localStorage에 저장
export async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다')
  const data = await response.json()
  localStorage.setItem('token', data.token)  // 토큰 저장
  return data
}

// 로그아웃: localStorage에서 토큰 삭제만 하면 됨
export async function logout() {
  localStorage.removeItem('token')
}

// 페이지 새로고침 시 토큰으로 로그인 상태 복원
export async function checkStatus() {
  const token = localStorage.getItem('token')
  if (!token) return { username: null, message: 'Not Login' }

  const response = await fetch('/api/auth/status', {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!response.ok) throw new Error('상태 확인 실패')
  return response.json()
}

// 다른 API 함수에서 가져다 쓰는 토큰 조회 헬퍼
export function getToken() {
  return localStorage.getItem('token')
}
```

## 5-2. postApi.js - Authorization 헤더 추가

```javascript
// frontend/src/api/postApi.js

import { getToken } from './authApi'

// 인증이 필요한 요청에 Authorization 헤더를 추가하는 헬퍼
function authHeaders(headers = {}) {
  const token = getToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

// 글 작성 (POST) - 인증 필요
export async function createPost(postData) {
  const response = await fetch('/api/posts', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(postData),
  })
  if (!response.ok) throw new Error('글 작성에 실패했습니다')
  return response.json()
}

// 글 삭제 (DELETE) - 인증 필요
export async function deletePost(id) {
  const response = await fetch(`/api/posts/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!response.ok) throw new Error('글 삭제에 실패했습니다')
}
```

`authHeaders()`는 저장된 토큰을 꺼내 `Authorization: Bearer 토큰` 형식으로 헤더에 추가합니다. 기존 헤더 객체를 받아서 거기에 인증 헤더를 합치는 방식이라, `Content-Type` 같은 다른 헤더와 함께 사용할 수 있습니다.

## 5-3. AuthContext - 앱 전역 인증 상태 관리

```jsx
// frontend/src/contexts/AuthContext.jsx

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)   // 로그인한 사용자 정보
  const [loading, setLoading] = useState(true)  // 초기 로딩 상태

  // 앱 시작 시(새로고침 포함) localStorage 토큰으로 로그인 상태 복원
  useEffect(() => {
    checkStatus()
      .then((data) => {
        if (data.username) setUser({ username: data.username })
      })
      .catch(() => {
        localStorage.removeItem('token')  // 만료된 토큰 삭제
      })
      .finally(() => setLoading(false))
  }, [])

  const login = async (username, password) => {
    const data = await apiLogin(username, password)
    setUser({ username: data.username })
  }

  const logout = async () => {
    await apiLogout()
    setUser(null)
  }

  // 토큰 확인이 끝날 때까지 빈 화면 (UI 깜빡임 방지)
  if (loading) return <div className="min-h-screen bg-gray-50" />

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

// 어디서든 인증 상태에 접근하는 커스텀 훅
export function useAuth() {
  return useContext(AuthContext)
}
```

`AuthContext`는 로그인 상태(`user`)를 앱 전체에서 공유합니다. props drilling(부모 -> 자식 -> 손자로 props를 계속 내려주는 것) 없이 어느 컴포넌트에서든 `useAuth()`로 로그인 상태를 바로 사용할 수 있습니다.

`loading` 상태가 중요한 이유는, 새로고침 시 `checkStatus()` API 호출이 완료되기 전에 `user`가 `null`이라 비로그인 상태로 렌더링되면, 잠깐 로그인 페이지가 보이다가 로그인 상태로 바뀌는 깜빡임이 발생하기 때문입니다. `loading`이 `true`인 동안 빈 화면을 보여주면 이 문제를 방지할 수 있습니다.

## 5-4. App.jsx - 라우트 가드

```jsx
// frontend/src/App.jsx

function App() {
  const { user, logout } = useAuth()

  return (
    <div>
      <nav>
        {user ? (
          // 로그인 상태: 글 작성 버튼 + 로그아웃
          <>
            <span>{user.username}</span>
            <Link to="/posts/new">새 글 작성</Link>
            <button onClick={logout}>로그아웃</button>
          </>
        ) : (
          // 비로그인 상태: 로그인 버튼만
          <Link to="/login">로그인</Link>
        )}
      </nav>

      <Routes>
        <Route path="/" element={<PostListPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* 라우트 가드: 비로그인이면 로그인 페이지로 리다이렉트 */}
        <Route
          path="/posts/new"
          element={user ? <PostCreatePage /> : <Navigate to="/login" />}
        />
        <Route path="/posts/:id" element={<PostDetailPage />} />
        <Route
          path="/posts/:id/edit"
          element={user ? <PostEditPage /> : <Navigate to="/login" />}
        />
      </Routes>
    </div>
  )
}
```

라우트 가드는 삼항 연산자로 간단히 구현합니다. `user`가 있으면 해당 페이지를 보여주고, 없으면 `<Navigate to="/login" />`으로 로그인 페이지로 리다이렉트합니다. 이 방식은 백엔드의 `SecurityConfig`와 함께 **이중 보호**를 제공합니다. 프론트엔드 라우트 가드는 우회할 수 있지만, 백엔드 API는 JWT 없이 호출할 수 없으므로 실제 데이터는 안전합니다.

# 6. 전체 인증 흐름

---

지금까지 구현한 각 구성 요소가 실제로 어떻게 연결되어 동작하는지 흐름을 정리합니다.

## 로그인 흐름

```text
1. [React] LoginPage에서 username/password 입력
2. [React] authApi.login() → POST /api/auth/login 호출
3. [Spring] AuthController.login()에서 계정 확인
4. [Spring] JwtTokenProvider.generateToken()으로 JWT 발급
5. [React] 응답에서 token을 받아 localStorage에 저장
6. [React] AuthContext의 user 상태 업데이트 → UI 변경
```

## 인증된 API 호출 흐름

```text
1. [React] createPost() → authHeaders()로 Authorization 헤더에 토큰 추가
2. [Spring] JwtAuthenticationFilter가 헤더에서 토큰 추출
3. [Spring] JwtTokenProvider.validateToken()으로 서명/만료 검증
4. [Spring] 유효하면 SecurityContext에 인증 정보 설정
5. [Spring] AuthorizationFilter가 접근 권한 확인 → Controller 실행
```

# 7. 주의할 점

---

## `anonymousUser` 체크 누락

Spring Security는 인증되지 않은 요청에도 `AnonymousAuthenticationToken`을 주입하고, 해당 객체의 `isAuthenticated()`는 `true`를 반환합니다. `/status` API에서 `"anonymousUser".equals(authentication.getPrincipal())` 체크를 빠뜨리면 비로그인 사용자도 로그인 상태로 판단됩니다.

```java
// 잘못된 코드: anonymousUser도 true를 반환
if (authentication != null && authentication.isAuthenticated()) {
    return "로그인 상태";  // 비로그인 사용자도 여기에 들어옴!
}

// 올바른 코드: anonymousUser를 명시적으로 제외
if (authentication != null
        && authentication.isAuthenticated()
        && !"anonymousUser".equals(authentication.getPrincipal())) {
    return "로그인 상태";
}
```

## `filterChain.doFilter()` 미호출

`JwtAuthenticationFilter`에서 `filterChain.doFilter(request, response)` 호출을 빠뜨리면 요청이 필터에서 멈춥니다. 토큰이 없거나 유효하지 않아도 이 줄은 반드시 실행해야 합니다. 인증 여부 판단은 Spring Security의 다음 필터(`AuthorizationFilter`)가 합니다.

## JJWT 버전에 따른 API 변화

JJWT 0.12.x부터 API가 크게 바뀌었습니다. 인터넷의 예제 코드를 참고할 때 버전을 반드시 확인해야 합니다.

| 항목 | 0.11.x 이하 (구 버전) | 0.12.x 이상 (현재) |
|------|----------------------|-------------------|
| 파서 생성 | `Jwts.parserBuilder()` | `Jwts.parser()` |
| 키 지정 | `.setSigningKey(key)` | `.verifyWith(key)` |
| 클레임 파싱 | `.parseClaimsJws(token)` | `.parseSignedClaims(token)` |
| Subject 설정 | `.setSubject(name)` | `.subject(name)` |
| 만료시간 설정 | `.setExpiration(date)` | `.expiration(date)` |

## JWT 보안 취약점: 토큰 탈취

세션 방식은 서버에서 세션을 파기하여 즉시 로그아웃이 가능하지만, JWT는 토큰이 만료될 때까지 서버가 막을 방법이 없습니다. 일반적인 대응 방법은 다음과 같습니다.

- 토큰 만료 시간을 짧게 설정 (1시간 이하)
- Refresh Token을 별도로 도입하여 Access Token을 주기적으로 갱신
- `localStorage` 대신 `httpOnly` 쿠키에 토큰을 저장하면 XSS 공격으로 인한 토큰 탈취를 방지할 수 있음 (단, CSRF 방어가 다시 필요해짐)

## `Keys.hmacShaKeyFor()` 키 길이

`Keys.hmacShaKeyFor(secret.getBytes())`는 바이트 배열의 길이에 따라 알고리즘을 자동 선택합니다. 32바이트 이상이면 HS256, 48바이트 이상이면 HS384, 64바이트 이상이면 HS512를 사용합니다. 키가 32바이트 미만이면 `WeakKeyException`이 발생하므로, `jwt.secret` 값이 충분히 긴지 확인해야 합니다.

# 8. 정리

---

| 구성 요소 | 역할 |
|-----------|------|
| `SecurityConfig` | URL별 접근 권한 정의, Stateless 설정, JWT 필터 등록 |
| `JwtTokenProvider` | JWT 생성 (`generateToken`), 검증 (`validateToken`), username 추출 (`getUsername`) |
| `JwtAuthenticationFilter` | 매 요청의 Authorization 헤더에서 토큰 추출 후 SecurityContext에 인증 설정 |
| `AuthController` | 로그인(토큰 발급), 로그아웃(서버 무처리), 상태 확인 API |
| `authApi.js` | `localStorage` 토큰 저장/삭제, API 호출 |
| `AuthContext` | React 전역 인증 상태 관리, 새로고침 시 상태 복원 |

```text
핵심:
  JWT 인증 = 서버는 상태를 저장하지 않고, 클라이언트가 매 요청마다 토큰을 제시한다.
  백엔드: SecurityFilterChain → JwtAuthenticationFilter → SecurityContext 설정.
  프론트엔드: localStorage에 토큰 저장 → authHeaders()로 매 요청에 토큰 첨부.
  보안: 토큰 만료 시간을 짧게 + 민감 정보는 Payload에 넣지 않기.
```

세션 방식(Phase 10A)으로 기본 구조를 잡고, JWT 방식(Phase 10B)으로 전환하면서 Stateless 인증의 동작 원리를 직접 구현해 볼 수 있었습니다.

# Reference

---

- [Spring Security 공식 문서 - Authorize HTTP Requests](https://docs.spring.io/spring-security/reference/servlet/authorization/authorize-http-requests.html)
- [Spring Security 공식 문서 - Session Management](https://docs.spring.io/spring-security/reference/servlet/authentication/session-management.html)
- [Spring Security 공식 문서 - Architecture (SecurityFilterChain)](https://docs.spring.io/spring-security/reference/servlet/architecture.html)
- [JJWT GitHub (0.12.x)](https://github.com/jwtk/jjwt)
