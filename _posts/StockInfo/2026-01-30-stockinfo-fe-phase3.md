---
title: "[StockInfo] FE Phase 3 - 검색/즐겨찾기/차트"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Recharts, LocalStorage]
---

# Introduction

---

Phase 3에서는 사용자 개인화 기능을 구현했다. 디바운스 검색, LocalStorage 기반 즐겨찾기/최근 본 종목, Recharts를 활용한 가격 차트를 다룬다.

# Custom Hooks 4종

---

## 1. useDebounce - 입력 디바운스

타이핑 중에는 API를 호출하지 않고, 입력이 멈춘 후 300ms 뒤에 호출한다.

```typescript
// src/hooks/useDebounce.ts
import { useState, useEffect } from 'react';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    // delay 후에 값을 업데이트하는 타이머 설정
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    // 값이 변경되면 이전 타이머 취소
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default useDebounce;
```

**사용 예시:**
```typescript
const [query, setQuery] = useState('');
const debouncedQuery = useDebounce(query, 300);

useEffect(() => {
  if (debouncedQuery) {
    searchStocks(debouncedQuery);
  }
}, [debouncedQuery]);
```

## 2. useLocalStorage - LocalStorage 영속화

React 상태를 LocalStorage와 동기화한다.

```typescript
// src/hooks/useLocalStorage.ts
import { useState, useCallback, useEffect } from 'react';

function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  // 초기값: LocalStorage에서 읽기, 없으면 initialValue
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  // 값 설정 시 LocalStorage에도 저장
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const newValue = value instanceof Function ? value(prev) : value;
        localStorage.setItem(key, JSON.stringify(newValue));
        return newValue;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}

export default useLocalStorage;
```

## 3. useFavorites - 즐겨찾기 관리

최대 50개의 종목을 즐겨찾기할 수 있다.

```typescript
// src/hooks/useFavorites.ts
import { useCallback } from 'react';
import useLocalStorage from './useLocalStorage';

interface FavoritesData {
  updatedAt: string;
  items: string[];  // 종목 코드 배열
}

const STORAGE_KEY = 'stockinfo:favorites:v1';
const MAX_FAVORITES = 50;

function useFavorites() {
  const [data, setData] = useLocalStorage<FavoritesData>(STORAGE_KEY, {
    updatedAt: new Date().toISOString(),
    items: [],
  });

  // 즐겨찾기 여부 확인
  const isFavorite = useCallback(
    (code: string) => data.items.includes(code),
    [data.items]
  );

  // 즐겨찾기 추가
  const add = useCallback(
    (code: string) => {
      setData((prev) => {
        if (prev.items.includes(code)) return prev;
        // 최대 개수 초과 시 가장 오래된 것 제거
        if (prev.items.length >= MAX_FAVORITES) {
          return {
            updatedAt: new Date().toISOString(),
            items: [...prev.items.slice(1), code],
          };
        }
        return {
          updatedAt: new Date().toISOString(),
          items: [...prev.items, code],
        };
      });
    },
    [setData]
  );

  // 즐겨찾기 제거
  const remove = useCallback(
    (code: string) => {
      setData((prev) => ({
        updatedAt: new Date().toISOString(),
        items: prev.items.filter((c) => c !== code),
      }));
    },
    [setData]
  );

  // 토글
  const toggle = useCallback(
    (code: string) => {
      if (isFavorite(code)) remove(code);
      else add(code);
    },
    [isFavorite, add, remove]
  );

  return { favorites: data.items, isFavorite, toggle, add, remove };
}

export default useFavorites;
```

## 4. useRecents - 최근 본 종목 관리

최대 10개의 최근 본 종목을 관리한다.

```typescript
// src/hooks/useRecents.ts
const STORAGE_KEY = 'stockinfo:recents:v1';
const MAX_RECENTS = 10;

function useRecents() {
  const [data, setData] = useLocalStorage<RecentsData>(STORAGE_KEY, {
    updatedAt: new Date().toISOString(),
    items: [],
  });

  // 최근 본 종목 추가 (맨 앞에 추가, 중복 제거)
  const addRecent = useCallback(
    (stock: RecentStock) => {
      setData((prev) => {
        // 이미 있으면 제거 후 맨 앞에 추가
        const filtered = prev.items.filter((s) => s.code !== stock.code);
        const newItems = [stock, ...filtered].slice(0, MAX_RECENTS);
        return {
          updatedAt: new Date().toISOString(),
          items: newItems,
        };
      });
    },
    [setData]
  );

  return { recents: data.items, addRecent };
}
```

