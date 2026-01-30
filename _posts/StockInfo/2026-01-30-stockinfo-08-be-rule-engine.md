---
title: "[StockInfo] 08. Rule Engine - 종목 점수 계산 시스템"
categories:
  - StockInfo
tags:
  - [Java, Spring, Business Logic]
---

# Introduction

---

Stock-Info의 핵심 기능은 **종목 점수**입니다. "이 종목이 좋은가요?"라는 질문에 0-100점으로 답합니다.

하지만 "좋은 종목"의 기준은 무엇일까요? PER이 낮으면 좋은가요? 거래량이 많으면 좋은가요? 이 글에서는 Rule Engine이 어떤 규칙으로 종목을 평가하는지 알아봅니다.

# Rule Engine 개요

---

## 왜 Rule Engine인가?

주식 평가 기준은 **복잡하고 변할 수 있습니다**.

```java
// 나쁜 예: 하드코딩된 조건들
public int calculateScore(Stock stock) {
    int score = 50;
    if (stock.getPer() < 10) score += 10;
    if (stock.getPer() > 30) score -= 10;
    if (stock.getVolume() > 1000000) score += 5;
    // ... 수십 개의 조건이 뒤섞임
    return score;
}
```

문제점:
- 조건이 많아지면 관리 불가
- 어떤 조건이 적용되었는지 추적 어려움
- 조건 변경 시 영향도 파악 어려움

**Rule Engine**은 각 규칙을 **독립적인 단위**로 분리합니다.

## 6단계 평가 파이프라인

```
┌─────────────────────────────────────────────────────────────────┐
│                    종목 평가 파이프라인                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [HF] Hard Filters  →  거래정지, 극단적 비유동성 체크           │
│         ↓ (통과)                                                │
│  [M] Momentum       →  거래량, 가격 추세 평가                   │
│         ↓                                                        │
│  [N] News           →  뉴스 센티먼트 반영                       │
│         ↓                                                        │
│  [P] Profitability  →  실적, ROE 평가                           │
│         ↓                                                        │
│  [V] Valuation      →  PER/PBR vs 섹터 중앙값                   │
│         ↓                                                        │
│  [S] Stability      →  변동성, 유동성 평가                      │
│         ↓                                                        │
│      최종 점수 (0-100)                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

# 점수 시스템

---

## 점수 범위와 등급

| 점수 범위 | 등급 | 의미 |
|----------|------|------|
| 70-100 | STRONG | 긍정적 - 검토 추천 |
| 40-69 | NEUTRAL | 중립적 - 추가 분석 필요 |
| 0-39 | WEAK | 부정적 - 신중한 접근 |

## 기본 점수

모든 종목은 **50점**에서 시작합니다.

```java
public static final int BASE_SCORE = 50;
public static final int MAX_SCORE = 100;
public static final int MIN_SCORE = 0;
```

각 규칙이 조건에 따라 점수를 **가감**합니다.

# 규칙 상수 정의

---

## RuleConstants 클래스

모든 규칙의 임계값을 한 곳에서 관리합니다.

```java
/**
 * 규칙 엔진에서 사용하는 상수 정의.
 *
 * 임계값을 한 곳에서 관리하여 유지보수를 쉽게 합니다.
 */
public final class RuleConstants {

    private RuleConstants() {}  // 인스턴스화 방지

    // ===== 점수 범위 =====
    public static final int BASE_SCORE = 50;
    public static final int MAX_SCORE = 100;
    public static final int MIN_SCORE = 0;

    // ===== 등급 임계값 =====
    public static final int STRONG_THRESHOLD = 70;
    public static final int WEAK_THRESHOLD = 40;

    // ===== Hard Filter (HF) =====
    /** 거래정지 종목 제외 */
    public static final boolean HF_EXCLUDE_SUSPENDED = true;
    /** 최소 거래량 (극단적 비유동성 필터) */
    public static final long HF_MIN_VOLUME = 1000;

