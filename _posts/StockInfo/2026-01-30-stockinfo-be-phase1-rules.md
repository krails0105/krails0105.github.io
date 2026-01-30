---
title: "[StockInfo] BE Phase 1 - Rule Engine 구현"
categories:
  - StockInfo
tags:
  - [Java, Spring, Business Logic]
---

# Introduction

---

초보자를 위한 주식 정보 서비스에서 가장 중요한 것은 **신뢰할 수 있는 종목 평가**다. 전문가가 일일이 종목을 분석할 수 없으니, 정량적 지표를 기반으로 자동으로 평가하는 **Rule Engine**을 구현했다.

이 글에서는 6단계 평가 파이프라인, 점수 시스템, 카드 슬롯 규칙, 템플릿 선택 로직을 다룬다.

# 6단계 평가 파이프라인

---

Rule Engine은 종목을 6단계로 순차 평가한다. 각 단계에서 트리거된 규칙(Rule)에 따라 긍정/주의 카드가 생성된다.

```
┌──────────────────────────────────────────────────────────────┐
│  1. HF (Hard Filters)  - 거래정지, 극단적 비유동성, 결측     │
│  2. M  (Momentum)      - 거래량, 가격 추세, 과열             │
│  3. N  (News)          - 뉴스 센티먼트                       │
│  4. P  (Profitability) - 실적, ROE                          │
│  5. V  (Valuation)     - PER/PBR vs 섹터 중앙값              │
│  6. S  (Stability)     - 변동성, 유동성                      │
└──────────────────────────────────────────────────────────────┘
```

## Phase A: Hard Filters (하드 필터)

**목적**: 즉각적인 리스크 감지. 여기서 걸리면 Top Picks 대상에서 제외.

| 규칙 ID | 조건 | 카드 내용 |
|---------|------|----------|
| HF-01 | 거래정지 또는 관리종목 | "거래정지 또는 관리종목 상태로 주의가 필요해요." |
| HF-02 | 유동성이 매우 낮음 | "유동성이 매우 낮아 거래에 어려움이 있을 수 있어요." |
| HF-03 | PER ≤ 0 또는 비정상 | "PER이 비정상이라 적자 가능성을 확인해 보세요." |
| HF-04 | 데이터 coverage < 0.7 | "분석에 필요한 정보가 일부 부족해요." |

```java
private void evaluateHardFilters(StockSignals signals, List<String> triggeredRules,
    List<ReasonCard> cautionCards, RuleFlags flags) {

  // HF-01: 거래정지/관리/상폐
  if (signals.isSuspended() || signals.isAdministrative()) {
    triggeredRules.add("HF-01");
    flags.topPicksEligible = false;
    flags.riskLevel = RiskLevel.HIGH;
    cautionCards.add(ReasonCard.builder()
        .key("HF-01")
        .category(Category.RISK)
        .polarity(Polarity.CAUTION)
        .text("거래정지 또는 관리종목 상태로 주의가 필요해요.")
        .strength(Strength.STRONG)
        .build());
  }

  // HF-02: 유동성 매우 낮음
  if (signals.hasLowLiquidity()) {
    triggeredRules.add("HF-02");
    cautionCards.add(/* ... */);
  }

  // HF-03: PER ≤ 0 또는 비정상
  if (signals.hasValuationAnomaly()) {
    triggeredRules.add("HF-03");
    flags.hasValuationAnomaly = true;
    cautionCards.add(/* ... */);
  }

  // HF-04: 결측 과다
  if (signals.getDataCoverage() < COVERAGE_LOW_THRESHOLD) {
    triggeredRules.add("HF-04");
    flags.hasLowCoverage = true;
    cautionCards.add(/* ... */);
  }
}
```

## Phase B: Momentum (과열/변동성)

**목적**: 단기 급등락, 과열 신호 감지

| 규칙 ID | 조건 | 카드 유형 |
|---------|------|----------|
| M-01 | volumeRatio ≥ 1.5 | POSITIVE |
| M-02 | 5일 수익률 상위 20% | POSITIVE |
| M-04 | 급등 + volumeRatio ≥ 2.0 | CAUTION |
| M-05 | 급락 또는 변동성 급증 | CAUTION |

