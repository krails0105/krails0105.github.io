---
title: "[StockInfo] 07. JPA Entity와 Repository - 데이터베이스 접근"
categories:
  - StockInfo
tags:
  - [Java, Spring, JPA, Database]
---

# Introduction

---

Stock-Info는 수집한 뉴스를 **데이터베이스에 저장**합니다. Java 객체를 DB 테이블에 저장하려면 어떻게 해야 할까요?

**JPA(Java Persistence API)**는 Java 객체와 DB 테이블을 매핑하여, SQL 없이도 데이터를 저장/조회할 수 있게 합니다.

# JPA란?

---

## ORM (Object-Relational Mapping)

객체와 관계형 DB 테이블을 자동으로 매핑합니다.

```
┌─────────────────┐        ┌─────────────────┐
│   Java 객체     │  JPA   │   DB 테이블     │
│                 │ ←────→ │                 │
│ class Article   │        │ articles 테이블 │
│   Long id       │        │   id BIGINT     │
│   String title  │        │   title VARCHAR │
│   String url    │        │   url VARCHAR   │
└─────────────────┘        └─────────────────┘
```

## JPA의 장점

1. **SQL 작성 최소화**: 기본 CRUD는 자동 생성
2. **타입 안전성**: 컴파일 시점에 오류 발견
3. **DB 독립성**: DB 종류 변경 시 코드 수정 최소화
4. **생산성**: 반복적인 SQL 작업 제거

## Spring Data JPA

Spring이 JPA를 더 편하게 쓸 수 있게 감싼 것입니다.

```java
// 인터페이스만 정의하면 구현체는 Spring이 자동 생성!
public interface ArticleRepository extends JpaRepository<Article, Long> {
    List<Article> findByTitle(String title);  // 메서드명으로 쿼리 생성
}
```

# Entity 클래스

---

## 기본 어노테이션

```java
@Entity                    // JPA Entity임을 선언
@Table(name = "articles")  // 테이블명 지정 (생략 시 클래스명 사용)
@Getter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Article {

    @Id                                 // Primary Key
    @GeneratedValue(strategy = GenerationType.IDENTITY)  // 자동 증가
    private Long id;

    @Column(nullable = false, length = 500)  // 컬럼 속성
    private String title;

    @Column(nullable = false, length = 2048)
    private String url;

    @Column(nullable = false)
    private LocalDateTime publishedAt;
}
```

## 주요 어노테이션 설명

| 어노테이션 | 역할 |
|-----------|------|
| @Entity | JPA가 관리하는 Entity 클래스 |
| @Table | 매핑할 테이블명 |
| @Id | Primary Key 필드 |
| @GeneratedValue | PK 생성 전략 |
| @Column | 컬럼 속성 (nullable, length 등) |

## @GeneratedValue 전략

| 전략 | 설명 | 적합한 DB |
|------|------|----------|
| IDENTITY | DB의 AUTO_INCREMENT | MySQL, H2 |
| SEQUENCE | 시퀀스 사용 | PostgreSQL, Oracle |
| TABLE | 별도 테이블로 관리 | 모든 DB |
| AUTO | DB에 맞게 자동 선택 | 개발용 |

# Stock-Info의 Entity

---

## RawNewsArticle (원본 뉴스)

RSS에서 수집한 원본 뉴스를 저장합니다.

```java
/**
 * 원본 뉴스 기사 엔티티.
 *
 * RSS 피드에서 수집한 가공 전 뉴스를 저장합니다.
 * 처리 상태(PENDING/PROCESSED/FAILED)를 관리합니다.
 */
@Entity
@Table(
    name = "raw_news_articles",
    indexes = {
        @Index(name = "idx_raw_url", columnList = "url", unique = true),
        @Index(name = "idx_raw_status", columnList = "status"),
        @Index(name = "idx_raw_published", columnList = "publishedAt")
    })
@Getter
@Builder(toBuilder = true)
@NoArgsConstructor
@AllArgsConstructor
public class RawNewsArticle {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(nullable = false, length = 2048, unique = true)
    private String url;

    @Column(nullable = false, length = 100)
    private String publisher;

    @Column(nullable = false)
    private LocalDateTime publishedAt;

    @Enumerated(EnumType.STRING)   // Enum을 문자열로 저장
    @Column(nullable = false, length = 20)
    private ProcessingStatus status;

    @Column(nullable = false)
    private LocalDateTime collectedAt;

    @Column
    private LocalDateTime processedAt;

    /**
     * 처리 상태 Enum
     */
    public enum ProcessingStatus {
        PENDING,     // 대기 중
        PROCESSED,   // 처리 완료
        FAILED       // 처리 실패
    }
}
```

