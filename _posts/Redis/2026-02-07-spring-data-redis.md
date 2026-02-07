---
title: "[Redis] Spring Data Redis - 캐싱 전략과 RedisTemplate 활용"
categories:
  - Redis
tags:
  - [Redis, Spring, SpringDataRedis, Cache, RedisTemplate]
---

# Introduction

---

앞서 Redis의 자료구조를 살펴봤습니다. 이제 **Spring 애플리케이션에서 Redis를 어떻게 사용**하는지 알아봅니다. Spring Data Redis는 Redis와의 연동을 추상화하여, **RedisTemplate**으로 직접 조작하거나 **@Cacheable** 어노테이션으로 선언적 캐싱을 적용할 수 있습니다.

이 글은 Spring Data Redis의 설정과 실무에서 자주 쓰이는 캐싱 패턴을 정리합니다.

# 1. 기본 설정

---

## 의존성

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

## application.yml

```yaml
spring:
  redis:
    host: localhost
    port: 6379
    password: ""  # 비밀번호 없으면 생략
    timeout: 3000ms
    lettuce:
      pool:
        max-active: 8
        max-idle: 8
        min-idle: 2
```

## 연결 확인

```java
@SpringBootTest
class RedisConnectionTest {

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    @Test
    void 연결_테스트() {
        redisTemplate.opsForValue().set("test:key", "hello");
        String value = redisTemplate.opsForValue().get("test:key");
        assertThat(value).isEqualTo("hello");
    }
}
```

# 2. RedisTemplate

---

## 구조

```text
RedisTemplate<K, V>
├── opsForValue()   → String 타입 (ValueOperations)
├── opsForHash()    → Hash 타입 (HashOperations)
├── opsForList()    → List 타입 (ListOperations)
├── opsForSet()     → Set 타입 (SetOperations)
└── opsForZSet()    → Sorted Set 타입 (ZSetOperations)
```

## 설정 (직렬화)

```java
@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);

        // 키는 String으로
        template.setKeySerializer(new StringRedisSerializer());
        template.setHashKeySerializer(new StringRedisSerializer());

        // 값은 JSON으로 (객체 저장용)
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        template.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());

        return template;
    }
}
```

## String 연산

```java
@Service
@RequiredArgsConstructor
public class CacheService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 저장
    public void set(String key, Object value, Duration ttl) {
        redisTemplate.opsForValue().set(key, value, ttl);
    }

    // 조회
    public Object get(String key) {
        return redisTemplate.opsForValue().get(key);
    }

    // 삭제
    public void delete(String key) {
        redisTemplate.delete(key);
    }

    // 존재 확인
    public boolean exists(String key) {
        return Boolean.TRUE.equals(redisTemplate.hasKey(key));
    }

    // TTL 조회
    public Long getTtl(String key) {
        return redisTemplate.getExpire(key, TimeUnit.SECONDS);
    }
}
```

## Hash 연산

```java
@Service
@RequiredArgsConstructor
public class UserCacheService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 사용자 정보 저장
    public void saveUser(User user) {
        String key = "user:" + user.getId();
        HashOperations<String, String, Object> ops = redisTemplate.opsForHash();

        ops.put(key, "name", user.getName());
        ops.put(key, "email", user.getEmail());
        ops.put(key, "age", user.getAge());

        redisTemplate.expire(key, Duration.ofHours(1));
    }

    // 필드 조회
    public String getUserName(Long userId) {
        String key = "user:" + userId;
        return (String) redisTemplate.opsForHash().get(key, "name");
    }

    // 전체 조회
    public Map<String, Object> getUser(Long userId) {
        String key = "user:" + userId;
        return redisTemplate.<String, Object>opsForHash().entries(key);
    }
}
```

## List 연산 (큐)

