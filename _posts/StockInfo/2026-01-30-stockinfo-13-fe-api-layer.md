---
title: "[StockInfo] 13. API Layer - Axios와 타입 안전한 API 호출"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Axios, API]
---

# Introduction

---

프론트엔드에서 백엔드 API를 호출하는 것은 핵심 기능입니다. 단순히 `fetch()`를 쓰면 될까요?

실제 프로젝트에서는 더 많은 것이 필요합니다:
- 인증 토큰 자동 첨부
- 에러 처리
- 타입 안전성
- 재사용 가능한 설정

Stock-Info는 **Axios**로 API Layer를 구성했습니다.

# Axios vs Fetch

---

## 왜 Axios인가?

| 기능 | Fetch | Axios |
|------|-------|-------|
| 브라우저 내장 | O | X (설치 필요) |
| JSON 자동 변환 | X (수동) | O |
| 요청/응답 인터셉터 | X | O |
| 타임아웃 설정 | 복잡 | 간단 |
| 에러 처리 | 상태 코드 직접 체크 | 자동 throw |

```javascript
// Fetch - JSON 변환 필요
const response = await fetch('/api/stocks');
const data = await response.json();

// Axios - 자동 변환
const { data } = await axios.get('/api/stocks');
```

# Axios 인스턴스 설정

---

## 기본 설정

```tsx
// src/services/api.ts

import axios from 'axios';

// 환경 변수에서 API URL 읽기
const API_BASE_URL = import.meta.env.VITE_API_URL
  || 'http://localhost:8080/api';

// Axios 인스턴스 생성
const api = axios.create({
  baseURL: API_BASE_URL,     // 모든 요청의 기본 URL
  timeout: 10000,            // 10초 타임아웃
  headers: {
    'Content-Type': 'application/json',
  },
});

export default api;
```

### 환경 변수

Vite에서는 `import.meta.env`로 환경 변수를 읽습니다.

```bash
# .env.local
VITE_API_URL=http://localhost:8080/api

# .env.production
VITE_API_URL=https://api.stockinfo.com
```

**주의:** Vite 환경 변수는 `VITE_` 접두사가 필요합니다.

# 인터셉터 (Interceptor)

---

## 요청 인터셉터

모든 요청에 **인증 토큰을 자동 첨부**합니다.

```tsx
// 요청 인터셉터
api.interceptors.request.use(
  (config) => {
    // localStorage에서 토큰 읽기
    const token = localStorage.getItem('accessToken');

    // 토큰이 있으면 Authorization 헤더에 추가
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => Promise.reject(error)
);
```

### Bearer 토큰

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

- `Bearer`: 토큰 타입
- 뒤에 실제 토큰 값

## 응답 인터셉터

모든 응답에 대해 **공통 에러 처리**를 합니다.

```tsx
// 응답 인터셉터
api.interceptors.response.use(
  // 성공 시: 그대로 반환
  (response) => response,

  // 실패 시: 에러 처리
  (error) => {
    // 401 에러: 인증 실패 (토큰 만료 등)
    if (error.response?.status === 401) {
      // 토큰 삭제
      localStorage.removeItem('accessToken');
      // 로그인 페이지로 이동
      window.location.href = '/login';
    }

    // 에러를 다시 던져서 호출한 곳에서 처리
    return Promise.reject(error);
  }
);
```

# TypeScript 타입 정의

---

## 타입 파일 구성

```tsx
// src/types/index.ts

// 시장 요약
export interface MarketSummary {
  name: string;        // "코스피", "코스닥"
  value: number;       // 지수값
  change: number;      // 전일대비
  changePercent: number; // 등락률
}

// 섹터 점수
export interface SectorScore {
  name: string;
  score: number;
  label: 'STRONG' | 'NEUTRAL' | 'WEAK';
  stockCount: number;
  topStocks?: StockScore[];
  headlines?: string[];
}

// 종목 점수
export interface StockScore {
  code: string;
  name: string;
  score: number;
  label: 'STRONG' | 'NEUTRAL' | 'WEAK';
  price: number;
  priceChange: string;
  sectorName: string;
}

// 종목 상세
export interface StockDetail {
  stockCode: string;
  stockName: string;
  closingPrice: number;
  priceChange: number;
  changeRate: number;
  eps: number;
  per: number;
  forwardEps: number;
  forwardPer: number;
  bps: number;
  pbr: number;
  dividendPerShare: number;
  dividendYield: number;
}

// 차트 데이터
export interface ChartDataPoint {
  timestamp: string;
  price: number;
}

export interface ChartResponse {
  dataPoints: ChartDataPoint[];
  meta: {
    stockCode: string;
    range: ChartRange;
    dataPointCount: number;
  };
}

export type ChartRange = '1D' | '1W' | '1M' | '3M' | '1Y';

// 검색 결과
export interface SearchResult {
  code: string;
  name: string;
  score: number;
  label: string;
  price: number;
  priceChange: string;
  sectorName: string;
  market?: string;
}

// 종목 인사이트
export interface StockInsight {
  entity: {
    code: string;
    name: string;
  };
  score: {
    value: number;
    grade: string;
  };
  summary: {
    headline: string;
    tone: 'ACTIVE_GUIDE' | 'CAUTIOUS_GUIDE';
    actionHint: {
      text: string;
    };
  };
  reasons: {
    positive: ReasonCard[];
    caution: ReasonCard[];
    triggeredRules: string[];
  };
  meta: {
    asOf: string;
    sources: string[];
    coverage: number;
  };
}

export interface ReasonCard {
  text: string;
  polarity: 'POSITIVE' | 'NEGATIVE';
}
```

