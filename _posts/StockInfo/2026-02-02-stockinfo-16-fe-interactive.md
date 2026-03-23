---
title: "[StockInfo] 16. 검색/즐겨찾기/차트 - 인터랙티브 기능"
categories:
  - StockInfo
tags: [React, TypeScript, Recharts]
---

## Introduction

---

Stock-Info의 핵심 인터랙티브 기능을 알아봅니다:
- **검색**: 종목명/코드로 빠른 검색
- **즐겨찾기**: 관심 종목 저장 및 관리
- **차트**: Recharts로 주가 시각화

## SearchPage

---

### 검색 화면 구조

```
┌─────────────────────────────────────────────┐
│  🔍 [삼성전자________________] [검색]       │
│                                              │
│  추천 검색어                                 │
│  [삼성전자] [SK하이닉스] [현대차] [카카오]   │
│                                              │
│  검색 결과                                   │
│  ┌─────────────────────────────────────────┐│
│  │ 삼성전자 (005930)        72점 STRONG    ││
│  │ 72,500원  +0.69%         전기전자       ││
│  └─────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────┐│
│  │ 삼성전기 (009150)        65점 NEUTRAL   ││
│  │ 145,000원  -0.34%        전기전자       ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### 컴포넌트 구현

```tsx
// src/pages/SearchPage.tsx

import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import useDebounce from '../hooks/useDebounce';
import { searchStocks } from '../services/api';
import type { SearchResult } from '../types';
import ScoreBadge from '../components/ScoreBadge';
import EmptyState from '../components/EmptyState';
import { Search, TrendingUp } from 'lucide-react';
import './SearchPage.css';