```java
@Service
@RequiredArgsConstructor
public class QueueService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 큐에 추가
    public void enqueue(String queueName, Object item) {
        redisTemplate.opsForList().rightPush(queueName, item);
    }

    // 큐에서 꺼내기
    public Object dequeue(String queueName) {
        return redisTemplate.opsForList().leftPop(queueName);
    }

    // 블로킹 대기 (타임아웃)
    public Object dequeueBlocking(String queueName, Duration timeout) {
        return redisTemplate.opsForList().leftPop(queueName, timeout);
    }

    // 큐 길이
    public Long size(String queueName) {
        return redisTemplate.opsForList().size(queueName);
    }
}
```

## Set 연산

```java
@Service
@RequiredArgsConstructor
public class LikeService {

    private final RedisTemplate<String, Object> redisTemplate;

    // 좋아요 추가
    public void like(Long postId, Long userId) {
        String key = "post:" + postId + ":likes";
        redisTemplate.opsForSet().add(key, userId);
    }

    // 좋아요 취소
    public void unlike(Long postId, Long userId) {
        String key = "post:" + postId + ":likes";
        redisTemplate.opsForSet().remove(key, userId);
    }

    // 좋아요 여부
    public boolean isLiked(Long postId, Long userId) {
        String key = "post:" + postId + ":likes";
        return Boolean.TRUE.equals(redisTemplate.opsForSet().isMember(key, userId));
    }

    // 좋아요 수
    public Long likeCount(Long postId) {
        String key = "post:" + postId + ":likes";
        return redisTemplate.opsForSet().size(key);
    }
}
```

## Sorted Set 연산 (리더보드)

```java
@Service
@RequiredArgsConstructor
public class LeaderboardService {

    private final RedisTemplate<String, Object> redisTemplate;
    private static final String KEY = "game:leaderboard";

    // 점수 갱신
    public void updateScore(String playerId, double score) {
        redisTemplate.opsForZSet().add(KEY, playerId, score);
    }

    // 점수 증가
    public Double incrementScore(String playerId, double delta) {
        return redisTemplate.opsForZSet().incrementScore(KEY, playerId, delta);
    }

    // 순위 조회 (높은 점수 기준, 0부터 시작)
    public Long getRank(String playerId) {
        return redisTemplate.opsForZSet().reverseRank(KEY, playerId);
    }

    // 상위 N명
    public Set<ZSetOperations.TypedTuple<Object>> getTopN(int n) {
        return redisTemplate.opsForZSet().reverseRangeWithScores(KEY, 0, n - 1);
    }
}
```

# 3. @Cacheable - 선언적 캐싱

---

Spring Cache 추상화와 Redis를 조합하면 어노테이션만으로 캐싱을 적용할 수 있습니다.

## 설정

```java
@Configuration
@EnableCaching
public class RedisCacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration config = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(10))  // 기본 TTL
            .disableCachingNullValues()         // null 캐싱 안 함
            .serializeKeysWith(
                RedisSerializationContext.SerializationPair
                    .fromSerializer(new StringRedisSerializer()))
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair
                    .fromSerializer(new GenericJackson2JsonRedisSerializer()));

        // 캐시별 TTL 설정
        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "products", config.entryTtl(Duration.ofMinutes(30)),
            "users", config.entryTtl(Duration.ofHours(1)),
            "configs", config.entryTtl(Duration.ofDays(1))
        );

        return RedisCacheManager.builder(factory)
            .cacheDefaults(config)
            .withInitialCacheConfigurations(cacheConfigs)
            .build();
    }
}
```

## 사용법

```java
@Service
@RequiredArgsConstructor
public class ProductService {

    private final ProductRepository productRepository;

    // 조회 → 캐시에 있으면 바로 반환, 없으면 DB 조회 후 캐시
    @Cacheable(value = "products", key = "#id")
    public Product findById(Long id) {
        log.info("DB에서 조회: {}", id);
        return productRepository.findById(id).orElseThrow();
    }

    // 수정 → 캐시 갱신
    @CachePut(value = "products", key = "#product.id")
    public Product update(Product product) {
        return productRepository.save(product);
    }

    // 삭제 → 캐시 제거
    @CacheEvict(value = "products", key = "#id")
    public void delete(Long id) {
        productRepository.deleteById(id);
    }

    // 전체 캐시 제거
    @CacheEvict(value = "products", allEntries = true)
    public void clearCache() {
        log.info("products 캐시 전체 삭제");
    }
}
```