# API 함수 구현

---

## 시장 지수 조회

```tsx
/**
 * 시장 지수 데이터를 가져옵니다 (코스피, 코스닥 등)
 */
export async function getMarketSummary(): Promise<MarketSummary[]> {
  const response = await api.get('/indexes');

  // API 응답을 MarketSummary 타입으로 변환
  return response.data.map((item: {
    name: string;
    closingPrice: number;
    priceChange: number;
    changeRate: string;
  }) => ({
    name: item.name,
    value: item.closingPrice,
    change: item.priceChange,
    // "+0.42%"에서 숫자 추출
    changePercent: parseFloat(item.changeRate.replace('%', '')) || 0,
  }));
}
```

### 응답 변환

백엔드 응답과 프론트엔드 타입이 다를 수 있습니다.

```tsx
// 백엔드 응답
{
  "closingPrice": 2850.32,
  "changeRate": "+0.42%"
}

// 프론트엔드 타입
{
  value: 2850.32,
  changePercent: 0.42
}
```

변환 로직을 API 함수에서 처리합니다.

## 섹터 스코어보드 조회

```tsx
export interface SectorScoreboardResponse {
  updatedAt: string;
  sectors: SectorScore[];
}

/**
 * 전체 섹터의 점수/라벨/이유를 가져옵니다
 */
export async function getSectorScoreboard(): Promise<SectorScoreboardResponse> {
  const response = await api.get('/sectors');

  // 배열 응답을 객체로 감싸기
  const sectors: SectorScore[] = response.data.map((s: SectorScore) => ({
    ...s,
    headlines: s.headlines || [],
  }));

  return {
    updatedAt: new Date().toISOString(),
    sectors,
  };
}
```

## 종목 상세 조회

```tsx
/**
 * 특정 종목의 재무지표 정보를 가져옵니다
 */
export async function getStockDetail(code: string): Promise<StockDetail> {
  const response = await api.get(`/stocks/${code}`);
  const data = response.data;

  // null 처리 (nullish coalescing)
  return {
    stockCode: data.stockCode,
    stockName: data.stockName,
    closingPrice: data.closingPrice ?? 0,
    priceChange: data.priceChange ?? 0,
    changeRate: data.changeRate ?? 0,
    eps: data.eps ?? 0,
    per: data.per ?? 0,
    forwardEps: data.forwardEps ?? 0,
    forwardPer: data.forwardPer ?? 0,
    bps: data.bps ?? 0,
    pbr: data.pbr ?? 0,
    dividendPerShare: data.dividendPerShare ?? 0,
    dividendYield: data.dividendYield ?? 0,
  };
}
```

### Nullish Coalescing (??)

```tsx
// ?? : null 또는 undefined일 때만 기본값 사용
data.eps ?? 0  // eps가 null/undefined면 0

// || : falsy 값(0, '', false 등)도 기본값 사용
data.eps || 0  // eps가 0이어도 0 반환 (문제!)
```

## 종목 차트 조회

```tsx
/**
 * 종목 차트 데이터 조회
 */
export async function getStockChart(
  stockCode: string,
  range: ChartRange = '1M'
): Promise<ChartResponse> {
  const response = await api.get<ChartResponse>(
    `/stocks/${stockCode}/chart`,
    { params: { range } }
  );

  return response.data;
}
```

### 제네릭으로 타입 지정

```tsx
// 응답 타입을 제네릭으로 지정
const response = await api.get<ChartResponse>('/stocks/005930/chart');

// response.data의 타입이 ChartResponse로 추론됨
```

## 종목 검색