    // ===== Momentum (M) =====
    /** 거래량 급증 기준 (전일 대비 배수) */
    public static final double M_VOLUME_SURGE_RATIO = 2.0;
    /** 거래량 급증 보너스 점수 */
    public static final int M_VOLUME_SURGE_BONUS = 5;
    /** 가격 상승 추세 기준 (%) */
    public static final double M_PRICE_UP_THRESHOLD = 3.0;
    /** 가격 하락 추세 기준 (%) */
    public static final double M_PRICE_DOWN_THRESHOLD = -3.0;
    /** 추세 점수 */
    public static final int M_TREND_SCORE = 5;

    // ===== News (N) =====
    /** 긍정 뉴스 보너스 */
    public static final int N_POSITIVE_NEWS_BONUS = 3;
    /** 부정 뉴스 페널티 */
    public static final int N_NEGATIVE_NEWS_PENALTY = -5;
    /** 뉴스 반영 기간 (일) */
    public static final int N_NEWS_WINDOW_DAYS = 7;

    // ===== Profitability (P) =====
    /** 흑자 보너스 */
    public static final int P_PROFIT_BONUS = 10;
    /** 적자 페널티 */
    public static final int P_LOSS_PENALTY = -15;
    /** ROE 우수 기준 (%) */
    public static final double P_ROE_GOOD_THRESHOLD = 10.0;
    /** ROE 우수 보너스 */
    public static final int P_ROE_GOOD_BONUS = 5;

    // ===== Valuation (V) =====
    /** PER 저평가 기준 (섹터 중앙값 대비 비율) */
    public static final double V_PER_UNDERVALUED_RATIO = 0.7;
    /** PER 고평가 기준 */
    public static final double V_PER_OVERVALUED_RATIO = 1.5;
    /** PER 점수 */
    public static final int V_PER_SCORE = 8;
    /** PBR 저평가 기준 */
    public static final double V_PBR_UNDERVALUED = 1.0;
    /** PBR 점수 */
    public static final int V_PBR_SCORE = 5;

    // ===== Stability (S) =====
    /** 변동성 기준 (일간 변동률 %) */
    public static final double S_VOLATILITY_HIGH = 5.0;
    /** 변동성 페널티 */
    public static final int S_VOLATILITY_PENALTY = -5;
    /** 유동성 우수 기준 (시가총액, 억원) */
    public static final long S_MARKET_CAP_LARGE = 10000;
    /** 유동성 보너스 */
    public static final int S_LIQUIDITY_BONUS = 3;

    // ===== 카드 슬롯 =====
    public static final int MAX_POSITIVE_CARDS = 3;
    public static final int MIN_POSITIVE_CARDS = 2;
    public static final int MAX_CAUTION_CARDS = 2;
    public static final int MIN_CAUTION_CARDS = 1;
}
```

## 상수화의 장점

1. **한 곳에서 관리**: 임계값 변경 시 여기만 수정
2. **가독성**: 매직 넘버 대신 의미 있는 이름
3. **재사용**: 여러 곳에서 동일 기준 적용

# Rule Engine Service 구현

---

## 전체 구조

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class RuleEngineService {

    private final NewsAggregatorService newsService;
    private final SectorDataProvider sectorDataProvider;

    /**
     * 종목 인사이트(10초 요약) 생성
     */
    public StockInsight evaluateStock(StockInfo stock) {
        // 1. 규칙 평가 실행
        EvaluationResult result = runRules(stock);

        // 2. 카드 생성 (긍정/주의)
        List<ReasonCard> positiveCards = selectPositiveCards(result);
        List<ReasonCard> cautionCards = selectCautionCards(result);

        // 3. 헤드라인 생성
        String headline = generateHeadline(stock, result);

        // 4. 최종 인사이트 조합
        return buildInsight(stock, result, positiveCards,
                           cautionCards, headline);
    }

    /**
     * 모든 규칙 실행
     */
    private EvaluationResult runRules(StockInfo stock) {
        int score = BASE_SCORE;
        List<TriggeredRule> triggeredRules = new ArrayList<>();

        // HF: Hard Filters
        HardFilterResult hfResult = evaluateHardFilters(stock);
        if (hfResult.isFiltered()) {
            return EvaluationResult.filtered(hfResult.getReason());
        }

        // M: Momentum
        MomentumResult mResult = evaluateMomentum(stock);
        score += mResult.getScoreDelta();
        triggeredRules.addAll(mResult.getTriggeredRules());

        // N: News
        NewsResult nResult = evaluateNews(stock);
        score += nResult.getScoreDelta();
        triggeredRules.addAll(nResult.getTriggeredRules());

        // P: Profitability
        ProfitabilityResult pResult = evaluateProfitability(stock);
        score += pResult.getScoreDelta();
        triggeredRules.addAll(pResult.getTriggeredRules());

        // V: Valuation
        ValuationResult vResult = evaluateValuation(stock);
        score += vResult.getScoreDelta();
        triggeredRules.addAll(vResult.getTriggeredRules());

        // S: Stability
        StabilityResult sResult = evaluateStability(stock);
        score += sResult.getScoreDelta();
        triggeredRules.addAll(sResult.getTriggeredRules());

        // 점수 범위 제한
        score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

        return EvaluationResult.builder()
            .score(score)
            .label(calculateLabel(score))
            .triggeredRules(triggeredRules)
            .build();
    }
}
```

