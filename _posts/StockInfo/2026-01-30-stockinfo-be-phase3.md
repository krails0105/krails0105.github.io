---
title: "[StockInfo] BE Phase 3 - 차트와 검색 API"
categories:
  - StockInfo
tags:
  - [Java, Spring, API Design]
---

# Introduction

---

Phase 3에서는 시각적 정보 제공을 위한 **차트 API**와 종목 찾기를 위한 **검색 API 확장**을 구현했다. Strategy 패턴을 활용한 ChartDataProvider와 키워드 기반 검색을 다룬다.

# ChartDataProvider 인터페이스

---

## 설계 의도

차트 데이터 소스는 개발/운영 환경에 따라 달라진다:
- 개발: Mock 데이터 (고정 패턴)
- 운영: KRX/외부 API (실시간)

Provider 패턴으로 추상화하여 환경별 구현체를 쉽게 전환한다.

## 인터페이스 정의

```java
// ChartDataProvider.java
public interface ChartDataProvider {

  /**
   * 종목 차트 데이터 조회
   *
   * @param stockCode 종목 코드 (예: "005930")
   * @param range 기간 ("1D", "1W", "1M", "3M", "1Y")
   * @return ChartResponse 차트 데이터
   */
  ChartResponse getChartData(String stockCode, String range);
}
```

## Response DTO

```java
@Getter
@Builder
public class ChartResponse {
  private List<DataPoint> dataPoints;
  private ChartMeta meta;

  @Getter
  @Builder
  public static class DataPoint {
    private String date;      // "2024-01-30T09:00:00"
    private int price;        // 71000
    private Long volume;      // 거래량 (선택)
  }

  @Getter
  @Builder
  public static class ChartMeta {
    private String asOf;      // 기준 시각
    private String source;    // "MOCK" or "KRX"
    private String range;     // "1M"
  }
}
```

# MockChartDataProvider (개발용)

---

개발 환경에서 사용하는 Mock 구현체다. 기간별로 다른 개수의 데이터 포인트를 생성한다.

```java
@Service
@Profile("local")
public class MockChartDataProvider implements ChartDataProvider {

  @Override
  public ChartResponse getChartData(String stockCode, String range) {
    int basePrice = getBasePrice(stockCode);
    List<ChartResponse.DataPoint> dataPoints = generateMockData(basePrice, range);

    return ChartResponse.builder()
        .dataPoints(dataPoints)
        .meta(ChartResponse.ChartMeta.builder()
            .asOf(LocalDateTime.now().toString())
            .source("MOCK")
            .range(range)
            .build())
        .build();
  }

  private int getBasePrice(String stockCode) {
    // 종목코드별 기본 가격 (Mock)
    return switch (stockCode) {
      case "005930" -> 71000;  // 삼성전자
      case "000660" -> 180000; // SK하이닉스
      default -> 50000;
    };
  }

  private List<ChartResponse.DataPoint> generateMockData(int basePrice, String range) {
    int count = getDataPointCount(range);
    List<ChartResponse.DataPoint> points = new ArrayList<>();
    Random random = new Random();

    LocalDateTime now = LocalDateTime.now();

    for (int i = count - 1; i >= 0; i--) {
      LocalDateTime date = calculateDate(now, range, i);
      // 랜덤 변동 (-3% ~ +3%)
      double variation = 1 + (random.nextDouble() - 0.5) * 0.06;
      int price = (int) (basePrice * variation);

      points.add(ChartResponse.DataPoint.builder()
          .date(date.toString())
          .price(price)
          .build());
    }

    return points;
  }

  /** 기간별 데이터 포인트 수 */
  private int getDataPointCount(String range) {
    return switch (range) {
      case "1D" -> 14;   // 30분 단위
      case "1W" -> 5;    // 일 단위
      case "1M" -> 20;   // 일 단위
      case "3M" -> 60;   // 일 단위
      case "1Y" -> 52;   // 주 단위
      default -> 20;
    };
  }
}
```

# KrxChartDataProvider (운영용)

---

운영 환경에서 사용하는 KRX API 연동 구현체다. (현재는 stub)

```java
@Service
@Profile("prod")
@RequiredArgsConstructor
public class KrxChartDataProvider implements ChartDataProvider {

  private final RestClient krxRestClient;

  @Override
  public ChartResponse getChartData(String stockCode, String range) {
    // TODO: 실제 KRX API 호출 구현
    // 현재는 MockChartDataProvider와 동일한 로직 사용
    throw new UnsupportedOperationException("KRX chart API not implemented yet");
  }
}
```

# Chart API 엔드포인트

---

