---
title: "[StockInfo] 05. DTO 3-Layer 설계 - 데이터 변환의 기술"
categories:
  - StockInfo
tags:
  - [Java, Spring, DTO, Architecture]
---

# Introduction

---

DTO(Data Transfer Object)는 **계층 간 데이터 전달**을 위한 객체입니다.

"그냥 하나의 DTO를 쓰면 안 되나요?"라고 물을 수 있습니다. 하지만 각 계층의 요구사항이 다르기 때문에, DTO를 **역할별로 분리**하면 유지보수가 훨씬 쉬워집니다.

# DTO가 필요한 이유

---

## 문제: Entity를 그대로 노출하면?

```java
// Entity를 API 응답으로 직접 반환
@GetMapping("/stocks/{code}")
public Stock getStock(@PathVariable String code) {
    return stockRepository.findByCode(code);  // Entity 반환
}
```

문제점:

1. **민감한 정보 노출**: Entity에 있는 모든 필드가 노출됨
2. **순환 참조**: JPA 연관관계가 있으면 무한 루프
3. **API 스펙 변경의 어려움**: Entity 변경 시 API도 변경됨
4. **외부 API 필드명 노출**: `IsuSrtCd` 같은 필드가 그대로 노출

## 해결: DTO로 분리

```java
// DTO를 통해 필요한 필드만 노출
@GetMapping("/stocks/{code}")
public StockDetailResponse getStock(@PathVariable String code) {
    StockInfo stock = stockService.getStockById(code);
    return StockDetailResponse.fromStockInfo(stock);  // DTO 변환
}
```

# 3-Layer DTO 아키텍처

---

Stock-Info는 DTO를 **3가지 역할**로 분리합니다.

```
┌─────────────────┐
│   External API  │  KRX, KIS 등 외부 서비스
└────────┬────────┘
         │ External DTO (외부 API 응답 매핑)
         ▼
┌─────────────────┐
│    Provider     │  데이터 접근 계층
└────────┬────────┘
         │ Domain DTO (내부 표준 형식)
         ▼
┌─────────────────┐
│    Service      │  비즈니스 로직 계층
└────────┬────────┘
         │ Domain DTO
         ▼
┌─────────────────┐
│   Controller    │  웹 계층
└────────┬────────┘
         │ Response DTO (클라이언트용)
         ▼
┌─────────────────┐
│    Client       │  프론트엔드
└─────────────────┘
```

## 각 DTO의 역할

| DTO 종류 | 위치 | 역할 | 예시 |
|---------|------|------|------|
| **External** | `dto/external/` | 외부 API 응답 매핑 | KrxStockItem |
| **Domain** | `dto/domain/` | 내부 비즈니스 로직 | StockInfo |
| **Response** | `dto/response/` | 클라이언트 응답 | StockDetailResponse |

# External DTO - 외부 API 매핑

---

## 역할

외부 API(KRX, KIS 등)의 응답을 **그대로 매핑**합니다.

외부 API의 필드명이 바뀌면 여기만 수정합니다.

## 예시: KrxStockItem

```java
/**
 * KRX API 종목 기본 정보 응답
 *
 * KRX API는 한글 약어를 사용하므로,
 * JsonProperty로 실제 필드명을 매핑합니다.
 */
@Getter
@NoArgsConstructor
@AllArgsConstructor
public class KrxStockItem {

    @JsonProperty("ISU_SRT_CD")  // 종목단축코드
    private String isuSrtCd;

    @JsonProperty("ISU_NM")      // 종목명
    private String isuNm;

    @JsonProperty("MKT_NM")      // 시장구분 (KOSPI/KOSDAQ)
    private String mktNm;

    @JsonProperty("TDD_CLSPRC")  // 당일종가
    private Long tddClsPrc;

    @JsonProperty("CMPPREVDD_PRC")  // 전일대비
    private Long cmpprevddPrc;

    @JsonProperty("FLUC_RT")     // 등락률
    private Double flucRt;

    @JsonProperty("MKTCAP")      // 시가총액
    private Long mktcap;
}
```

### 코드 분석

**@JsonProperty**

JSON 필드명과 Java 필드명을 매핑합니다.

```json
// KRX API 응답 (JSON)
{
  "ISU_SRT_CD": "005930",
  "ISU_NM": "삼성전자",
  "TDD_CLSPRC": 72500
}
```

```java
// Java 객체로 변환
KrxStockItem item = objectMapper.readValue(json, KrxStockItem.class);
item.getIsuSrtCd();  // "005930"
item.getIsuNm();     // "삼성전자"
item.getTddClsPrc(); // 72500
```

## 예시: KrxStockFinancialItem

재무 지표가 포함된 응답입니다.