## 조건부 캐싱

```java
// 가격이 10000 이상일 때만 캐시
@Cacheable(value = "products", key = "#id", condition = "#id > 0")
public Product findById(Long id) { ... }

// 결과가 null이면 캐시 안 함
@Cacheable(value = "products", key = "#id", unless = "#result == null")
public Product findById(Long id) { ... }
```

## 복합 키

```java
@Cacheable(value = "userOrders", key = "#userId + ':' + #status")
public List<Order> findOrders(Long userId, String status) { ... }

// 또는 SpEL 표현식
@Cacheable(value = "products", key = "T(java.lang.String).format('%d:%s', #categoryId, #sort)")
public List<Product> findByCategory(Long categoryId, String sort) { ... }
```

# 4. 캐싱 패턴

---

## Cache-Aside (Lazy Loading)

가장 일반적인 패턴입니다.

```java
@Service
@RequiredArgsConstructor
public class ProductService {

    private final RedisTemplate<String, Object> redisTemplate;
    private final ProductRepository productRepository;

    public Product findById(Long id) {
        String key = "product:" + id;

        // 1. 캐시 조회
        Product cached = (Product) redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return cached;
        }

        // 2. 캐시 없으면 DB 조회
        Product product = productRepository.findById(id).orElseThrow();

        // 3. 캐시에 저장
        redisTemplate.opsForValue().set(key, product, Duration.ofMinutes(30));

        return product;
    }

    public void update(Product product) {
        // DB 저장
        productRepository.save(product);

        // 캐시 삭제 (다음 조회 시 새 데이터로 캐시)
        String key = "product:" + product.getId();
        redisTemplate.delete(key);
    }
}
```

## Write-Through

쓰기 시 캐시와 DB를 동시에 갱신합니다.

```java
public Product update(Product product) {
    // DB 저장
    Product saved = productRepository.save(product);

    // 캐시도 갱신
    String key = "product:" + saved.getId();
    redisTemplate.opsForValue().set(key, saved, Duration.ofMinutes(30));

    return saved;
}
```

## Cache Stampede 방지

캐시가 만료될 때 동시에 많은 요청이 DB를 조회하는 문제를 방지합니다.

```java
@Service
@RequiredArgsConstructor
public class ProductService {

    private final RedisTemplate<String, Object> redisTemplate;
    private final ProductRepository productRepository;

    public Product findById(Long id) {
        String key = "product:" + id;
        String lockKey = "lock:" + key;

        Product cached = (Product) redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return cached;
        }

        // 락 획득 시도
        Boolean acquired = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, "1", Duration.ofSeconds(10));

        if (Boolean.TRUE.equals(acquired)) {
            try {
                // 락 획득 성공 → DB 조회 후 캐시 저장
                Product product = productRepository.findById(id).orElseThrow();
                redisTemplate.opsForValue().set(key, product, Duration.ofMinutes(30));
                return product;
            } finally {
                redisTemplate.delete(lockKey);
            }
        } else {
            // 락 획득 실패 → 잠시 대기 후 재시도
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return findById(id);  // 재귀 호출 (실제로는 재시도 횟수 제한 필요)
        }
    }
}
```

# 5. TTL 전략

---

## 시간 기반 TTL

```java
// 고정 TTL
redisTemplate.opsForValue().set(key, value, Duration.ofMinutes(30));

// 동적 TTL (비즈니스 로직에 따라)
public Duration calculateTtl(Product product) {
    if (product.isHotItem()) {
        return Duration.ofMinutes(5);   // 인기 상품은 짧게
    } else {
        return Duration.ofHours(1);     // 일반 상품은 길게
    }
}
```

## Sliding Window TTL

조회할 때마다 TTL 연장합니다.

