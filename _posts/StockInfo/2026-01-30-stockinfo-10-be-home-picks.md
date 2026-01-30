---
title: "[StockInfo] 10. Home Picks API - 다양성 있는 추천 시스템"
categories:
  - StockInfo
tags:
  - [Java, Spring, Algorithm]
---

# Introduction

---

홈 화면에 "오늘 주목할 종목"을 보여주고 싶습니다. 단순히 점수 높은 종목만 보여주면 될까요?

점수만으로 선정하면 **비슷한 종목**만 나올 수 있습니다. 예를 들어, 반도체 업황이 좋으면 삼성전자, SK하이닉스, DB하이텍이 모두 상위에 올라옵니다.

**다양성**을 확보하면서도 **품질 높은** 추천을 하려면 어떻게 해야 할까요?

# 4-Bucket 선택 전략

---

## 다양한 관점의 추천

사용자마다 관심사가 다릅니다:
- "안정적인 종목을 원해요" → **STABLE**
- "업종 대표 종목이 궁금해요" → **REPRESENTATIVE**
- "요즘 뜨는 종목은?" → **MOMENTUM**
- "저평가된 종목 찾아주세요" → **VALUE**

4가지 버킷(Bucket)에서 골고루 선정합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│                     4-Bucket 선택 전략                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [STABLE]         저변동성 + 고유동성 + 흑자                    │
│       ↓           → 위험 회피형 투자자                         │
│                                                                  │
│  [REPRESENTATIVE] 섹터 상위 + 시총 대형                        │
│       ↓           → 업종 대표주 관심                           │
│                                                                  │
│  [MOMENTUM]       거래량 급증 + 가격 상승                       │
│       ↓           → 모멘텀 투자자                              │
│                                                                  │
│  [VALUE]          PER/PBR 저평가 + 흑자                        │
│       ↓           → 가치 투자자                                │
│                                                                  │
│  ────────────────────────────────────────────────────────────   │
│                                                                  │
│  다양성 제약 적용:                                               │
│  • 같은 섹터에서 최대 2개                                       │
│  • 같은 버킷에서 최대 3개                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

# HomePicksService 구현

---

## 전체 구조

```java
/**
 * 홈 Watchlist Picks 서비스.
 *
 * 4가지 버킷에서 다양성 있게 종목을 선정합니다.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class HomePicksService {

    private final StockDataProvider stockDataProvider;
    private final RuleEngineService ruleEngineService;

    // 다양성 제약
    private static final int MAX_PER_SECTOR = 2;   // 섹터당 최대
    private static final int MAX_PER_BUCKET = 3;   // 버킷당 최대
    private static final int DEFAULT_SIZE = 8;     // 기본 선정 개수

    /**
     * 홈 Picks 조회
     *
     * @param size 선정 개수 (5~10, 기본 8)
     * @param preset 프리셋 (default/stable/momentum/value)
     */
    public HomePicksResponse getHomePicks(int size, String preset) {
        // 1. 전체 종목 조회 (점수 포함)
        List<StockWithScore> candidates = getCandidates();

        // 2. 기본 필터 (흑자, 거래량 충분)
        candidates = applyBaseFilters(candidates);

        // 3. 프리셋에 따른 가중치 조정
        Map<Bucket, Double> weights = getWeights(preset);

        // 4. 버킷별 점수 계산
        Map<Bucket, List<StockWithScore>> bucketCandidates =
            scoreBuckets(candidates, weights);

        // 5. 다양성 제약 적용하며 선정
        List<HomePickItem> picks = selectWithDiversity(
            bucketCandidates, size);

        return HomePicksResponse.builder()
            .picks(picks)
            .updatedAt(LocalDateTime.now())
            .totalCandidates(candidates.size())
            .build();
    }
}
```

## 버킷 정의

```java
/**
 * 선정 버킷 Enum
 */
public enum Bucket {
    STABLE,         // 안정형
    REPRESENTATIVE, // 대표주
    MOMENTUM,       // 모멘텀
    VALUE           // 가치
}
```

## 기본 필터

```java
/**
 * 기본 필터 적용
 *
 * 흑자 기업, 최소 거래량 충족
 */
private List<StockWithScore> applyBaseFilters(
        List<StockWithScore> candidates) {

    return candidates.stream()
        .filter(s -> s.getEps() != null && s.getEps() > 0)  // 흑자
        .filter(s -> s.getVolume() >= 10000)                // 거래량
        .toList();
}
```

## 버킷별 점수 계산

