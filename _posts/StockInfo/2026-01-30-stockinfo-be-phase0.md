---
title: "[StockInfo] BE Phase 0 - Provider 패턴과 DTO 설계"
categories:
  - StockInfo
tags:
  - [Java, Spring, Design Pattern]
---

# Introduction

---

주식 투자를 처음 시작하는 초보자를 위한 주식 정보 서비스 **Stock-Info** 프로젝트의 백엔드 기초 설계를 소개한다. 이 글에서는 외부 API 연동을 추상화하는 **Provider/Strategy 패턴**과 계층별로 DTO를 분리하는 **3-Layer DTO 아키텍처**를 다룬다.

# Provider/Strategy 패턴

---

## 왜 Provider 패턴인가?

실제 서비스를 개발할 때 외부 데이터 소스는 자주 바뀐다. 개발 초기에는 Mock 데이터로 빠르게 프로토타이핑하고, 이후 실제 API(KRX, KIS 등)로 전환해야 한다. 이런 상황에서 비즈니스 로직이 특정 데이터 소스에 강하게 결합되어 있으면 전환 비용이 커진다.

Provider 패턴은 **데이터 제공 방식을 인터페이스로 추상화**하여 구현체를 쉽게 교체할 수 있게 해준다. Spring의 `@Profile` 어노테이션과 조합하면 환경별로 다른 구현체를 자동 주입할 수 있다.

## 인터페이스 설계

### StockDataProvider

```java
public interface StockDataProvider {

  List<StockInfo> getAllStocks();

  StockInfo getStockById(String stockId);

  List<StockScoreDto> getStocksBySector(String sectorId);

  StockScoreDto getStockByCode(String code);

  List<StockScoreDto> searchStocks(String keyword);

  List<StockScoreDto> getTopStocksBySector(String sectorId, int limit);
}
```

### SectorDataProvider

```java
public interface SectorDataProvider {

  List<SectorScoreDto> getAllSectors();

  List<StockInfo> getStocksBySectorId(String sectorId);

  List<KrxStockItem> getStocksBySectorName(String sectorId);
}
```

### IndexDataProvider

```java
public interface IndexDataProvider {

  List<Index> getAllIndexes();
}
```

## 구현체 전환 (Spring Profile)

### Mock 구현체 (개발용)

```java
@Service
@Profile("local")
public class MockStockDataProvider implements StockDataProvider {

  @Override
  public List<StockInfo> getAllStocks() {
    // 하드코딩된 Mock 데이터 반환
    return List.of(
        StockInfo.builder()
            .code("005930")
            .name("삼성전자")
            .price(71000)
            .changeRate(1.5)
            .build(),
        // ...
    );
  }
}
```

### KRX 구현체 (운영용)

```java
@Service
@Profile("prod")
@RequiredArgsConstructor
public class KrxStockDataProviderImpl implements StockDataProvider {

  private final RestClient restClient;

  @Override
  public List<StockInfo> getAllStocks() {
    KrxStockResponse response = restClient.get()
        .uri("/api/stocks")
        .retrieve()
        .body(KrxStockResponse.class);

    // External DTO → Domain DTO 변환
    return response.getItems().stream()
        .map(this::toDomain)
        .toList();
  }
}
```

### 프로파일 전환

```bash
# 개발 환경 (Mock 데이터)
./gradlew bootRun

# 운영 환경 (실제 KRX 데이터)
SPRING_PROFILES_ACTIVE=prod ./gradlew bootRun
```

# DTO 3-Layer 아키텍처

---

## 왜 DTO를 분리하는가?

단일 DTO로 모든 계층을 처리하면 다음과 같은 문제가 발생한다:

1. **외부 API 변경에 취약**: API 응답 필드가 바뀌면 전체 코드에 영향
2. **불필요한 데이터 노출**: 내부 처리용 필드가 클라이언트에 노출
3. **변환 로직 분산**: 여러 곳에서 동일한 변환 로직 중복

3-Layer DTO 아키텍처는 각 계층의 관심사를 분리하여 이 문제를 해결한다.