```java
// M-04: 급등 + 거래량 폭증
if (signals.getVolumeRatio() != null
    && signals.getVolumeRatio() >= VOLUME_RATIO_OVERHEAT
    && signals.getChangeRate() > 5.0) {
  triggeredRules.add("M-04");
  flags.hasOverheat = true;
  cautionCards.add(ReasonCard.builder()
      .key("M-04")
      .category(Category.MOMENTUM)
      .polarity(Polarity.CAUTION)
      .text("급등 + 거래량 폭증이라 조정이 와도 이상하지 않은 구간이에요.")
      .strength(Strength.STRONG)
      .build());
}
```

## Phase C: News (뉴스)

**목적**: 최근 뉴스의 긍정/부정 신호 반영

| 규칙 ID | 조건 | 카드 유형 |
|---------|------|----------|
| N-01 | 긍정 뉴스 (EARNINGS, CONTRACT, BUYBACK_DIVIDEND) | POSITIVE |
| N-02 | 부정 뉴스 (REGULATION_RISK) | CAUTION |

```java
// N-01: 긍정 뉴스 (부정 뉴스가 없을 때만)
if (hasHighPositive && !hasHighNegative) {
  triggeredRules.add("N-01");
  positiveCards.add(ReasonCard.builder()
      .key("N-01")
      .category(Category.NEWS)
      .polarity(Polarity.POSITIVE)
      .text(String.format("최근 %s 긍정 이슈가 있어 단기 촉매가 될 수 있어요.", tag))
      .strength(Strength.MEDIUM)
      .build());
}
```

## Phase D: Fundamentals (실적/수익성)

**목적**: 기업의 체력 평가

| 규칙 ID | 조건 | 카드 유형 |
|---------|------|----------|
| P-01 | 실적 흐름 IMPROVING | POSITIVE |
| P-02 | 실적 흐름 DECLINING | CAUTION |
| P-03 | ROE ≥ 섹터 중앙값 × 1.2 | POSITIVE |
| P-05 | 적자/마진 악화 | CAUTION |

## Phase E: Valuation (밸류에이션)

**목적**: 섹터 대비 고평가/저평가 판단

```java
// V-01: PER 저평가
if (per != null && sectorMedianPer != null
    && per > 0 && per <= sectorMedianPer * PER_LOW_RATIO) {
  triggeredRules.add("V-01");
  positiveCards.add(ReasonCard.builder()
      .key("V-01")
      .category(Category.VALUATION)
      .polarity(Polarity.POSITIVE)
      .text("섹터 대비 PER이 낮아 가격 부담이 덜한 편이에요.")
      .strength(Strength.MEDIUM)
      .evidence(Map.of("per", per, "sectorMedianPer", sectorMedianPer))
      .build());
}
```

**임계치 상수**:
```java
public static final double PER_LOW_RATIO = 0.8;   // 저평가 기준
public static final double PER_HIGH_RATIO = 1.3;  // 고평가 기준
public static final double PBR_LOW_RATIO = 0.8;
public static final double PBR_HIGH_RATIO = 1.3;
```

## Phase F: Stability (안정성)

**목적**: 초보자에게 적합한 안정적인 종목 식별

| 규칙 ID | 조건 | 카드 유형 |
|---------|------|----------|
| S-01 | 변동성 ≤ 섹터 중앙값 × 0.8 | POSITIVE |
| S-02 | 변동성 ≥ 섹터 중앙값 × 1.3 | CAUTION |
| S-03 | 유동성 점수 > 0.7 | POSITIVE |

# 점수 시스템

---

## 점수 계산

기본 점수는 등락률 기반으로 계산하고, 리스크 플래그에 따라 상한을 조정한다.

```java
private int calculateBaseScore(StockSignals signals) {
  double changeRate = signals.getChangeRate();
  int score = (int) ((changeRate + 5) * 10);
  return Math.max(0, Math.min(100, score));
}

// 리스크 플래그에 따른 조정
if (flags.riskLevel == RiskLevel.HIGH) {
  baseScore = Math.min(baseScore, 30);
} else if (flags.hasOverheat || flags.hasNegativeNews) {
  baseScore = Math.min(baseScore, 50);
}
```

## 등급 레이블

```java
public enum ScoreLabel {
  STRONG,   // 70-100점
  NEUTRAL,  // 40-69점
  WEAK      // 0-39점
}
```

# 카드 슬롯 규칙

---

초보자에게 너무 많은 정보를 주면 혼란스럽다. 카드 개수를 제한하고 우선순위를 정했다.

## 긍정 카드 (Positive)