## 각 규칙의 구현

### HF: Hard Filters (하드 필터)

즉시 제외해야 할 종목을 걸러냅니다.

```java
/**
 * 하드 필터 - 거래정지, 극단적 비유동성 체크
 */
private HardFilterResult evaluateHardFilters(StockInfo stock) {
    // 거래정지 체크
    if (stock.isSuspended()) {
        return HardFilterResult.filtered("SUSPENDED");
    }

    // 극단적 비유동성 (거래량 1000주 미만)
    if (stock.getVolume() < HF_MIN_VOLUME) {
        return HardFilterResult.filtered("ILLIQUID");
    }

    return HardFilterResult.passed();
}
```

### M: Momentum (모멘텀)

거래량과 가격 추세를 평가합니다.

```java
/**
 * 모멘텀 평가 - 거래량 급증, 가격 추세
 */
private MomentumResult evaluateMomentum(StockInfo stock) {
    int scoreDelta = 0;
    List<TriggeredRule> rules = new ArrayList<>();

    // 거래량 급증 체크 (전일 대비 2배 이상)
    double volumeRatio = stock.getVolume() /
                         (double) stock.getAvgVolume();
    if (volumeRatio >= M_VOLUME_SURGE_RATIO) {
        scoreDelta += M_VOLUME_SURGE_BONUS;
        rules.add(new TriggeredRule("M_VOLUME_SURGE",
            "거래량 급증", "POSITIVE", M_VOLUME_SURGE_BONUS));
    }

    // 가격 추세 체크
    double changeRate = stock.getChangeRate();
    if (changeRate >= M_PRICE_UP_THRESHOLD) {
        scoreDelta += M_TREND_SCORE;
        rules.add(new TriggeredRule("M_PRICE_UP",
            "상승 추세", "POSITIVE", M_TREND_SCORE));
    } else if (changeRate <= M_PRICE_DOWN_THRESHOLD) {
        scoreDelta -= M_TREND_SCORE;
        rules.add(new TriggeredRule("M_PRICE_DOWN",
            "하락 추세", "NEGATIVE", -M_TREND_SCORE));
    }

    return new MomentumResult(scoreDelta, rules);
}
```

### P: Profitability (수익성)

실적과 ROE를 평가합니다.

```java
/**
 * 수익성 평가 - 흑자/적자, ROE
 */
private ProfitabilityResult evaluateProfitability(StockInfo stock) {
    int scoreDelta = 0;
    List<TriggeredRule> rules = new ArrayList<>();

    // 흑자/적자 체크
    Double eps = stock.getEps();
    if (eps != null) {
        if (eps > 0) {
            scoreDelta += P_PROFIT_BONUS;
            rules.add(new TriggeredRule("P_PROFIT",
                "흑자 기업", "POSITIVE", P_PROFIT_BONUS));
        } else {
            scoreDelta += P_LOSS_PENALTY;
            rules.add(new TriggeredRule("P_LOSS",
                "적자 기업", "NEGATIVE", P_LOSS_PENALTY));
        }
    }

    // ROE 체크
    Double roe = stock.getRoe();
    if (roe != null && roe >= P_ROE_GOOD_THRESHOLD) {
        scoreDelta += P_ROE_GOOD_BONUS;
        rules.add(new TriggeredRule("P_ROE_GOOD",
            "ROE 우수 (10% 이상)", "POSITIVE", P_ROE_GOOD_BONUS));
    }

    return new ProfitabilityResult(scoreDelta, rules);
}
```

