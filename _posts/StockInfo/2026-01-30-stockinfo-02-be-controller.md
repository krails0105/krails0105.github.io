---
title: "[StockInfo] 02. Spring Controller - REST API의 입구"
categories:
  - StockInfo
tags:
  - [Java, Spring, REST API]
---

# Introduction

---

웹 애플리케이션에서 **Controller**는 클라이언트의 요청을 가장 먼저 받는 곳입니다. 마치 회사의 안내 데스크처럼, 어떤 요청이 왔는지 확인하고 적절한 부서(Service)로 연결해줍니다.

이 글에서는 Spring의 Controller가 무엇인지, 그리고 Stock-Info 프로젝트에서 어떻게 구현했는지 알아봅니다.

# Controller란?

---

## 기본 개념

**Controller**는 MVC(Model-View-Controller) 패턴의 C에 해당합니다.

```
클라이언트 요청  →  [Controller]  →  Service  →  데이터 처리
                       ↓
                   응답 반환
```

Controller의 역할:
1. **HTTP 요청 수신**: URL과 HTTP 메서드(GET, POST 등)에 따라 요청 처리
2. **파라미터 추출**: URL 경로, 쿼리 스트링, 요청 본문에서 데이터 추출
3. **Service 호출**: 비즈니스 로직은 Service에 위임
4. **응답 반환**: 처리 결과를 JSON 등의 형식으로 반환

## REST API란?

REST(Representational State Transfer)는 웹 API 설계 스타일입니다.

| HTTP 메서드 | 의미 | 예시 |
|------------|------|------|
| GET | 조회 | 종목 정보 가져오기 |
| POST | 생성 | 새 즐겨찾기 추가 |
| PUT | 수정 | 정보 업데이트 |
| DELETE | 삭제 | 즐겨찾기 제거 |

URL 설계 규칙:
```
/api/stocks          # 종목 목록 (복수형)
/api/stocks/005930   # 특정 종목 (ID로 식별)
/api/stocks/search   # 동작 (동사는 예외적으로 허용)
```

# Spring의 Controller 어노테이션

---

## @RestController

REST API용 Controller를 선언합니다.

```java
@RestController  // REST API Controller임을 선언
public class StockController {
    // ...
}
```

`@RestController` = `@Controller` + `@ResponseBody`
- `@Controller`: Spring MVC Controller
- `@ResponseBody`: 반환값을 JSON으로 변환

## @RequestMapping

기본 URL 경로를 지정합니다.

```java
@RestController
@RequestMapping("/api/stocks")  // 이 Controller의 모든 메서드는 /api/stocks로 시작
public class StockController {
    // GET /api/stocks/005930 처리
}
```

## HTTP 메서드 매핑

```java
@GetMapping("/{id}")      // GET 요청
@PostMapping              // POST 요청
@PutMapping("/{id}")      // PUT 요청
@DeleteMapping("/{id}")   // DELETE 요청
```

## 파라미터 추출

```java
// URL 경로 변수: /api/stocks/005930
@GetMapping("/{id}")
public Stock getStock(@PathVariable String id) { ... }

// 쿼리 스트링: /api/stocks/search?keyword=삼성
@GetMapping("/search")
public List<Stock> search(@RequestParam String keyword) { ... }

// 쿼리 스트링 (기본값 설정)
@GetMapping("/chart")
public Chart getChart(
    @RequestParam(defaultValue = "1M") String range) { ... }
```

## ResponseEntity

HTTP 상태 코드와 함께 응답을 반환합니다.

```java
@GetMapping("/{id}")
public ResponseEntity<StockDetail> getStock(@PathVariable String id) {
    StockInfo stock = stockService.getStockById(id);

    if (stock == null) {
        return ResponseEntity.notFound().build();  // 404 Not Found
    }

    return ResponseEntity.ok(stockDetail);  // 200 OK + 데이터
}
```

