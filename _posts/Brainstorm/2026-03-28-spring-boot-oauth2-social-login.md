---
title: "[Spring Boot] OAuth2 소셜 로그인 구현 (구글/카카오/네이버)"
categories:
  - Brainstorm
tags: [Spring Boot, OAuth2, Spring Security, Google, Kakao, Naver, JWT, Brainstorm]
date: 2026-03-28
---

## Introduction

---

이번 포스트에서는 Spring Boot 프로젝트에 구글, 카카오, 네이버 소셜 로그인을 연동하는 과정을 정리합니다. Spring Security가 제공하는 `spring-boot-starter-oauth2-client`를 활용해 OAuth2 인증 흐름을 구현하고, 각 소셜 플랫폼마다 다른 응답 구조를 깔끔하게 처리하는 인터페이스 패턴도 함께 다룹니다.

이 글을 읽고 나면 다음을 할 수 있습니다.

- OAuth2 소셜 로그인의 전체 흐름을 이해하고, Spring Security가 어디까지 자동 처리하는지 파악
- 구글/카카오/네이버 3개 플랫폼의 설정 차이를 정리하고 `application.properties`에 올바르게 등록
- 인터페이스 + Factory 패턴으로 플랫폼별 사용자 정보 파싱을 깔끔하게 분리
- JWT 기반 인증과 OAuth2 세션의 공존 문제를 해결

## 사전 준비 (Prerequisites)

---

이 글의 내용을 따라가려면 다음 환경이 필요합니다.