### V: Valuation (밸류에이션)

PER/PBR을 섹터 평균과 비교합니다.

```java
/**
 * 밸류에이션 평가 - PER/PBR vs 섹터 중앙값
 */
private ValuationResult evaluateValuation(StockInfo stock) {
    int scoreDelta = 0;
    List<TriggeredRule> rules = new ArrayList<>();

    // 섹터 중앙값 조회
    SectorMedian median = sectorDataProvider
        .getSectorMedian(stock.getSectorName());

    // PER 평가
    Double per = stock.getPer();
    if (per != null && median.getPer() != null) {
        double ratio = per / median.getPer();

        if (ratio <= V_PER_UNDERVALUED_RATIO) {
            // 섹터 중앙값의 70% 이하 → 저평가
            scoreDelta += V_PER_SCORE;
            rules.add(new TriggeredRule("V_PER_LOW",
                "PER 저평가 (섹터 대비)", "POSITIVE", V_PER_SCORE));
        } else if (ratio >= V_PER_OVERVALUED_RATIO) {
            // 섹터 중앙값의 150% 이상 → 고평가
            scoreDelta -= V_PER_SCORE;
            rules.add(new TriggeredRule("V_PER_HIGH",
                "PER 고평가 (섹터 대비)", "NEGATIVE", -V_PER_SCORE));
        }
    }

    // PBR 평가
    Double pbr = stock.getPbr();
    if (pbr != null && pbr < V_PBR_UNDERVALUED) {
        scoreDelta += V_PBR_SCORE;
        rules.add(new TriggeredRule("V_PBR_LOW",
            "PBR 1 미만 (자산 대비 저평가)", "POSITIVE", V_PBR_SCORE));
    }

    return new ValuationResult(scoreDelta, rules);
}
```

# 카드 선택 로직

---

## 슬롯 규칙

10초 요약에는 **제한된 개수의 카드**만 표시합니다.

```
긍정 카드: 2~3개
주의 카드: 1~2개
```

너무 많은 정보는 오히려 혼란을 줍니다.

## 카드 우선순위 선택

```java
/**
 * 긍정 카드 선택 (최대 3개)
 *
 * 우선순위:
 * 1. 점수 영향이 큰 규칙
 * 2. 초보자에게 중요한 규칙 (수익성 > 밸류에이션 > 모멘텀)
 */
private List<ReasonCard> selectPositiveCards(EvaluationResult result) {
    return result.getTriggeredRules().stream()
        .filter(r -> "POSITIVE".equals(r.getPolarity()))
        .sorted(Comparator
            .comparingInt(TriggeredRule::getScoreDelta).reversed()
            .thenComparing(this::getRulePriority))
        .limit(MAX_POSITIVE_CARDS)
        .map(this::toReasonCard)
        .toList();
}

/**
 * 주의 카드 선택 (최대 2개)
 */
private List<ReasonCard> selectCautionCards(EvaluationResult result) {
    return result.getTriggeredRules().stream()
        .filter(r -> "NEGATIVE".equals(r.getPolarity()))
        .sorted(Comparator
            .comparingInt(TriggeredRule::getScoreDelta))  // 오름차순 (큰 페널티 우선)
        .limit(MAX_CAUTION_CARDS)
        .map(this::toReasonCard)
        .toList();
}

/**
 * 규칙 우선순위 (낮을수록 우선)
 */
private int getRulePriority(TriggeredRule rule) {
    return switch (rule.getCategory()) {
        case "P" -> 1;  // 수익성 (초보자에게 가장 중요)
        case "V" -> 2;  // 밸류에이션
        case "M" -> 3;  // 모멘텀
        case "S" -> 4;  // 안정성
        case "N" -> 5;  // 뉴스
        default -> 10;
    };
}
```

# 헤드라인 생성

---

## 템플릿 기반 생성