| 상태 코드 | 의미 | 메서드 |
|----------|------|--------|
| 200 | 성공 | `ResponseEntity.ok(data)` |
| 201 | 생성됨 | `ResponseEntity.created(uri).body(data)` |
| 400 | 잘못된 요청 | `ResponseEntity.badRequest()` |
| 404 | 없음 | `ResponseEntity.notFound()` |
| 500 | 서버 오류 | (예외 처리로 자동) |

# Stock-Info의 Controller 구현

---

## StockController

종목 관련 API를 담당합니다.

```java
@RestController
@RequestMapping("/api/stocks")
@RequiredArgsConstructor  // 생성자 주입 자동 생성
@Slf4j                    // 로깅
public class StockController {

    // 의존성 주입: Service 객체를 Spring이 자동으로 넣어줌
    private final StockService stockService;

    /**
     * 종목 상세 조회
     * GET /api/stocks/{id}
     */
    @GetMapping("/{id}")
    public ResponseEntity<StockDetailResponse> getStockById(
            @PathVariable String id) {

        log.info("Request to get stock: {}", id);  // 로그 출력

        StockInfo stockInfo = stockService.getStockById(id);

        if (stockInfo == null) {
            return ResponseEntity.notFound().build();
        }

        // Domain DTO → Response DTO 변환
        return ResponseEntity.ok(
            StockDetailResponse.fromStockInfo(stockInfo)
        );
    }

    /**
     * 종목 검색
     * GET /api/stocks/search?keyword=삼성
     */
    @GetMapping("/search")
    public List<StockScoreDto> searchStocks(
            @RequestParam String keyword) {

        return stockService.searchStocks(keyword);
    }

    /**
     * 종목 차트 데이터
     * GET /api/stocks/{code}/chart?range=1M
     */
    @GetMapping("/{code}/chart")
    public ResponseEntity<ChartResponse> getStockChart(
            @PathVariable String code,
            @RequestParam(defaultValue = "1M") String range) {

        ChartResponse chart = stockService.getStockChart(code, range);
        return ResponseEntity.ok(chart);
    }
}
```

### 코드 분석

**@RequiredArgsConstructor**

Lombok이 `final` 필드에 대한 생성자를 자동 생성합니다.

```java
// Lombok이 자동으로 만들어주는 코드
public StockController(StockService stockService) {
    this.stockService = stockService;
}
```

**@Slf4j**

로깅을 위한 `log` 객체를 자동 생성합니다.

```java
log.info("Request: {}", id);   // INFO 레벨
log.debug("Debug: {}", data);  // DEBUG 레벨
log.error("Error: {}", e);     // ERROR 레벨
```

## SectorController

섹터(업종) 관련 API를 담당합니다.

```java
@RestController
@RequestMapping("/api/sectors")
@RequiredArgsConstructor
@Slf4j
public class SectorController {

    private final SectorService sectorService;

    /**
     * 스코어보드 조회 (메인 페이지용)
     * GET /api/sectors/scoreboard
     *
     * 반환: 핫 섹터, 시장 요약, 전체 섹터 점수
     */
    @GetMapping("/scoreboard")
    public ScoreboardResponse getScoreboard() {
        return sectorService.getScoreboard();
    }

    /**
     * 전체 섹터 목록
     * GET /api/sectors
     */
    @GetMapping
    public List<SectorScoreDto> getAllSectors() {
        return sectorService.getAllSectors();
    }

    /**
     * 섹터별 종목 조회
     * GET /api/sectors/{sectorName}/stocks
     *
     * 예: /api/sectors/전기전자/stocks
     */
    @GetMapping("/{sectorName}/stocks")
    public ResponseEntity<List<StockListItem>> getStocksBySectorName(
            @PathVariable String sectorName) {

        List<StockListItem> stocks = sectorService
            .getStocksBySectorName(sectorName);

        if (stocks.isEmpty()) {
            return ResponseEntity.notFound().build();
        }

        return ResponseEntity.ok(stocks);
    }

    /**
     * 섹터 인사이트 조회
     * GET /api/sectors/{sectorName}/insight
     */
    @GetMapping("/{sectorName}/insight")
    public ResponseEntity<SectorInsight> getSectorInsight(
            @PathVariable String sectorName) {

        SectorInsight insight = sectorService
            .getSectorInsight(sectorName);

        return ResponseEntity.ok(insight);
    }
}
```