```java
/**
 * 버킷별 점수 계산
 */
private Map<Bucket, List<StockWithScore>> scoreBuckets(
        List<StockWithScore> candidates,
        Map<Bucket, Double> weights) {

    Map<Bucket, List<StockWithScore>> result = new EnumMap<>(Bucket.class);

    // STABLE 버킷: 저변동성 + 고유동성
    result.put(Bucket.STABLE, candidates.stream()
        .filter(s -> s.getVolatility() < 3.0)      // 변동성 3% 미만
        .filter(s -> s.getMarketCap() > 10000)     // 시총 1조 이상
        .sorted(Comparator
            .comparingDouble(StockWithScore::getVolatility))  // 낮은 순
        .toList());

    // REPRESENTATIVE 버킷: 섹터 상위 + 대형
    result.put(Bucket.REPRESENTATIVE, candidates.stream()
        .filter(s -> isSectorTop3(s))              // 섹터 내 TOP 3
        .filter(s -> s.getMarketCap() > 50000)     // 시총 5조 이상
        .sorted(Comparator
            .comparingLong(StockWithScore::getMarketCap)
            .reversed())                            // 높은 순
        .toList());

    // MOMENTUM 버킷: 거래량 급증 + 가격 상승
    result.put(Bucket.MOMENTUM, candidates.stream()
        .filter(s -> s.getVolumeRatio() > 1.5)     // 평균 대비 1.5배
        .filter(s -> s.getChangeRate() > 0)        // 상승
        .sorted(Comparator
            .comparingDouble(StockWithScore::getVolumeRatio)
            .reversed())                            // 높은 순
        .toList());

    // VALUE 버킷: PER/PBR 저평가
    result.put(Bucket.VALUE, candidates.stream()
        .filter(s -> s.getPer() != null && s.getPer() < 10)  // PER 10 미만
        .filter(s -> s.getPbr() != null && s.getPbr() < 1)   // PBR 1 미만
        .sorted(Comparator
            .comparingDouble(StockWithScore::getPer))         // 낮은 순
        .toList());

    return result;
}
```

## 프리셋별 가중치

```java
/**
 * 프리셋에 따른 버킷 가중치
 */
private Map<Bucket, Double> getWeights(String preset) {
    return switch (preset.toLowerCase()) {
        case "stable" -> Map.of(
            Bucket.STABLE, 0.5,
            Bucket.REPRESENTATIVE, 0.3,
            Bucket.MOMENTUM, 0.1,
            Bucket.VALUE, 0.1
        );
        case "momentum" -> Map.of(
            Bucket.STABLE, 0.1,
            Bucket.REPRESENTATIVE, 0.2,
            Bucket.MOMENTUM, 0.5,
            Bucket.VALUE, 0.2
        );
        case "value" -> Map.of(
            Bucket.STABLE, 0.1,
            Bucket.REPRESENTATIVE, 0.2,
            Bucket.MOMENTUM, 0.2,
            Bucket.VALUE, 0.5
        );
        default -> Map.of(  // "default" - 균등 분배
            Bucket.STABLE, 0.25,
            Bucket.REPRESENTATIVE, 0.25,
            Bucket.MOMENTUM, 0.25,
            Bucket.VALUE, 0.25
        );
    };
}
```

# 다양성 제약 적용

---

## 선정 알고리즘

```java
/**
 * 다양성 제약 적용하며 선정
 *
 * 제약:
 * - 같은 섹터에서 최대 2개
 * - 같은 버킷에서 최대 3개
 */
private List<HomePickItem> selectWithDiversity(
        Map<Bucket, List<StockWithScore>> bucketCandidates,
        int targetSize) {

    List<HomePickItem> selected = new ArrayList<>();

    // 섹터별 카운트
    Map<String, Integer> sectorCount = new HashMap<>();
    // 버킷별 카운트
    Map<Bucket, Integer> bucketCount = new EnumMap<>(Bucket.class);

    // 라운드 로빈으로 버킷 순회
    List<Bucket> bucketOrder = List.of(
        Bucket.STABLE, Bucket.REPRESENTATIVE,
        Bucket.MOMENTUM, Bucket.VALUE
    );

    // 버킷별 인덱스 (다음에 선택할 위치)
    Map<Bucket, Integer> bucketIndex = new EnumMap<>(Bucket.class);
    for (Bucket b : Bucket.values()) {
        bucketIndex.put(b, 0);
    }

    // 목표 개수 채울 때까지 반복
    int round = 0;
    while (selected.size() < targetSize && round < 100) {
        round++;

        for (Bucket bucket : bucketOrder) {
            if (selected.size() >= targetSize) break;

            // 버킷 제한 체크
            int currentBucketCount = bucketCount.getOrDefault(bucket, 0);
            if (currentBucketCount >= MAX_PER_BUCKET) continue;

            // 버킷의 후보 목록
            List<StockWithScore> candidates = bucketCandidates.get(bucket);
            int idx = bucketIndex.get(bucket);

            // 다음 유효한 후보 찾기
            while (idx < candidates.size()) {
                StockWithScore candidate = candidates.get(idx);
                idx++;

                // 이미 선정된 종목인지 체크
                if (isAlreadySelected(selected, candidate)) continue;

                // 섹터 제한 체크
                String sector = candidate.getSectorName();
                int currentSectorCount = sectorCount.getOrDefault(sector, 0);
                if (currentSectorCount >= MAX_PER_SECTOR) continue;

                // 선정!
                selected.add(toHomePickItem(candidate, bucket));
                sectorCount.merge(sector, 1, Integer::sum);
                bucketCount.merge(bucket, 1, Integer::sum);
                bucketIndex.put(bucket, idx);
                break;
            }
        }
    }

    return selected;
}

/**
 * 이미 선정된 종목인지 확인
 */
private boolean isAlreadySelected(
        List<HomePickItem> selected,
        StockWithScore candidate) {

    return selected.stream()
        .anyMatch(item -> item.getCode().equals(candidate.getCode()));
}

/**
 * HomePickItem 생성
 */
private HomePickItem toHomePickItem(StockWithScore stock, Bucket bucket) {
    return HomePickItem.builder()
        .code(stock.getCode())
        .name(stock.getName())
        .price(stock.getPrice())
        .changeRate(stock.getChangeRate())
        .score(stock.getScore())
        .label(stock.getLabel())
        .sectorName(stock.getSectorName())
        .bucket(bucket.name())
        .reason(getBucketReason(bucket, stock))
        .build();
}

/**
 * 버킷별 선정 이유
 */
private String getBucketReason(Bucket bucket, StockWithScore stock) {
    return switch (bucket) {
        case STABLE -> String.format(
            "안정적 (변동성 %.1f%%)", stock.getVolatility());
        case REPRESENTATIVE -> String.format(
            "%s 섹터 대표", stock.getSectorName());
        case MOMENTUM -> String.format(
            "거래량 %.1f배 급증", stock.getVolumeRatio());
        case VALUE -> String.format(
            "저평가 (PER %.1f)", stock.getPer());
    };
}
```

