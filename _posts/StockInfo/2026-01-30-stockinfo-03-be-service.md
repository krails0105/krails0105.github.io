---
title: "[StockInfo] 03. Spring Service - 비즈니스 로직의 핵심"
categories:
  - StockInfo
tags:
  - [Java, Spring, Service Layer]
---

# Introduction

---

Controller가 안내 데스크라면, **Service**는 실제 업무를 처리하는 담당 부서입니다.

Service 계층은 애플리케이션의 **비즈니스 로직**을 담당합니다. "이 종목의 점수를 어떻게 계산할까?", "핫 섹터 TOP 3는 어떤 기준으로 선정할까?" 같은 핵심 로직이 여기에 있습니다.

# Service 계층이란?

---

## 계층 구조에서의 위치

```
┌─────────────┐
│ Controller  │  ← 요청/응답 처리
├─────────────┤
│  Service    │  ← 비즈니스 로직 (핵심!)
├─────────────┤
│  Provider   │  ← 데이터 접근
└─────────────┘
```

## Service의 역할

1. **비즈니스 로직 구현**: 점수 계산, 필터링, 정렬 등
2. **여러 Provider 조합**: 주식 데이터 + 섹터 데이터 조합
3. **트랜잭션 관리**: DB 작업의 원자성 보장
4. **검증 및 예외 처리**: 비즈니스 규칙 검증

## 왜 Service를 분리할까?

**관심사 분리 (Separation of Concerns)**

```java
// 나쁜 예: Controller에 비즈니스 로직
@GetMapping("/sectors/scoreboard")
public ScoreboardResponse getScoreboard() {
    List<SectorScoreDto> sectors = sectorProvider.getAll();

    // 비즈니스 로직이 Controller에 있음!
    List<HotSectorDto> hotSectors = sectors.stream()
        .filter(s -> s.getStockCount() >= 5)
        .sorted(Comparator.comparing(s -> s.getScore()).reversed())
        .limit(3)
        .map(this::toHotSector)
        .toList();

    MarketSummaryDto summary = calculateMarketSummary(sectors);

    return new ScoreboardResponse(hotSectors, summary, sectors);
}

// 좋은 예: Controller는 위임만
@GetMapping("/sectors/scoreboard")
public ScoreboardResponse getScoreboard() {
    return sectorService.getScoreboard();  // Service에 위임
}
```

분리의 장점:
- **테스트 용이**: Service만 단위 테스트 가능
- **재사용**: 여러 Controller에서 같은 로직 사용
- **유지보수**: 비즈니스 규칙 변경 시 Service만 수정

# Spring의 Service 어노테이션

---

## @Service

Service 클래스임을 선언합니다.

```java
@Service  // Spring이 이 클래스를 관리
public class StockService {
    // ...
}
```

`@Service`는 `@Component`의 특수화입니다:
- `@Component`: 일반 Spring Bean
- `@Service`: 비즈니스 로직 담당 Bean
- `@Repository`: 데이터 접근 담당 Bean
- `@Controller`: 웹 요청 처리 담당 Bean

## 의존성 주입 (Dependency Injection)

Service는 필요한 의존성을 외부에서 주입받습니다.

```java
@Service
@RequiredArgsConstructor  // 생성자 자동 생성
public class StockService {

    // final 필드 → 생성자 주입 대상
    private final StockDataProvider stockDataProvider;
    private final SectorDataProvider sectorDataProvider;
    private final ChartDataProvider chartDataProvider;
}
```

Spring이 자동으로 해주는 일:
1. `StockDataProvider` 구현체 찾기
2. `SectorDataProvider` 구현체 찾기
3. `ChartDataProvider` 구현체 찾기
4. 이들을 주입하여 `StockService` 생성

# Stock-Info의 Service 구현

---

## StockService

종목 관련 비즈니스 로직을 담당합니다.

```java
@Service
@RequiredArgsConstructor
public class StockService {

    private final StockDataProvider stockDataProvider;
    private final SectorDataProvider sectorDataProvider;
    private final ChartDataProvider chartDataProvider;

    /**
     * 종목 ID로 상세 정보 조회
     */
    public StockInfo getStockById(String id) {
        return stockDataProvider.getStockById(id);
    }

    /**
     * 종목 검색
     *
     * 종목명 또는 종목코드로 검색합니다.
     * 매핑 테이블(40+ 종목)을 기반으로 검색합니다.
     */
    public List<StockScoreDto> searchStocks(String keyword) {
        return stockDataProvider.searchStocks(keyword);
    }

    /**
     * 상위 종목 조회 (점수순)
     */
    public List<StockScoreDto> getTopStocks(int limit) {
        return stockDataProvider.getAllStocks().stream()
            .sorted(Comparator.comparingInt(StockScoreDto::getScore)
                .reversed())
            .limit(limit)
            .toList();
    }

    /**
     * 종목 차트 데이터 조회
     *
     * @param stockCode 종목 코드
     * @param range 기간 (1D, 1W, 1M, 3M, 1Y)
     */
    public ChartResponse getStockChart(String stockCode, String range) {
        return chartDataProvider.getChartData(stockCode, range);
    }
}
```