```java
public Product findById(Long id) {
    String key = "product:" + id;
    Product product = (Product) redisTemplate.opsForValue().get(key);

    if (product != null) {
        // 조회할 때마다 TTL 갱신
        redisTemplate.expire(key, Duration.ofMinutes(30));
    }

    return product;
}
```

## TTL 설계 기준

```text
짧은 TTL (1~5분):
  - 실시간성 중요 (재고, 가격)
  - 자주 변경되는 데이터
  - Cache Hit 감소 → DB 부하 증가

긴 TTL (1시간~1일):
  - 거의 안 변하는 데이터 (상품 정보, 설정)
  - Cache Hit 증가 → DB 부하 감소
  - 데이터 불일치 가능성 증가

권장:
  - 조회 빈도 ÷ 변경 빈도 = 적정 TTL 기준
  - 중요 데이터는 명시적 캐시 무효화 (@CacheEvict)
```

# 6. 실무 고려사항

---

## 키 네이밍 컨벤션

```text
권장: {서비스}:{엔티티}:{id}:{서브키}

예시:
  user:profile:123           - 사용자 123 프로필
  product:detail:456         - 상품 456 상세
  cart:user:123              - 사용자 123 장바구니
  session:token:abc123       - 세션 토큰
  rate:limit:user:123        - 사용자 123 rate limit
```

## 직렬화 선택

```text
StringRedisSerializer:
  - 문자열만 저장
  - 가장 빠름
  - 디버깅 쉬움

GenericJackson2JsonRedisSerializer:
  - 객체를 JSON으로 저장
  - 타입 정보 포함 (@class 필드)
  - 다른 언어에서도 읽기 쉬움

JdkSerializationRedisSerializer (기본값):
  - Java 직렬화
  - 클래스 변경에 취약
  - 권장하지 않음
```

## 연결 풀 설정

```yaml
spring:
  redis:
    lettuce:
      pool:
        max-active: 16       # 최대 연결 수
        max-idle: 8          # 최대 유휴 연결
        min-idle: 4          # 최소 유휴 연결
        max-wait: 1000ms     # 연결 대기 시간
```

## 장애 대응

```java
@Service
@RequiredArgsConstructor
public class ResilientCacheService {

    private final RedisTemplate<String, Object> redisTemplate;
    private final ProductRepository productRepository;

    public Product findById(Long id) {
        try {
            Product cached = (Product) redisTemplate.opsForValue()
                .get("product:" + id);
            if (cached != null) {
                return cached;
            }
        } catch (Exception e) {
            // Redis 장애 시 로그만 남기고 DB 조회
            log.warn("Redis 조회 실패, DB fallback: {}", e.getMessage());
        }

        // DB 조회
        Product product = productRepository.findById(id).orElseThrow();

        try {
            redisTemplate.opsForValue()
                .set("product:" + id, product, Duration.ofMinutes(30));
        } catch (Exception e) {
            log.warn("Redis 저장 실패: {}", e.getMessage());
        }

        return product;
    }
}
```

# 7. 정리

---

| 방식 | 장점 | 단점 |
|------|------|------|
| **RedisTemplate** | 세밀한 제어, 모든 자료구조 지원 | 코드량 많음 |
| **@Cacheable** | 간단, 선언적 | 커스터마이징 제한 |

| 패턴 | 설명 |
|------|------|
| **Cache-Aside** | 조회 시 캐시 → 없으면 DB → 캐시 저장 |
| **Write-Through** | 쓰기 시 DB + 캐시 동시 갱신 |
| **Cache Stampede 방지** | 락으로 동시 DB 조회 방지 |

```text
핵심:
  Spring Data Redis = RedisTemplate + @Cacheable.
  직렬화 설정 필수 (JSON 권장).
  TTL은 데이터 특성에 맞게 설계.
  Redis 장애 시 fallback 처리 필요.
```

# Reference

---

- [Spring Data Redis Documentation](https://docs.spring.io/spring-data/redis/docs/current/reference/html/)
- [Spring Cache Abstraction](https://docs.spring.io/spring-framework/reference/integration/cache.html)
- [Lettuce Reference](https://lettuce.io/core/release/reference/)
