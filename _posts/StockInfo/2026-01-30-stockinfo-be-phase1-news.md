---
title: "[StockInfo] BE Phase 1.5 - 뉴스 파이프라인"
categories:
  - StockInfo
tags:
  - [Java, Spring, Scheduler, RSS]
---

# Introduction

---

종목 분석에서 최신 뉴스는 중요한 신호다. 실적 발표, 대형 계약, 규제 이슈 등은 주가에 큰 영향을 미친다. 이 글에서는 뉴스를 자동으로 수집하고 태깅하여 종목/섹터별로 연결하는 파이프라인을 다룬다.

# 아키텍처 개요

---

```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐     ┌────────────┐
│ Google News    │────▶│  Collector     │────▶│   Tagger       │────▶│ Deduplicator│
│ RSS Feeds      │     │  Service       │     │   Service      │     │ Service    │
└────────────────┘     └────────────────┘     └────────────────┘     └────────────┘
       │                      │                      │                      │
       │                      ▼                      ▼                      ▼
       │               RawNewsArticle          ProcessedNews          ClusterID
       │                   (DB)                    (DB)                 (DB)
       │
       └──────────────────────────────────────────────────────────────────┘
                              NewsScheduler (15분/5분 주기)
```

# NewsCollectorService - RSS 수집

---

## RSS 피드 구성

총 34개의 RSS 피드를 수집한다:
- 일반 시장 뉴스 (2개)
- 시총 상위 종목별 (20개)
- 섹터/테마별 (12개)

```java
@Service
@RequiredArgsConstructor
public class NewsCollectorService {

  private static final String GOOGLE_NEWS_RSS_BASE =
      "https://news.google.com/rss/search?q=%s&hl=ko&gl=KR&ceid=KR:ko";

  private static final List<RssFeedConfig> RSS_FEEDS = buildRssFeeds();

  private static List<RssFeedConfig> buildRssFeeds() {
    List<RssFeedConfig> feeds = new ArrayList<>();

    // 1. 일반 시장 뉴스
    feeds.add(new RssFeedConfig("google-finance-kr",
        String.format(GOOGLE_NEWS_RSS_BASE, encodeQuery("주식 OR 코스피 OR 코스닥"))));
    feeds.add(new RssFeedConfig("google-economy-kr",
        String.format(GOOGLE_NEWS_RSS_BASE, encodeQuery("경제 실적 배당"))));

    // 2. 시총 상위 종목별
    List<String> topStocks = List.of(
        "삼성전자", "SK하이닉스", "LG에너지솔루션", "삼성바이오로직스",
        "현대차", "기아", "셀트리온", "KB금융", /* ... */);

    for (String stock : topStocks) {
      feeds.add(new RssFeedConfig("stock-" + stock,
          String.format(GOOGLE_NEWS_RSS_BASE, encodeQuery(stock))));
    }

    // 3. 섹터/테마별
    List<String> sectors = List.of(
        "반도체", "2차전지 배터리", "전기차", "바이오 제약",
        "AI 인공지능", "조선 해운", /* ... */);

    for (String sector : sectors) {
      feeds.add(new RssFeedConfig("sector-" + sector.split(" ")[0],
          String.format(GOOGLE_NEWS_RSS_BASE, encodeQuery(sector + " 주식"))));
    }

    return feeds;
  }
}
```

## 수집 로직

Rome 라이브러리를 사용하여 RSS를 파싱한다. URL 기반 중복 체크로 이미 수집된 뉴스는 건너뛴다.

```java
@Transactional
public CollectionResult collectFromAllFeeds() {
  int totalCollected = 0;
  int totalDuplicates = 0;
  int totalErrors = 0;

  for (RssFeedConfig feed : RSS_FEEDS) {
    try {
      CollectionResult result = collectFromFeed(feed);
      totalCollected += result.collected();
      totalDuplicates += result.duplicates();
    } catch (Exception e) {
      log.error("Failed to collect from feed: {}", feed.name(), e);
      totalErrors++;
    }
  }

  return new CollectionResult(totalCollected, totalDuplicates, totalErrors);
}

public CollectionResult collectFromFeed(RssFeedConfig feed) throws Exception {
  SyndFeedInput input = new SyndFeedInput();
  SyndFeed syndFeed;

  try (XmlReader reader = new XmlReader(new URL(feed.url()))) {
    syndFeed = input.build(reader);
  }

  int collected = 0;
  int duplicates = 0;

  for (SyndEntry entry : syndFeed.getEntries()) {
    String url = normalizeUrl(entry.getLink());

    // URL 기반 중복 체크
    if (rawNewsRepository.existsByUrl(url)) {
      duplicates++;
      continue;
    }

    RawNewsArticle article = RawNewsArticle.builder()
        .title(cleanTitle(entry.getTitle()))
        .publisher(extractPublisher(entry, feed.name()))
        .url(url)
        .publishedAt(toLocalDateTime(entry.getPublishedDate()))
        .content(extractContent(entry))
        .sourceFeed(feed.name())
        .collectedAt(LocalDateTime.now())
        .status(ProcessingStatus.PENDING)
        .build();

    rawNewsRepository.save(article);
    collected++;
  }

  return new CollectionResult(collected, duplicates, 0);
}
```

