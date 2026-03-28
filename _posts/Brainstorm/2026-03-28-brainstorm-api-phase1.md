---
layout: single
title: "[Brainstorm API] Phase 1 구현기 - JWT 인증부터 공유 링크까지"
categories:
  - Brainstorm
tags: [Spring Boot, JWT, Spring Security, JPA, REST API]
toc: true
toc_sticky: true
date: 2026-03-28
---

# Introduction

---

브레인스토밍 협업 서비스의 백엔드 API를 Spring Boot로 구현하는 프로젝트를 진행했다. Phase 1 목표는 "혼자 또는 여럿이 방을 만들고, 키워드를 등록하고, 공유 링크로 참여할 수 있는 REST API"를 완성하는 것이었다. JWT 인증 시스템부터 Room CRUD, Keyword Like 토글, 공유 링크까지 순차적으로 쌓아올렸고, 이번 글에서는 각 기능이 왜 이런 구조로 만들어졌는지 실제 코드와 함께 정리한다.

**이 글을 읽고 나면** JWT 기반 인증 흐름, 소유자 권한 체크 패턴, 좋아요 토글 구현, 공유 링크 설계, 그리고 API 응답 통일 패턴을 직접 프로젝트에 적용할 수 있다.

# 사전 준비 (Prerequisites)

---

이 글의 코드를 이해하려면 아래 항목에 대한 기본 지식이 필요하다.

- **Java 17** 이상 (record, text block 등 최신 문법은 사용하지 않지만 17 기반)
- **Spring Boot 3.x** 프로젝트 생성 및 실행 경험
- **Spring Data JPA** 기본 개념 (Entity, Repository, `save()`, `findById()`)
- **REST API** 개념 (GET, POST, PATCH, DELETE)
- **Gradle** 빌드 도구 기본 사용법

**Tech Stack**

