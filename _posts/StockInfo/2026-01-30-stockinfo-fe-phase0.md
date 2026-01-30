---
title: "[StockInfo] FE Phase 0 - 프로젝트 구조와 API 레이어"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Vite]
---

# Introduction

---

Stock-Info 프론트엔드는 **React 19 + TypeScript + Vite**로 구성했다. 이 글에서는 프로젝트 구조, Axios를 활용한 API 레이어 설계, React Router DOM을 이용한 라우팅 구성을 다룬다.

# 기술 스택 선택

---

## 왜 Vite인가?

Create React App(CRA) 대신 Vite를 선택한 이유:

1. **빠른 개발 서버**: 네이티브 ESM 기반으로 콜드 스타트가 매우 빠름
2. **HMR(Hot Module Replacement)**: 컴포넌트 변경 시 즉시 반영
3. **번들 최적화**: Rollup 기반 프로덕션 빌드로 최적화된 결과물

## 프로젝트 초기화

```bash
npm create vite@latest stock-info-frontend -- --template react-swc-ts
cd stock-info-frontend
npm install
```

SWC는 Rust로 작성된 트랜스파일러로, Babel보다 훨씬 빠르다.

# 프로젝트 구조

---

```
src/
├── components/       # 재사용 가능한 컴포넌트
│   ├── MarketSummaryBar.tsx
│   ├── SectorCard.tsx
│   ├── StockRankingTable.tsx
│   ├── ScoreBadge.tsx
│   ├── Skeleton.tsx
│   └── EmptyState.tsx
├── hooks/            # Custom Hooks
│   ├── useDebounce.ts
│   ├── useLocalStorage.ts
│   ├── useFavorites.ts
│   └── useRecents.ts
├── pages/            # 페이지 컴포넌트
│   ├── HomePage.tsx
│   ├── SearchPage.tsx
│   ├── SectorDetailPage.tsx
│   └── StockDetailPage.tsx
├── services/
│   └── api.ts        # Axios 설정 + API 함수
├── types/
│   └── index.ts      # TypeScript 타입 정의
├── App.tsx           # 라우트 정의
└── main.tsx          # 엔트리 포인트
```

## 디렉토리별 역할

| 디렉토리 | 역할 | 예시 |
|---------|------|------|
| `components/` | UI 컴포넌트 | `ScoreBadge`, `Skeleton` |
| `hooks/` | 상태 로직 재사용 | `useFavorites`, `useDebounce` |
| `pages/` | 라우트에 매핑되는 페이지 | `HomePage`, `StockDetailPage` |
| `services/` | 외부 통신 로직 | API 호출 함수 |
| `types/` | TypeScript 인터페이스 | `StockDetail`, `SectorScore` |

# API 레이어 구성

---

## Axios 인스턴스 설정

공통 설정을 가진 Axios 인스턴스를 생성하여 반복 코드를 줄인다.

```typescript
// src/services/api.ts
import axios from 'axios';

// 환경 변수에서 API URL 읽기 (기본값: localhost:8080)
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';

// Axios 인스턴스 생성
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,  // 10초 타임아웃
  headers: {
    'Content-Type': 'application/json',
  },
});
```

## Request Interceptor - Bearer 토큰 자동 첨부

모든 요청에 인증 토큰을 자동으로 추가한다.

```typescript
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
```

## Response Interceptor - 401 처리

인증 실패 시 토큰을 삭제하고 로그인 페이지로 리다이렉트한다.

```typescript
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
```

## API 함수 예시

백엔드 응답을 프론트엔드 타입으로 변환하는 함수들을 정의한다.

