---
title: "[StockInfo] 04. Provider 패턴 - Strategy로 데이터 소스 추상화"
categories:
  - StockInfo
tags:
  - [Java, Spring, Design Pattern, Strategy]
---

# Introduction

---

Stock-Info는 **개발 환경**에서는 Mock 데이터를, **운영 환경**에서는 실제 KRX(한국거래소) API를 사용합니다.

코드 한 줄 수정 없이 환경에 따라 데이터 소스를 바꾸려면 어떻게 해야 할까요? 바로 **Provider 패턴**과 **Strategy 패턴**이 답입니다.

# Strategy 패턴이란?

---

## 기본 개념

Strategy 패턴은 **알고리즘(또는 동작)을 캡슐화**하여 교체 가능하게 만드는 디자인 패턴입니다.

```
┌─────────────┐
│  Service    │
│  (사용자)    │
└──────┬──────┘
       │ 인터페이스 사용
       ▼
┌─────────────┐
│  Provider   │  ← 인터페이스 (계약)
│ (Interface) │
└──────┬──────┘
       │
   ┌───┴───┐
   ▼       ▼
┌─────┐ ┌─────┐
│Mock │ │ KRX │  ← 구현체들
└─────┘ └─────┘
```

## 왜 Strategy 패턴을 쓸까?

**문제 상황**

```java
@Service
public class StockService {

    public StockInfo getStock(String code) {
        // 개발 환경
        if (isDevelopment()) {
            return mockData.get(code);
        }
        // 운영 환경
        else {
            return krxApi.fetch(code);
        }
    }
}
```

문제점:
- 환경마다 `if-else` 분기 필요
- 새 데이터 소스 추가 시 모든 메서드 수정
- 테스트하기 어려움

**해결: Strategy 패턴**

```java
// 인터페이스 정의
public interface StockDataProvider {
    StockInfo getStockById(String code);
}

// 구현체 1: Mock
@Component
@Profile("local")
public class MockStockDataProvider implements StockDataProvider {
    public StockInfo getStockById(String code) {
        return mockData.get(code);
    }
}

// 구현체 2: KRX
@Component
@Profile("prod")
public class KrxStockDataProvider implements StockDataProvider {
    public StockInfo getStockById(String code) {
        return krxApi.fetch(code);
    }
}

// Service는 인터페이스만 알면 됨
@Service
public class StockService {
    private final StockDataProvider stockDataProvider;

    public StockInfo getStock(String code) {
        return stockDataProvider.getStockById(code);
    }
}
```

장점:
- Service는 **인터페이스만** 알면 됨
- 구현체 교체가 **설정 한 줄**로 가능
- **테스트 시 Mock 주입** 용이

# Spring Profile로 구현체 전환

---

## @Profile 어노테이션

Spring Profile은 **환경별 설정**을 관리합니다.

```java
@Component
@Profile("local")  // local 프로필에서만 활성화
public class MockStockDataProvider implements StockDataProvider { }

@Component
@Profile("prod")   // prod 프로필에서만 활성화
public class KrxStockDataProvider implements StockDataProvider { }
```

## 프로필 활성화 방법

```bash
# 방법 1: 환경 변수
SPRING_PROFILES_ACTIVE=prod ./gradlew bootRun

# 방법 2: application.yml
spring:
  profiles:
    active: local

# 방법 3: 커맨드 라인
./gradlew bootRun --args='--spring.profiles.active=prod'
```

## Stock-Info의 application.yml

```yaml
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}  # 기본값: local
```

- 환경 변수가 있으면 그 값 사용
- 없으면 `local` 사용 (Mock 데이터)

# Stock-Info의 Provider 구현

---

## Provider 인터페이스

### StockDataProvider

```java
/**
 * 주식 데이터 제공자 인터페이스.
 *
 * 이 인터페이스를 구현하여 다양한 데이터 소스
 * (Mock, KRX, KIS 등)를 지원합니다.
 */
public interface StockDataProvider {

    /**
     * 종목 ID로 주식 정보 조회
     */
    StockInfo getStockById(String id);

    /**
     * 섹터별 종목 목록 조회
     */
    List<StockScoreDto> getStocksBySector(String sectorName);

    /**
     * 전체 종목 조회
     */
    List<StockScoreDto> getAllStocks();

    /**
     * 종목 검색
     */
    List<StockScoreDto> searchStocks(String keyword);
}
```

### SectorDataProvider

```java
/**
 * 섹터 데이터 제공자 인터페이스.
 */
public interface SectorDataProvider {

    /**
     * 전체 섹터 목록 조회
     */
    List<SectorScoreDto> getAllSectors();

    /**
     * 섹터명으로 섹터 정보 조회
     */
    SectorScoreDto getSectorByName(String name);
}
```