### 코드 분석

**단일 Provider 사용**

```java
public StockInfo getStockById(String id) {
    return stockDataProvider.getStockById(id);
}
```

간단한 조회는 Provider에 바로 위임합니다.

**여러 Provider 조합**

```java
public StockDetailWithSector getStockWithSector(String code) {
    StockInfo stock = stockDataProvider.getStockById(code);
    SectorScoreDto sector = sectorDataProvider
        .getSectorByName(stock.getSectorName());

    return new StockDetailWithSector(stock, sector);
}
```

여러 데이터 소스를 조합하는 것이 Service의 핵심 역할입니다.

## SectorService

섹터 관련 비즈니스 로직을 담당합니다.

```java
@Slf4j
@Service
@RequiredArgsConstructor
public class SectorService {

    // 비즈니스 상수: TOP3 선정을 위한 최소 표본 크기
    private static final int MIN_SAMPLE_SIZE_FOR_TOP3 = 5;

    private final SectorDataProvider sectorDataProvider;
    private final StockDataProvider stockDataProvider;

    /**
     * 스코어보드 조회 (메인 페이지용)
     *
     * 반환 내용:
     * - 핫 섹터 TOP 3 (표본 크기 >= 5인 섹터만)
     * - 시장 요약 (평균 점수, 상승/하락 섹터 수)
     * - 전체 섹터 목록 (점수순)
     */
    public ScoreboardResponse getScoreboard() {
        // 1. 전체 섹터 조회
        List<SectorScoreDto> allSectors = sectorDataProvider.getAllSectors();

        // 2. 점수순 정렬
        List<SectorScoreDto> sortedSectors = allSectors.stream()
            .sorted(Comparator.comparingInt(SectorScoreDto::getScore)
                .reversed())
            .toList();

        // 3. 핫 섹터 TOP 3 선정 (표본 크기 검증)
        List<HotSectorDto> hotSectors = sortedSectors.stream()
            .filter(s -> s.getStockCount() >= MIN_SAMPLE_SIZE_FOR_TOP3)
            .limit(3)
            .map(this::toHotSector)
            .toList();

        // 4. 시장 요약 계산
        MarketSummaryDto marketSummary = calculateMarketSummary(allSectors);

        // 5. 응답 조합
        return ScoreboardResponse.builder()
            .hotSectors(hotSectors)
            .marketSummary(marketSummary)
            .sectors(sortedSectors)
            .build();
    }

    /**
     * 시장 요약 계산
     */
    private MarketSummaryDto calculateMarketSummary(
            List<SectorScoreDto> sectors) {

        // 평균 점수 계산
        double avgScore = sectors.stream()
            .mapToInt(SectorScoreDto::getScore)
            .average()
            .orElse(50.0);

        // STRONG/WEAK 섹터 수 계산
        long strongCount = sectors.stream()
            .filter(s -> "STRONG".equals(s.getLabel()))
            .count();

        long weakCount = sectors.stream()
            .filter(s -> "WEAK".equals(s.getLabel()))
            .count();

        return MarketSummaryDto.builder()
            .averageScore((int) avgScore)
            .strongSectorCount((int) strongCount)
            .weakSectorCount((int) weakCount)
            .build();
    }

    /**
     * SectorScoreDto → HotSectorDto 변환
     */
    private HotSectorDto toHotSector(SectorScoreDto sector) {
        return HotSectorDto.builder()
            .name(sector.getName())
            .score(sector.getScore())
            .label(sector.getLabel())
            .stockCount(sector.getStockCount())
            .topStock(sector.getTopStocks().isEmpty()
                ? null
                : sector.getTopStocks().get(0))
            .build();
    }

    /**
     * 섹터별 종목 목록 조회
     */
    public List<StockListItem> getStocksBySectorName(String sectorName) {
        List<StockScoreDto> stocks = stockDataProvider
            .getStocksBySector(sectorName);

        // Domain DTO → Response DTO 변환
        return stocks.stream()
            .map(StockListItem::fromStockScore)
            .toList();
    }
}
```