### 코드 분석

**@Index**

자주 검색하는 컬럼에 인덱스를 생성합니다.

```java
@Index(name = "idx_raw_url", columnList = "url", unique = true)
```

- `name`: 인덱스명
- `columnList`: 인덱스 대상 컬럼
- `unique`: 유니크 인덱스 여부

**@Enumerated**

Java Enum을 DB에 저장하는 방식을 지정합니다.

```java
@Enumerated(EnumType.STRING)  // 문자열로 저장 ("PENDING")
private ProcessingStatus status;

// EnumType.ORDINAL은 숫자로 저장 (0, 1, 2) - 권장하지 않음
```

**@Builder(toBuilder = true)**

기존 객체를 기반으로 새 객체를 생성할 수 있습니다.

```java
// 상태 변경 시 새 객체 생성
RawNewsArticle updated = article.toBuilder()
    .status(ProcessingStatus.PROCESSED)
    .processedAt(LocalDateTime.now())
    .build();
```

## ProcessedNewsArticle (처리된 뉴스)

태깅과 클러스터링이 완료된 뉴스입니다.

```java
/**
 * 처리 완료된 뉴스 기사 엔티티.
 *
 * 태깅, 클러스터링이 완료된 뉴스를 저장하며,
 * 종목/섹터 연관 정보와 중요도를 포함합니다.
 */
@Entity
@Table(
    name = "processed_news_articles",
    indexes = {
        @Index(name = "idx_processed_stock", columnList = "stockCode"),
        @Index(name = "idx_processed_sector", columnList = "sectorName"),
        @Index(name = "idx_processed_cluster", columnList = "clusterId"),
        @Index(name = "idx_processed_published", columnList = "publishedAt"),
        @Index(name = "idx_processed_representative",
               columnList = "isClusterRepresentative")
    })
@Getter
@Builder(toBuilder = true)
@NoArgsConstructor
@AllArgsConstructor
public class ProcessedNewsArticle {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long rawArticleId;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(nullable = false, length = 100)
    private String publisher;

    @Column(nullable = false, length = 2048)
    private String url;

    @Column(nullable = false)
    private LocalDateTime publishedAt;

    // 태그 목록 (별도 테이블)
    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(
        name = "news_tags",
        joinColumns = @JoinColumn(name = "article_id"))
    @Enumerated(EnumType.STRING)
    @Column(name = "tag")
    private List<NewsTag> tags;

    // 중요도
    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private NewsImportance importance;

    // 연관 종목 코드
    @Column(length = 20)
    private String stockCode;

    // 연관 섹터명
    @Column(length = 50)
    private String sectorName;

    // 클러스터 ID (유사 뉴스 그룹)
    @Column(length = 50)
    private String clusterId;

    // 클러스터 대표 여부
    @Column
    private Boolean isClusterRepresentative;

    @Column(nullable = false)
    private LocalDateTime processedAt;

    /**
     * 뉴스 태그 Enum (7종)
     */
    public enum NewsTag {
        EARNINGS,          // 실적 발표
        CONTRACT,          // 대형 계약
        BUYBACK_DIVIDEND,  // 자사주/배당
        REGULATION_RISK,   // 규제 리스크
        MA,                // 인수합병
        INDUSTRY,          // 산업 동향
        RUMOR              // 루머
    }

    /**
     * 뉴스 중요도 Enum
     */
    public enum NewsImportance {
        HIGH,
        MEDIUM,
        LOW
    }
}
```

### 코드 분석

**@ElementCollection**

Entity가 아닌 값 타입(Enum, 기본 타입)의 컬렉션을 매핑합니다.

```java
@ElementCollection(fetch = FetchType.EAGER)
@CollectionTable(
    name = "news_tags",                          // 별도 테이블명
    joinColumns = @JoinColumn(name = "article_id"))  // FK
@Enumerated(EnumType.STRING)
@Column(name = "tag")
private List<NewsTag> tags;
```