```java
@RestController
@RequestMapping("/api/stocks")
@RequiredArgsConstructor
public class StockController {

  private final ChartDataProvider chartDataProvider;

  /**
   * 종목 차트 데이터 조회
   *
   * @param code 종목 코드
   * @param range 기간 (1D, 1W, 1M, 3M, 1Y)
   */
  @GetMapping("/{code}/chart")
  public ChartResponse getStockChart(
      @PathVariable String code,
      @RequestParam(defaultValue = "1M") String range) {

    // range 검증
    List<String> validRanges = List.of("1D", "1W", "1M", "3M", "1Y");
    if (!validRanges.contains(range)) {
      throw new IllegalArgumentException("Invalid range: " + range);
    }

    return chartDataProvider.getChartData(code, range);
  }
}
```

## API 명세

| Method | Endpoint | Parameters | Response |
|--------|----------|------------|----------|
| GET | `/api/stocks/{code}/chart` | `range` (1D/1W/1M/3M/1Y) | ChartResponse |

## 응답 예시

```json
{
  "dataPoints": [
    { "date": "2024-01-29T00:00:00", "price": 70500 },
    { "date": "2024-01-30T00:00:00", "price": 71000 },
    { "date": "2024-01-31T00:00:00", "price": 71200 }
  ],
  "meta": {
    "asOf": "2024-01-31T15:30:00",
    "source": "MOCK",
    "range": "1M"
  }
}
```

# Search API 확장

---

## 기존 검색 API

종목명/코드로 검색하여 일치하는 종목 목록을 반환한다.

```java
@GetMapping("/search")
public List<StockScoreDto> searchStocks(
    @RequestParam String keyword) {
  return stockDataProvider.searchStocks(keyword);
}
```

## MockStockDataProvider 검색 구현

```java
@Override
public List<StockScoreDto> searchStocks(String keyword) {
  if (keyword == null || keyword.isBlank()) {
    return List.of();
  }

  String lowerKeyword = keyword.toLowerCase().trim();

  return getAllStockScores().stream()
      .filter(stock ->
          stock.getName().toLowerCase().contains(lowerKeyword) ||
          stock.getCode().contains(lowerKeyword))
      .limit(20)  // 최대 20개
      .toList();
}
```

## 40+ 종목 매핑

주요 종목에 대해 다양한 검색어를 지원한다.

```java
// NewsTaggerService.java에서 재사용
private static final Map<String, String> STOCK_NAME_CODE_MAP = Map.ofEntries(
    // 정식 명칭
    Map.entry("삼성전자", "005930"),
    Map.entry("SK하이닉스", "000660"),
    Map.entry("현대자동차", "005380"),

    // 약칭/별칭
    Map.entry("하이닉스", "000660"),
    Map.entry("현대차", "005380"),
    Map.entry("삼바", "207940"),      // 삼성바이오로직스

    // 영문
    Map.entry("NAVER", "035420"),
    Map.entry("네이버", "035420"),

    // 총 40+ 종목
    // ...
);
```

## KrxStockDataProvider 검색 구현

실제 API에서는 KRX 데이터를 기반으로 검색한다.

```java
@Override
public List<StockScoreDto> searchStocks(String keyword) {
  List<KrxStockItem> allStocks = fetchAllStocks();

  return allStocks.stream()
      .filter(stock ->
          stock.getISU_NM().contains(keyword) ||
          stock.getISU_CD().contains(keyword))
      .map(this::toStockScoreDto)
      .limit(20)
      .toList();
}
```

# StockService 통합

---

Controller에서 직접 Provider를 호출하지 않고 Service를 통해 통합한다.

```java
@Service
@RequiredArgsConstructor
public class StockService {

  private final StockDataProvider stockDataProvider;
  private final ChartDataProvider chartDataProvider;

  public List<StockScoreDto> searchStocks(String keyword) {
    return stockDataProvider.searchStocks(keyword);
  }

  public ChartResponse getChartData(String stockCode, String range) {
    return chartDataProvider.getChartData(stockCode, range);
  }

  public StockInfo getStockDetail(String stockCode) {
    return stockDataProvider.getStockById(stockCode);
  }
}
```

# Conclusion

---

Phase 3 차트와 검색 API의 핵심:

1. **ChartDataProvider**: Strategy 패턴으로 Mock/KRX 구현체 전환
2. **Chart API**: GET /api/stocks/{code}/chart?range=1M
3. **기간별 데이터 포인트**: 1D(14), 1W(5), 1M(20), 3M(60), 1Y(52)
4. **Search API**: 종목명/코드 검색, 40+ 종목 매핑

이 API들로 프론트엔드에서 차트 시각화와 종목 검색 기능을 구현할 수 있게 되었다.

# Reference

---

- [Strategy Pattern](https://refactoring.guru/design-patterns/strategy)
- [Spring Profiles](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.profiles)