### ChartDataProvider

```java
/**
 * 차트 데이터 제공자 인터페이스.
 */
public interface ChartDataProvider {

    /**
     * 종목 차트 데이터 조회
     *
     * @param stockCode 종목 코드
     * @param range 기간 (1D, 1W, 1M, 3M, 1Y)
     * @return 차트 데이터
     */
    ChartResponse getChartData(String stockCode, String range);
}
```

## Mock 구현체 (개발용)

### MockStockDataProvider

```java
@Component
@Profile("local")  // local 프로필에서만 활성화
public class MockStockDataProvider implements StockDataProvider {

    // Mock 데이터 저장소
    private final Map<String, StockInfo> stockMap = new HashMap<>();
    private final Map<String, List<StockScoreDto>> sectorStocksMap =
        new HashMap<>();

    // 생성자에서 Mock 데이터 초기화
    public MockStockDataProvider() {
        initializeMockData();
    }

    private void initializeMockData() {
        // 삼성전자
        stockMap.put("005930", StockInfo.builder()
            .code("005930")
            .name("삼성전자")
            .price(72500)
            .priceChange(500)
            .changeRate(0.69)
            .per(12.5)
            .pbr(1.2)
            .market("KOSPI")
            .sectorName("전기전자")
            .marketCap(432000000000000L)
            .build());

        // SK하이닉스
        stockMap.put("000660", StockInfo.builder()
            .code("000660")
            .name("SK하이닉스")
            .price(178000)
            .priceChange(-2000)
            .changeRate(-1.11)
            .per(8.3)
            .pbr(1.8)
            .market("KOSPI")
            .sectorName("전기전자")
            .marketCap(129000000000000L)
            .build());

        // 섹터별 종목 매핑
        sectorStocksMap.put("전기전자", List.of(
            toStockScore(stockMap.get("005930")),
            toStockScore(stockMap.get("000660"))
        ));
    }

    @Override
    public StockInfo getStockById(String id) {
        return stockMap.get(id);
    }

    @Override
    public List<StockScoreDto> getStocksBySector(String sectorName) {
        return sectorStocksMap.getOrDefault(sectorName, List.of());
    }

    @Override
    public List<StockScoreDto> getAllStocks() {
        return stockMap.values().stream()
            .map(this::toStockScore)
            .toList();
    }

    @Override
    public List<StockScoreDto> searchStocks(String keyword) {
        String lowerKeyword = keyword.toLowerCase();

        return stockMap.values().stream()
            .filter(s ->
                s.getName().toLowerCase().contains(lowerKeyword) ||
                s.getCode().contains(keyword))
            .map(this::toStockScore)
            .toList();
    }

    private StockScoreDto toStockScore(StockInfo info) {
        return StockScoreDto.builder()
            .code(info.getCode())
            .name(info.getName())
            .score(calculateScore(info))
            .label(calculateLabel(info))
            .price(info.getPrice())
            .priceChange(formatPriceChange(info))
            .sectorName(info.getSectorName())
            .build();
    }
}
```

### MockChartDataProvider

```java
@Component
@Profile("local")
public class MockChartDataProvider implements ChartDataProvider {

    private final Random random = new Random(42);  // 고정 시드

    @Override
    public ChartResponse getChartData(String stockCode, String range) {
        int dataPoints = getDataPointCount(range);
        double basePrice = getBasePrice(stockCode);

        List<ChartDataPoint> points = generateMockPrices(
            dataPoints, basePrice, range);

        return ChartResponse.builder()
            .dataPoints(points)
            .meta(ChartMeta.builder()
                .stockCode(stockCode)
                .range(range)
                .dataPointCount(dataPoints)
                .build())
            .build();
    }

    private int getDataPointCount(String range) {
        return switch (range) {
            case "1D" -> 14;   // 30분 간격
            case "1W" -> 5;    // 일별
            case "1M" -> 22;   // 영업일
            case "3M" -> 66;   // 영업일
            case "1Y" -> 252;  // 영업일
            default -> 22;
        };
    }

    private List<ChartDataPoint> generateMockPrices(
            int count, double basePrice, String range) {

        List<ChartDataPoint> points = new ArrayList<>();
        double price = basePrice;
        LocalDateTime now = LocalDateTime.now();

        for (int i = count - 1; i >= 0; i--) {
            // 랜덤 변동 (-1% ~ +1%)
            double change = (random.nextDouble() - 0.5) * 0.02;
            price = price * (1 + change);

            LocalDateTime time = calculateTime(now, i, range);

            points.add(ChartDataPoint.builder()
                .timestamp(time.toString())
                .price(Math.round(price))
                .build());
        }

        return points;
    }
}
```