생성되는 테이블:

```sql
-- processed_news_articles 테이블
CREATE TABLE processed_news_articles (
    id BIGINT PRIMARY KEY,
    title VARCHAR(500),
    ...
);

-- news_tags 테이블 (별도)
CREATE TABLE news_tags (
    article_id BIGINT,
    tag VARCHAR(255),
    FOREIGN KEY (article_id) REFERENCES processed_news_articles(id)
);
```

# Repository 인터페이스

---

## 기본 사용법

```java
@Repository
public interface ArticleRepository extends JpaRepository<Article, Long> {
    // 기본 CRUD 메서드는 JpaRepository가 제공
    // save(), findById(), findAll(), delete() 등
}
```

## Stock-Info의 Repository

### RawNewsArticleRepository

```java
/**
 * 원본 뉴스 기사 저장소.
 */
@Repository
public interface RawNewsArticleRepository
        extends JpaRepository<RawNewsArticle, Long> {

    /**
     * URL로 중복 체크
     */
    boolean existsByUrl(String url);

    /**
     * 처리 대기 중인 뉴스 조회
     */
    List<RawNewsArticle> findByStatus(ProcessingStatus status);

    /**
     * 처리 대기 중인 뉴스 조회 (제한)
     */
    List<RawNewsArticle> findByStatusOrderByPublishedAtAsc(
        ProcessingStatus status,
        Pageable pageable);
}
```

### ProcessedNewsArticleRepository

```java
/**
 * 처리 완료된 뉴스 기사 저장소.
 */
@Repository
public interface ProcessedNewsArticleRepository
        extends JpaRepository<ProcessedNewsArticle, Long> {

    /**
     * 종목 관련 뉴스 조회 (특정 시점 이후)
     */
    List<ProcessedNewsArticle> findByStockCodeAndPublishedAtAfter(
        String stockCode,
        LocalDateTime after);

    /**
     * 섹터 관련 뉴스 조회
     */
    List<ProcessedNewsArticle> findBySectorNameAndPublishedAtAfter(
        String sectorName,
        LocalDateTime after);

    /**
     * 클러스터 대표 뉴스 조회
     */
    @Query("SELECT p FROM ProcessedNewsArticle p " +
           "WHERE p.clusterId = :clusterId " +
           "AND p.isClusterRepresentative = true")
    Optional<ProcessedNewsArticle> findClusterRepresentative(
        @Param("clusterId") String clusterId);

    /**
     * 최근 뉴스 조회 (중요도/발행일 정렬)
     */
    @Query("SELECT p FROM ProcessedNewsArticle p " +
           "WHERE p.publishedAt > :since " +
           "ORDER BY p.importance ASC, p.publishedAt DESC")
    List<ProcessedNewsArticle> findRecentNews(
        @Param("since") LocalDateTime since,
        Pageable pageable);

    /**
     * 종목별 대표 뉴스만 조회
     */
    @Query("SELECT p FROM ProcessedNewsArticle p " +
           "WHERE p.stockCode = :stockCode " +
           "AND p.publishedAt > :after " +
           "AND p.isClusterRepresentative = true " +
           "ORDER BY p.importance ASC, p.publishedAt DESC")
    List<ProcessedNewsArticle> findRepresentativeNewsByStockCode(
        @Param("stockCode") String stockCode,
        @Param("after") LocalDateTime after);

    /**
     * 원본 기사 ID로 처리 완료 여부 확인
     */
    boolean existsByRawArticleId(Long rawArticleId);
}
```

## 쿼리 메서드 명명 규칙

Spring Data JPA는 **메서드명을 파싱**하여 쿼리를 생성합니다.

| 메서드명 | 생성되는 SQL |
|---------|-------------|
| `findByTitle` | `WHERE title = ?` |
| `findByStockCode` | `WHERE stock_code = ?` |
| `findByPublishedAtAfter` | `WHERE published_at > ?` |
| `findByStatusOrderByPublishedAtAsc` | `WHERE status = ? ORDER BY published_at ASC` |
| `existsByUrl` | `SELECT COUNT(*) > 0 WHERE url = ?` |

### 키워드 조합