# NewsTaggerService - 태깅

---

## 7종 태그

키워드 기반 규칙으로 뉴스에 태그를 부여한다.

| 태그 | 키워드 예시 | 의미 |
|-----|-----------|------|
| EARNINGS | 실적, 분기, 영업이익, 매출 | 실적 관련 |
| CONTRACT | 계약, 수주, 납품, 공급 | 계약/수주 |
| BUYBACK_DIVIDEND | 배당, 자사주, 주주환원 | 주주환원 |
| REGULATION_RISK | 규제, 제재, 과징금, 소송 | 리스크 |
| MA | 인수, 합병, M&A | M&A |
| INDUSTRY | 업종, 산업, 섹터 | 산업 전반 |
| RUMOR | 루머, 소문, 관측 | 미확인 정보 |

```java
@Service
public class NewsTaggerService {

  private static final Map<NewsTag, List<Pattern>> TAG_PATTERNS = Map.of(
      NewsTag.EARNINGS, List.of(
          Pattern.compile("실적", Pattern.CASE_INSENSITIVE),
          Pattern.compile("분기", Pattern.CASE_INSENSITIVE),
          Pattern.compile("영업이익", Pattern.CASE_INSENSITIVE),
          Pattern.compile("매출", Pattern.CASE_INSENSITIVE)),
      NewsTag.CONTRACT, List.of(
          Pattern.compile("계약", Pattern.CASE_INSENSITIVE),
          Pattern.compile("수주", Pattern.CASE_INSENSITIVE)),
      NewsTag.REGULATION_RISK, List.of(
          Pattern.compile("규제", Pattern.CASE_INSENSITIVE),
          Pattern.compile("제재", Pattern.CASE_INSENSITIVE),
          Pattern.compile("과징금", Pattern.CASE_INSENSITIVE),
          Pattern.compile("소송", Pattern.CASE_INSENSITIVE)),
      // ...
  );

  public List<NewsTag> assignTags(RawNewsArticle article) {
    List<NewsTag> tags = new ArrayList<>();
    String text = buildSearchText(article);

    for (Map.Entry<NewsTag, List<Pattern>> entry : TAG_PATTERNS.entrySet()) {
      for (Pattern pattern : entry.getValue()) {
        if (pattern.matcher(text).find()) {
          tags.add(entry.getKey());
          break;
        }
      }
    }

    // 태그 없으면 기본값
    if (tags.isEmpty()) {
      tags.add(NewsTag.INDUSTRY);
    }

    return tags;
  }
}
```

## 중요도 결정

신선도, 태그, 언론사 신뢰도를 종합하여 중요도를 결정한다.

```java
public NewsImportance determineImportance(RawNewsArticle article, List<NewsTag> tags) {
  int score = 0;

  // 신선도 점수 (24시간 이내: +3, 72시간 이내: +1)
  if (article.getPublishedAt() != null) {
    long hoursAgo = ChronoUnit.HOURS.between(article.getPublishedAt(), LocalDateTime.now());
    if (hoursAgo <= 24) score += 3;
    else if (hoursAgo <= 72) score += 1;
  }

  // 태그별 점수
  if (tags.contains(NewsTag.EARNINGS)) score += 3;
  if (tags.contains(NewsTag.CONTRACT)) score += 2;
  if (tags.contains(NewsTag.MA)) score += 3;
  if (tags.contains(NewsTag.REGULATION_RISK)) score += 2;

  // 신뢰 언론사 가산점
  if (isTrustedPublisher(article.getPublisher())) score += 1;

  // 등급 결정
  if (score >= 5) return NewsImportance.HIGH;
  if (score >= 2) return NewsImportance.MEDIUM;
  return NewsImportance.LOW;
}
```

## 종목명 → 코드 매핑

40개 이상의 주요 종목에 대해 종목명을 코드로 매핑한다.

```java
private static final Map<String, String> STOCK_NAME_CODE_MAP = Map.ofEntries(
    Map.entry("삼성전자", "005930"),
    Map.entry("SK하이닉스", "000660"),
    Map.entry("하이닉스", "000660"),  // 약칭 지원
    Map.entry("LG에너지솔루션", "373220"),
    Map.entry("현대차", "005380"),
    Map.entry("현대자동차", "005380"),  // 정식 명칭
    Map.entry("NAVER", "035420"),
    Map.entry("네이버", "035420"),  // 한글 명칭
    // ...
);

public String extractStockCode(RawNewsArticle article) {
  String text = buildSearchText(article);

  // 1. 종목명으로 찾기
  for (Map.Entry<String, String> entry : STOCK_NAME_CODE_MAP.entrySet()) {
    if (text.contains(entry.getKey())) {
      return entry.getValue();
    }
  }

  // 2. 6자리 숫자 패턴 찾기
  Matcher matcher = STOCK_CODE_PATTERN.matcher(text);
  if (matcher.find()) {
    return matcher.group(1);
  }

  return null;
}
```

# NewsDeduplicatorService - 클러스터링