// 추천 검색어
const SUGGESTED_KEYWORDS = [
  '삼성전자', 'SK하이닉스', '현대차', '카카오',
  'LG에너지솔루션', '네이버', '기아', '셀트리온'
];

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialKeyword = searchParams.get('q') || '';

  const [keyword, setKeyword] = useState(initialKeyword);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // 300ms 디바운스 적용
  const debouncedKeyword = useDebounce(keyword, 300);

  // 디바운스된 키워드로 검색
  useEffect(() => {
    if (!debouncedKeyword.trim()) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    async function performSearch() {
      setLoading(true);
      try {
        const data = await searchStocks(debouncedKeyword);
        setResults(data);
        setHasSearched(true);

        // URL 파라미터 업데이트
        setSearchParams({ q: debouncedKeyword });
      } catch (error) {
        console.error('Search failed:', error);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }

    performSearch();
  }, [debouncedKeyword, setSearchParams]);

  // 추천 검색어 클릭
  const handleSuggestionClick = (suggested: string) => {
    setKeyword(suggested);
  };

  return (
    <div className="search-page">
      {/* 검색 입력 */}
      <div className="search-input-container">
        <Search className="search-icon" size={20} />
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="종목명 또는 종목코드 검색..."
          className="search-input"
          autoFocus
        />
        {keyword && (
          <button
            className="clear-button"
            onClick={() => setKeyword('')}
            aria-label="검색어 지우기"
          >
            ✕
          </button>
        )}
      </div>

      {/* 추천 검색어 */}
      {!hasSearched && (
        <div className="suggestions-section">
          <h3 className="suggestions-title">
            <TrendingUp size={16} />
            추천 검색어
          </h3>
          <div className="suggestions-list">
            {SUGGESTED_KEYWORDS.map((suggested) => (
              <button
                key={suggested}
                className="suggestion-chip"
                onClick={() => handleSuggestionClick(suggested)}
              >
                {suggested}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 검색 결과 */}
      {loading ? (
        <div className="search-loading">검색 중...</div>
      ) : hasSearched ? (
        results.length > 0 ? (
          <div className="search-results">
            <p className="results-count">
              {results.length}개 종목을 찾았습니다
            </p>
            <div className="results-list">
              {results.map((stock) => (
                <SearchResultCard key={stock.code} stock={stock} />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Search size={48} />}
            title="검색 결과가 없습니다"
            description={`"${debouncedKeyword}"에 해당하는 종목을 찾을 수 없습니다`}
          />
        )
      ) : null}
    </div>
  );
}

// ================================================
// 검색 결과 카드
// ================================================
interface SearchResultCardProps {
  stock: SearchResult;
}

function SearchResultCard({ stock }: SearchResultCardProps) {
  const changeClass = stock.priceChange.startsWith('+') ? 'up'
                    : stock.priceChange.startsWith('-') ? 'down'
                    : 'flat';

  return (
    <Link to={`/stock/${stock.code}`} className="search-result-card">
      <div className="result-main">
        <div className="result-info">
          <span className="result-name">{stock.name}</span>
          <span className="result-code">{stock.code}</span>
        </div>
        <ScoreBadge score={stock.score} label={stock.label} size="sm" />
      </div>

      <div className="result-details">
        <div className="result-price">
          <span className="price-value">
            {stock.price.toLocaleString()}원
          </span>
          <span className={`price-change ${changeClass}`}>
            {stock.priceChange}
          </span>
        </div>
        <span className="result-sector">{stock.sectorName}</span>
      </div>
    </Link>
  );
}
```

### CSS 스타일

```css
/* src/pages/SearchPage.css */

.search-page {
  max-width: 600px;
  margin: 0 auto;
  padding: var(--spacing-lg);
}

/* 검색 입력 */
.search-input-container {
  position: relative;
  margin-bottom: var(--spacing-lg);
}

.search-icon {
  position: absolute;
  left: var(--spacing-md);
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-gray-400);
}

.search-input {
  width: 100%;
  padding: var(--spacing-md) var(--spacing-md) var(--spacing-md) 48px;
  font-size: var(--font-size-md);
  border: 2px solid var(--color-gray-200);
  border-radius: var(--radius-lg);
  outline: none;
  transition: border-color var(--transition-fast);
}

.search-input:focus {
  border-color: var(--color-primary-500);
}

.clear-button {
  position: absolute;
  right: var(--spacing-md);
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--color-gray-400);
  cursor: pointer;
  padding: 4px;
}

/* 추천 검색어 */
.suggestions-section {
  margin-bottom: var(--spacing-xl);
}

.suggestions-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-600);
  margin-bottom: var(--spacing-sm);
}

.suggestions-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.suggestion-chip {
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-gray-100);
  border: none;
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  color: var(--color-gray-700);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.suggestion-chip:hover {
  background: var(--color-primary-100);
  color: var(--color-primary-700);
}

/* 검색 결과 */
.results-count {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
  margin-bottom: var(--spacing-md);
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.search-result-card {
  display: block;
  padding: var(--spacing-md);
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-subtle);
  text-decoration: none;
  transition: all var(--transition-fast);
}

.search-result-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.result-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xs);
}

.result-info {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.result-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-900);
}

.result-code {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
}