```java
@Getter
@NoArgsConstructor
public class KrxStockFinancialItem {

    @JsonProperty("STOCK_CODE")
    private String stockCode;

    @JsonProperty("STOCK_NAME")
    private String stockName;

    @JsonProperty("CLOSING_PRICE")
    private Long closingPrice;

    @JsonProperty("EPS")           // 주당순이익
    private Double eps;

    @JsonProperty("PER")           // 주가수익비율
    private Double per;

    @JsonProperty("BPS")           // 주당순자산
    private Double bps;

    @JsonProperty("PBR")           // 주가순자산비율
    private Double pbr;

    @JsonProperty("DIVIDEND_YIELD") // 배당수익률
    private Double dividendYield;
}
```

# Domain DTO - 내부 표준 형식

---

## 역할

내부 비즈니스 로직에서 사용하는 **표준화된 형식**입니다.

- 이해하기 쉬운 필드명 사용
- 외부 API와 무관하게 설계
- Service 계층에서 사용

## 예시: StockInfo

```java
/**
 * 종목 기본 정보 (Domain DTO)
 *
 * 외부 API 형식과 무관하게 내부에서 사용하는 표준 형식입니다.
 */
@Getter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class StockInfo {

    private String code;          // 종목코드 (예: "005930")
    private String name;          // 종목명 (예: "삼성전자")
    private long price;           // 현재가
    private long priceChange;     // 전일대비
    private double changeRate;    // 등락률 (%)
    private Double per;           // PER (주가수익비율)
    private Double pbr;           // PBR (주가순자산비율)
    private String market;        // 시장 (KOSPI/KOSDAQ)
    private String sectorName;    // 섹터명
    private Long marketCap;       // 시가총액
}
```

## 예시: Index

```java
/**
 * 시장 지수 정보 (Domain DTO)
 */
@Getter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Index {

    private String name;          // 지수명 (코스피, 코스닥)
    private double closingPrice;  // 종가
    private double priceChange;   // 전일대비
    private double changeRate;    // 등락률 (%)
    private double openingPrice;  // 시가
    private double highPrice;     // 고가
    private double lowPrice;      // 저가
}
```

## External → Domain 변환

Provider에서 변환을 담당합니다.

```java
@Component
@Profile("prod")
public class KrxStockDataProviderImpl implements StockDataProvider {

    @Override
    public StockInfo getStockById(String id) {
        // 1. 외부 API 호출 → External DTO
        KrxStockItem response = krxRestClient.get()
            .uri("/stock/basic?code={code}", id)
            .retrieve()
            .body(KrxStockItem.class);

        // 2. External DTO → Domain DTO 변환
        return toStockInfo(response);
    }

    /**
     * KRX 응답 → 내부 표준 형식 변환
     */
    private StockInfo toStockInfo(KrxStockItem item) {
        return StockInfo.builder()
            .code(item.getIsuSrtCd())        // ISU_SRT_CD → code
            .name(item.getIsuNm())           // ISU_NM → name
            .price(item.getTddClsPrc())      // TDD_CLSPRC → price
            .priceChange(item.getCmpprevddPrc())
            .changeRate(item.getFlucRt())
            .market(item.getMktNm())
            .marketCap(item.getMktcap())
            .build();
    }
}
```

# Response DTO - 클라이언트 응답

---

## 역할

프론트엔드에 전달하는 **최종 응답 형식**입니다.

- 클라이언트가 필요한 필드만 포함
- 가공된 데이터 (포맷팅 등)
- API 문서화 대상

## 예시: StockDetailResponse

```java
/**
 * 종목 상세 조회 응답 (Response DTO)
 */
@Getter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class StockDetailResponse {

    private String stockCode;
    private String stockName;
    private long closingPrice;
    private long priceChange;
    private double changeRate;
    private Double eps;
    private Double per;
    private Double bps;
    private Double pbr;
    private Double dividendYield;

    /**
     * Domain DTO → Response DTO 변환
     *
     * 정적 팩토리 메서드 패턴
     */
    public static StockDetailResponse fromStockInfo(StockInfo info) {
        return StockDetailResponse.builder()
            .stockCode(info.getCode())
            .stockName(info.getName())
            .closingPrice(info.getPrice())
            .priceChange(info.getPriceChange())
            .changeRate(info.getChangeRate())
            .per(info.getPer())
            .pbr(info.getPbr())
            .build();
    }
}
```

## 예시: StockListItem

목록 조회용 간략 응답입니다.