# 선정 결과 예시

---

## API 응답

```json
{
  "picks": [
    {
      "code": "005930",
      "name": "삼성전자",
      "price": 72500,
      "changeRate": 0.69,
      "score": 75,
      "label": "STRONG",
      "sectorName": "전기전자",
      "bucket": "REPRESENTATIVE",
      "reason": "전기전자 섹터 대표"
    },
    {
      "code": "035720",
      "name": "카카오",
      "price": 45000,
      "changeRate": -0.22,
      "score": 68,
      "label": "NEUTRAL",
      "sectorName": "서비스업",
      "bucket": "STABLE",
      "reason": "안정적 (변동성 2.1%)"
    },
    {
      "code": "005380",
      "name": "현대차",
      "price": 185000,
      "changeRate": 1.1,
      "score": 72,
      "label": "STRONG",
      "sectorName": "자동차",
      "bucket": "MOMENTUM",
      "reason": "거래량 2.3배 급증"
    },
    {
      "code": "086790",
      "name": "하나금융지주",
      "price": 52000,
      "changeRate": 0.38,
      "score": 70,
      "label": "STRONG",
      "sectorName": "금융",
      "bucket": "VALUE",
      "reason": "저평가 (PER 4.2)"
    }
    // ... 4개 더
  ],
  "updatedAt": "2026-01-30T09:00:00",
  "totalCandidates": 120
}
```

## 다양성 확보 결과

| 버킷 | 선정 종목 | 섹터 |
|------|----------|------|
| STABLE | 카카오 | 서비스업 |
| STABLE | 삼성생명 | 금융 |
| REPRESENTATIVE | 삼성전자 | 전기전자 |
| REPRESENTATIVE | LG화학 | 화학 |
| MOMENTUM | 현대차 | 자동차 |
| MOMENTUM | SK하이닉스 | 전기전자 |
| VALUE | 하나금융지주 | 금융 |
| VALUE | 기아 | 자동차 |

- 전기전자: 2개 (제한에 도달)
- 금융: 2개 (제한에 도달)
- 각 버킷: 2개씩 (균등 분배)

# Controller 연동

---

```java
@RestController
@RequestMapping("/api/home")
@RequiredArgsConstructor
public class HomeController {

    private final HomePicksService homePicksService;

    /**
     * 홈 Watchlist Picks 조회
     *
     * GET /api/home/picks?size=8&preset=default
     */
    @GetMapping("/picks")
    public HomePicksResponse getHomePicks(
            @RequestParam(defaultValue = "8") int size,
            @RequestParam(defaultValue = "default") String preset) {

        // 범위 제한 (5~10)
        size = Math.max(5, Math.min(10, size));

        return homePicksService.getHomePicks(size, preset);
    }
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| 4-Bucket | STABLE, REPRESENTATIVE, MOMENTUM, VALUE |
| 프리셋 | 버킷 가중치 조정 (stable, momentum, value, default) |
| 다양성 제약 | 섹터당 2개, 버킷당 3개 |
| 라운드 로빈 | 버킷을 순회하며 균등 선정 |

다양성 있는 추천 시스템의 핵심:
1. **다양한 관점**: 4가지 버킷으로 투자 스타일 반영
2. **제약 조건**: 섹터/버킷 편중 방지
3. **투명한 이유**: 선정 이유 명시

다음 글부터는 **Frontend 편**입니다. React의 기본 개념부터 시작합니다.

# Reference

---

- [Diversity in Recommendation Systems](https://dl.acm.org/doi/10.1145/3240323.3240372)
- [Multi-Armed Bandit for Recommendations](https://en.wikipedia.org/wiki/Multi-armed_bandit)
