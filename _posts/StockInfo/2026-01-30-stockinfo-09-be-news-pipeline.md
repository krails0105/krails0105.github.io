---
title: "[StockInfo] 09. News Pipeline - 뉴스 수집/태깅/클러스터링"
categories:
  - StockInfo
tags:
  - [Java, Spring, RSS, Scheduler]
---

# Introduction

---

주식 투자에서 뉴스는 중요한 정보입니다. "삼성전자 실적 발표", "현대차 신차 출시" 같은 뉴스는 주가에 영향을 줍니다.

Stock-Info는 뉴스를 **자동으로 수집**하고, **태그를 붙이고**, **중복을 제거**합니다. 이 과정을 **뉴스 파이프라인**이라고 합니다.

# 파이프라인 개요

---

```
┌─────────────────────────────────────────────────────────────────┐
│                        뉴스 파이프라인                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [수집] NewsCollector  ─→  Google News RSS 피드 (34개)          │
│            │                                                     │
│            ▼                                                     │
│  [저장] RawNewsArticle  ─→  H2 DB (원본 저장)                   │
│            │                                                     │
│            ▼                                                     │
│  [태깅] NewsTagger      ─→  7종 태그 + 중요도 결정              │
│            │                                                     │
│            ▼                                                     │
│  [클러스터링] NewsDeduplicator  ─→  Jaccard 유사도 기반         │
│            │                                                     │
│            ▼                                                     │
│  [저장] ProcessedNewsArticle  ─→  H2 DB (처리 완료)             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

# 뉴스 수집 (NewsCollectorService)

---

## RSS 피드란?

**RSS(Really Simple Syndication)**는 웹사이트의 최신 콘텐츠를 XML 형식으로 제공하는 표준입니다.

```xml
<!-- RSS 피드 예시 -->
<rss version="2.0">
  <channel>
    <title>삼성전자 뉴스</title>
    <item>
      <title>삼성전자, 반도체 신규 투자 발표</title>
      <link>https://news.example.com/123</link>
      <pubDate>Thu, 30 Jan 2026 09:00:00 GMT</pubDate>
      <source>한국경제</source>
    </item>
  </channel>
</rss>
```

## Google News RSS 피드 구성

```java
/**
 * 뉴스 수집 서비스.
 *
 * Google News RSS 피드에서 주식/경제 뉴스를 수집합니다.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class NewsCollectorService {

    private final RawNewsArticleRepository rawNewsRepo;

    // 수집할 RSS 피드 목록 (34개)
    private static final List<String> RSS_FEEDS = List.of(
        // 종목별 피드
        "https://news.google.com/rss/search?q=삼성전자+주식&hl=ko",
        "https://news.google.com/rss/search?q=SK하이닉스+주식&hl=ko",
        "https://news.google.com/rss/search?q=현대차+주식&hl=ko",
        "https://news.google.com/rss/search?q=LG에너지솔루션+주식&hl=ko",
        // ... 40+ 주요 종목

        // 섹터별 피드
        "https://news.google.com/rss/search?q=반도체+산업&hl=ko",
        "https://news.google.com/rss/search?q=전기차+배터리&hl=ko",
        "https://news.google.com/rss/search?q=바이오+제약&hl=ko",

        // 시장 전체
        "https://news.google.com/rss/search?q=코스피&hl=ko",
        "https://news.google.com/rss/search?q=코스닥&hl=ko",
        "https://news.google.com/rss/search?q=증시+전망&hl=ko"
    );

    /**
     * 모든 피드에서 뉴스 수집
     */
    public void collectAll() {
        log.info("Starting news collection from {} feeds", RSS_FEEDS.size());

        int totalCollected = 0;
        for (String feedUrl : RSS_FEEDS) {
            try {
                int collected = collectFromFeed(feedUrl);
                totalCollected += collected;
            } catch (Exception e) {
                log.error("Failed to collect from: {}", feedUrl, e);
            }
        }

        log.info("News collection completed. Total: {} articles", totalCollected);
    }

    /**
     * 단일 피드에서 뉴스 수집
     */
    private int collectFromFeed(String feedUrl) {
        List<RssItem> items = fetchRssFeed(feedUrl);

        int collected = 0;
        for (RssItem item : items) {
            // URL로 중복 체크
            if (rawNewsRepo.existsByUrl(item.getLink())) {
                continue;
            }

            // 원본 뉴스 저장
            RawNewsArticle article = RawNewsArticle.builder()
                .title(item.getTitle())
                .url(item.getLink())
                .publisher(extractPublisher(item.getSource()))
                .publishedAt(parseDate(item.getPubDate()))
                .status(ProcessingStatus.PENDING)
                .collectedAt(LocalDateTime.now())
                .build();

            rawNewsRepo.save(article);
            collected++;
        }

        return collected;
    }

    /**
     * RSS XML 파싱
     */
    private List<RssItem> fetchRssFeed(String feedUrl) {
        // XML 파싱 로직 (JAXB 또는 Rome 라이브러리 사용)
        // ...
    }
}
```

### URL 중복 체크

같은 뉴스가 여러 피드에 나올 수 있습니다.

```java
// URL로 중복 체크 (Repository)
boolean existsByUrl(String url);

