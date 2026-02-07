---
title: "[Spring] Cache 추상화 - @Cacheable, @CacheEvict, 캐시 전략"
categories:
  - Spring
tags:
  - [Spring, Cache, Cacheable, CacheEvict, Redis, Performance]
---

# Introduction

---

동일한 요청에 동일한 응답을 반복 계산하는 것은 낭비입니다. **캐시(Cache)**는 계산 결과를 저장해두고 재사용하여 성능을 높이는 기법입니다. Spring은 **캐시 추상화**를 제공하여 어노테이션만으로 캐싱 로직을 적용할 수 있습니다. 캐시 저장소(Redis, EhCache, Caffeine 등)를 바꿔도 비즈니스 코드는 수정할 필요가 없습니다.

이 글은 Spring Cache 추상화의 사용법과 실무 전략을 정리합니다.

# 1. 기본 설정

---

## 의존성 추가

```xml
<!-- Spring Boot -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
</dependency>

<!-- 캐시 구현체 (택1) -->
<!-- Caffeine (로컬 캐시) -->
<dependency>
    <groupId>com.github.ben-manes.caffeine</groupId>
    <artifactId>caffeine</artifactId>
</dependency>

<!-- Redis (분산 캐시) -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

## 캐시 활성화

```java
@SpringBootApplication
@EnableCaching  // 캐시 활성화
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

# 2. @Cacheable - 캐시 조회/저장

---

## 기본 사용법

```java
@Service
public class ProductService {

    @Cacheable("products")
    public Product findById(Long id) {
        // 첫 호출: DB 조회 후 캐시에 저장
        // 이후 호출: 캐시에서 반환 (이 메서드 실행 안 됨)
        System.out.println("DB 조회 실행");
        return productRepository.findById(id).orElseThrow();
    }
}
```

```text
findById(1L) → DB 조회 → 캐시 저장 (key=1)
findById(1L) → 캐시 조회 → 바로 반환 (DB 조회 안 함)
findById(2L) → DB 조회 → 캐시 저장 (key=2)
```

## 캐시 키 지정

```java
// 기본: 모든 파라미터를 키로 사용
@Cacheable("products")
public Product findById(Long id) { ... }

// 특정 파라미터만 키로
@Cacheable(value = "products", key = "#id")
public Product findById(Long id, boolean includeDetails) { ... }

// 복합 키
@Cacheable(value = "userOrders", key = "#userId + '_' + #status")
public List<Order> findOrders(Long userId, String status) { ... }

// 객체 속성
@Cacheable(value = "users", key = "#request.email")
public User findUser(UserRequest request) { ... }
```

## 조건부 캐싱

```java
// 조건이 true일 때만 캐시
@Cacheable(value = "products", condition = "#id > 10")
public Product findById(Long id) { ... }

// 결과가 조건을 만족할 때만 캐시
@Cacheable(value = "products", unless = "#result == null")
public Product findById(Long id) { ... }

// 결과 가격이 1000 미만이면 캐시 안 함
@Cacheable(value = "products", unless = "#result.price < 1000")
public Product findById(Long id) { ... }
```

# 3. @CacheEvict - 캐시 삭제

---

## 기본 사용법

```java
@CacheEvict(value = "products", key = "#id")
public void deleteProduct(Long id) {
    productRepository.deleteById(id);
}
```

데이터가 변경되면 캐시도 무효화해야 일관성이 유지됩니다.

## 전체 삭제

```java
@CacheEvict(value = "products", allEntries = true)
public void refreshAll() {
    // products 캐시 전체 삭제
}
```

## 메서드 실행 전 삭제

```java
@CacheEvict(value = "products", key = "#id", beforeInvocation = true)
public void deleteProduct(Long id) {
    // 메서드 실행 전에 캐시 삭제
    // 메서드가 실패해도 캐시는 이미 삭제됨
    productRepository.deleteById(id);
}
```

# 4. @CachePut - 캐시 갱신

---

항상 메서드를 실행하고 결과를 캐시에 저장합니다. `@Cacheable`과 달리 캐시가 있어도 메서드를 실행합니다.

```java
@CachePut(value = "products", key = "#product.id")
public Product update(Product product) {
    // 항상 실행되고, 결과를 캐시에 저장
    return productRepository.save(product);
}
```

```text
@Cacheable: 캐시 있으면 메서드 실행 안 함
@CachePut:  캐시 있어도 메서드 항상 실행, 결과를 캐시에 갱신
```

# 5. @Caching - 복합 연산

---

여러 캐시 연산을 한 메서드에 적용합니다.

```java
@Caching(
    cacheable = { @Cacheable(value = "products", key = "#id") },
    evict = { @CacheEvict(value = "productList", allEntries = true) }
)
public Product findById(Long id) { ... }

@Caching(evict = {
    @CacheEvict(value = "products", key = "#product.id"),
    @CacheEvict(value = "productList", allEntries = true),
    @CacheEvict(value = "productsByCategory", key = "#product.categoryId")
})
public void update(Product product) { ... }
```

# 6. CacheManager 설정

---

## Caffeine (로컬 캐시)

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    public CacheManager cacheManager() {
        CaffeineCacheManager cacheManager = new CaffeineCacheManager();
        cacheManager.setCaffeine(Caffeine.newBuilder()
            .maximumSize(1000)                // 최대 1000개 항목
            .expireAfterWrite(10, TimeUnit.MINUTES)  // 10분 후 만료
            .recordStats());                  // 통계 수집
        return cacheManager;
    }
}
```

## 캐시별 설정

```java
@Bean
public CacheManager cacheManager() {
    SimpleCacheManager cacheManager = new SimpleCacheManager();
    cacheManager.setCaches(List.of(
        buildCache("products", 500, 30, TimeUnit.MINUTES),
        buildCache("users", 1000, 60, TimeUnit.MINUTES),
        buildCache("configs", 100, 24, TimeUnit.HOURS)
    ));
    return cacheManager;
}