- **기본**: 최대 3개
- **coverage < 0.7**: 최대 2개 (정보 부족 시 신중하게)
- **카테고리 다양성 유지**: 동일 카테고리 중복 방지

```java
private List<ReasonCard> selectPositiveCards(List<ReasonCard> cards, double coverage) {
  int maxCards = coverage < COVERAGE_LOW_THRESHOLD
      ? MAX_POSITIVE_CARDS_LOW_COVERAGE  // 2개
      : MAX_POSITIVE_CARDS;              // 3개

  // 강도 순으로 정렬 후 카테고리 다양성 유지하며 선택
  // ...
}
```

## 주의 카드 (Caution)

- **최소 1개 보장**: 초보자 보호를 위해 항상 주의 카드 1개 이상
- **리스크 상황**: 최대 2개
- **우선순위**: RISK > MOMENTUM > NEWS > FUNDAMENTALS > VALUATION

```java
// 최소 caution 1개 보장
if (finalCaution.isEmpty()) {
  finalCaution.add(ReasonCard.builder()
      .key("DEFAULT")
      .category(Category.RISK)
      .text("투자 판단 전 본인만의 기준을 꼭 확인하세요.")
      .strength(Strength.WEAK)
      .build());
}
```

# 템플릿 선택 로직

---

트리거된 규칙들을 종합하여 5가지 템플릿 중 하나를 선택한다.

## 템플릿 종류

| 템플릿 | 성격 | 대표 헤드라인 |
|--------|------|--------------|
| E (Risk) | 리스크형 | "리스크 신호가 있어 관망이 기본이에요." |
| B (Momentum) | 모멘텀형 | "추세가 강해서 단기 관찰 우선순위가 높은 종목이에요." |
| D (Growth) | 성장형 | "실적 흐름이 좋아 유력 후보로 살펴볼 만해요." |
| A (Value) | 밸류형 | "섹터 대비 부담이 낮아 우선 검토할 만한 후보예요." |
| C (Stable) | 안정형 | "초보자가 우선 검토하기 좋은 후보예요." |

## 선택 우선순위

**E > B > D > A > C**

```java
private Template pickTemplate(List<String> triggeredRules, StockSignals signals, RuleFlags flags) {
  // E: 리스크형 - 하드필터/과열/부정뉴스
  if (flags.riskLevel == RiskLevel.HIGH || flags.hasOverheat || flags.hasNegativeNews) {
    return Template.E_RISK;
  }

  // B: 모멘텀형 - 거래량/수익률 강세
  boolean hasMomentum = triggeredRules.contains("M-01") || triggeredRules.contains("M-02");
  if (hasMomentum && !flags.hasLowCoverage) {
    return Template.B_MOMENTUM;
  }

  // D: 성장형 - 실적 개선
  if (triggeredRules.contains("P-01") || triggeredRules.contains("P-03")) {
    return Template.D_GROWTH;
  }

  // A: 밸류형 - PER/PBR 저평가
  if (triggeredRules.contains("V-01") || triggeredRules.contains("V-03")) {
    return Template.A_VALUE;
  }

  // C: 안정형 - 기본
  return Template.C_STABLE;
}
```

## 톤 매칭 헤드라인

점수와 coverage에 따라 헤드라인 톤을 조절한다.

| 조건 | 톤 | 예시 |
|------|----|----|
| score ≥ 70 & coverage ≥ 0.7 | 강한 톤 | "우선 검토할 만한 유력 후보" |
| 50 ≤ score < 70 | 중간 톤 | "관찰 리스트 상단에 올려둘 만해요" |
| score < 50 or coverage < 0.7 | 조건부 톤 | "확인 후 접근이 좋아요" |

# Conclusion

---

Stock-Info Rule Engine의 핵심 설계를 정리하면:

1. **6단계 평가 파이프라인**: HF → M → N → P → V → S 순서로 체계적 평가
2. **점수 시스템**: 0-100점, STRONG/NEUTRAL/WEAK 등급
3. **카드 슬롯 규칙**: 긍정 2-3개, 주의 1-2개로 정보 과부하 방지
4. **템플릿 선택**: E(리스크) > B(모멘텀) > D(성장) > A(밸류) > C(안정) 우선순위

이 구조 덕분에 종목 평가가 일관되고 설명 가능해졌다. 각 규칙의 임계치는 운영 데이터를 보며 튜닝할 수 있다.

# Reference

---

- [Rule Engine Pattern](https://martinfowler.com/bliki/RulesEngine.html)