.result-details {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.result-price {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.price-value {
  font-size: var(--font-size-sm);
  color: var(--color-gray-700);
}

.price-change.up { color: var(--color-price-up); }
.price-change.down { color: var(--color-price-down); }
.price-change.flat { color: var(--color-gray-500); }

.result-sector {
  font-size: var(--font-size-xs);
  color: var(--color-gray-500);
}
```

# FavoriteButton

---

### 즐겨찾기 토글 버튼

```tsx
// src/components/FavoriteButton.tsx

import useFavorites from '../hooks/useFavorites';
import { Star } from 'lucide-react';
import './FavoriteButton.css';

interface FavoriteButtonProps {
  stockCode: string;
  size?: 'sm' | 'md' | 'lg';
}

export default function FavoriteButton({
  stockCode,
  size = 'md'
}: FavoriteButtonProps) {
  const { isFavorite, toggle } = useFavorites();

  const favorite = isFavorite(stockCode);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();  // Link 내부에서 사용 시 이동 방지
    e.stopPropagation();
    toggle(stockCode);
  };

  const iconSize = { sm: 16, md: 20, lg: 24 }[size];

  return (
    <button
      onClick={handleClick}
      className={`favorite-button size-${size} ${favorite ? 'active' : ''}`}
      aria-label={favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
      aria-pressed={favorite}
    >
      <Star
        size={iconSize}
        fill={favorite ? 'currentColor' : 'none'}
        strokeWidth={2}
      />
    </button>
  );
}
```

```css
/* src/components/FavoriteButton.css */

.favorite-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-gray-400);
  padding: var(--spacing-xs);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.favorite-button:hover {
  color: var(--color-warning);
  background: rgba(245, 158, 11, 0.1);
}

.favorite-button.active {
  color: var(--color-warning);
}

/* 클릭 피드백 */
.favorite-button:active {
  transform: scale(0.9);
}

/* 크기 변형 */
.favorite-button.size-sm { padding: 4px; }
.favorite-button.size-md { padding: 6px; }
.favorite-button.size-lg { padding: 8px; }
```

# StockPriceChart

---

### Recharts로 차트 구현

```tsx
// src/components/StockPriceChart.tsx

import { useState, useEffect } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { getStockChart } from '../services/api';
import type { ChartResponse, ChartRange, ChartDataPoint } from '../types';
import './StockPriceChart.css';

interface StockPriceChartProps {
  stockCode: string;
}

const RANGE_OPTIONS: { value: ChartRange; label: string }[] = [
  { value: '1D', label: '1일' },
  { value: '1W', label: '1주' },
  { value: '1M', label: '1개월' },
  { value: '3M', label: '3개월' },
  { value: '1Y', label: '1년' },
];

export default function StockPriceChart({ stockCode }: StockPriceChartProps) {
  const [range, setRange] = useState<ChartRange>('1M');
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [loading, setLoading] = useState(true);

  // 차트 데이터 로드
  useEffect(() => {
    async function loadChart() {
      setLoading(true);
      try {
        const response: ChartResponse = await getStockChart(stockCode, range);
        setData(response.dataPoints);
      } catch (error) {
        console.error('Failed to load chart:', error);
        setData([]);
      } finally {
        setLoading(false);
      }
    }

    loadChart();
  }, [stockCode, range]);

  // 가격 범위 계산 (Y축 범위)
  const prices = data.map(d => d.price);
  const minPrice = Math.min(...prices) * 0.98;
  const maxPrice = Math.max(...prices) * 1.02;

  // 상승/하락 여부
  const isUp = data.length > 1 && data[data.length - 1].price > data[0].price;

  return (
    <div className="stock-price-chart">
      {/* 기간 선택 탭 */}
      <div className="chart-range-tabs">
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option.value}
            className={`range-tab ${range === option.value ? 'active' : ''}`}
            onClick={() => setRange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* 차트 영역 */}
      <div className="chart-container">
        {loading ? (
          <div className="chart-loading">차트 로딩 중...</div>
        ) : data.length === 0 ? (
          <div className="chart-empty">차트 데이터가 없습니다</div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart
              data={data}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                {/* 그라디언트 정의 */}
                <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor={isUp ? '#dc2626' : '#2563eb'}
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="95%"
                    stopColor={isUp ? '#dc2626' : '#2563eb'}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>

              <XAxis
                dataKey="timestamp"
                tickFormatter={formatXAxis}
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
              />

              <YAxis
                domain={[minPrice, maxPrice]}
                tickFormatter={(v) => v.toLocaleString()}
                tick={{ fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />

              <Tooltip
                content={<CustomTooltip />}
                cursor={{ stroke: '#9ca3af', strokeDasharray: '5 5' }}
              />

              <Area
                type="monotone"
                dataKey="price"
                stroke={isUp ? '#dc2626' : '#2563eb'}
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorPrice)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// X축 포맷터
function formatXAxis(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// 커스텀 툴팁
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) {
    return null;
  }

  const date = new Date(label);
  const price = payload[0].value;

  return (
    <div className="chart-tooltip">
      <p className="tooltip-date">
        {date.toLocaleDateString('ko-KR', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })}
      </p>
      <p className="tooltip-price">
        {price.toLocaleString()}원
      </p>
    </div>
  );
}
```

### CSS 스타일

```css
/* src/components/StockPriceChart.css */

.stock-price-chart {
  background: white;
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  box-shadow: var(--shadow-subtle);
}

/* 기간 선택 탭 */
.chart-range-tabs {
  display: flex;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-md);
}

.range-tab {
  flex: 1;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-gray-100);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--color-gray-600);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.range-tab:hover {
  background: var(--color-gray-200);
}

.range-tab.active {
  background: var(--color-primary-600);
  color: white;
}

/* 차트 컨테이너 */
.chart-container {
  height: 300px;
}

.chart-loading,
.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-gray-500);
}