## KRX 구현체 (운영용)

### KrxStockDataProviderImpl

```java
@Component
@Profile("prod")  // prod 프로필에서만 활성화
@RequiredArgsConstructor
@Slf4j
public class KrxStockDataProviderImpl implements StockDataProvider {

    private final RestClient krxRestClient;

    @Override
    public StockInfo getStockById(String id) {
        try {
            KrxStockItem response = krxRestClient.get()
                .uri("/stock/basic?code={code}", id)
                .retrieve()
                .body(KrxStockItem.class);

            // External DTO → Domain DTO 변환
            return toStockInfo(response);
        } catch (Exception e) {
            log.error("Failed to fetch stock: {}", id, e);
            return null;
        }
    }

    /**
     * KRX API 응답 → 내부 DTO 변환
     */
    private StockInfo toStockInfo(KrxStockItem item) {
        return StockInfo.builder()
            .code(item.getIsuSrtCd())      // 종목코드
            .name(item.getIsuNm())         // 종목명
            .price(item.getTddClsPrc())    // 종가
            .priceChange(item.getCmpprevddPrc())  // 전일대비
            .changeRate(item.getFlucRt()) // 등락률
            .market(item.getMktNm())       // 시장구분
            .marketCap(item.getMktcap())   // 시가총액
            .build();
    }

    @Override
    public List<StockScoreDto> getAllStocks() {
        // KRX API 호출하여 전체 종목 조회
        KrxStockListResponse response = krxRestClient.get()
            .uri("/stock/list")
            .retrieve()
            .body(KrxStockListResponse.class);

        return response.getItems().stream()
            .map(this::toStockScore)
            .toList();
    }

    // ... 나머지 메서드들
}
```

### 코드 분석

**External DTO → Domain DTO 변환**

KRX API는 한글 약어를 사용합니다:
- `IsuSrtCd`: 종목단축코드
- `IsuNm`: 종목명
- `TddClsPrc`: 당일종가

이를 이해하기 쉬운 Domain DTO로 변환합니다:
- `code`, `name`, `price`

```java
private StockInfo toStockInfo(KrxStockItem item) {
    return StockInfo.builder()
        .code(item.getIsuSrtCd())    // 외부 필드명 → 내부 필드명
        .name(item.getIsuNm())
        .price(item.getTddClsPrc())
        .build();
}
```

# Provider 패턴의 장점

---

## 1. 테스트 용이성

테스트 시 Mock Provider를 주입할 수 있습니다.

```java
@Test
void testGetTopStocks() {
    // Mock Provider 생성
    StockDataProvider mockProvider = new MockStockDataProvider();

    // Service에 Mock 주입
    StockService service = new StockService(mockProvider);

    // 테스트
    List<StockScoreDto> result = service.getTopStocks(3);
    assertThat(result).hasSize(3);
}
```

## 2. 환경별 설정

코드 변경 없이 환경 변수만으로 전환합니다.

```bash
# 개발: Mock 데이터
./gradlew bootRun

# 운영: KRX 실제 데이터
SPRING_PROFILES_ACTIVE=prod ./gradlew bootRun
```

## 3. 새 데이터 소스 추가

새 Provider만 구현하면 됩니다.

```java
@Component
@Profile("kis")  // KIS API 사용 시
public class KisStockDataProvider implements StockDataProvider {
    // KIS(한국투자증권) API 구현
}
```

## 4. 점진적 마이그레이션

일부만 새 Provider로 교체할 수 있습니다.

```java
@Service
public class StockService {
    // 기본 데이터는 KRX에서
    private final StockDataProvider stockProvider;

    // 차트 데이터는 별도 Provider에서
    private final ChartDataProvider chartProvider;
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| Strategy 패턴 | 알고리즘을 캡슐화하여 교체 가능하게 함 |
| Provider 인터페이스 | 데이터 접근 계약 정의 |
| @Profile | 환경별로 다른 Bean 활성화 |
| Mock Provider | 개발/테스트용 가짜 데이터 |
| KRX Provider | 운영용 실제 데이터 |

Provider 패턴을 통해 **데이터 소스를 추상화**하면, 비즈니스 로직(Service)은 "데이터가 어디서 오는지" 신경 쓰지 않아도 됩니다.

다음 글에서는 **DTO 3-Layer 설계**에 대해 알아봅니다.

# Reference

---

- [Strategy Pattern - Refactoring Guru](https://refactoring.guru/design-patterns/strategy)
- [Spring Profiles Documentation](https://docs.spring.io/spring-boot/docs/current/reference/html/features.html#features.profiles)