점수와 트리거된 규칙에 따라 **적절한 헤드라인**을 선택합니다.

```java
/**
 * 헤드라인 생성
 *
 * 템플릿 우선순위: E > B > D > A > C
 * E: 적자 + 저점수 (경고)
 * B: 흑자 + 저평가 (긍정)
 * D: 흑자만 (중립-긍정)
 * A: 저평가만 (중립)
 * C: 기본 (중립)
 */
private String generateHeadline(StockInfo stock,
                                EvaluationResult result) {
    boolean hasProfit = hasRule(result, "P_PROFIT");
    boolean hasLoss = hasRule(result, "P_LOSS");
    boolean hasUndervalued = hasRule(result, "V_PER_LOW")
                          || hasRule(result, "V_PBR_LOW");
    int score = result.getScore();

    // E: 적자 + 저점수 → 강한 경고
    if (hasLoss && score < WEAK_THRESHOLD) {
        return "적자 지속 중, 신중한 접근이 필요합니다";
    }

    // B: 흑자 + 저평가 → 긍정적
    if (hasProfit && hasUndervalued) {
        return "실적 안정적, 밸류에이션 매력 있습니다";
    }

    // D: 흑자만
    if (hasProfit) {
        return "흑자 기업, 추가 분석 후 검토해보세요";
    }

    // A: 저평가만
    if (hasUndervalued) {
        return "업종 대비 저평가 상태입니다";
    }

    // C: 기본
    if (score >= STRONG_THRESHOLD) {
        return "전반적으로 양호한 지표를 보입니다";
    } else if (score < WEAK_THRESHOLD) {
        return "일부 지표가 부정적, 추가 확인 필요";
    } else {
        return "중립적인 상태, 추가 분석이 필요합니다";
    }
}

private boolean hasRule(EvaluationResult result, String ruleId) {
    return result.getTriggeredRules().stream()
        .anyMatch(r -> ruleId.equals(r.getId()));
}
```

# 최종 인사이트 조합

---

```java
/**
 * 최종 StockInsight 빌드
 */
private StockInsight buildInsight(StockInfo stock,
                                   EvaluationResult result,
                                   List<ReasonCard> positiveCards,
                                   List<ReasonCard> cautionCards,
                                   String headline) {
    String tone = result.getScore() >= NEUTRAL_THRESHOLD
        ? "ACTIVE_GUIDE"
        : "CAUTIOUS_GUIDE";

    String actionHint = generateActionHint(result);

    return StockInsight.builder()
        .entity(EntityInfo.builder()
            .code(stock.getCode())
            .name(stock.getName())
            .build())
        .score(ScoreInfo.builder()
            .value(result.getScore())
            .grade(result.getLabel())
            .build())
        .summary(SummaryInfo.builder()
            .headline(headline)
            .tone(tone)
            .actionHint(ActionHint.builder()
                .text(actionHint)
                .build())
            .build())
        .reasons(ReasonsInfo.builder()
            .positive(positiveCards)
            .caution(cautionCards)
            .triggeredRules(result.getTriggeredRules().stream()
                .map(TriggeredRule::getId)
                .toList())
            .build())
        .meta(MetaInfo.builder()
            .asOf(LocalDateTime.now())
            .sources(List.of("KRX", "뉴스"))
            .coverage(calculateCoverage(stock))
            .build())
        .build();
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| Rule Engine | 비즈니스 규칙을 독립적 단위로 관리 |
| 6단계 파이프라인 | HF → M → N → P → V → S |
| 점수 시스템 | 0-100점, STRONG/NEUTRAL/WEAK |
| 카드 슬롯 | 긍정 2-3개, 주의 1-2개 |
| 헤드라인 템플릿 | 조건 기반 문장 선택 |

Rule Engine을 통해:
- 각 규칙을 **독립적으로 테스트** 가능
- 임계값 **조정이 용이**
- 새 규칙 **추가가 쉬움**

다음 글에서는 **뉴스 파이프라인**에 대해 알아봅니다.

# Reference

---

- [Rule Engine Pattern](https://martinfowler.com/bliki/RulesEngine.html)
- [Stock Valuation Metrics](https://www.investopedia.com/terms/v/valuation.asp)