### URL 인코딩 주의

한글이 포함된 URL은 인코딩이 필요합니다.

```
/api/sectors/전기전자/stocks
→ /api/sectors/%EC%A0%84%EA%B8%B0%EC%A0%84%EC%9E%90/stocks
```

프론트엔드에서:
```typescript
const url = `/sectors/${encodeURIComponent(sectorName)}/stocks`;
```

## IndexController

시장 지수 API를 담당합니다.

```java
@RestController
@RequestMapping("/api/indexes")
@RequiredArgsConstructor
public class IndexController {

    private final IndexService indexService;

    /**
     * 시장 지수 조회
     * GET /api/indexes
     *
     * 반환: 코스피, 코스닥 지수 정보
     */
    @GetMapping
    public List<IndexResponse> getIndexes() {
        return indexService.getIndexes()
            .stream()
            .map(IndexResponse::fromIndex)
            .toList();
    }
}
```

# Controller 설계 원칙

---

## 1. 얇은 Controller

Controller는 요청/응답 처리만 담당합니다. 비즈니스 로직은 Service에 위임합니다.

```java
// 나쁜 예: Controller에 로직이 있음
@GetMapping("/top")
public List<Stock> getTopStocks() {
    List<Stock> all = stockService.getAll();
    return all.stream()
        .sorted(Comparator.comparing(Stock::getScore).reversed())
        .limit(10)
        .toList();  // 정렬/필터 로직이 Controller에!
}

// 좋은 예: Service에 위임
@GetMapping("/top")
public List<Stock> getTopStocks(
        @RequestParam(defaultValue = "10") int limit) {
    return stockService.getTopStocks(limit);
}
```

## 2. 일관된 응답 형식

모든 API가 일관된 형식으로 응답합니다.

```java
// 성공: 데이터 직접 반환
{
  "stockCode": "005930",
  "stockName": "삼성전자",
  "closingPrice": 72500
}

// 목록: 배열 반환
[
  { "code": "005930", "name": "삼성전자" },
  { "code": "000660", "name": "SK하이닉스" }
]
```

## 3. 적절한 HTTP 상태 코드

상황에 맞는 상태 코드를 반환합니다.

```java
@GetMapping("/{id}")
public ResponseEntity<Stock> getStock(@PathVariable String id) {
    Stock stock = service.findById(id);

    if (stock == null) {
        return ResponseEntity.notFound().build();  // 404
    }

    return ResponseEntity.ok(stock);  // 200
}
```

## 4. 예외 처리

Controller에서 발생한 예외는 전역 처리합니다.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<String> handleBadRequest(
            IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(e.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleError(Exception e) {
        log.error("Unexpected error", e);
        return ResponseEntity.internalServerError()
            .body("서버 오류가 발생했습니다.");
    }
}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| @RestController | REST API용 Controller 선언 |
| @RequestMapping | 기본 URL 경로 지정 |
| @GetMapping | GET 요청 처리 |
| @PathVariable | URL 경로에서 값 추출 |
| @RequestParam | 쿼리 스트링에서 값 추출 |
| ResponseEntity | HTTP 상태 코드와 함께 응답 |

Controller는 클라이언트와 서버 사이의 **계약(API 스펙)**을 정의합니다. 다음 글에서는 Controller가 호출하는 **Service 계층**에 대해 알아봅니다.

# Reference

---

- [Spring Web MVC Documentation](https://docs.spring.io/spring-framework/docs/current/reference/html/web.html)
- [Building REST services with Spring](https://spring.io/guides/tutorials/rest/)