// 수집 시 체크
if (rawNewsRepo.existsByUrl(item.getLink())) {
    continue;  // 이미 있으면 스킵
}
```

# 뉴스 태깅 (NewsTaggerService)

---

## 7종 태그

| 태그 | 의미 | 키워드 예시 |
|------|------|-------------|
| EARNINGS | 실적 발표 | 실적, 영업이익, 순이익, 분기 |
| CONTRACT | 대형 계약 | 수주, 계약, MOU, 납품 |
| BUYBACK_DIVIDEND | 자사주/배당 | 자사주, 배당, 주주환원 |
| REGULATION_RISK | 규제 리스크 | 제재, 규제, 과징금, 조사 |
| MA | 인수합병 | 인수, 합병, M&A, 지분 |
| INDUSTRY | 산업 동향 | 시장, 전망, 성장, 추세 |
| RUMOR | 루머 | 소문, 관측, 추정, 전해 |

## 태거 구현

```java
/**
 * 뉴스 태깅 서비스.
 *
 * 뉴스 제목을 분석하여 태그를 부여하고 중요도를 결정합니다.
 */
@Service
@Slf4j
public class NewsTaggerService {

    // 태그별 키워드 맵
    private static final Map<NewsTag, List<String>> TAG_KEYWORDS = Map.of(
        NewsTag.EARNINGS, List.of(
            "실적", "영업이익", "순이익", "매출", "분기", "잠정실적",
            "어닝", "흑자", "적자", "전환"
        ),
        NewsTag.CONTRACT, List.of(
            "수주", "계약", "MOU", "납품", "공급", "협력",
            "파트너", "체결"
        ),
        NewsTag.BUYBACK_DIVIDEND, List.of(
            "자사주", "배당", "주주환원", "소각", "취득"
        ),
        NewsTag.REGULATION_RISK, List.of(
            "제재", "규제", "과징금", "조사", "검찰", "공정위",
            "소송", "패소", "리콜"
        ),
        NewsTag.MA, List.of(
            "인수", "합병", "M&A", "지분", "매각", "투자유치"
        ),
        NewsTag.INDUSTRY, List.of(
            "시장", "전망", "성장", "추세", "업황", "산업"
        ),
        NewsTag.RUMOR, List.of(
            "소문", "관측", "추정", "전해", "알려", "가능성"
        )
    );

    // 종목명 → 종목코드 매핑 (40+ 종목)
    private static final Map<String, String> STOCK_NAME_TO_CODE = Map.ofEntries(
        Map.entry("삼성전자", "005930"),
        Map.entry("SK하이닉스", "000660"),
        Map.entry("현대차", "005380"),
        Map.entry("현대자동차", "005380"),
        Map.entry("기아", "000270"),
        Map.entry("LG에너지솔루션", "373220"),
        Map.entry("삼성바이오로직스", "207940"),
        Map.entry("셀트리온", "068270"),
        Map.entry("카카오", "035720"),
        Map.entry("네이버", "035420"),
        Map.entry("삼성SDI", "006400")
        // ... 더 많은 매핑
    );