/* 툴팁 */
.chart-tooltip {
  background: white;
  border: 1px solid var(--color-gray-200);
  border-radius: var(--radius-md);
  padding: var(--spacing-sm);
  box-shadow: var(--shadow-md);
}

.tooltip-date {
  font-size: var(--font-size-xs);
  color: var(--color-gray-500);
  margin: 0 0 4px 0;
}

.tooltip-price {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-gray-900);
  margin: 0;
}
```

# HomePage 통합

---

```tsx
// src/pages/HomePage.tsx (주요 부분)

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import useFavorites from '../hooks/useFavorites';
import useRecents from '../hooks/useRecents';
import { getMarketSummary, getStockDetail } from '../services/api';
import MarketSummaryBar from '../components/MarketSummaryBar';
import HomeFavorites from '../components/HomeFavorites';
import HomeRecents from '../components/HomeRecents';
import { Search } from 'lucide-react';

export default function HomePage() {
  const { favorites } = useFavorites();
  const { recents } = useRecents();

  // ... 데이터 로드 로직

  return (
    <div className="home-page">
      {/* 검색바 → /search로 이동 */}
      <Link to="/search" className="home-search-bar">
        <Search size={20} />
        <span>종목 검색...</span>
      </Link>

      {/* 시장 지수 */}
      <MarketSummaryBar data={marketData} />

      {/* 즐겨찾기 섹션 (있을 때만 표시) */}
      {favorites.length > 0 && (
        <HomeFavorites
          stocks={favoriteStocks}
          maxItems={5}
        />
      )}

      {/* 최근 본 종목 섹션 (있을 때만 표시) */}
      {recents.length > 0 && (
        <HomeRecents
          stocks={recentStocks}
          maxItems={5}
        />
      )}

      {/* 섹터 목록 */}
      <SectorListGrid sectors={sectors} />
    </div>
  );
}
```

## 정리

---

| 기능 | 구현 |
|------|------|
| 검색 | useDebounce + searchStocks API |
| 즐겨찾기 | useFavorites + LocalStorage |
| 최근 본 종목 | useRecents + LocalStorage |
| 차트 | Recharts AreaChart + getStockChart API |
| 기간 선택 | useState로 range 관리 |

인터랙티브 기능 구현의 핵심:
- **디바운스**: 불필요한 API 호출 방지
- **LocalStorage**: 새로고침에도 데이터 유지
- **Recharts**: 반응형 차트 쉽게 구현
- **커스텀 훅**: 로직 재사용

이것으로 Stock-Info 프로젝트의 FE/BE 구현을 모두 살펴보았습니다.

## 시리즈 마무리

---

Stock-Info 블로그 시리즈를 통해 다룬 내용:

**Backend (Spring Boot)**
1. Controller - REST API 엔드포인트
2. Service - 비즈니스 로직
3. Provider 패턴 - 데이터 소스 추상화
4. DTO 3-Layer - 계층별 데이터 분리
5. Configuration - 환경 설정
6. JPA - 데이터베이스 접근
7. Rule Engine - 점수 계산
8. News Pipeline - 뉴스 수집/태깅
9. Home Picks - 다양성 있는 추천

**Frontend (React)**
1. React 기초 - 컴포넌트, Props, State
2. Custom Hooks - 재사용 로직
3. API Layer - Axios 설정
4. CSS 스타일링 - 디자인 토큰
5. 인사이트 컴포넌트 - 10초 요약 UI
6. 인터랙티브 기능 - 검색/즐겨찾기/차트

## Reference

---

- [Recharts Documentation](https://recharts.org/)
- [React Router Documentation](https://reactrouter.com/)
- [LocalStorage API](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
