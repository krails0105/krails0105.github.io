---
title: "[StockInfo] 캐시와 외부 API 연동 - 차트 데이터 실서비스화"
categories:
  - StockInfo
tags:
  - [Spring Boot, Cache, Caffeine, 외부 API, 차트]
---

# Introduction

---

> **시리즈 안내**: 이 글은 Stock-Info 프로젝트 시리즈의 마지막 글(17/17)입니다.

서비스가 "실제로 동작한다"는 것과 "실제 데이터를 보여준다"는 것은 다릅니다. Phase 3까지 Mock 데이터로 UI를 완성했다면, Phase 4에서는 실제 데이터를 연동하여 서비스의 신뢰도를 높입니다.

이번 글에서는 외부 API를 연동할 때 고려해야 할 점과 Spring Boot에서 캐시를 적용하는 방법을 Stock-Info 차트 기능 구현을 통해 설명합니다.

# 외부 API 연동 시 고려사항

---

외부 API를 사용할 때 반드시 고려해야 할 3가지가 있습니다.

## 1. 레이트 리밋 (Rate Limit)

대부분의 외부 API는 호출 횟수 제한이 있습니다. 초당/분당/일당 호출 횟수를 초과하면 429 에러가 발생하거나 IP가 차단될 수 있습니다.

## 2. 응답 지연

외부 API 호출은 내부 메서드 호출보다 훨씬 느립니다. 네트워크 레이턴시, 외부 서버 처리 시간 등이 추가되어 사용자 경험에 영향을 줍니다.

## 3. 장애 대응

외부 서비스가 다운되거나 응답이 느려질 때 우리 서비스도 함께 죽으면 안 됩니다. Graceful degradation이 필요합니다.

이 세 가지 문제를 한 번에 해결하는 방법이 **캐시(Cache)**입니다.

# Spring Boot 캐시 설정

---

Stock-Info에서는 Caffeine 캐시를 사용합니다. Caffeine은 Java 8+용 고성능 인메모리 캐시 라이브러리입니다.

## 의존성 추가

```gradle
// build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-cache'
    implementation 'com.github.ben-manes.caffeine:caffeine:3.1.8'
}
```

## 캐시 설정 클래스

```java
@Configuration
@EnableCaching  // 캐시 활성화
public class CacheConfig {

  public static final String CHART_CACHE = "chartCache";

  @Bean
  public CacheManager cacheManager() {
    CaffeineCacheManager cacheManager = new CaffeineCacheManager(CHART_CACHE);
    cacheManager.setCaffeine(
        Caffeine.newBuilder()
            .expireAfterWrite(60, TimeUnit.SECONDS) // TTL 60초
            .maximumSize(500)                       // 최대 500개 엔트리
            .recordStats());                        // 통계 수집
    return cacheManager;
  }
}
```

**설정 값 의미:**
- `expireAfterWrite(60초)`: 캐시에 저장된 후 60초가 지나면 만료
- `maximumSize(500)`: 최대 500개 캐시 엔트리 (종목코드 × range 조합)
- `recordStats()`: 캐시 히트율 등 통계 수집

# 외부 API 연동 구현

---

Stock-Info에서는 네이버 금융 차트 API를 사용하여 실제 주가 데이터를 조회합니다.

## Provider 구현