    /**
     * 뉴스 태깅
     *
     * @param article 원본 뉴스
     * @return 태깅 결과 (태그 목록, 중요도, 연관 종목)
     */
    public TaggingResult tag(RawNewsArticle article) {
        String title = article.getTitle();

        // 1. 태그 추출
        List<NewsTag> tags = extractTags(title);

        // 2. 중요도 결정
        NewsImportance importance = determineImportance(tags);

        // 3. 연관 종목 추출
        String stockCode = extractStockCode(title);

        // 4. 연관 섹터 추출
        String sectorName = extractSectorName(title);

        return TaggingResult.builder()
            .tags(tags)
            .importance(importance)
            .stockCode(stockCode)
            .sectorName(sectorName)
            .build();
    }

    /**
     * 제목에서 태그 추출
     */
    private List<NewsTag> extractTags(String title) {
        List<NewsTag> tags = new ArrayList<>();

        for (Map.Entry<NewsTag, List<String>> entry : TAG_KEYWORDS.entrySet()) {
            NewsTag tag = entry.getKey();
            List<String> keywords = entry.getValue();

            // 키워드 중 하나라도 포함되면 태그 추가
            boolean matched = keywords.stream()
                .anyMatch(keyword -> title.contains(keyword));

            if (matched) {
                tags.add(tag);
            }
        }

        return tags;
    }

    /**
     * 중요도 결정
     *
     * HIGH: 실적, 계약, 자사주/배당
     * MEDIUM: 규제, M&A
     * LOW: 산업, 루머
     */
    private NewsImportance determineImportance(List<NewsTag> tags) {
        Set<NewsTag> highPriority = Set.of(
            NewsTag.EARNINGS,
            NewsTag.CONTRACT,
            NewsTag.BUYBACK_DIVIDEND
        );

        Set<NewsTag> mediumPriority = Set.of(
            NewsTag.REGULATION_RISK,
            NewsTag.MA
        );

        // 가장 높은 우선순위 태그 기준
        for (NewsTag tag : tags) {
            if (highPriority.contains(tag)) {
                return NewsImportance.HIGH;
            }
        }

        for (NewsTag tag : tags) {
            if (mediumPriority.contains(tag)) {
                return NewsImportance.MEDIUM;
            }
        }

        return NewsImportance.LOW;
    }

    /**
     * 제목에서 종목코드 추출
     */
    private String extractStockCode(String title) {
        for (Map.Entry<String, String> entry : STOCK_NAME_TO_CODE.entrySet()) {
            if (title.contains(entry.getKey())) {
                return entry.getValue();
            }
        }
        return null;
    }
}
```

# 뉴스 클러스터링 (NewsDeduplicatorService)

---

## 왜 클러스터링이 필요한가?

같은 사건에 대해 **여러 언론사**가 기사를 씁니다.

```
"삼성전자, 3분기 실적 발표...영업이익 10조" - A사
"삼성전자 3분기 영업이익 10조원 달성" - B사
"삼성전자, 역대급 실적...3Q 영업익 10조" - C사
```

비슷한 뉴스를 **하나의 클러스터**로 묶고, **대표 뉴스**만 표시합니다.

## Jaccard 유사도

두 문장의 유사도를 측정하는 방법입니다.

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|

예시:
문장 A: {"삼성전자", "3분기", "실적", "영업이익", "10조"}
문장 B: {"삼성전자", "3분기", "영업이익", "10조원", "달성"}

교집합: {"삼성전자", "3분기", "영업이익"}  = 3개
합집합: {"삼성전자", "3분기", "실적", "영업이익", "10조", "10조원", "달성"} = 7개

Jaccard = 3/7 ≈ 0.43
```

임계값 0.6 이상이면 "유사한 뉴스"로 판단합니다.

## 클러스터링 구현