| 구분 | 기술 |
|------|------|
| Framework | Spring Boot 3.x, Java 17 |
| 인증 | Spring Security + JWT ([jjwt](https://github.com/jwtk/jjwt) 라이브러리) |
| DB 접근 | Spring Data JPA |
| DB | H2 (개발) / PostgreSQL (운영) |
| 문서화 | Springdoc OpenAPI (Swagger) |
| 배포 | Railway |

# 배경 (Problem & Context)

---

처음에는 단순해 보였다. "사용자가 로그인하고, 방을 만들고, 키워드를 올리면 된다"는 요구사항이었다. 그런데 실제로 구현하다 보면 아래 질문들이 연달아 튀어나온다.

- 로그인 정보를 어떻게 유지하지? 세션? 토큰?
- 방 수정/삭제는 누구나 할 수 있게 하면 안 되는데, 어떻게 검증하지?
- 키워드 조회 시 "내가 이미 좋아요를 눌렀는지" 여부를 어떻게 같이 내려주지?
- 공유 링크는 어떻게 만들고, 클릭하면 어떻게 자동으로 방에 들어가지?

이 질문들에 답하면서 Phase 1 구조가 만들어졌다. 아래 다이어그램은 전체 요청 흐름을 보여준다.

```
Client (React)
    │
    │ Authorization: Bearer {JWT}
    ▼
┌─────────────┐
│  JwtFilter  │ ← 토큰 검증 & SecurityContext에 userId 저장
└──────┬──────┘
       ▼
┌─────────────────────┐
│  SecurityConfig     │ ← 경로별 인증/비인증 판단
└──────┬──────────────┘
       ▼
┌─────────────────────┐
│  Controller         │ ← SecurityContext에서 userId 추출
└──────┬──────────────┘
       ▼
┌─────────────────────┐
│  Service            │ ← 비즈니스 로직 + 권한 체크
└──────┬──────────────┘
       ▼
┌─────────────────────┐
│  Repository (JPA)   │ ← DB 접근
└─────────────────────┘
```

# 핵심 기능별 구현

---

## 1. JWT 인증

### JWT란?

JWT(JSON Web Token)는 서버가 "이 사람은 인증된 사용자입니다"라는 정보를 토큰 안에 담아서 클라이언트에게 주는 방식이다. 서버는 토큰을 어딘가에 저장하지 않는다. 토큰을 받을 때마다 서명만 검증하면 된다. 이게 **Stateless 인증**의 핵심이다.

세션 방식과 비교하면 이렇다:

| 구분 | 세션 (Session) | JWT |
|------|---------------|-----|
| 저장 위치 | 서버 메모리/DB | 클라이언트 (보통 localStorage) |
| 서버 부담 | 세션 저장소 필요 | 없음 (서명 검증만) |
| 확장성 | 서버 늘어나면 세션 공유 필요 | 서버 간 공유 불필요 |
| 만료 관리 | 서버에서 직접 삭제 가능 | 토큰 자체에 만료 시간 포함 |

이 프로젝트에서는 REST API 서버이고 프론트엔드와 분리된 구조이므로 JWT를 선택했다.

### JwtProvider: 토큰 생성과 검증

`JwtProvider`는 JWT 토큰을 만들고, 검증하고, 안에 담긴 정보를 꺼내는 역할을 한다. [jjwt](https://github.com/jwtk/jjwt) 라이브러리를 사용했다.

```java
// src/main/java/com/brainstorm/brainstorm_api/config/jwt/JwtProvider.java

@Component
public class JwtProvider {

    private final SecretKey secret;   // HMAC 서명에 사용할 비밀키
    private final long expiration;    // 토큰 만료 시간 (밀리초)

    // application.properties에서 jwt.secret, jwt.expiration 값을 주입받음
    public JwtProvider(@Value("${jwt.secret}") String secret,
                       @Value("${jwt.expiration}") long expiration) {
        // 문자열 비밀키를 HMAC용 SecretKey 객체로 변환
        this.secret = Keys.hmacShaKeyFor(secret.getBytes());
        this.expiration = expiration;
    }

    // 토큰 생성: userId를 subject에 담아서 서명
    public String createToken(UUID userId) {
        Date now = new Date();
        Date expirationDate = new Date(now.getTime() + expiration);

        return Jwts.builder()
            .subject(String.valueOf(userId))   // 토큰의 "주인"이 누구인지
            .signWith(this.secret)             // 비밀키로 서명 (HMAC-SHA)
            .issuedAt(now)                     // 발급 시각
            .expiration(expirationDate)        // 만료 시각
            .compact();                        // 최종 JWT 문자열 생성
    }

    // 토큰에서 userId 추출
    public UUID getUserIdFromToken(String token) {
        String subject = Jwts.parser()
            .verifyWith(this.secret)           // 같은 비밀키로 서명 검증
            .build()
            .parseSignedClaims(token)          // 서명된 Claims 파싱
            .getPayload()
            .getSubject();                     // subject (= userId) 추출

        return UUID.fromString(subject);
    }

    // 토큰 유효성 검증 (서명 위조, 만료 등 체크)
    public boolean validateToken(String token) {
        try {
            Jwts.parser()
                .verifyWith(this.secret)
                .build()
                .parseSignedClaims(token);     // 파싱 성공 = 유효한 토큰
            return true;
        } catch (JwtException e) {
            return false;                      // 서명 불일치, 만료 등 → 무효
        }
    }
}
```

**코드 포인트:**
- `Keys.hmacShaKeyFor()`는 jjwt가 제공하는 유틸로, 문자열을 HMAC-SHA 알고리즘에 맞는 `SecretKey`로 변환한다. 비밀키 문자열은 최소 256비트(32바이트) 이상이어야 한다.
- `Jwts.builder()`와 `Jwts.parser()`는 jjwt 0.12.x 버전의 현행 API다. 이전 버전의 `Jwts.parserBuilder()`는 deprecated 되었으므로 주의하자.
- `parseSignedClaims()`는 서명된 JWT(JWS)를 파싱한다. 서명 검증에 실패하면 `JwtException`을 던진다.

### JwtFilter: 모든 요청을 가로채서 검증

Spring Security의 필터 체인에 커스텀 필터를 끼워 넣어서, 모든 HTTP 요청의 `Authorization` 헤더를 검사한다.

```java
// src/main/java/com/brainstorm/brainstorm_api/config/jwt/JwtFilter.java

@Component
@RequiredArgsConstructor
public class JwtFilter extends OncePerRequestFilter {
    // OncePerRequestFilter: 요청당 정확히 1번만 실행되는 것을 보장하는 필터

    private final JwtProvider jwtProvider;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
                                    throws ServletException, IOException {

        // Authorization 헤더에서 JWT 토큰을 추출하고 검증하는 흐름:
        // 1. "Authorization" 헤더 가져오기 (없으면 null → Optional.empty)
        // 2. "Bearer "로 시작하는지 확인
        // 3. "Bearer " 이후 토큰 문자열만 추출
        // 4. 토큰 서명/만료 검증
        // 5. 토큰에서 userId 추출
        // 6. SecurityContext에 인증 정보 저장
        Optional.ofNullable(request.getHeader("Authorization"))
            .filter(h -> h.startsWith("Bearer "))
            .map(h -> h.substring(7))
            .filter(jwtProvider::validateToken)
            .map(jwtProvider::getUserIdFromToken)
            .ifPresent(id -> {
                // UsernamePasswordAuthenticationToken(principal, credentials, authorities)
                // - principal: userId (Controller에서 getPrincipal()로 꺼냄)
                // - credentials: null (이미 토큰으로 인증 완료)
                // - authorities: 빈 리스트 (역할 기반 권한이 필요하면 여기에 추가)
                UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(id, null, List.of());
                SecurityContextHolder.getContext().setAuthentication(authentication);
            });

        // 반드시 호출! 이 줄이 없으면 요청이 Controller까지 전달되지 않음
        filterChain.doFilter(request, response);
    }
}
```

`Optional` 체이닝으로 각 단계 중 하나라도 실패하면 `SecurityContext`에 아무것도 저장되지 않는다. 그러면 Spring Security가 `authenticated()` 규칙에 의해 자동으로 403을 반환한다.

> **왜 `OncePerRequestFilter`를 상속할까?**
> 일반 `Filter`를 사용하면 서블릿 포워딩 등의 상황에서 같은 요청에 대해 필터가 여러 번 실행될 수 있다. `OncePerRequestFilter`는 요청당 정확히 1번만 실행되는 것을 보장해준다.

### SecurityConfig: 경로별 인증 규칙

`SecurityFilterChain` 빈을 직접 정의해서 Spring Security의 기본 설정을 커스터마이징한다.

```java
// src/main/java/com/brainstorm/brainstorm_api/config/SecurityConfig.java

@Configuration
@EnableWebSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtFilter jwtFilter;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            // JWT는 헤더로 전달하므로 CSRF 방어 불필요
            .csrf(csrf -> csrf.disable())
            // WebConfig에 설정한 CORS 규칙을 Security에도 적용
            .cors(Customizer.withDefaults())
            // JWT는 Stateless 인증 → 서버에 세션 저장 안 함
            .sessionManagement(session ->
                session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
            // 경로별 인증 규칙
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/auth/signup", "/api/auth/login").permitAll()
                .requestMatchers("/docs/**", "/swagger-ui/**", "/v3/api-docs/**").permitAll()
                .requestMatchers("/oauth2/**", "/login/oauth2/**").permitAll()
                .requestMatchers("/h2-console/**").permitAll()
                .anyRequest().authenticated())   // 나머지는 토큰 필수
            // JwtFilter를 Spring Security 기본 인증 필터 앞에 추가
            .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
```

**인증 흐름 요약:**

```
요청 들어옴
  → JwtFilter가 먼저 실행 (addFilterBefore로 앞에 배치)
  → 토큰 유효하면 SecurityContext에 인증 정보 저장
  → Spring Security가 SecurityContext 확인
  → authenticated() 규칙에 의해 통과/거부 판단
```

`permitAll()`로 지정한 경로(회원가입, 로그인, Swagger 등)는 토큰 없이도 접근 가능하다. 나머지 경로에서 `SecurityContext`가 비어 있으면 403 Forbidden이 반환된다.

---

## 2. Room CRUD + 소유자 권한

방을 만든 사람만 수정/삭제할 수 있다. 이 권한 체크를 어디서 할지가 중요한 설계 포인트다.

### 방 생성: 오너 자동 등록

```java
// src/main/java/com/brainstorm/brainstorm_api/service/RoomService.java

@Transactional
public Room save(RoomRequest roomRequest, UUID userId) {
    // JWT에서 추출한 userId로 User 조회
    User user = userRepository.findById(userId)
        .orElseThrow(() -> new NoSuchElementException("Not Found User"));

    Room newRoom = new Room();
    newRoom.setOwner(user);
    newRoom.setName(roomRequest.getName());
    newRoom.setTopic(roomRequest.getTopic());

    // 방 최대 인원 유효성 검증 (1~12명)
    int totalUserCount = roomRequest.getTotalUserCount();
    if (totalUserCount < 1 || totalUserCount > 12) {
        throw new IllegalStateException("Total user count have to be between 1 and 12");
    }
    newRoom.setTotalUserCount(totalUserCount);
    newRoom.setIsPublic(roomRequest.getIsPublic());

    Room savedRoom = roomRepository.save(newRoom);

    // 방 생성자를 OWNER 역할로 RoomMember에 자동 추가
    roomMemberService.save(savedRoom.getId(), savedRoom.getOwner().getId(), RoomRole.OWNER);
    return savedRoom;
}
```

**핵심:** `RoomRequest`에서 owner 필드를 제거하고, JWT 토큰에서 추출한 `userId`를 사용한다. 클라이언트가 임의로 `"owner": "다른사람UUID"`를 body에 담아서 보내도 무시된다.

### 방 삭제: 소유자 권한 체크

```java
public void delete(Long id, UUID userId) {
    User user = userRepository.findById(userId)
        .orElseThrow(() -> new NoSuchElementException("Not Found User"));
    Room room = roomRepository.findById(id)
        .orElseThrow(() -> new NoSuchElementException("Not Found Room"));

    // JWT에서 꺼낸 userId와 방의 owner_id 비교
    if (!user.getId().equals(room.getOwner().getId())) {
        throw new UnauthorizedAccessException("Unauthorized User");
    }

    roomRepository.deleteById(id);
}
```

Controller에서 `userId`를 받을 때는 `SecurityContext`에서 직접 꺼낸다:

```java
UUID userId = (UUID) SecurityContextHolder.getContext()
    .getAuthentication().getPrincipal();
```

이 값은 `JwtFilter`에서 `UsernamePasswordAuthenticationToken`의 principal로 저장한 바로 그 값이다. 요청 body에서 userId를 받지 않으므로, 클라이언트가 조작할 수 없다.

### Room 엔티티: shareToken과 타임스탬프 자동 생성

```java
// src/main/java/com/brainstorm/brainstorm_api/entity/Room.java

@Entity
@Getter @Setter
@NoArgsConstructor
public class Room {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne
    @JoinColumn(name = "owner_id")
    private User owner;

    // Room 삭제 시 연관 데이터도 함께 삭제
    @OneToMany(mappedBy = "room", cascade = CascadeType.REMOVE)
    @JsonIgnore
    private List<RoomMember> roomMembers;

    @OneToMany(mappedBy = "room", cascade = CascadeType.REMOVE)
    @JsonIgnore
    private List<Favorite> favorites;

    private String name;
    private String topic;
    private Integer totalUserCount;
    private Boolean isPublic;

    @Column(unique = true)
    private String shareToken;

    private LocalDateTime updatedAt;
    private LocalDateTime createdAt;

    @PrePersist
    void onCreate() {
        this.shareToken = UUID.randomUUID().toString();  // 방 생성 시 공유 토큰 자동 발급
        this.createdAt = LocalDateTime.now();
        this.updatedAt = this.createdAt;
    }

    @PreUpdate
    void onUpdate() {
        this.updatedAt = LocalDateTime.now();
    }
}
```

**`@PrePersist`와 `@PreUpdate`는 뭘까?**

JPA의 엔티티 라이프사이클 콜백이다. `@PrePersist`는 `save()`가 실제 DB에 INSERT되기 직전에, `@PreUpdate`는 UPDATE되기 직전에 자동 실행된다. 덕분에 서비스 코드에서 `shareToken`이나 `createdAt`을 직접 설정할 필요가 없다.

`cascade = CascadeType.REMOVE`는 Room을 삭제할 때 연관된 `RoomMember`, `Favorite` 레코드도 함께 삭제한다. 이 설정이 없으면 외래키 제약 조건 위반 오류가 발생한다 (아래 "주의할 점" 섹션에서 자세히 설명).

---

## 3. Keyword CRUD + 좋아요 토글

### 키워드 제한 (방당 유저 10개)

한 사용자가 하나의 방에 등록할 수 있는 키워드를 10개로 제한했다. 서비스 레이어에서 저장 전에 개수를 체크한다.

```java
// src/main/java/com/brainstorm/brainstorm_api/service/KeywordService.java

public Keyword save(Long roomId, UUID userId, KeywordRequest keywordRequest) {
    final int MAX_KEYWORD = 10;
    long keywordCount = keywordRepository.countByRoomIdAndUserId(roomId, userId);
    if (keywordCount >= MAX_KEYWORD) {
        throw new KeywordFullException(
            String.format("Keyword Exceed (> %d)", MAX_KEYWORD));
    }

    Room room = roomRepository.findById(roomId)
        .orElseThrow(() -> new NoSuchElementException("Not Found Room"));
    User user = userRepository.findById(userId)
        .orElseThrow(() -> new NoSuchElementException("Not Found User"));

    Keyword keyword = new Keyword();
    keyword.setRoom(room);
    keyword.setUser(user);
    keyword.setContent(keywordRequest.getContent());

    return keywordRepository.save(keyword);
}
```

`countByRoomIdAndUserId()`는 Spring Data JPA의 **메서드 이름 쿼리**다. 메서드 이름만 규칙에 맞게 작성하면 JPA가 자동으로 `SELECT COUNT(*) FROM keyword WHERE room_id = ? AND user_id = ?` 쿼리를 생성한다.

### 좋아요 토글 패턴

좋아요는 "있으면 취소, 없으면 추가"하는 토글 방식이다. 별도의 `KeywordLike` 테이블에 `(keyword_id, user_id)` 조합으로 저장한다.

```java
public KeywordResponse toggleLike(Long keywordId, UUID userId) {
    // 1. 현재 좋아요 상태 확인
    boolean exists = keywordLikeRepository.existsByKeywordIdAndUserId(keywordId, userId);

    Keyword keyword = keywordRepository.findById(keywordId)
        .orElseThrow(() -> new NoSuchElementException("Not Found Keyword"));
    User user = userRepository.findById(userId)
        .orElseThrow(() -> new NoSuchElementException("Not Found User"));

    // 2. 응답 DTO 구성
    KeywordResponse keywordResponse = new KeywordResponse();
    keywordResponse.setId(keywordId);
    keywordResponse.setLiked(!exists);       // 토글 후 상태를 미리 설정
    keywordResponse.setContent(keyword.getContent());
    keywordResponse.setNickname(user.getNickname());

    // 3. 토글 실행
    if (!exists) {
        // 좋아요가 없었으면 → 추가
        KeywordLike like = new KeywordLike();
        like.setKeyword(keyword);
        like.setUser(user);
        keywordLikeRepository.save(like);
    } else {
        // 좋아요가 있었으면 → 삭제 (취소)
        keywordLikeRepository
            .findByKeywordIdAndUserId(keywordId, userId)
            .ifPresent(keywordLikeRepository::delete);
    }

    // 4. 토글 후 최신 좋아요 수를 다시 조회
    keywordResponse.setLikeCount(keywordLikeRepository.countByKeywordId(keywordId));
    return keywordResponse;
}
```

**왜 이런 구조일까?**
- `existsBy...`로 먼저 확인하고, 결과에 따라 `save` 또는 `delete`를 실행한다.
- `setLiked(!exists)`로 토글 후의 상태를 응답에 담는다 (있었으면 취소 → false, 없었으면 추가 → true).
- `setLikeCount()`는 토글 실행 후에 다시 조회한다. 동시성 상황에서도 최신 카운트를 반영하기 위해서다.

키워드 목록 조회 시에는 각 키워드마다 총 좋아요 수(`likeCount`)와 내가 눌렀는지 여부(`liked`)를 같이 응답한다. 프론트엔드에서 별도의 API 호출 없이 하트 아이콘의 채움/빈 상태를 바로 렌더링할 수 있다.

### 키워드 삭제: 이중 권한 체크

키워드는 본인이 작성한 것만 삭제할 수 있되, **방 오너도 삭제할 수 있다**.

```java
public void delete(Long keywordId, UUID userId) {
    Keyword keyword = keywordRepository.findById(keywordId)
        .orElseThrow(() -> new NoSuchElementException("Not Found Keyword"));

    UUID keywordOwnerId = keyword.getUser().getId();   // 키워드 작성자
    UUID roomOwnerId = keyword.getRoom().getOwner().getId();  // 방 오너

    // 키워드 작성자 또는 방 오너만 삭제 가능
    if (!(userId.equals(keywordOwnerId) || userId.equals(roomOwnerId))) {
        throw new UnauthorizedAccessException("Access Denied");
    }

    keywordRepository.delete(keyword);
}
```

---

## 4. 공유 링크

Room 생성 시 `@PrePersist`에 의해 `shareToken`이 자동 생성된다. 오너가 재발급을 요청하면 새 UUID로 교체된다.

### 공유 링크로 방 참여

공유 링크를 통해 접속하면 자동으로 MEMBER 역할로 방에 추가된다.

```java
// src/main/java/com/brainstorm/brainstorm_api/service/ShareService.java

@Service
@RequiredArgsConstructor
public class ShareService {

    private final RoomRepository roomRepository;
    private final RoomMemberRepository roomMemberRepository;
    private final RoomMemberService roomMemberService;

    public Room joinRoomByShareToken(String token, UUID userId) {
        Room room = roomRepository.findByShareToken(token)
            .orElseThrow(() -> new NoSuchElementException("Not Found Room"));

        // 이미 멤버인지 확인 → 중복 가입 방지
        boolean exist = roomMemberRepository.existsByRoomIdAndUserId(room.getId(), userId);
        if (!exist) {
            roomMemberService.save(room.getId(), userId, RoomRole.MEMBER);
        }

        return room;
    }
}
```

### 공유 토큰 재발급

오너가 재발급을 요청하면 기존 토큰은 무효화되고, 새 UUID가 발급된다. 이전에 공유된 링크로는 더 이상 참여할 수 없다.

```java
// src/main/java/com/brainstorm/brainstorm_api/service/RoomService.java

public String getShareToken(Long roomId, UUID userId) {
    Room room = roomRepository.findById(roomId)
        .orElseThrow(() -> new NoSuchElementException("Not Found Room"));

    // 오너만 재발급 가능
    if (!room.getOwner().getId().equals(userId)) {
        throw new UnauthorizedAccessException("Only access for room owner");
    }

    // 새 UUID로 교체 → 기존 링크 무효화
    String shareToken = UUID.randomUUID().toString();
    room.setShareToken(shareToken);
    roomRepository.save(room);

    return appUrl + "/join/" + shareToken;
    // 예: https://brainstorm-app.com/join/550e8400-e29b-41d4-a716-446655440000
}
```

---

## 5. ApiResponse 통일 + 글로벌 예외 처리

### 왜 응답 형식을 통일할까?

프론트엔드 입장에서 생각해보자. API마다 응답 형태가 다르면 매번 파싱 로직을 다르게 짜야 한다. `{status, data, error}` 형태로 통일하면 프론트엔드에서 공통 응답 핸들러를 하나만 만들면 된다.

```java
// src/main/java/com/brainstorm/brainstorm_api/common/ApiResponse.java

@Getter
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)  // null 필드는 JSON에서 제외
public class ApiResponse<T> {

    private int status;
    private T data;
    private String error;

    // 성공 응답 (기본 200)
    public static <T> ApiResponse<T> success(T data) {
        return new ApiResponse<>(200, data, null);
    }

    // 성공 응답 (커스텀 상태 코드, 예: 201 Created)
    public static <T> ApiResponse<T> success(int status, T data) {
        return new ApiResponse<>(status, data, null);
    }

    // 에러 응답
    public static <T> ApiResponse<T> error(int status, String error) {
        return new ApiResponse<>(status, null, error);
    }
}
```

`@JsonInclude(NON_NULL)` 덕분에 성공 응답에는 `error` 필드가 아예 나오지 않고, 에러 응답에는 `data` 필드가 나오지 않는다.

**실제 응답 예시:**

```json
// 성공 시
{
  "status": 200,
  "data": { "id": 1, "name": "아이디어 방", "topic": "스타트업 아이디어" }
}

// 에러 시
{
  "status": 403,
  "error": "Unauthorized User"
}
```

### 글로벌 예외 처리: @RestControllerAdvice

예외 처리를 각 Controller에 흩뿌려 놓으면 관리가 어렵다. `@RestControllerAdvice`로 한 곳에 모아서 처리한다.

```java
// src/main/java/com/brainstorm/brainstorm_api/common/exception/GlobalExceptionHandler.java

@RestControllerAdvice
public class GlobalExceptionHandler {

    // 소유자가 아닌 사용자의 접근 시도
    @ExceptionHandler(UnauthorizedAccessException.class)
    public ResponseEntity<ApiResponse<Void>> handleUnauthorizedAccessException(
            UnauthorizedAccessException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
            .body(ApiResponse.error(403, e.getMessage()));
    }

    // DTO 유효성 검증 실패 (@NotBlank, @Email 등)
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(
            MethodArgumentNotValidException e) {
        // 실패한 필드명과 메시지를 조합
        String message = e.getBindingResult().getFieldErrors().stream()
            .map(error -> error.getField() + ": " + error.getDefaultMessage())
            .reduce((a, b) -> a + ", " + b)
            .orElse("Invalid Request");
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.error(400, message));
    }

    // 존재하지 않는 리소스 접근
    @ExceptionHandler(NoSuchElementException.class)
    public ResponseEntity<ApiResponse<Void>> handleNotFound(NoSuchElementException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .body(ApiResponse.error(404, e.getMessage()));
    }

    // 이메일 중복 등 데이터 무결성 위반
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ApiResponse<Void>> handleConflict(
            DataIntegrityViolationException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
            .body(ApiResponse.error(409, e.getMessage()));
    }

    // 그 외 모든 예외 → 500 (상세 메시지 노출하지 않음)
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleGeneral(Exception e) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ApiResponse.error(500, "Internal Error"));
    }
}
```

> **`@ExceptionHandler(Exception.class)`를 마지막에 두는 이유:**
> 구체적인 예외 핸들러가 먼저 매칭되고, 어떤 핸들러에도 걸리지 않는 예외만 이 catch-all 핸들러로 들어온다. 이때 `e.getMessage()`를 그대로 내리지 않고 "Internal Error"로 고정하는 이유는 보안이다. 내부 스택 트레이스나 DB 정보가 클라이언트에 노출되는 것을 방지한다.

**이 프로젝트에서 처리하는 예외 목록:**

| 예외 | HTTP 상태 | 발생 상황 |
|------|----------|----------|
| `UnauthorizedAccessException` | 403 Forbidden | 소유자가 아닌 사용자가 수정/삭제 시도 |
| `InvalidCredentialsException` | 401 Unauthorized | 로그인 비밀번호 불일치 |
| `MethodArgumentNotValidException` | 400 Bad Request | DTO 유효성 검증 실패 |
| `NoSuchElementException` | 404 Not Found | 존재하지 않는 Room/User/Keyword |
| `KeywordFullException` | 400 Bad Request | 키워드 10개 초과 |
| `RoomFullException` | 400 Bad Request | 방 인원 초과 |
| `DuplicateEmailException` | 409 Conflict | 이메일 중복 회원가입 |
| `DataIntegrityViolationException` | 409 Conflict | DB 제약 조건 위반 |

# 주의할 점 (Gotchas)

---

### 1. filterChain.doFilter()는 반드시 호출해야 한다

`JwtFilter`에서 토큰 검증이 실패해도 `filterChain.doFilter(request, response)`는 **무조건** 호출해야 한다. 이 줄이 없으면 요청이 Controller까지 전달되지 않는다. 토큰이 없는 요청도 일단 다음 필터로 넘기고, Spring Security가 `SecurityContext`를 확인해서 인증 여부를 판단하는 것이 올바른 흐름이다.

```java
// 잘못된 예 - 토큰이 없으면 요청이 멈춤
if (token == null) {
    response.setStatus(401);
    return;  // filterChain.doFilter() 호출 안 함!
}

// 올바른 예 - 항상 다음 필터로 넘김
// (토큰 검증 로직)
filterChain.doFilter(request, response);  // 이 줄은 조건 밖에 있어야 함
```

### 2. RoomRequest에서 owner 필드를 제거해야 보안이 생긴다

처음 설계에서는 `RoomRequest`에 `ownerId` 필드가 있었다. 그러면 클라이언트가 다른 사람의 UUID를 body에 담아서 보낼 수 있다. JWT 토큰에서 userId를 추출하는 방식으로 바꿔야 조작을 막을 수 있다.

```java
// Before: 클라이언트가 ownerId를 조작할 수 있음
public class RoomRequest {
    private UUID ownerId;  // 위험!
    private String name;
}

// After: 토큰에서 추출하므로 조작 불가
// RoomRequest에는 name, topic 등 순수 데이터만 남기고
// userId는 SecurityContext에서 가져온다
```

### 3. Cascade DELETE 설정이 없으면 외래키 오류가 발생한다

Room을 삭제할 때 연관된 `RoomMember`, `Keyword`, `Favorite` 레코드가 남아 있으면 외래키 제약 조건 위반 오류가 난다.

```
DataIntegrityViolationException:
  Cannot delete or update a parent row: a foreign key constraint fails
```

`@OneToMany(cascade = CascadeType.REMOVE)`를 추가해서 Room 삭제 시 연관 데이터도 함께 지워지도록 처리했다.

```java
@OneToMany(mappedBy = "room", cascade = CascadeType.REMOVE)
private List<RoomMember> roomMembers;
```

### 4. @Repository 어노테이션 누락 주의

`UserRepository`에 `@Repository`가 없어도 Spring Data JPA 환경에서는 대부분 동작한다. `JpaRepository`를 상속하면 Spring이 자동으로 빈으로 등록하기 때문이다. 하지만 특정 스캔 설정이나 모듈 구조에서 빈 등록이 안 되는 경우가 있었다. 명시적으로 `@Repository`를 붙여두면 이런 문제를 예방할 수 있다.

### 5. JJWT 버전별 API 차이

jjwt 라이브러리는 0.12.x 버전에서 API가 크게 바뀌었다. 구글 검색 시 나오는 예제가 구버전인 경우가 많으니 주의하자.

| 항목 | 구버전 (0.11.x 이하) | 현행 (0.12.x) |
|------|---------------------|---------------|
| 파서 생성 | `Jwts.parserBuilder()` | `Jwts.parser()` |
| 키 설정 | `.setSigningKey(key)` | `.verifyWith(key)` |
| Claims 파싱 | `.parseClaimsJws(token)` | `.parseSignedClaims(token)` |
| subject 설정 | `.setSubject(id)` | `.subject(id)` |

# 다음 단계 (Next Steps)

---

Phase 1에서는 기본적인 CRUD와 인증/권한 흐름을 완성했다. 이후 개선 방향은 다음과 같다.

- **실시간 기능**: WebSocket으로 키워드 실시간 공유 (현재는 새로고침 필요)
- **OAuth2 소셜 로그인 완성**: Google/Kakao/Naver 연동 코드가 이미 일부 작성됨
- **Refresh Token**: 현재 Access Token만 발급하는 구조 → Refresh Token 추가로 보안 강화
- **페이지네이션 일관성**: Room 목록은 페이지네이션이 있지만 Keyword는 없음

# 정리 (Key Takeaways)

---

1. **JWT 인증 흐름**: JwtProvider(생성/검증) → JwtFilter(요청 가로채기) → SecurityConfig(경로 규칙) 3개의 클래스가 인증 파이프라인을 구성한다.
2. **소유자 권한 체크**: DTO에서 userId를 받지 않고, SecurityContext에서 추출한 값만 신뢰한다.
3. **좋아요 토글**: `existsBy...`로 현재 상태를 확인하고, 결과에 따라 save/delete를 분기한다.
4. **공유 링크**: `@PrePersist`로 자동 생성하고, 재발급 시 UUID를 교체해서 이전 링크를 무효화한다.
5. **응답 통일**: `ApiResponse<T>` + `@RestControllerAdvice`로 모든 성공/에러 응답을 `{status, data, error}` 형태로 맞춘다.
6. **Cascade 설정**: 부모 엔티티 삭제 시 연관 데이터도 함께 삭제되도록 `CascadeType.REMOVE`를 설정해야 외래키 오류를 방지할 수 있다.

# Reference

---

- [jjwt GitHub - Java JWT 라이브러리](https://github.com/jwtk/jjwt)
- [Spring Security 공식 문서](https://docs.spring.io/spring-security/reference/)
- [Spring Data JPA 공식 문서](https://docs.spring.io/spring-data/jpa/reference/)
- 프로젝트 소스코드:
  - `config/jwt/JwtProvider.java` - JWT 토큰 생성/검증
  - `config/jwt/JwtFilter.java` - 요청별 토큰 검증 필터
  - `config/SecurityConfig.java` - Spring Security 설정
  - `service/RoomService.java` - Room CRUD + 권한 체크
  - `service/KeywordService.java` - Keyword CRUD + 좋아요 토글
  - `service/ShareService.java` - 공유 링크 참여
  - `common/ApiResponse.java` - 통일 응답 래퍼
  - `common/exception/GlobalExceptionHandler.java` - 글로벌 예외 처리