### 비즈니스 로직 분석

**표본 크기 검증**

```java
private static final int MIN_SAMPLE_SIZE_FOR_TOP3 = 5;

// 표본이 5개 미만인 섹터는 TOP3에서 제외
.filter(s -> s.getStockCount() >= MIN_SAMPLE_SIZE_FOR_TOP3)
```

왜 이런 규칙이 필요할까요?

섹터에 종목이 1~2개뿐이면 "이 섹터가 좋다"고 말하기 어렵습니다. 통계적 신뢰도를 위해 최소 표본 크기를 설정합니다.

**점수순 정렬**

```java
.sorted(Comparator.comparingInt(SectorScoreDto::getScore).reversed())
```

- `comparingInt()`: int 값으로 비교
- `reversed()`: 내림차순 (높은 점수가 먼저)

**Stream API 활용**

```java
double avgScore = sectors.stream()
    .mapToInt(SectorScoreDto::getScore)  // int로 변환
    .average()                            // 평균 계산
    .orElse(50.0);                        // 없으면 50
```

Java의 Stream API로 컬렉션을 함수형으로 처리합니다.

## IndexService

시장 지수 조회를 담당합니다.

```java
@Service
@RequiredArgsConstructor
public class IndexService {

    // 표시할 지수 목록
    private static final Set<String> TARGET_INDEXES = Set.of(
        "코스피",
        "코스닥"
    );

    private final IndexDataProvider indexDataProvider;

    /**
     * 시장 지수 목록 조회
     *
     * 코스피, 코스닥 지수만 필터링하여 반환합니다.
     */
    public List<Index> getIndexes() {
        return indexDataProvider.getAllIndexes().stream()
            .filter(idx -> TARGET_INDEXES.contains(idx.getName()))
            .toList();
    }
}
```

### 비즈니스 상수 관리

```java
private static final Set<String> TARGET_INDEXES = Set.of(
    "코스피",
    "코스닥"
);
```

비즈니스 상수는 Service 내부에 정의합니다:
- `Set.of()`: 불변 Set 생성
- `private static final`: 상수 선언

# Service 설계 원칙

---

## 1. 단일 책임 원칙

하나의 Service는 하나의 도메인을 담당합니다.

```java
// 좋은 예: 도메인별 분리
StockService    // 종목 관련
SectorService   // 섹터 관련
NewsService     // 뉴스 관련

// 나쁜 예: 모든 것을 하나에
MainService     // 모든 로직이 여기에...
```

## 2. 인터페이스 의존

구현체가 아닌 인터페이스에 의존합니다.

```java
@Service
public class StockService {
    // 인터페이스에 의존 → 구현체 교체 용이
    private final StockDataProvider stockDataProvider;

    // 나쁜 예: 구현체에 직접 의존
    // private final MockStockDataProvider mockProvider;
}
```

## 3. 트랜잭션 관리

DB 작업이 포함된 경우 `@Transactional`을 사용합니다.

```java
@Service
@Transactional(readOnly = true)  // 기본: 읽기 전용
public class NewsService {

    @Transactional  // 쓰기 작업은 별도 지정
    public void saveNews(NewsArticle article) {
        newsRepository.save(article);
    }
}
```

## 4. DTO 변환 위치

- **Provider**: External DTO → Domain DTO
- **Controller 또는 Service**: Domain DTO → Response DTO

```java
// Service에서 변환하는 경우
public List<StockListItem> getStocks() {
    return stockDataProvider.getAll().stream()
        .map(StockListItem::fromStockScore)  // 변환
        .toList();
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| @Service | Service 클래스 선언 |
| @RequiredArgsConstructor | 생성자 주입 자동 생성 |
| 비즈니스 로직 | 점수 계산, 필터링, 정렬 등 핵심 규칙 |
| Provider 조합 | 여러 데이터 소스를 조합 |
| 비즈니스 상수 | MIN_SAMPLE_SIZE 같은 규칙 상수 |

Service 계층은 애플리케이션의 **두뇌** 역할을 합니다. Controller가 "무엇을 해달라"고 요청하면, Service가 "어떻게 할지" 결정합니다.

다음 글에서는 Service가 호출하는 **Provider 계층**과 Strategy 패턴에 대해 알아봅니다.

# Reference

---

- [Spring Service Layer Best Practices](https://docs.spring.io/spring-framework/docs/current/reference/html/core.html)
- [Domain-Driven Design: Service Layer](https://martinfowler.com/eaaCatalog/serviceLayer.html)