- **Java 17** 이상 (switch expression 문법 사용)
- **Spring Boot 3.x** + **Spring Security 6.x**
- **spring-boot-starter-oauth2-client** 의존성
- JWT 기반 인증이 이미 구현된 상태 (JwtProvider, JwtFilter 등)
- 각 소셜 플랫폼의 OAuth 클라이언트 등록 완료
  - [Google Cloud Console](https://console.cloud.google.com/) 에서 OAuth 2.0 클라이언트 생성
  - [Kakao Developers](https://developers.kakao.com/) 에서 앱 등록 및 카카오 로그인 활성화
  - [Naver Developers](https://developers.naver.com/) 에서 애플리케이션 등록

## 배경 (왜 소셜 로그인인가?)

---

소셜 로그인을 구현하기 전에는 이메일/비밀번호 기반의 로컬 로그인만 지원하고 있었습니다. 사용자 입장에서는 매번 회원가입을 하는 번거로움이 있었고, 개발자 입장에서는 비밀번호 관리, 이메일 인증 등의 부담이 있었습니다.

소셜 로그인을 추가하면:

- 사용자는 기존 계정(구글, 카카오, 네이버)으로 바로 로그인 가능
- 비밀번호를 서버에 저장할 필요 없음
- 이미 검증된 사용자 정보(이메일 등)를 활용 가능

## OAuth2 인증 흐름 이해하기

---

코드를 보기 전에, OAuth2 로그인이 어떤 순서로 진행되는지 전체 그림을 먼저 이해해야 합니다.

```
[사용자]          [프론트엔드]         [백엔드(Spring)]        [소셜 플랫폼(구글 등)]
   |                  |                     |                         |
   |  "구글로 로그인" 클릭                   |                         |
   |----------------->|                     |                         |
   |                  |  /oauth2/authorization/google 요청            |
   |                  |------------------->|                         |
   |                  |                     | 구글 인증 페이지로 redirect|
   |                  |                     |------------------------>|
   |                  |                     |                         |
   |  구글에서 로그인/동의                    |                         |
   |------------------------------------------------>|               |
   |                  |                     |                         |
   |                  |                     |  callback URL로 code 전달|
   |                  |                     |<------------------------|
   |                  |                     |                         |
   |                  |                     |  code로 access_token 교환|
   |                  |                     |------------------------>|
   |                  |                     |<--- access_token -------|
   |                  |                     |                         |
   |                  |                     |  access_token으로 사용자 정보 조회
   |                  |                     |------------------------>|
   |                  |                     |<--- 사용자 정보 ---------|
   |                  |                     |                         |
   |                  |                     | DB 저장 + JWT 발급       |
   |                  |                     |                         |
   |                  | FE로 redirect (token 포함)                    |
   |                  |<--------------------|                         |
   |  로그인 완료       |                     |                         |
   |<-----------------|                     |                         |
```

Spring Security의 `oauth2Login()`을 사용하면 **code 교환부터 사용자 정보 조회까지의 과정을 프레임워크가 자동으로 처리**해줍니다. 개발자는 "사용자 정보를 받은 이후" 로직만 구현하면 됩니다.

핵심 포인트를 정리하면 다음과 같습니다.

| 단계 | 누가 처리하는가 | 설명 |
|------|----------------|------|
| 인증 페이지 redirect | Spring Security 자동 | `/oauth2/authorization/{provider}` 요청 시 자동 redirect |
| authorization code 수신 | Spring Security 자동 | `/login/oauth2/code/{provider}` callback 자동 처리 |
| code -> access_token 교환 | Spring Security 자동 | `DefaultOAuth2UserService` 내부에서 처리 |
| access_token -> 사용자 정보 조회 | Spring Security 자동 | `super.loadUser()` 호출 시 처리 |
| 사용자 DB 저장/연동 | **개발자 구현** | `CustomOAuth2UserService.loadUser()` |
| JWT 발급 + FE redirect | **개발자 구현** | `OAuth2SuccessHandler.onAuthenticationSuccess()` |

## 설계 방향 (Approach)

---

각 소셜 플랫폼(구글, 카카오, 네이버)은 사용자 정보를 서로 다른 JSON 구조로 반환합니다.

- **구글**: 응답이 평탄(flat)함 -- `attributes.get("email")`으로 바로 접근
- **카카오**: 중첩 구조 -- `kakao_account.email`, `properties.nickname`
- **네이버**: 중첩 구조 -- `response.email`, `response.name`

이 차이를 처리하기 위해 **`OAuth2UserInfo` 인터페이스**를 정의하고, 각 플랫폼별 구현 클래스를 만들었습니다. 그리고 Factory 메서드 패턴으로 `registrationId`(google/kakao/naver)에 따라 알맞은 구현체를 반환합니다.

```
OAuth2UserInfo (인터페이스)
├── getEmail()
├── getNickname()
└── getProviderId()

구현체:
├── GoogleOAuth2UserInfo   ← 평탄 구조 (바로 get)
├── KakaoOAuth2UserInfo    ← kakao_account / properties 중첩
└── NaverOAuth2UserInfo    ← response 중첩
```

이렇게 하면 `CustomOAuth2UserService`와 `OAuth2SuccessHandler`는 어느 플랫폼인지 신경 쓰지 않고 동일한 인터페이스(`getEmail()`, `getNickname()` 등)로 사용자 정보에 접근할 수 있습니다.

## 구현 (Step by Step)

---

### Step 1. 의존성 추가

```groovy
// build.gradle
implementation 'org.springframework.boot:spring-boot-starter-oauth2-client'
```

이 의존성 하나로 Spring Security의 OAuth2 Client 기능 전체가 포함됩니다. `spring-boot-starter-security`는 이미 추가되어 있다고 가정합니다.

### Step 2. application.properties -- 소셜 플랫폼 설정

먼저 각 소셜 플랫폼의 OAuth 설정을 등록합니다. 이 설정이 있어야 Spring Security가 어떤 플랫폼에 어떤 URL로 인증을 요청할지 알 수 있습니다.

```properties
# ============================================================
# 구글 OAuth2
# ============================================================
# 구글은 Spring Boot에 provider 정보가 내장되어 있어서 client-id, client-secret, scope만 지정하면 됨
# (내부적으로 CommonOAuth2Provider.GOOGLE에 authorization-uri, token-uri 등이 미리 정의되어 있음)
spring.security.oauth2.client.registration.google.client-id=${GOOGLE_CLIENT_ID}
spring.security.oauth2.client.registration.google.client-secret=${GOOGLE_CLIENT_SECRET}
spring.security.oauth2.client.registration.google.scope=email,profile

# ============================================================
# 카카오 OAuth2
# ============================================================
# 카카오는 Spring Boot가 모르는 플랫폼이므로 registration + provider 모두 직접 설정해야 함
spring.security.oauth2.client.registration.kakao.client-id=${KAKAO_CLIENT_ID}
spring.security.oauth2.client.registration.kakao.client-secret=${KAKAO_CLIENT_SECRET}
spring.security.oauth2.client.registration.kakao.scope=account_email,profile_nickname
spring.security.oauth2.client.registration.kakao.authorization-grant-type=authorization_code
spring.security.oauth2.client.registration.kakao.redirect-uri={baseUrl}/login/oauth2/code/{registrationId}
spring.security.oauth2.client.registration.kakao.client-name=Kakao
spring.security.oauth2.client.registration.kakao.client-authentication-method=client_secret_post

spring.security.oauth2.client.provider.kakao.authorization-uri=https://kauth.kakao.com/oauth/authorize
spring.security.oauth2.client.provider.kakao.token-uri=https://kauth.kakao.com/oauth/token
spring.security.oauth2.client.provider.kakao.user-info-uri=https://kapi.kakao.com/v2/user/me
spring.security.oauth2.client.provider.kakao.user-name-attribute=id

# ============================================================
# 네이버 OAuth2
# ============================================================
# 네이버도 카카오와 동일하게 provider를 직접 지정
spring.security.oauth2.client.registration.naver.client-id=${NAVER_CLIENT_ID}
spring.security.oauth2.client.registration.naver.client-secret=${NAVER_CLIENT_SECRET}
spring.security.oauth2.client.registration.naver.scope=email,name
spring.security.oauth2.client.registration.naver.authorization-grant-type=authorization_code
spring.security.oauth2.client.registration.naver.redirect-uri={baseUrl}/login/oauth2/code/{registrationId}
spring.security.oauth2.client.registration.naver.client-name=Naver
spring.security.oauth2.client.registration.naver.client-authentication-method=client_secret_post

spring.security.oauth2.client.provider.naver.authorization-uri=https://nid.naver.com/oauth2.0/authorize
spring.security.oauth2.client.provider.naver.token-uri=https://nid.naver.com/oauth2.0/token
spring.security.oauth2.client.provider.naver.user-info-uri=https://openapi.naver.com/v1/nid/me
spring.security.oauth2.client.provider.naver.user-name-attribute=response
```

**구글 vs 카카오/네이버 설정의 차이**를 정리하면 다음과 같습니다.

| 항목 | 구글 | 카카오 / 네이버 |
|------|------|----------------|
| provider 설정 | 불필요 (Spring Boot 내장) | 직접 지정 필요 (`authorization-uri`, `token-uri`, `user-info-uri`) |
| `client-authentication-method` | 기본값 `client_secret_basic` 사용 | `client_secret_post` 명시 필요 |
| `authorization-grant-type` | 기본값 `authorization_code` 사용 | 명시적으로 지정 |
| `redirect-uri` | 기본값 사용 | 명시적으로 지정 |

> **`{baseUrl}`과 `{registrationId}`는 Spring Security가 런타임에 자동으로 치환하는 플레이스홀더입니다.** 예를 들어 로컬에서는 `http://localhost:8080/login/oauth2/code/kakao`로 치환됩니다.

### Step 3. OAuth2UserInfo 인터페이스 & 구현체

플랫폼마다 다른 응답 구조를 통일된 인터페이스로 추상화합니다.

```java
// src/main/java/.../config/oauth/OAuth2UserInfo.java
package com.brainstorm.brainstorm_api.config.oauth;

import java.util.Map;

public interface OAuth2UserInfo {
    String getEmail();
    String getNickname();
    String getProviderId();

    // registrationId(google/kakao/naver)에 따라 알맞은 구현체를 반환하는 Factory 메서드
    static OAuth2UserInfo of(String registrationId, Map<String, Object> attributes) {
        return switch (registrationId) {
            case "google" -> new GoogleOAuth2UserInfo(attributes);
            case "kakao"  -> new KakaoOAuth2UserInfo(attributes);
            case "naver"  -> new NaverOAuth2UserInfo(attributes);
            default -> throw new IllegalArgumentException("Unsupported Provider: " + registrationId);
        };
    }
}
```

각 플랫폼 구현체는 응답 JSON 구조가 다르기 때문에 별도로 작성합니다.

**GoogleOAuth2UserInfo** -- 구글은 응답이 평탄(flat)해서 바로 `get()` 가능:

```java
// src/main/java/.../config/oauth/GoogleOAuth2UserInfo.java
package com.brainstorm.brainstorm_api.config.oauth;

import java.util.Map;

public class GoogleOAuth2UserInfo implements OAuth2UserInfo {

    private final Map<String, Object> attributes;

    GoogleOAuth2UserInfo(Map<String, Object> attributes) {
        this.attributes = attributes;
    }

    @Override
    public String getEmail() {
        return (String) this.attributes.get("email");  // 평탄 구조: 바로 접근
    }

    @Override
    public String getNickname() {
        return (String) this.attributes.get("name");
    }

    @Override
    public String getProviderId() {
        return (String) this.attributes.get("sub");  // 구글 고유 사용자 ID
    }
}
```

**KakaoOAuth2UserInfo** -- 카카오는 `kakao_account`, `properties` 하위에 정보가 있음:

```java
// src/main/java/.../config/oauth/KakaoOAuth2UserInfo.java
package com.brainstorm.brainstorm_api.config.oauth;

import java.util.Map;

public class KakaoOAuth2UserInfo implements OAuth2UserInfo {

    private final Map<String, Object> attributes;

    KakaoOAuth2UserInfo(Map<String, Object> attributes) {
        this.attributes = attributes;
    }

    @Override
    public String getEmail() {
        // 카카오 응답 구조: { "kakao_account": { "email": "..." } }
        Map<String, Object> account = (Map<String, Object>) this.attributes.get("kakao_account");
        if (account == null) return "";
        return (String) account.get("email");
    }

    @Override
    public String getNickname() {
        // 카카오 응답 구조: { "properties": { "nickname": "..." } }
        Map<String, Object> properties = (Map<String, Object>) this.attributes.get("properties");
        if (properties == null) return "";
        return (String) properties.get("nickname");
    }

    @Override
    public String getProviderId() {
        // 카카오 id는 Long 타입이므로 String으로 변환
        return String.valueOf(this.attributes.get("id"));
    }
}
```

**NaverOAuth2UserInfo** -- 네이버는 `response` 하위에 모든 정보가 있음:

```java
// src/main/java/.../config/oauth/NaverOAuth2UserInfo.java
package com.brainstorm.brainstorm_api.config.oauth;

import java.util.Map;

public class NaverOAuth2UserInfo implements OAuth2UserInfo {

    private final Map<String, Object> attributes;

    NaverOAuth2UserInfo(Map<String, Object> attributes) {
        this.attributes = attributes;
    }

    @Override
    public String getEmail() {
        // 네이버 응답 구조: { "response": { "email": "...", "name": "...", "id": "..." } }
        Map<String, Object> response = (Map<String, Object>) attributes.get("response");
        if (response == null) return "";
        return (String) response.get("email");
    }

    @Override
    public String getNickname() {
        Map<String, Object> response = (Map<String, Object>) attributes.get("response");
        if (response == null) return "";
        return (String) response.get("name");
    }

    @Override
    public String getProviderId() {
        Map<String, Object> response = (Map<String, Object>) attributes.get("response");
        if (response == null) return "";
        return (String) response.get("id");
    }
}
```

### Step 4. CustomOAuth2UserService -- 사용자 저장/연동

Spring Security가 소셜 플랫폼에서 사용자 정보를 가져온 뒤 호출하는 서비스입니다. 여기서 DB에 사용자를 저장하거나 기존 회원과 연동합니다.

```java
// src/main/java/.../service/CustomOAuth2UserService.java
package com.brainstorm.brainstorm_api.service;

import com.brainstorm.brainstorm_api.config.oauth.OAuth2UserInfo;
import com.brainstorm.brainstorm_api.entity.User;
import com.brainstorm.brainstorm_api.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class CustomOAuth2UserService extends DefaultOAuth2UserService {

    private final UserRepository userRepository;

    @Override
    public OAuth2User loadUser(OAuth2UserRequest userRequest) throws OAuth2AuthenticationException {
        // 1. Spring Security가 액세스 토큰 교환 + 사용자 정보 조회를 마친 결과를 가져옴
        OAuth2User oAuth2User = super.loadUser(userRequest);

        // 2. 어떤 소셜 플랫폼인지 확인 (google / kakao / naver)
        String registrationId = userRequest.getClientRegistration().getRegistrationId();

        // 3. 플랫폼별 응답 구조를 통일된 인터페이스로 변환
        OAuth2UserInfo userInfo = OAuth2UserInfo.of(registrationId, oAuth2User.getAttributes());

        // 4. 이메일 기반으로 기존 회원인지 확인 (소셜 계정 자동 연동)
        User user = userRepository.findByEmail(userInfo.getEmail()).orElse(null);
        if (user == null) {
            // 신규 회원: 새로 생성
            User newUser = new User();
            newUser.setEmail(userInfo.getEmail());
            newUser.setNickname(userInfo.getNickname());
            newUser.setProvider(registrationId.toUpperCase());  // "GOOGLE", "KAKAO", "NAVER"
            newUser.setProviderId(userInfo.getProviderId());
            userRepository.save(newUser);
        } else {
            // 기존 회원: provider 정보만 업데이트 (다른 소셜로 가입했던 경우 대비)
            user.setProvider(registrationId.toUpperCase());
            user.setProviderId(userInfo.getProviderId());
            userRepository.save(user);
        }

        return oAuth2User;
    }
}
```

이메일을 기준으로 기존 회원과 자동 연동하는 구조입니다. 구글로 가입한 사람이 나중에 네이버로 로그인해도 같은 계정이 연결됩니다.

### Step 5. OAuth2SuccessHandler -- JWT 발급 후 FE로 redirect

OAuth2 인증이 성공하면 호출되는 핸들러입니다. 여기서 JWT를 발급하고 프론트엔드로 리다이렉트합니다.

```java
// src/main/java/.../config/oauth/OAuth2SuccessHandler.java
package com.brainstorm.brainstorm_api.config.oauth;

import com.brainstorm.brainstorm_api.common.exception.InvalidCredentialsException;
import com.brainstorm.brainstorm_api.config.jwt.JwtProvider;
import com.brainstorm.brainstorm_api.entity.User;
import com.brainstorm.brainstorm_api.repository.UserRepository;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationSuccessHandler;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class OAuth2SuccessHandler extends SimpleUrlAuthenticationSuccessHandler {

    private final UserRepository userRepository;
    private final JwtProvider jwtProvider;

    @Value("${app.frontend-url}")
    private String appUrl;

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response,
                                        Authentication authentication) throws IOException, ServletException {
        OAuth2User oAuth2User = (OAuth2User) authentication.getPrincipal();
        OAuth2AuthenticationToken authToken = (OAuth2AuthenticationToken) authentication;

        // 어떤 소셜 플랫폼인지 확인 (google / kakao / naver)
        String registrationId = authToken.getAuthorizedClientRegistrationId();
        OAuth2UserInfo userInfo = OAuth2UserInfo.of(registrationId, oAuth2User.getAttributes());

        // CustomOAuth2UserService에서 이미 저장했으므로 반드시 존재
        User user = userRepository.findByEmail(userInfo.getEmail())
                .orElseThrow(() -> new InvalidCredentialsException("Not Found User"));

        // JWT 발급 후 FE의 callback 페이지로 redirect
        String token = jwtProvider.createToken(user.getId());
        response.sendRedirect(appUrl + "/oauth/callback?token=" + token);
    }
}
```

FE는 `/oauth/callback` 페이지에서 URL의 `token` 파라미터를 읽어 로컬 스토리지에 저장하면 됩니다. 예를 들면:

```javascript
// 프론트엔드 (React 등) - /oauth/callback 페이지
const params = new URLSearchParams(window.location.search);
const token = params.get("token");
if (token) {
    localStorage.setItem("accessToken", token);
    window.location.href = "/";  // 메인 페이지로 이동
}
```

### Step 6. SecurityConfig 변경

기존 JWT 전용이었던 SecurityConfig에 OAuth2 관련 설정을 추가합니다.

```java
// src/main/java/.../config/SecurityConfig.java
package com.brainstorm.brainstorm_api.config;

import com.brainstorm.brainstorm_api.config.jwt.JwtFilter;
import com.brainstorm.brainstorm_api.config.oauth.OAuth2SuccessHandler;
import com.brainstorm.brainstorm_api.service.CustomOAuth2UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableWebSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtFilter jwtFilter;
    private final CustomOAuth2UserService customOAuth2UserService;
    private final OAuth2SuccessHandler oAuth2SuccessHandler;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .cors(Customizer.withDefaults())
            // ★ IF_REQUIRED로 설정하는 이유는 아래 "주의할 점" 섹션 참고
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/signup", "/api/auth/login").permitAll()
                .requestMatchers("/docs/**", "/swagger-ui/**", "/v3/api-docs/**").permitAll()
                // OAuth2 관련 경로를 인증 없이 허용
                .requestMatchers("/oauth2/**", "/login/oauth2/**").permitAll()
                .requestMatchers("/h2-console/**").permitAll()
                .anyRequest().authenticated())
            // OAuth2 로그인 설정
            .oauth2Login(oauth -> oauth
                // 사용자 정보를 가져온 후 처리할 서비스 지정
                .userInfoEndpoint(userInfo -> userInfo.userService(customOAuth2UserService))
                // 인증 성공 후 JWT 발급 및 redirect 처리
                .successHandler(oAuth2SuccessHandler))
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

핵심 변경 사항 3가지를 요약하면 다음과 같습니다.

1. **`SessionCreationPolicy.IF_REQUIRED`**: 기존 `STATELESS`에서 변경 (이유는 아래 "주의할 점" 참고)
2. **`/oauth2/**`, `/login/oauth2/**` 경로 허용**: Spring Security가 사용하는 OAuth2 관련 엔드포인트
3. **`.oauth2Login()` 설정 추가**: `userInfoEndpoint`에 커스텀 서비스, `successHandler`에 JWT 발급 핸들러 등록

### Step 7. User 엔티티 변경

소셜 로그인 사용자는 비밀번호가 없으므로 `password` 컬럼을 nullable로 변경하고, `provider`/`providerId` 필드를 추가합니다.

```java
// src/main/java/.../entity/User.java
@Entity
@Table(name = "users")
@Getter @Setter @NoArgsConstructor
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(unique = true, nullable = false)
    private String email;

    @Column(nullable = false)
    private String nickname;

    @Column  // nullable = true (기본값) — 소셜 로그인 사용자는 비밀번호가 없음
    @JsonIgnore
    private String password;

    private String provider;    // "LOCAL", "GOOGLE", "KAKAO", "NAVER"
    private String providerId;  // 각 소셜 플랫폼에서 발급한 고유 ID

    // ... timestamps, factory method 등 생략
}
```

기존에 `nullable = false`였던 `password` 컬럼을 `nullable = true`(기본값)로 변경한 것이 핵심입니다. 로컬 회원가입 시에는 `provider`에 `"LOCAL"`이 저장됩니다.

## 주의할 점 (Gotchas & Troubleshooting)

---

### 1. `STATELESS` 세션 정책과 OAuth2 충돌

JWT 기반 인증에서는 보통 `SessionCreationPolicy.STATELESS`를 사용합니다. 그런데 OAuth2 로그인 흐름에서는 **`state` 파라미터 검증을 위해 세션이 필요**합니다.

`state`는 CSRF 공격을 방지하기 위한 랜덤 값으로, Spring Security가 인증 요청 시 생성해서 세션에 저장하고, 콜백에서 돌아온 `state` 값과 비교합니다. `STATELESS`로 설정하면 세션을 아예 생성하지 않으므로 이 검증이 실패합니다.

```
# STATELESS 상태에서 발생하는 에러 예시
[authorization_request_not_found]
```

**해결**: `IF_REQUIRED`로 설정하면 OAuth2 흐름에서만 필요시 세션을 생성하고, 일반 API 요청에서는 세션을 사용하지 않습니다.

```java
// STATELESS → IF_REQUIRED 로 변경
.sessionManagement(session ->
    session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
```

### 2. 카카오/네이버 응답의 중첩 구조 NPE

카카오의 `kakao_account`, 네이버의 `response` 같은 중첩 맵은 **권한 설정이나 사용자 동의 상태에 따라 `null`로 올 수 있습니다**. `null` 체크 없이 `.get()`을 연속 호출하면 NPE가 발생합니다.

```java
// 잘못된 예 - NPE 발생 가능
return (String) ((Map<String, Object>) attributes.get("kakao_account")).get("email");

// 올바른 예 - null 체크 후 접근
Map<String, Object> account = (Map<String, Object>) attributes.get("kakao_account");
if (account == null) return "";
return (String) account.get("email");
```

### 3. `client-authentication-method=client_secret_post` 누락

카카오와 네이버는 액세스 토큰 요청 시 `client_secret`을 HTTP 헤더(Basic Auth)가 아닌 **요청 body에 담아서 보내야** 합니다. Spring Security의 기본값은 `client_secret_basic`(HTTP Basic 헤더 방식)이므로, 이 설정을 명시하지 않으면 토큰 교환 단계에서 인증 오류가 발생합니다.

```properties
# 카카오, 네이버 모두 이 설정이 필수
spring.security.oauth2.client.registration.kakao.client-authentication-method=client_secret_post
spring.security.oauth2.client.registration.naver.client-authentication-method=client_secret_post
```

### 4. 구글 OAuth 클라이언트 만료

구글 Cloud Console에서 생성한 OAuth 클라이언트는 **테스트 모드(OAuth 동의 화면이 "테스트" 상태)일 때, 리프레시 토큰이 7일 후 만료**됩니다. 갑자기 로그인이 안 된다면 앱을 프로덕션 모드로 전환하거나, 테스트 사용자를 재등록해야 합니다.

### 5. 프론트엔드에서 소셜 로그인 시작하기

프론트엔드에서는 백엔드의 OAuth2 인증 시작 URL로 직접 이동시키면 됩니다.

```javascript
// 프론트엔드에서 소셜 로그인 버튼 클릭 시
const BACKEND_URL = "https://your-api.com";

// 구글 로그인
window.location.href = `${BACKEND_URL}/oauth2/authorization/google`;
// 카카오 로그인
window.location.href = `${BACKEND_URL}/oauth2/authorization/kakao`;
// 네이버 로그인
window.location.href = `${BACKEND_URL}/oauth2/authorization/naver`;
```

`/oauth2/authorization/{registrationId}` 경로는 Spring Security가 자동으로 생성하는 엔드포인트입니다. 별도의 Controller를 만들 필요가 없습니다.

## 정리 (Summary)

---

이번 포스트에서 다룬 핵심 내용을 요약합니다.

| 항목 | 설명 |
|------|------|
| **의존성** | `spring-boot-starter-oauth2-client` 하나면 충분 |
| **OAuth2UserInfo 인터페이스** | 플랫폼별 응답 구조 차이를 Factory 패턴으로 추상화 |
| **CustomOAuth2UserService** | `DefaultOAuth2UserService`를 상속, 사용자 DB 저장/연동 담당 |
| **OAuth2SuccessHandler** | 인증 성공 후 JWT 발급 + 프론트엔드 redirect |
| **SecurityConfig** | `IF_REQUIRED` 세션 정책, OAuth2 경로 permitAll, `oauth2Login()` 설정 |
| **application.properties** | 구글은 간단, 카카오/네이버는 provider URL 직접 지정 |

## 다음 단계 (Next Steps)

---

- **로그아웃 처리**: 소셜 로그인 세션 및 JWT 무효화 처리
- **계정 연동 고도화**: 이메일 기반 자동 연동의 보안 리스크 검토 (이메일 인증 여부 확인 등)
- **프로필 이미지**: 소셜 플랫폼에서 프로필 사진 URL도 함께 받아 저장
- **에러 핸들링**: OAuth2 인증 실패 시 `AuthenticationFailureHandler` 추가

## Reference

---

**프로젝트 소스 코드:**

- `brainstorm-api/src/main/java/.../config/oauth/OAuth2UserInfo.java`
- `brainstorm-api/src/main/java/.../config/oauth/GoogleOAuth2UserInfo.java`
- `brainstorm-api/src/main/java/.../config/oauth/KakaoOAuth2UserInfo.java`
- `brainstorm-api/src/main/java/.../config/oauth/NaverOAuth2UserInfo.java`
- `brainstorm-api/src/main/java/.../config/oauth/OAuth2SuccessHandler.java`
- `brainstorm-api/src/main/java/.../service/CustomOAuth2UserService.java`
- `brainstorm-api/src/main/java/.../config/SecurityConfig.java`

**공식 문서:**

- [Spring Security OAuth2 Login](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/index.html)
- [Spring Security OAuth2 Login - Advanced Configuration](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/advanced.html)
- [Spring Boot - OAuth2 Client Auto-configuration](https://docs.spring.io/spring-boot/reference/web/spring-security.html#web.security.oauth2.client)
- [카카오 로그인 REST API](https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api)
- [네이버 로그인 개발 가이드](https://developers.naver.com/docs/login/overview/overview.md)
