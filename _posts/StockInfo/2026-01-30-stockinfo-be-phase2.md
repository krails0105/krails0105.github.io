---
title: "[StockInfo] BE Phase 2 - UX 개선 API"
categories:
  - StockInfo
tags:
  - [Java, Spring, API Design]
---

# Introduction

---

Phase 1에서 Rule Engine과 뉴스 파이프라인을 구현했다. Phase 2에서는 **신뢰도 높은 추천**을 위한 API 개선을 진행했다. 표본 크기 검증, 톤 매칭 헤드라인, 홈 Watchlist Picks API를 다룬다.

# 섹터 표본 크기 검증

---

## 문제

섹터에 종목이 2-3개뿐인데 "Top 3"를 보여주면 의미가 없다. 표본이 충분해야 순위에 신뢰성이 생긴다.

## 해결

최소 표본 크기를 정의하고, 이를 만족하지 않으면 Top 3 표시를 제한한다.

```java
/** 표본 보정 상수 */
private static final int MIN_SAMPLE_SIZE_FOR_TOP3 = 5;

public SectorInsight getSectorInsight(String sectorName) {
  List<StockListItem> stocks = getStocksBySectorName(sectorName);
  int sampleSize = stocks.size();

  // 표본 크기 정보 추가
  return SectorInsight.builder()
      .sectorName(sectorName)
      .sampleSize(sampleSize)
      .isTop3Reliable(sampleSize >= MIN_SAMPLE_SIZE_FOR_TOP3)
      .topPicks(selectTopPicks(stocks, sampleSize))
      .build();
}
```

## Response DTO

클라이언트에서 표본 크기에 따라 UI를 조절할 수 있도록 필드를 추가했다.

```java
@Getter
@Builder
public class SectorInsight {
  private String sectorName;
  private int sampleSize;           // 섹터 내 종목 수
  private boolean isTop3Reliable;   // Top 3 신뢰 가능 여부
  private List<TopPick> topPicks;
  // ...
}
```

# Headline Tone Matching

---

## 문제

점수가 낮은 종목에 "유력 후보"라고 표시하면 신뢰도가 떨어진다. 점수와 데이터 커버리지에 따라 톤을 조절해야 한다.

## 톤 매칭 규칙

| 조건 | 톤 | 예시 헤드라인 |
|------|----|----|
| score ≥ 70 & coverage ≥ 0.7 | 강한 톤 | "우선 검토할 만한 **유력 후보**예요." |
| 50 ≤ score < 70 | 중간 톤 | "**관찰 리스트 상단**에 올려둘 만해요." |
| score < 50 or coverage < 0.7 | 조건부 톤 | "**확인 후 접근**이 좋아요." |

## 구현

```java
/** 톤 매칭 임계치 */
public static final int TONE_STRONG_SCORE = 70;
public static final double TONE_STRONG_COVERAGE = 0.7;
public static final int TONE_MEDIUM_SCORE = 50;

private String getToneMatchedHeadline(Template template, int score, double coverage, RuleFlags flags) {
  // HF-04 (정보 부족) 시 조건부 프리픽스
  if (flags.hasLowCoverage) {
    return "정보가 제한적이지만, " + getConditionalHeadline(template);
  }

  // 강한 톤: score>=70 && coverage>=0.7
  if (score >= TONE_STRONG_SCORE && coverage >= TONE_STRONG_COVERAGE) {
    return getStrongToneHeadline(template);
  }

  // 중간 톤: 50<=score<70
  if (score >= TONE_MEDIUM_SCORE) {
    return getMediumToneHeadline(template);
  }

  // 조건부 톤: score<50 OR coverage<0.7
  return getConditionalHeadline(template);
}

private String getStrongToneHeadline(Template template) {
  return switch (template) {
    case A_VALUE -> "섹터 대비 부담이 낮아 우선 검토할 만한 유력 후보예요.";
    case B_MOMENTUM -> "추세가 강해서 단기 관찰 우선순위가 높은 종목이에요.";
    case C_STABLE -> "안정적인 흐름으로 초보자가 우선 검토하기 좋은 후보예요.";
    case D_GROWTH -> "실적 흐름이 좋아 유력 후보로 살펴볼 만해요.";
    case E_RISK -> "리스크 신호가 있어 관망이 기본이에요.";
  };
}
```

# Top Picks Role 분화

---

## 문제

Top 5 종목이 모두 같은 성격이면 다양성이 부족하다. 역할(Role)을 분화하여 각 종목의 특성을 명확히 한다.

## Role 종류

| Role | 의미 | 조건 |
|------|------|------|
| REPRESENTATIVE | 섹터 대표주 | 강세 섹터의 고점수(≥70) 종목 |
| WATCHLIST_PRIORITY | 관찰 우선 | 모멘텀/밸류 등 특정 강점 |