```java
/**
 * 뉴스 중복 제거 서비스.
 *
 * Jaccard 유사도 기반으로 비슷한 뉴스를 클러스터링합니다.
 */
@Service
@Slf4j
public class NewsDeduplicatorService {

    // 유사도 임계값
    @Value("${news.clustering.similarity-threshold}")
    private double similarityThreshold;  // 0.6

    // 클러스터링 윈도우 (시간)
    @Value("${news.clustering.window-hours}")
    private int windowHours;  // 72

    /**
     * 뉴스 클러스터링
     *
     * @param articles 처리할 뉴스 목록
     * @return 클러스터링 결과
     */
    public List<NewsCluster> cluster(List<ProcessedNewsArticle> articles) {
        List<NewsCluster> clusters = new ArrayList<>();

        for (ProcessedNewsArticle article : articles) {
            // 기존 클러스터에 속하는지 확인
            NewsCluster matchedCluster = findMatchingCluster(
                article, clusters);

            if (matchedCluster != null) {
                // 기존 클러스터에 추가
                matchedCluster.addArticle(article);
            } else {
                // 새 클러스터 생성
                NewsCluster newCluster = new NewsCluster();
                newCluster.addArticle(article);
                clusters.add(newCluster);
            }
        }

        // 각 클러스터에서 대표 뉴스 선정
        for (NewsCluster cluster : clusters) {
            cluster.selectRepresentative();
        }

        return clusters;
    }

    /**
     * 매칭되는 클러스터 찾기
     */
    private NewsCluster findMatchingCluster(
            ProcessedNewsArticle article,
            List<NewsCluster> clusters) {

        for (NewsCluster cluster : clusters) {
            // 시간 윈도우 체크
            if (!isWithinTimeWindow(article, cluster)) {
                continue;
            }

            // 유사도 체크
            double similarity = calculateSimilarity(
                article, cluster.getRepresentative());

            if (similarity >= similarityThreshold) {
                return cluster;
            }
        }

        return null;
    }

    /**
     * Jaccard 유사도 계산
     */
    private double calculateSimilarity(
            ProcessedNewsArticle a,
            ProcessedNewsArticle b) {

        Set<String> tokensA = tokenize(a.getTitle());
        Set<String> tokensB = tokenize(b.getTitle());

        // 교집합 크기
        Set<String> intersection = new HashSet<>(tokensA);
        intersection.retainAll(tokensB);

        // 합집합 크기
        Set<String> union = new HashSet<>(tokensA);
        union.addAll(tokensB);

        if (union.isEmpty()) {
            return 0.0;
        }

        return (double) intersection.size() / union.size();
    }

    /**
     * 문장 토큰화 (명사 추출)
     */
    private Set<String> tokenize(String text) {
        // 간단한 토큰화: 공백 분리 + 불용어 제거
        return Arrays.stream(text.split("\\s+"))
            .filter(token -> token.length() >= 2)
            .filter(token -> !STOP_WORDS.contains(token))
            .collect(Collectors.toSet());
    }

    /**
     * 시간 윈도우 내인지 확인
     */
    private boolean isWithinTimeWindow(
            ProcessedNewsArticle article,
            NewsCluster cluster) {

        LocalDateTime articleTime = article.getPublishedAt();
        LocalDateTime clusterTime = cluster.getRepresentative()
            .getPublishedAt();

        long hoursDiff = Duration.between(clusterTime, articleTime)
            .abs().toHours();

        return hoursDiff <= windowHours;
    }

    private static final Set<String> STOP_WORDS = Set.of(
        "의", "가", "이", "은", "는", "을", "를", "에", "와", "과",
        "도", "로", "으로", "에서", "까지", "부터"
    );
}
```

# 스케줄러 (NewsScheduler)

---

```java
/**
 * 뉴스 수집/처리 스케줄러.
 *
 * - 수집: 15분마다
 * - 처리: 5분마다
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class NewsScheduler {

    private final NewsCollectorService collector;
    private final NewsProcessorService processor;

    @Value("${news.collection.enabled}")
    private boolean collectionEnabled;

    /**
     * 뉴스 수집 스케줄 (15분마다)
     */
    @Scheduled(fixedRateString = "${news.collection.interval-minutes}",
               timeUnit = TimeUnit.MINUTES)
    public void collectNews() {
        if (!collectionEnabled) {
            return;
        }

        log.info("Scheduled news collection started");
        collector.collectAll();
    }

    /**
     * 뉴스 처리 스케줄 (5분마다)
     */
    @Scheduled(fixedRateString = "${news.processing.interval-minutes}",
               timeUnit = TimeUnit.MINUTES)
    public void processNews() {
        if (!collectionEnabled) {
            return;
        }

        log.info("Scheduled news processing started");
        processor.processPendingNews();
    }
}
```

## @Scheduled 어노테이션