```java
// And, Or
findByStockCodeAndPublishedAtAfter(code, date)
// WHERE stock_code = ? AND published_at > ?

// Containing, Like
findByTitleContaining(keyword)
// WHERE title LIKE '%keyword%'

// Between
findByPublishedAtBetween(start, end)
// WHERE published_at BETWEEN ? AND ?

// IsNull, IsNotNull
findByStockCodeIsNull()
// WHERE stock_code IS NULL

// OrderBy
findByStatusOrderByPublishedAtDesc(status)
// WHERE status = ? ORDER BY published_at DESC
```

## @Query - JPQL 직접 작성

복잡한 쿼리는 JPQL로 직접 작성합니다.

```java
@Query("SELECT p FROM ProcessedNewsArticle p " +
       "WHERE p.stockCode = :stockCode " +
       "AND p.publishedAt > :after " +
       "AND p.isClusterRepresentative = true " +
       "ORDER BY p.importance ASC, p.publishedAt DESC")
List<ProcessedNewsArticle> findRepresentativeNewsByStockCode(
    @Param("stockCode") String stockCode,
    @Param("after") LocalDateTime after);
```

### JPQL vs SQL

| JPQL | SQL |
|------|-----|
| `SELECT p FROM ProcessedNewsArticle p` | `SELECT * FROM processed_news_articles` |
| Entity 클래스명 사용 | 테이블명 사용 |
| 필드명 사용 | 컬럼명 사용 |

# Repository 사용 예시

---

## Service에서 사용

```java
@Service
@RequiredArgsConstructor
public class NewsAggregatorService {

    private final ProcessedNewsArticleRepository newsRepository;

    /**
     * 종목 관련 뉴스 조회
     */
    public List<NewsHeadline> getNewsForStock(String stockCode) {
        LocalDateTime since = LocalDateTime.now().minusDays(7);

        List<ProcessedNewsArticle> articles = newsRepository
            .findRepresentativeNewsByStockCode(stockCode, since);

        return articles.stream()
            .map(this::toHeadline)
            .limit(5)
            .toList();
    }

    /**
     * 뉴스 저장
     */
    @Transactional
    public void saveNews(ProcessedNewsArticle article) {
        newsRepository.save(article);
    }

    private NewsHeadline toHeadline(ProcessedNewsArticle article) {
        return NewsHeadline.builder()
            .title(article.getTitle())
            .publisher(article.getPublisher())
            .url(article.getUrl())
            .tags(article.getTags().stream()
                .map(Enum::name)
                .toList())
            .publishedAt(article.getPublishedAt())
            .build();
    }
}
```

### @Transactional

데이터 변경 작업에는 트랜잭션이 필요합니다.

```java
@Transactional  // 트랜잭션 시작
public void processNews(RawNewsArticle raw) {
    // 1. 태깅
    List<NewsTag> tags = tagger.tag(raw);

    // 2. 처리된 뉴스 저장
    ProcessedNewsArticle processed = createProcessed(raw, tags);
    processedRepo.save(processed);

    // 3. 원본 상태 업데이트
    RawNewsArticle updated = raw.toBuilder()
        .status(ProcessingStatus.PROCESSED)
        .processedAt(LocalDateTime.now())
        .build();
    rawRepo.save(updated);
    // 모든 작업 성공 시 commit, 실패 시 rollback
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| @Entity | JPA가 관리하는 DB 테이블 매핑 클래스 |
| @Id, @GeneratedValue | Primary Key 설정 |
| @Column | 컬럼 속성 (nullable, length 등) |
| @Index | 인덱스 생성 |
| @ElementCollection | 값 타입 컬렉션 매핑 |
| JpaRepository | 기본 CRUD 제공 |
| 쿼리 메서드 | 메서드명으로 쿼리 자동 생성 |
| @Query | JPQL 직접 작성 |
| @Transactional | 트랜잭션 관리 |

다음 글에서는 **Rule Engine**에 대해 알아봅니다. 종목 점수를 어떻게 계산하는지, 어떤 규칙들이 적용되는지 살펴봅니다.

# Reference

---

- [Spring Data JPA Documentation](https://docs.spring.io/spring-data/jpa/docs/current/reference/html/)
- [JPA Query Methods](https://docs.spring.io/spring-data/jpa/docs/current/reference/html/#jpa.query-methods)