```typescript
// 시장 지수 조회
export async function getMarketSummary(): Promise<MarketSummary[]> {
  const response = await api.get('/indexes');

  // IndexResponse → MarketSummary 변환
  return response.data.map((item: IndexResponse) => ({
    name: item.name,
    value: item.closingPrice,
    change: item.priceChange,
    changePercent: parseFloat(item.changeRate.replace('%', '')) || 0,
  }));
}

// 섹터별 종목 조회
export async function getStockScoreboard(sectorName: string): Promise<StockScoreboardResponse> {
  const response = await api.get(`/sectors/${encodeURIComponent(sectorName)}/stocks`);
  return {
    sectorName,
    updatedAt: new Date().toISOString(),
    stocks: response.data,
  };
}

// 종목 검색
export async function searchStocks(keyword: string): Promise<SearchResult[]> {
  if (!keyword.trim()) return [];

  const response = await api.get('/stocks/search', {
    params: { keyword: keyword.trim() },
  });

  return response.data;
}
```

# 라우팅 구성

---

React Router DOM 7을 사용하여 SPA 라우팅을 구성한다.

## 라우트 정의

```typescript
// src/App.tsx
import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import SectorDetailPage from './pages/SectorDetailPage';
import StockDetailPage from './pages/StockDetailPage';

function App() {
  return (
    <div className="app">
      <Routes>
        {/* 홈 페이지 */}
        <Route path="/" element={<HomePage />} />

        {/* 검색 페이지 */}
        <Route path="/search" element={<SearchPage />} />

        {/* 동적 라우팅: :sectorName이 변수가 됨 */}
        <Route path="/sector/:sectorName" element={<SectorDetailPage />} />

        {/* 종목 상세 */}
        <Route path="/stock/:stockCode" element={<StockDetailPage />} />
      </Routes>
    </div>
  );
}
```

## 라우트 테이블

| Path | Page | 설명 |
|------|------|------|
| `/` | HomePage | 시장 지수 + 섹터 목록 + 즐겨찾기 |
| `/search` | SearchPage | 종목 검색 |
| `/sector/:sectorName` | SectorDetailPage | 섹터별 종목 목록 |
| `/stock/:stockCode` | StockDetailPage | 종목 상세 + 차트 |

## useParams로 동적 파라미터 읽기

```typescript
// src/pages/SectorDetailPage.tsx
import { useParams } from 'react-router-dom';

function SectorDetailPage() {
  // URL이 /sector/전기전자 라면 sectorName = "전기전자"
  const { sectorName } = useParams<{ sectorName: string }>();

  // ...
}
```

# TypeScript 타입 정의

---

## 백엔드 응답에 맞춘 타입

```typescript
// src/types/index.ts

// 종목 상세 (KrxStockFinancialItem 기반)
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

// 섹터 점수
export interface SectorScore {
  sectorName: string;
  stockCount: number;
  score: number;
  label: 'STRONG' | 'NEUTRAL' | 'WEAK';
  reasons: string[];
  headlines?: NewsHeadline[];
}

// 종목 점수
export interface StockScore {
  code: string;
  name: string;
  price: number;
  priceChange: string;
  changeRate: string;
  score: number;
  label: 'STRONG' | 'NEUTRAL' | 'WEAK';
  reasons: string[];
  per?: number;
  pbr?: number;
}

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
```

## 차트 관련 타입

```typescript
export type ChartRange = '1D' | '1W' | '1M' | '3M' | '1Y';

export interface ChartDataPoint {
  date: string;
  price: number;
  volume?: number;
}

export interface ChartResponse {
  dataPoints: ChartDataPoint[];
  meta: {
    asOf: string;
    source: string;
    range: ChartRange;
  };
}
```

# Conclusion

---

Stock-Info 프론트엔드의 기초 설계를 정리하면:

1. **Vite + React 19 + TypeScript**: 빠른 개발 환경과 타입 안정성
2. **Axios 인스턴스**: 공통 설정과 인터셉터로 인증/에러 처리 일원화
3. **React Router DOM 7**: 동적 라우팅으로 섹터/종목 페이지 구성
4. **명확한 디렉토리 구조**: components/hooks/pages/services/types 분리

이 구조를 바탕으로 컴포넌트를 추가하고 기능을 확장할 수 있었다.

# Reference

---

- [Vite Documentation](https://vitejs.dev/)
- [React Router v7](https://reactrouter.com/)
- [Axios Documentation](https://axios-http.com/)