```java
// 고정 간격 (밀리초)
@Scheduled(fixedRate = 900000)  // 15분

// 설정 파일에서 값 읽기
@Scheduled(fixedRateString = "${news.collection.interval-minutes}",
           timeUnit = TimeUnit.MINUTES)

// cron 표현식
@Scheduled(cron = "0 */15 * * * *")  // 매 15분마다
```

# 뉴스 처리 파이프라인 통합

---

```java
/**
 * 뉴스 처리 파이프라인.
 *
 * 수집 → 태깅 → 클러스터링 → 저장
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class NewsProcessorService {

    private final RawNewsArticleRepository rawNewsRepo;
    private final ProcessedNewsArticleRepository processedNewsRepo;
    private final NewsTaggerService tagger;
    private final NewsDeduplicatorService deduplicator;

    @Value("${news.processing.batch-size}")
    private int batchSize;  // 100

    /**
     * 대기 중인 뉴스 처리
     */
    @Transactional
    public void processPendingNews() {
        // 1. PENDING 상태 뉴스 조회
        Pageable pageable = PageRequest.of(0, batchSize);
        List<RawNewsArticle> pending = rawNewsRepo
            .findByStatusOrderByPublishedAtAsc(
                ProcessingStatus.PENDING, pageable);

        if (pending.isEmpty()) {
            return;
        }

        log.info("Processing {} pending news articles", pending.size());

        // 2. 각 뉴스 태깅
        List<ProcessedNewsArticle> processed = new ArrayList<>();
        for (RawNewsArticle raw : pending) {
            try {
                TaggingResult tagging = tagger.tag(raw);

                ProcessedNewsArticle article = ProcessedNewsArticle.builder()
                    .rawArticleId(raw.getId())
                    .title(raw.getTitle())
                    .publisher(raw.getPublisher())
                    .url(raw.getUrl())
                    .publishedAt(raw.getPublishedAt())
                    .tags(tagging.getTags())
                    .importance(tagging.getImportance())
                    .stockCode(tagging.getStockCode())
                    .sectorName(tagging.getSectorName())
                    .processedAt(LocalDateTime.now())
                    .build();

                processed.add(article);

                // 원본 상태 업데이트
                rawNewsRepo.save(raw.toBuilder()
                    .status(ProcessingStatus.PROCESSED)
                    .processedAt(LocalDateTime.now())
                    .build());

            } catch (Exception e) {
                log.error("Failed to process article: {}", raw.getId(), e);
                rawNewsRepo.save(raw.toBuilder()
                    .status(ProcessingStatus.FAILED)
                    .build());
            }
        }

        // 3. 클러스터링
        List<NewsCluster> clusters = deduplicator.cluster(processed);

        // 4. 클러스터 정보 반영 및 저장
        for (NewsCluster cluster : clusters) {
            String clusterId = UUID.randomUUID().toString();

            for (ProcessedNewsArticle article : cluster.getArticles()) {
                boolean isRepresentative =
                    article.equals(cluster.getRepresentative());

                processedNewsRepo.save(article.toBuilder()
                    .clusterId(clusterId)
                    .isClusterRepresentative(isRepresentative)
                    .build());
            }
        }

        log.info("Processed {} articles into {} clusters",
            processed.size(), clusters.size());
    }
}
```

# 정리

---

| 단계 | 서비스 | 역할 |
|------|--------|------|
| 수집 | NewsCollectorService | RSS 피드에서 뉴스 수집 |
| 저장 | RawNewsArticleRepository | 원본 뉴스 저장 |
| 태깅 | NewsTaggerService | 7종 태그 + 중요도 결정 |
| 클러스터링 | NewsDeduplicatorService | Jaccard 유사도로 중복 제거 |
| 스케줄링 | NewsScheduler | 15분 수집, 5분 처리 |

뉴스 파이프라인을 통해:
- **자동화된 뉴스 수집**
- **의미 있는 태그 부여**
- **중복 제거로 깔끔한 뉴스 목록**

다음 글에서는 **Home Picks API**에 대해 알아봅니다.

# Reference

---

- [Jaccard Index - Wikipedia](https://en.wikipedia.org/wiki/Jaccard_index)
- [Spring @Scheduled](https://docs.spring.io/spring-framework/docs/current/reference/html/integration.html#scheduling)