```java
@Component
@Profile("prod")  // prod 프로파일에서만 활성화
@Slf4j
public class KrxChartDataProvider implements ChartDataProvider {

  private static final String NAVER_CHART_API_BASE =
      "https://fchart.stock.naver.com/siseJson.nhn";

  // 타임아웃 설정 (중요!)
  private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
  private static final Duration READ_TIMEOUT = Duration.ofSeconds(10);

  private final RestClient restClient;

  public KrxChartDataProvider() {
    // 타임아웃이 있는 RequestFactory 생성
    ClientHttpRequestFactorySettings settings =
        ClientHttpRequestFactorySettings.defaults()
            .withConnectTimeout(CONNECT_TIMEOUT)
            .withReadTimeout(READ_TIMEOUT);
    ClientHttpRequestFactory requestFactory =
        ClientHttpRequestFactoryBuilder.detect().build(settings);

    this.restClient = RestClient.builder()
        .requestFactory(requestFactory)  // 타임아웃 적용
        .defaultHeader("User-Agent", "Mozilla/5.0")
        .defaultHeader("Referer", "https://finance.naver.com")
        .build();
  }

  @Override
  @Cacheable(value = CacheConfig.CHART_CACHE, key = "#stockCode + '_' + #range")
  public ChartResponse getChartData(String stockCode, String range) {
    log.debug("Fetching chart data: code={}, range={}", stockCode, range);

    try {
      String xml = fetchFromNaverApi(stockCode, range);
      NaverChartResponse naverResponse = NaverChartResponse.fromXml(xml);

      if (naverResponse.getItems().isEmpty()) {
        return buildEmptyResponse(stockCode, range);
      }

      List<ChartDataPoint> dataPoints = convertToDataPoints(naverResponse.getItems(), range);

      return ChartResponse.builder()
          .stockCode(stockCode)
          .stockName(getStockName(stockCode))
          .range(range)
          .dataPoints(dataPoints)
          .meta(ChartMeta.builder()
              .asOf(OffsetDateTime.now(ZoneId.of("Asia/Seoul")))
              .source("NAVER")
              .build())
          .build();

    } catch (RestClientException e) {
      log.error("Failed to fetch chart data: code={}", stockCode);
      return buildEmptyResponse(stockCode, range);  // 에러 시 빈 응답
    }
  }
}
```

## 핵심 포인트

### 1. @Cacheable 어노테이션

```java
@Cacheable(value = CacheConfig.CHART_CACHE, key = "#stockCode + '_' + #range")
```

- `value`: 사용할 캐시 이름
- `key`: 캐시 키 (종목코드_기간 조합)

같은 종목코드와 range로 호출하면 메서드를 실행하지 않고 캐시된 결과를 반환합니다.

### 2. Graceful Degradation

```java
} catch (RestClientException e) {
    log.error("Failed to fetch chart data: code={}", stockCode);
    return buildEmptyResponse(stockCode, range);  // 빈 응답 반환
}
```

외부 API 호출이 실패해도 예외를 던지지 않고 빈 응답을 반환합니다. 프론트엔드에서는 빈 데이터를 받으면 EmptyState UI를 표시합니다.

### 3. Profile 분리

```java
@Profile("prod")  // prod에서만 활성화
```

개발 환경(local)에서는 MockChartDataProvider가, 운영 환경(prod)에서는 KrxChartDataProvider가 사용됩니다.

### 4. 타임아웃 설정

외부 API 호출 시 타임아웃을 설정하지 않으면 서버가 응답하지 않을 때 무한 대기할 수 있습니다.

```java
private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
private static final Duration READ_TIMEOUT = Duration.ofSeconds(10);

ClientHttpRequestFactorySettings settings =
    ClientHttpRequestFactorySettings.defaults()
        .withConnectTimeout(CONNECT_TIMEOUT)
        .withReadTimeout(READ_TIMEOUT);
```

**설정 값 의미:**
- `CONNECT_TIMEOUT(5초)`: 서버에 연결하는 데 최대 5초 대기
- `READ_TIMEOUT(10초)`: 응답을 읽는 데 최대 10초 대기

타임아웃이 발생하면 `RestClientException`이 던져지고, Graceful Degradation에 의해 빈 응답이 반환됩니다.

# 외부 API 응답 파싱

---

네이버 차트 API는 XML 형식으로 응답합니다. 이를 파싱하는 DTO를 구현합니다.

```java
@Getter
@Builder
public class NaverChartResponse {

  private List<ChartItem> items;

  @Getter
  @Builder
  public static class ChartItem {
    private String date;
    private long openPrice;
    private long highPrice;
    private long lowPrice;
    private long closePrice;
    private long volume;
  }

  public static NaverChartResponse fromXml(String xml) {
    List<ChartItem> items = new ArrayList<>();

    // <item data="20260130|72000|72500|71500|72200|15000000" /> 패턴 매칭
    Pattern pattern = Pattern.compile("<item\\s+data=\"([^\"]+)\"");
    Matcher matcher = pattern.matcher(xml);

    while (matcher.find()) {
      String data = matcher.group(1);
      String[] fields = data.split("\\|");

      if (fields.length >= 6) {
        try {
          ChartItem item = ChartItem.builder()
              .date(fields[0])
              .openPrice(parseLong(fields[1]))
              .highPrice(parseLong(fields[2]))
              .lowPrice(parseLong(fields[3]))
              .closePrice(parseLong(fields[4]))
              .volume(parseLong(fields[5]))
              .build();
          items.add(item);
        } catch (NumberFormatException e) {
          // 파싱 실패 시 스킵
        }
      }
    }

    return NaverChartResponse.builder().items(items).build();
  }
}
```