## 동적 섹션 타이틀

Role에 따라 UI 섹션 타이틀이 달라진다:

- REPRESENTATIVE → "이 섹터의 대표 종목"
- WATCHLIST_PRIORITY → "관심 등록 고려 종목"

```java
private PickBucket determineBucket(StockListItem stock, SectorScoreDto sector, double avgPer) {
  // 저평가: PER이 섹터 평균의 70% 이하
  if (stock.getPer() != null && stock.getPer() > 0 && stock.getPer() < avgPer * 0.7) {
    return PickBucket.VALUE;
  }

  // 섹터 대표: 강세 섹터의 고점수 종목
  if (sector.getLabel() == ScoreLabel.STRONG && stock.getScore() >= 70) {
    return PickBucket.REPRESENTATIVE;
  }

  // 모멘텀: 양의 등락률 1% 이상
  double changeRate = parseChangeRate(stock.getChangeRate());
  if (changeRate > 1.0) {
    return PickBucket.MOMENTUM;
  }

  // 기본: 안정형
  return PickBucket.STABLE;
}
```

# Home Watchlist Picks API

---

## 요구사항

메인 페이지에서 "오늘 주목할 종목 5~10개"를 선정해야 한다. 다양한 섹터와 버킷에서 골고루 선정하여 편향을 방지한다.

## 4-Bucket 시스템

| Bucket | 의미 | 기준 |
|--------|------|------|
| STABLE | 안정형 | 기본, 초보자 추천 |
| REPRESENTATIVE | 대표형 | 강세 섹터 고점수 |
| MOMENTUM | 모멘텀형 | 등락률 > 1% |
| VALUE | 저평가형 | PER < 섹터평균×0.7 |

## 다양성 제약

```java
/** 동일 섹터 최대 선정 수 */
private static final int MAX_SAME_SECTOR = 2;

/** 동일 버킷 최대 선정 수 */
private static final int MAX_SAME_BUCKET = 3;

private List<StockPickCard> selectWithDiversity(List<StockPickCard> candidates, int size, String preset) {
  List<StockPickCard> result = new ArrayList<>();
  Map<String, Integer> sectorCount = new HashMap<>();
  Map<PickBucket, Integer> bucketCount = new HashMap<>();

  // 점수 내림차순 정렬
  candidates.sort(Comparator.comparingInt(StockPickCard::getScoreValue).reversed());

  for (StockPickCard card : candidates) {
    if (result.size() >= size) break;

    int sCount = sectorCount.getOrDefault(card.getSectorName(), 0);
    int bCount = bucketCount.getOrDefault(card.getPickBucket(), 0);

    // 다양성 제약 체크
    if (sCount < MAX_SAME_SECTOR && bCount < MAX_SAME_BUCKET) {
      result.add(card);
      sectorCount.put(card.getSectorName(), sCount + 1);
      bucketCount.put(card.getPickBucket(), bCount + 1);
    }
  }

  return result;
}
```

## API 엔드포인트

```java
@RestController
@RequestMapping("/api/home")
@RequiredArgsConstructor
public class HomeController {

  private final HomePicksService homePicksService;

  @GetMapping("/picks")
  public HomePicksResponse getHomePicks(
      @RequestParam(defaultValue = "8") int size,
      @RequestParam(defaultValue = "default") String preset) {
    return homePicksService.getHomePicks(size, preset);
  }
}
```

## Response 구조

```java
@Getter
@Builder
public class HomePicksResponse {
  private LocalDateTime asOf;
  private String preset;
  private List<StockPickCard> items;
}

@Getter
@Builder
public class StockPickCard {
  private String code;
  private String name;
  private String sectorName;
  private int scoreValue;
  private ScoreLabel grade;
  private PickBucket pickBucket;  // STABLE, REPRESENTATIVE, MOMENTUM, VALUE
  private List<String> reasons;   // 선정 이유 2개
  private String caution;         // 주의사항 (있을 때만)
  private PickNews news;          // 관련 뉴스 1건 (있을 때만)

  public enum PickBucket {
    STABLE, REPRESENTATIVE, MOMENTUM, VALUE
  }
}
```

# Conclusion

---

Phase 2 UX 개선 API의 핵심:

1. **표본 검증**: MIN_SAMPLE_SIZE=5, sampleSize 필드로 신뢰도 표시
2. **Tone Matching**: 점수/coverage 기반 헤드라인 톤 조절
3. **Role 분화**: REPRESENTATIVE vs WATCHLIST_PRIORITY
4. **Home Picks**: 4-Bucket + 다양성 제약(섹터 2, 버킷 3)

이 개선으로 초보자에게 더 신뢰할 수 있는 추천을 제공할 수 있게 되었다.

# Reference

---

- [API Design Best Practices](https://swagger.io/resources/articles/best-practices-in-api-design/)