# SearchPage 구현

---

## 디바운스 검색

```typescript
// src/pages/SearchPage.tsx
function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // 300ms debounce
  const debouncedQuery = useDebounce(query, 300);

  // 검색 실행
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults([]);
      setHasSearched(false);
      return;
    }

    setLoading(true);
    setHasSearched(true);

    searchStocks(debouncedQuery)
      .then(setResults)
      .catch(() => setError('검색 중 오류가 발생했습니다'))
      .finally(() => setLoading(false));
  }, [debouncedQuery]);

  return (
    <div className="search-page">
      {/* 검색 입력 */}
      <input
        type="text"
        placeholder="종목명 또는 종목코드 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {/* 검색 전: 추천 검색어 */}
      {!hasSearched && <SuggestedKeywords onClick={setQuery} />}

      {/* 로딩 */}
      {loading && <SkeletonList />}

      {/* 결과 없음 */}
      {hasSearched && !loading && results.length === 0 && (
        <EmptyState variant="search" title="검색 결과가 없습니다" />
      )}

      {/* 검색 결과 */}
      {results.length > 0 && (
        <ResultList results={results} onSelect={(code) => navigate(`/stock/${code}`)} />
      )}
    </div>
  );
}
```

## 추천 검색어

```typescript
const SUGGESTED_KEYWORDS = ['삼성전자', 'SK하이닉스', '카카오', 'NAVER', '현대차'];

function SuggestedKeywords({ onClick }: { onClick: (keyword: string) => void }) {
  return (
    <div className="suggestions">
      <h3>추천 검색어</h3>
      <div className="suggestion-chips">
        {SUGGESTED_KEYWORDS.map((keyword) => (
          <button key={keyword} onClick={() => onClick(keyword)}>
            {keyword}
          </button>
        ))}
      </div>
    </div>
  );
}
```

# FavoriteButton 컴포넌트

---

즐겨찾기 토글 버튼이다. 즉시 피드백을 위해 optimistic update를 적용한다.

```typescript
// src/components/FavoriteButton.tsx
import { Star } from 'lucide-react';
import useFavorites from '../hooks/useFavorites';
import './FavoriteButton.css';

interface FavoriteButtonProps {
  stockCode: string;
  size?: 'sm' | 'md' | 'lg';
}

function FavoriteButton({ stockCode, size = 'md' }: FavoriteButtonProps) {
  const { isFavorite, toggle } = useFavorites();
  const isActive = isFavorite(stockCode);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();  // Link 내부에서 사용 시 navigation 방지
    e.stopPropagation();
    toggle(stockCode);
  };

  const iconSize = size === 'sm' ? 16 : size === 'lg' ? 24 : 20;

  return (
    <button
      className={`favorite-button favorite-button--${size} ${isActive ? 'active' : ''}`}
      onClick={handleClick}
      aria-label={isActive ? '즐겨찾기 해제' : '즐겨찾기 추가'}
    >
      <Star
        size={iconSize}
        fill={isActive ? 'var(--color-favorite)' : 'none'}
        stroke={isActive ? 'var(--color-favorite)' : 'currentColor'}
      />
    </button>
  );
}

export default FavoriteButton;
```

## CSS 스타일

```css
/* src/components/FavoriteButton.css */
.favorite-button {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  transition: transform 0.15s ease, color 0.15s ease;
}

.favorite-button:hover {
  color: var(--color-favorite);
  transform: scale(1.1);
}

.favorite-button.active {
  color: var(--color-favorite);
}

.favorite-button:active {
  transform: scale(0.95);
}

:root {
  --color-favorite: #f59e0b;  /* amber */
}
```

# StockPriceChart (Recharts)

---

## 컴포넌트 구조