**파싱 시 주의점:**
- 정규식으로 필요한 데이터만 추출
- 파싱 실패 시 예외 대신 해당 아이템만 스킵
- 빈 응답도 정상 처리

# 테스트 작성

---

외부 API 연동 코드는 파싱 로직을 단위 테스트로 검증합니다.

```java
@Test
@DisplayName("일봉 데이터 XML 파싱 성공")
void shouldParseDailyChartXml() {
    // given
    String xml = """
        <chartdata>
        <item data="20260127|72000|72500|71500|72200|15000000" />
        <item data="20260128|72200|73000|72000|72800|18000000" />
        </chartdata>
        """;

    // when
    NaverChartResponse response = NaverChartResponse.fromXml(xml);

    // then
    assertThat(response.getItems()).hasSize(2);

    var firstItem = response.getItems().get(0);
    assertThat(firstItem.getDate()).isEqualTo("20260127");
    assertThat(firstItem.getClosePrice()).isEqualTo(72200L);
    assertThat(firstItem.getVolume()).isEqualTo(15000000L);
}

@Test
@DisplayName("잘못된 데이터 형식은 스킵")
void shouldSkipInvalidDataFormat() {
    // given
    String xml = """
        <chartdata>
        <item data="20260127|invalid|72500|71500|72200|15000000" />
        <item data="20260128|72200|73000|72000|72800|18000000" />
        </chartdata>
        """;

    // when
    NaverChartResponse response = NaverChartResponse.fromXml(xml);

    // then
    assertThat(response.getItems()).hasSize(1);  // 첫 번째는 스킵됨
}
```

# 정리

---

외부 API 연동 시 핵심 원칙:

1. **캐시 적용**: 레이트 리밋 대응, 응답 속도 향상
2. **타임아웃 설정**: 무한 대기 방지, 서비스 안정성 확보
3. **Graceful Degradation**: 실패해도 서비스는 계속
4. **Profile 분리**: 환경별 다른 구현체 사용
5. **견고한 파싱**: 예외 상황에서도 안정적으로 동작

캐시와 타임아웃은 단순히 성능을 위한 것이 아니라, 외부 의존성으로부터 서비스를 보호하는 방패입니다.

# 시리즈 완료

---

Stock-Info 시리즈를 모두 완료했습니다! 이 시리즈에서 다룬 내용을 정리합니다.

## 배운 것들

**Backend (Spring Boot)**
- Controller, Service, Provider 계층 구조
- DTO 설계와 변환 패턴
- JPA Entity와 Repository
- Rule Engine을 이용한 점수 시스템
- RSS 뉴스 수집 파이프라인
- 캐시와 외부 API 연동

**Frontend (React + TypeScript)**
- 컴포넌트, Props, State의 기본 개념
- Custom Hooks (useDebounce, useLocalStorage)
- Axios를 이용한 API Layer
- CSS 디자인 토큰과 컴포넌트 스타일링
- 검색, 즐겨찾기, 차트 등 인터랙티브 기능

## 다음 단계

이 프로젝트를 확장하려면:
- **테스트 작성**: JUnit, React Testing Library
- **CI/CD 구축**: GitHub Actions
- **배포**: AWS, Vercel, Railway 등
- **모니터링**: 로깅, 메트릭, 알림

→ **[01. 프로젝트 개요로 돌아가기](/stockinfo/stockinfo-01-overview/)**

# Reference

---

- [Spring Cache Abstraction](https://docs.spring.io/spring-framework/docs/current/reference/html/integration.html#cache)
- [Caffeine Cache](https://github.com/ben-manes/caffeine)
- [Spring Boot Cache Guide](https://spring.io/guides/gs/caching)