```java
/**
 * 종목 목록 아이템 (Response DTO)
 *
 * 목록에서는 필요한 필드만 반환하여 응답 크기를 줄입니다.
 */
@Getter
@Builder
public class StockListItem {

    private String code;
    private String name;
    private int score;
    private String label;      // STRONG / NEUTRAL / WEAK
    private long price;
    private String priceChange; // "+500 (+0.69%)" 형식
    private String sectorName;

    public static StockListItem fromStockScore(StockScoreDto dto) {
        return StockListItem.builder()
            .code(dto.getCode())
            .name(dto.getName())
            .score(dto.getScore())
            .label(dto.getLabel())
            .price(dto.getPrice())
            .priceChange(dto.getPriceChange())
            .sectorName(dto.getSectorName())
            .build();
    }
}
```

## 예시: IndexResponse

```java
/**
 * 시장 지수 응답 (Response DTO)
 */
@Getter
@Builder
public class IndexResponse {

    private String name;
    private double closingPrice;
    private double priceChange;
    private String changeRate;    // "+0.42%" 형식 문자열
    private String marketStatus;  // "상승" / "보합" / "하락"

    public static IndexResponse fromIndex(Index index) {
        return IndexResponse.builder()
            .name(index.getName())
            .closingPrice(index.getClosingPrice())
            .priceChange(index.getPriceChange())
            .changeRate(formatChangeRate(index.getChangeRate()))
            .marketStatus(determineStatus(index.getPriceChange()))
            .build();
    }

    private static String formatChangeRate(double rate) {
        String sign = rate >= 0 ? "+" : "";
        return String.format("%s%.2f%%", sign, rate);
    }

    private static String determineStatus(double change) {
        if (change > 0) return "상승";
        if (change < 0) return "하락";
        return "보합";
    }
}
```

### 코드 분석

**데이터 가공**

Response DTO에서 프론트엔드가 바로 표시할 수 있는 형식으로 가공합니다.

```java
// Domain DTO
changeRate = 0.42  // 숫자

// Response DTO
changeRate = "+0.42%"  // 포맷팅된 문자열
marketStatus = "상승"  // 상태 텍스트
```

# 변환 패턴

---

## 1. 정적 팩토리 메서드

DTO 내부에 변환 메서드를 정의합니다.

```java
public class StockDetailResponse {

    // 정적 팩토리 메서드
    public static StockDetailResponse fromStockInfo(StockInfo info) {
        return StockDetailResponse.builder()
            .stockCode(info.getCode())
            .stockName(info.getName())
            // ...
            .build();
    }
}

// 사용
StockDetailResponse response = StockDetailResponse.fromStockInfo(stockInfo);
```

장점:
- 변환 로직이 DTO와 함께 위치
- 생성자보다 가독성 좋음

## 2. Stream과 함께 사용

목록 변환에 유용합니다.

```java
// Domain DTO 목록 → Response DTO 목록
List<StockListItem> items = stocks.stream()
    .map(StockListItem::fromStockScore)  // 메서드 참조
    .toList();
```

## 3. Builder 패턴

`@Builder`로 가독성 높은 객체 생성을 지원합니다.

```java
StockInfo stock = StockInfo.builder()
    .code("005930")
    .name("삼성전자")
    .price(72500)
    .market("KOSPI")
    .build();
```

# 3-Layer DTO의 장점

---

## 1. 외부 API 변경 격리

KRX API 필드명이 바뀌어도 External DTO만 수정합니다.

```java
// 변경 전
@JsonProperty("ISU_SRT_CD")
private String isuSrtCd;

// 변경 후 (External DTO만 수정)
@JsonProperty("STOCK_CODE")
private String isuSrtCd;

// Domain/Response DTO는 변경 없음!
```

## 2. 클라이언트 응답 최적화

클라이언트별로 다른 Response DTO를 제공할 수 있습니다.

```java
// 목록용 (간략)
StockListItem: code, name, score, price

// 상세용 (전체)
StockDetailResponse: code, name, price, eps, per, bps, pbr, ...
```

## 3. 계층별 독립적 진화

각 계층이 독립적으로 변경될 수 있습니다.

# 정리

---

| DTO 계층 | 위치 | 변환 주체 | 역할 |
|---------|------|----------|------|
| External | dto/external/ | Provider | 외부 API 응답 매핑 |
| Domain | dto/domain/ | - | 내부 비즈니스 로직 |
| Response | dto/response/ | Controller | 클라이언트 응답 |

변환 흐름:
```
External DTO → Domain DTO → Response DTO
   (Provider)               (Controller)
```

다음 글에서는 **Spring Configuration**과 Profile 설정에 대해 알아봅니다.

# Reference

---

- [Data Transfer Object - Martin Fowler](https://martinfowler.com/eaaCatalog/dataTransferObject.html)
- [Lombok @Builder Documentation](https://projectlombok.org/features/Builder)