## 레이어별 역할

| Layer | 위치 | 역할 |
|-------|------|------|
| **External DTO** | `dto/external/` | 외부 API 응답 매핑 |
| **Domain DTO** | `dto/domain/` | 내부 비즈니스 로직용 표준 형식 |
| **Response DTO** | `dto/response/` | 클라이언트 응답용 (가공된 데이터) |

## 변환 흐름 다이어그램

```
┌─────────────┐     ┌──────────────┐     ┌───────────┐     ┌──────────────┐
│ 외부 API    │────▶│   Provider   │────▶│  Service  │────▶│  Controller  │
│ (KRX, KIS)  │     │              │     │           │     │              │
└─────────────┘     └──────────────┘     └───────────┘     └──────────────┘
       │                   │                   │                   │
       ▼                   ▼                   ▼                   ▼
  External DTO        Domain DTO          Domain DTO        Response DTO
  (KrxStockItem)      (StockInfo)         (StockInfo)       (StockResponse)
```

## 각 레이어 DTO 예시

### External DTO (KrxStockItem)

외부 API 응답을 그대로 매핑하는 DTO다. API 필드명을 그대로 사용한다.

```java
@Getter
@Builder
public class KrxStockItem {
  private String ISU_CD;        // 종목코드
  private String ISU_NM;        // 종목명
  private String MKT_NM;        // 시장구분
  private String SECT_TP_NM;    // 업종명
  private String TDD_CLSPRC;    // 종가
  private String CMPPREVDD_PRC; // 전일대비
  private String FLUC_RT;       // 등락률
}
```

### Domain DTO (StockInfo)

비즈니스 로직에서 사용하는 정규화된 DTO다. 의미 있는 필드명과 적절한 타입을 사용한다.

```java
@Getter
@Builder
public class StockInfo {
  private String code;
  private String name;
  private String market;
  private String sectorName;
  private int price;
  private int priceChange;
  private double changeRate;
  private Double per;
  private Double pbr;
  private Long marketCap;
}
```

### Response DTO (StockDetailResponse)

클라이언트에 반환하는 DTO다. 프론트엔드에서 바로 사용할 수 있도록 포맷팅된 값을 포함한다.

```java
@Getter
@Builder
public class StockDetailResponse {
  private String stockCode;
  private String stockName;
  private String closingPrice;    // "71,000원"
  private String priceChange;     // "+1,200원"
  private String changeRate;      // "+1.72%"
  private String eps;
  private String per;
  private String bps;
  private String pbr;
}
```

## 변환 메서드 패턴

각 DTO는 상위 레이어로 변환하는 정적 메서드를 제공한다.

```java
@Getter
@Builder
public class StockListItem {
  private String code;
  private String name;
  private int price;
  private String priceChange;
  private String changeRate;
  private int score;
  private ScoreLabel label;

  // Domain DTO → Response DTO 변환
  public static StockListItem fromStockInfo(StockInfo stock) {
    return StockListItem.builder()
        .code(stock.getCode())
        .name(stock.getName())
        .price(stock.getPrice())
        .priceChange(FormatUtils.formatPriceChange(stock.getPriceChange()))
        .changeRate(FormatUtils.formatPercent(stock.getChangeRate()))
        .build();
  }
}
```

# Conclusion

---

Stock-Info 프로젝트의 백엔드 기초 설계를 정리하면:

1. **Provider/Strategy 패턴**: 데이터 소스를 인터페이스로 추상화하고 Spring Profile로 구현체 전환
2. **DTO 3-Layer**: External → Domain → Response 계층별 DTO 분리로 관심사 분리

이 구조 덕분에 Mock 데이터로 프론트엔드 개발을 병행하면서, 나중에 실제 API 연동으로 부드럽게 전환할 수 있었다.

# Reference

---

- [Spring Framework - Profiles](https://docs.spring.io/spring-framework/reference/core/beans/environment.html)
- [Strategy Pattern](https://refactoring.guru/design-patterns/strategy)