---

비슷한 뉴스를 묶어서 중복을 제거한다. Jaccard 유사도를 사용한다.

## Jaccard 유사도

두 문자열의 단어 집합을 비교하여 유사도를 계산한다.

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

```java
@Service
public class NewsDeduplicatorService {

  /** Jaccard 유사도 임계값 (0.6 이상이면 유사) */
  private static final double SIMILARITY_THRESHOLD = 0.6;

  /** 클러스터링 윈도우 (72시간) */
  private static final int WINDOW_HOURS = 72;

  public double calculateJaccardSimilarity(String text1, String text2) {
    Set<String> words1 = tokenize(text1);
    Set<String> words2 = tokenize(text2);

    Set<String> intersection = new HashSet<>(words1);
    intersection.retainAll(words2);

    Set<String> union = new HashSet<>(words1);
    union.addAll(words2);

    if (union.isEmpty()) return 0.0;
    return (double) intersection.size() / union.size();
  }

  private Set<String> tokenize(String text) {
    return Arrays.stream(text.toLowerCase().split("\\s+"))
        .filter(word -> word.length() >= 2)
        .collect(Collectors.toSet());
  }
}
```

## 클러스터링 로직

72시간 이내의 유사 뉴스를 같은 클러스터로 묶는다.

```java
public String findOrCreateCluster(ProcessedNewsArticle article, List<ProcessedNewsArticle> recentArticles) {
  for (ProcessedNewsArticle existing : recentArticles) {
    double similarity = calculateJaccardSimilarity(article.getTitle(), existing.getTitle());

    if (similarity >= SIMILARITY_THRESHOLD) {
      // 기존 클러스터에 합류
      return existing.getClusterId();
    }
  }

  // 새 클러스터 생성
  return UUID.randomUUID().toString();
}
```

# NewsScheduler - 스케줄러

---

주기적으로 뉴스를 수집하고 처리한다.

```java
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = "news.collection.enabled", havingValue = "true")
public class NewsScheduler {

  private final NewsCollectorService collectorService;
  private final NewsProcessorService processorService;

  /** 15분마다 뉴스 수집 */
  @Scheduled(fixedDelayString = "${news.collection.interval-minutes:15}000")
  public void collectNews() {
    log.info("Starting scheduled news collection");
    CollectionResult result = collectorService.collectFromAllFeeds();
    log.info("Collection complete: collected={}, duplicates={}, errors={}",
        result.collected(), result.duplicates(), result.errors());
  }

  /** 5분마다 미처리 뉴스 처리 */
  @Scheduled(fixedDelayString = "${news.processing.interval-minutes:5}000")
  public void processNews() {
    log.info("Starting scheduled news processing");
    int processed = processorService.processPendingArticles();
    log.info("Processing complete: {} articles processed", processed);
  }
}
```

## 설정 (application.yml)

```yaml
news:
  collection:
    enabled: true
    interval-minutes: 15
  processing:
    batch-size: 100
    interval-minutes: 5
  clustering:
    similarity-threshold: 0.6
    window-hours: 72
```

# DB 엔티티

---

## RawNewsArticle (원본)

```java
@Entity
@Getter
@Builder
public class RawNewsArticle {
  @Id @GeneratedValue
  private Long id;

  private String title;
  private String publisher;
  private String url;
  private LocalDateTime publishedAt;
  private String content;
  private String sourceFeed;
  private LocalDateTime collectedAt;

  @Enumerated(EnumType.STRING)
  private ProcessingStatus status;  // PENDING, PROCESSED, FAILED

  public enum ProcessingStatus {
    PENDING, PROCESSED, FAILED
  }
}
```

## ProcessedNewsArticle (처리 완료)

```java
@Entity
@Getter
@Builder
public class ProcessedNewsArticle {
  @Id @GeneratedValue
  private Long id;

  private String title;
  private String publisher;
  private String url;
  private LocalDateTime publishedAt;

  private String stockCode;     // 연결된 종목
  private String sectorName;    // 연결된 섹터

  @ElementCollection
  private List<NewsTag> tags;   // EARNINGS, CONTRACT, ...

  @Enumerated(EnumType.STRING)
  private NewsImportance importance;  // HIGH, MEDIUM, LOW

  private String clusterId;     // 중복 클러스터 ID
  private boolean isClusterRepresentative;  // 클러스터 대표 여부
}
```

# Conclusion

---

Stock-Info 뉴스 파이프라인의 핵심:

1. **수집**: Google News RSS 34개 피드에서 15분마다 수집
2. **태깅**: 7종 태그 + 중요도(HIGH/MEDIUM/LOW) 부여
3. **클러스터링**: Jaccard 유사도 0.6 기준으로 72시간 윈도우 클러스터링
4. **스케줄러**: 수집 15분, 처리 5분 주기

이 파이프라인 덕분에 종목/섹터별 최신 뉴스를 자동으로 수집하고 분류할 수 있게 되었다.

# Reference

---

- [Rome RSS Library](https://rometools.github.io/rome/)
- [Jaccard Index](https://en.wikipedia.org/wiki/Jaccard_index)