```typescript
// src/components/StockPriceChart.tsx
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const RANGE_OPTIONS: { value: ChartRange; label: string }[] = [
  { value: '1D', label: '1일' },
  { value: '1W', label: '1주' },
  { value: '1M', label: '1개월' },
  { value: '3M', label: '3개월' },
  { value: '1Y', label: '1년' },
];

function StockPriceChart({ stockCode }: { stockCode: string }) {
  const [range, setRange] = useState<ChartRange>('1M');
  const [data, setData] = useState<ChartResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getStockChart(stockCode, range)
      .then(setData)
      .catch(() => setError('차트 데이터를 불러올 수 없습니다'))
      .finally(() => setLoading(false));
  }, [stockCode, range]);

  if (loading) return <ChartSkeleton />;
  if (!data) return <ChartError />;

  return (
    <div className="stock-chart">
      {/* 기간 탭 */}
      <div className="stock-chart__tabs">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`stock-chart__tab ${range === opt.value ? 'active' : ''}`}
            onClick={() => setRange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 차트 영역 */}
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data.dataPoints}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--accent-primary)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="var(--accent-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tickFormatter={formatDate} />
          <YAxis domain={[yMin, yMax]} tickFormatter={formatPrice} />
          <Tooltip formatter={formatTooltip} />
          <Area
            type="monotone"
            dataKey="price"
            stroke="var(--accent-primary)"
            strokeWidth={2}
            fill="url(#priceGradient)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

## Y축 범위 계산

차트가 너무 평평하거나 너무 급하지 않도록 범위를 조절한다.

```typescript
const prices = data.dataPoints.map((p) => p.price);
const minPrice = Math.min(...prices);
const maxPrice = Math.max(...prices);
const priceRange = maxPrice - minPrice;

// 위아래 10% 여유
const yMin = Math.floor((minPrice - priceRange * 0.1) / 100) * 100;
const yMax = Math.ceil((maxPrice + priceRange * 0.1) / 100) * 100;
```

## 날짜 포맷팅

기간에 따라 다른 포맷을 사용한다.

```typescript
const formatDate = (dateStr: string) => {
  const date = new Date(dateStr);
  if (range === '1D') {
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === '1W' || range === '1M') {
    return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('ko-KR', { year: '2-digit', month: 'short' });
};
```

# HomePage 통합

---

## 검색바 → /search

```tsx
<div className="home-search" onClick={() => navigate('/search')}>
  <Search size={18} />
  <span>종목 검색</span>
</div>
```

## 즐겨찾기 섹션 (5개)

```tsx
function HomeFavorites() {
  const { favorites } = useFavorites();
  const [stocks, setStocks] = useState<StockScore[]>([]);

  useEffect(() => {
    if (favorites.length === 0) return;
    // 즐겨찾기 종목 정보 조회
    Promise.all(favorites.slice(0, 5).map(getStockByCode))
      .then(setStocks);
  }, [favorites]);

  if (favorites.length === 0) {
    return (
      <EmptyState
        variant="favorites"
        title="즐겨찾기가 비어있습니다"
        action={{ label: "종목 검색", onClick: () => navigate('/search') }}
      />
    );
  }

  return (
    <section className="home-favorites">
      <h2>즐겨찾기</h2>
      <div className="favorites-grid">
        {stocks.map((stock) => (
          <FavoriteCard key={stock.code} stock={stock} />
        ))}
      </div>
    </section>
  );
}
```

## 최근 본 섹션 (5개, 가로 스크롤)

```tsx
function HomeRecents() {
  const { recents } = useRecents();

  if (recents.length === 0) return null;

  return (
    <section className="home-recents">
      <h2>최근 본 종목</h2>
      <div className="recents-scroll">
        {recents.slice(0, 5).map((stock) => (
          <RecentCard key={stock.code} stock={stock} />
        ))}
      </div>
    </section>
  );
}
```

```css
.recents-scroll {
  display: flex;
  gap: var(--space-md);
  overflow-x: auto;
  padding-bottom: var(--space-sm);
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.recents-scroll::-webkit-scrollbar {
  display: none;
}
```

# Conclusion

---

Phase 3 검색/즐겨찾기/차트의 핵심:

1. **Custom Hooks 4종**: useDebounce, useLocalStorage, useFavorites, useRecents
2. **SearchPage**: 디바운스 검색 + 추천 검색어 + 결과 카드
3. **FavoriteButton**: 토글 상태 + 즉시 피드백
4. **StockPriceChart**: Recharts AreaChart + 기간 탭 + Y축 범위 계산
5. **HomePage**: 검색바 + 즐겨찾기(5개) + 최근 본(5개, 가로 스크롤)

이 기능들로 사용자가 종목을 검색하고, 관심 종목을 관리하며, 가격 추이를 시각적으로 확인할 수 있게 되었다.

# Reference

---

- [Recharts Documentation](https://recharts.org/)
- [LocalStorage API](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