private CaffeineCache buildCache(String name, int maxSize, int duration, TimeUnit unit) {
    return new CaffeineCache(name,
        Caffeine.newBuilder()
            .maximumSize(maxSize)
            .expireAfterWrite(duration, unit)
            .build());
}
```

## Redis (분산 캐시)

```yaml
# application.yml
spring:
  redis:
    host: localhost
    port: 6379
  cache:
    type: redis
    redis:
      time-to-live: 600000  # 10분 (밀리초)
      cache-null-values: false
```

```java
@Configuration
@EnableCaching
public class RedisCacheConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        RedisCacheConfiguration config = RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(10))
            .disableCachingNullValues()
            .serializeValuesWith(
                RedisSerializationContext.SerializationPair.fromSerializer(
                    new GenericJackson2JsonRedisSerializer()
                )
            );

        return RedisCacheManager.builder(factory)
            .cacheDefaults(config)
            .withCacheConfiguration("products",
                config.entryTtl(Duration.ofMinutes(30)))
            .withCacheConfiguration("users",
                config.entryTtl(Duration.ofHours(1)))
            .build();
    }
}
```

# 7. 캐시 전략

---

## Cache-Aside (Lazy Loading)

```text
읽기: 캐시 확인 → 없으면 DB 조회 → 캐시 저장
쓰기: DB 저장 → 캐시 삭제 (또는 갱신)
```

가장 일반적인 패턴입니다. Spring `@Cacheable`이 이 방식입니다.

## Write-Through

```text
쓰기: 캐시 저장 → 동시에 DB 저장
읽기: 캐시에서 조회
```

쓰기 성능이 떨어지지만 일관성이 좋습니다.

## Write-Behind (Write-Back)

```text
쓰기: 캐시 저장 (DB 저장은 나중에 일괄)
읽기: 캐시에서 조회
```

쓰기 성능이 좋지만 데이터 유실 위험이 있습니다.

## TTL (Time To Live) 설정

```text
짧은 TTL (1~5분):
  - 자주 변하는 데이터
  - 실시간성이 중요한 데이터
  - 예: 주식 가격, 재고 수량

긴 TTL (1시간~1일):
  - 거의 안 변하는 데이터
  - 예: 상품 정보, 설정 값

영구 캐시 (TTL 없음):
  - 절대 안 변하는 데이터
  - 명시적 삭제만
```

# 8. 주의사항

---

## 같은 클래스 내 호출

```java
@Service
public class ProductService {

    @Cacheable("products")
    public Product findById(Long id) { ... }

    public Product findByIdWithDetails(Long id) {
        // ❌ 캐시 동작 안 함! (같은 클래스 내 호출)
        Product product = findById(id);
        return enrichWithDetails(product);
    }
}
```

Spring AOP는 프록시 기반이므로 **같은 클래스 내 호출은 프록시를 거치지 않습니다**. 해결 방법:

```java
// 방법 1: 별도 빈으로 분리
@Service
public class ProductCacheService {
    @Cacheable("products")
    public Product findById(Long id) { ... }
}

@Service
public class ProductService {
    @Autowired
    private ProductCacheService cacheService;

    public Product findByIdWithDetails(Long id) {
        Product product = cacheService.findById(id);  // ✅ 캐시 동작
        return enrichWithDetails(product);
    }
}
```

## Null 캐싱

```java
// null도 캐시됨 (의도한 경우)
@Cacheable("products")
public Product findById(Long id) {
    return productRepository.findById(id).orElse(null);
}

// null은 캐시 안 함
@Cacheable(value = "products", unless = "#result == null")
public Product findById(Long id) { ... }
```

## 직렬화

Redis 같은 분산 캐시는 객체를 직렬화해야 합니다.

```java
// Serializable 구현 필요
public class Product implements Serializable {
    private static final long serialVersionUID = 1L;
    // ...
}
```

## 캐시 일관성

```java
// 데이터 변경 시 관련 캐시 모두 삭제
@Transactional
@Caching(evict = {
    @CacheEvict(value = "products", key = "#product.id"),
    @CacheEvict(value = "productList", allEntries = true),
    @CacheEvict(value = "categoryProducts", key = "#product.categoryId")
})
public void update(Product product) {
    productRepository.save(product);
}
```

# 9. 정리

---

| 어노테이션 | 동작 |
|-----------|------|
| `@Cacheable` | 캐시 조회 → 없으면 실행 후 저장 |
| `@CacheEvict` | 캐시 삭제 |
| `@CachePut` | 항상 실행 후 캐시 갱신 |
| `@Caching` | 복합 연산 |
| `@EnableCaching` | 캐시 기능 활성화 |

| 속성 | 설명 |
|------|------|
| `value` | 캐시 이름 |
| `key` | 캐시 키 (SpEL) |
| `condition` | 캐싱 조건 |
| `unless` | 캐싱 제외 조건 |
| `allEntries` | 전체 삭제 여부 |

```text
핵심:
  Spring Cache = 캐시 로직을 어노테이션으로 분리.
  @Cacheable: 조회, @CacheEvict: 삭제, @CachePut: 갱신.
  같은 클래스 내 호출은 캐시 동작 안 함 (프록시).
  데이터 변경 시 관련 캐시 무효화 필수.
```

# Reference

---

- [Spring Cache Abstraction](https://docs.spring.io/spring-framework/reference/integration/cache.html)
- [Spring Boot Caching](https://docs.spring.io/spring-boot/docs/current/reference/html/io.html#io.caching)
- [Caffeine GitHub](https://github.com/ben-manes/caffeine)