```tsx
/**
 * 종목 검색 API
 */
export async function searchStocks(keyword: string): Promise<SearchResult[]> {
  if (!keyword.trim()) {
    return [];  // 빈 검색어는 빈 배열 반환
  }

  const response = await api.get('/stocks/search', {
    params: { keyword: keyword.trim() },
  });

  // 응답 변환
  return response.data.map((item: {
    code: string;
    name: string;
    score: number;
    label: string;
    price: number;
    priceChange: string;
    sectorName: string;
    market?: string;
  }) => ({
    code: item.code,
    name: item.name,
    score: item.score,
    label: item.label,
    price: item.price,
    priceChange: item.priceChange,
    sectorName: item.sectorName,
    market: item.market,
  }));
}
```

# 에러 처리

---

## 컴포넌트에서의 에러 처리

```tsx
function StockDetailPage() {
  const { code } = useParams<{ code: string }>();
  const [stock, setStock] = useState<StockDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStock() {
      try {
        setLoading(true);
        setError(null);

        const data = await getStockDetail(code!);
        setStock(data);
      } catch (err) {
        // Axios 에러 처리
        if (axios.isAxiosError(err)) {
          if (err.response?.status === 404) {
            setError('종목을 찾을 수 없습니다.');
          } else if (err.response?.status === 500) {
            setError('서버 오류가 발생했습니다.');
          } else {
            setError('네트워크 오류가 발생했습니다.');
          }
        } else {
          setError('알 수 없는 오류가 발생했습니다.');
        }
      } finally {
        setLoading(false);
      }
    }

    if (code) {
      fetchStock();
    }
  }, [code]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!stock) return null;

  return <StockDetailView stock={stock} />;
}
```

## axios.isAxiosError

Axios 에러인지 확인합니다.

```tsx
import axios from 'axios';

try {
  await api.get('/stocks/invalid');
} catch (err) {
  if (axios.isAxiosError(err)) {
    // Axios 에러 (네트워크, 응답 에러)
    console.log(err.response?.status);   // 404, 500 등
    console.log(err.response?.data);     // 에러 응답 본문
    console.log(err.message);            // 에러 메시지
  } else {
    // 기타 에러
    console.log(err);
  }
}
```

# 전체 API 파일

---

```tsx
// src/services/api.ts

import axios from 'axios';
import type {
  MarketSummary,
  SectorScoreboardResponse,
  StockScoreboardResponse,
  StockDetail,
  SectorScore,
  StockInsight,
  SectorInsight,
  HomePicksResponse,
  ChartResponse,
  ChartRange,
  SearchResult
} from '../types';

// ========================================
// Axios 인스턴스 설정
// ========================================

const API_BASE_URL = import.meta.env.VITE_API_URL
  || 'http://localhost:8080/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 요청 인터셉터
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// 응답 인터셉터
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('accessToken');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ========================================
// API 함수들
// ========================================

export async function getMarketSummary(): Promise<MarketSummary[]> { ... }
export async function getSectorScoreboard(): Promise<SectorScoreboardResponse> { ... }
export async function getStockDetail(code: string): Promise<StockDetail> { ... }
export async function getStockChart(stockCode: string, range?: ChartRange): Promise<ChartResponse> { ... }
export async function searchStocks(keyword: string): Promise<SearchResult[]> { ... }
export async function getStockInsight(stockCode: string): Promise<StockInsight> { ... }
export async function getSectorInsight(sectorName: string): Promise<SectorInsight> { ... }
export async function getHomePicks(size?: number, preset?: string): Promise<HomePicksResponse> { ... }

export default api;
```

# 정리

---

| 개념 | 설명 |
|------|------|
| Axios 인스턴스 | baseURL, timeout 등 공통 설정 |
| 요청 인터셉터 | 모든 요청에 토큰 자동 첨부 |
| 응답 인터셉터 | 401 에러 시 로그인 페이지 이동 |
| TypeScript 타입 | API 응답을 타입으로 정의 |
| 제네릭 | `api.get<Type>()` 으로 응답 타입 지정 |
| axios.isAxiosError | Axios 에러 여부 확인 |

API Layer를 잘 구성하면:
- **중복 코드 제거**: 공통 설정 한 곳에서 관리
- **타입 안전성**: 컴파일 시점에 오류 발견
- **유지보수 용이**: API 변경 시 한 곳만 수정

다음 글에서는 **CSS와 스타일링**을 알아봅니다.

# Reference

---

- [Axios Documentation](https://axios-http.com/docs/intro)
- [Vite Environment Variables](https://vitejs.dev/guide/env-and-mode.html)
