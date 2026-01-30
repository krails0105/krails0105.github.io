---
title: "[StockInfo] 12. Custom Hooks - 재사용 가능한 로직 추출"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Hooks]
---

# Introduction

---

React에서 같은 로직이 여러 컴포넌트에서 반복된다면? **Custom Hook**으로 추출하면 됩니다.

Stock-Info에서는 디바운스, 로컬 스토리지, 즐겨찾기 등의 로직을 Custom Hook으로 분리했습니다.

# Custom Hook이란?

---

## Hook 규칙

1. 이름이 `use`로 시작
2. 다른 Hook을 호출할 수 있음
3. 최상위에서만 호출 (조건문, 반복문 안에서 X)

```tsx
// Custom Hook
function useWindowSize() {
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });

  useEffect(() => {
    const handleResize = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return size;
}

// 사용
function MyComponent() {
  const { width, height } = useWindowSize();
  return <div>{width} x {height}</div>;
}
```

# useDebounce

---

## 디바운스란?

연속된 호출 중 **마지막 호출만 실행**합니다. 검색어 입력 시 매 글자마다 API를 호출하면 비효율적입니다.

```
입력: 삼 → 삼성 → 삼성전 → 삼성전자
     ✗    ✗      ✗       ✓ (300ms 후)
```

## 구현

```tsx
// src/hooks/useDebounce.ts

import { useState, useEffect } from 'react';

/**
 * 값이 변경된 후 delay만큼 기다린 후에 반환
 *
 * @param value - 디바운스할 값
 * @param delay - 지연 시간 (ms)
 * @returns 디바운스된 값
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    // delay 후에 값을 업데이트하는 타이머 설정
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    // 값이 변경되면 이전 타이머 취소 (cleanup)
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

export default useDebounce;
```

### 동작 원리

```
시간 →  0ms    100ms   200ms   300ms   400ms
입력:   삼     삼성    삼성전   삼성전자
타이머: [----] 취소
              [----]  취소
                      [----]  취소
                              [----✓]
출력:                                 삼성전자
```

1. 값이 바뀔 때마다 타이머 설정
2. 새 값이 들어오면 이전 타이머 취소
3. delay 동안 값이 안 바뀌면 업데이트

## 사용 예시

```tsx
// src/pages/SearchPage.tsx

import { useState, useEffect } from 'react';
import useDebounce from '../hooks/useDebounce';
import { searchStocks } from '../services/api';

function SearchPage() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState([]);

  // 300ms 디바운스 적용
  const debouncedKeyword = useDebounce(keyword, 300);

  // 디바운스된 값이 변경될 때만 API 호출
  useEffect(() => {
    if (debouncedKeyword) {
      searchStocks(debouncedKeyword).then(setResults);
    } else {
      setResults([]);
    }
  }, [debouncedKeyword]);

  return (
    <div>
      <input
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="종목명 또는 코드 검색..."
      />

      {results.map((stock) => (
        <div key={stock.code}>{stock.name}</div>
      ))}
    </div>
  );
}
```

# useLocalStorage

---

## LocalStorage란?

브라우저에 데이터를 **영구 저장**하는 공간입니다. 페이지를 새로고침해도 데이터가 유지됩니다.

```javascript
// 저장
localStorage.setItem('key', 'value');

// 읽기
localStorage.getItem('key');  // 'value'

// 삭제
localStorage.removeItem('key');
```

**주의:** 문자열만 저장 가능 → JSON 변환 필요

## 구현

```tsx
// src/hooks/useLocalStorage.ts

import { useState, useCallback } from 'react';

/**
 * LocalStorage에 데이터를 저장하고 읽는 훅
 *
 * @param key - 저장할 키 이름
 * @param initialValue - 초기값 (저장된 값이 없을 때 사용)
 * @returns [저장된 값, 값 설정 함수]
 */
function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {

  // 초기값 설정: localStorage에서 읽거나 initialValue 사용
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // 값 설정 함수
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        // 함수면 이전 값을 전달하여 실행
        const valueToStore =
          value instanceof Function ? value(storedValue) : value;

        setStoredValue(valueToStore);

        // localStorage에 저장
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      } catch (error) {
        console.warn(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, storedValue]
  );

  return [storedValue, setValue];
}

export default useLocalStorage;
```

### 코드 분석

**Lazy Initialization**

```tsx
const [storedValue, setStoredValue] = useState<T>(() => {
  // 함수를 전달하면 최초 렌더링 시 1회만 실행
  const item = window.localStorage.getItem(key);
  return item ? JSON.parse(item) : initialValue;
});
```

**함수형 업데이트 지원**

```tsx
// 값으로 업데이트
setValue([1, 2, 3]);

// 이전 값 기반으로 업데이트
setValue(prev => [...prev, 4]);
```

## 사용 예시

```tsx
function SettingsPage() {
  const [theme, setTheme] = useLocalStorage('theme', 'light');

  return (
    <div>
      <p>현재 테마: {theme}</p>
      <button onClick={() => setTheme('light')}>라이트</button>
      <button onClick={() => setTheme('dark')}>다크</button>
    </div>
  );
}
```

# useFavorites

---

## 즐겨찾기 기능

관심 있는 종목을 저장하고 관리합니다. useLocalStorage를 기반으로 구축합니다.

## 구현

```tsx
// src/hooks/useFavorites.ts

import { useCallback } from 'react';
import useLocalStorage from './useLocalStorage';

// 저장 형식
interface FavoritesData {
  updatedAt: string;
  items: string[];  // 종목 코드 배열
}

const STORAGE_KEY = 'stockinfo:favorites:v1';
const MAX_FAVORITES = 50;  // 최대 즐겨찾기 개수

const initialData: FavoritesData = {
  updatedAt: new Date().toISOString(),
  items: [],
};

/**
 * 즐겨찾기 관리 훅
 */
function useFavorites() {
  const [data, setData] = useLocalStorage<FavoritesData>(
    STORAGE_KEY,
    initialData
  );

  // 즐겨찾기 여부 확인
  const isFavorite = useCallback(
    (code: string) => data.items.includes(code),
    [data.items]
  );

  // 즐겨찾기 추가
  const add = useCallback(
    (code: string) => {
      setData((prev) => {
        // 이미 있으면 무시
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

  // 토글 (있으면 제거, 없으면 추가)
  const toggle = useCallback(
    (code: string) => {
      if (isFavorite(code)) {
        remove(code);
      } else {
        add(code);
      }
    },
    [isFavorite, add, remove]
  );

  return {
    favorites: data.items,
    isFavorite,
    toggle,
    add,
    remove,
  };
}

export default useFavorites;
```

### 코드 분석

**useCallback**

함수를 메모이제이션하여 불필요한 재생성을 방지합니다.

```tsx
// useCallback 없이: 매 렌더링마다 새 함수 생성
const add = (code: string) => { ... };

// useCallback 사용: 의존성이 변경될 때만 새 함수 생성
const add = useCallback(
  (code: string) => { ... },
  [setData]  // setData가 변경될 때만 재생성
);
```

**스토리지 키 버전 관리**

```tsx
const STORAGE_KEY = 'stockinfo:favorites:v1';
```

데이터 구조가 바뀌면 키 버전을 올려서 충돌을 방지합니다.

## 사용 예시

```tsx
// src/components/FavoriteButton.tsx

import useFavorites from '../hooks/useFavorites';

interface FavoriteButtonProps {
  stockCode: string;
}

export default function FavoriteButton({ stockCode }: FavoriteButtonProps) {
  const { isFavorite, toggle } = useFavorites();

  const favorite = isFavorite(stockCode);

  return (
    <button
      onClick={() => toggle(stockCode)}
      className={`favorite-btn ${favorite ? 'active' : ''}`}
      aria-label={favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
    >
      {favorite ? '★' : '☆'}
    </button>
  );
}
```

# useRecents

---

## 최근 본 종목

사용자가 조회한 종목을 기록합니다.

## 구현

```tsx
// src/hooks/useRecents.ts

import { useCallback } from 'react';
import useLocalStorage from './useLocalStorage';

interface RecentsData {
  updatedAt: string;
  items: string[];  // 종목 코드 배열
}

const STORAGE_KEY = 'stockinfo:recents:v1';
const MAX_RECENTS = 10;

const initialData: RecentsData = {
  updatedAt: new Date().toISOString(),
  items: [],
};

/**
 * 최근 본 종목 관리 훅
 */
function useRecents() {
  const [data, setData] = useLocalStorage<RecentsData>(
    STORAGE_KEY,
    initialData
  );

  // 종목 조회 기록 추가
  const addRecent = useCallback(
    (code: string) => {
      setData((prev) => {
        // 이미 있으면 맨 앞으로 이동
        const filtered = prev.items.filter((c) => c !== code);
        const newItems = [code, ...filtered].slice(0, MAX_RECENTS);

        return {
          updatedAt: new Date().toISOString(),
          items: newItems,
        };
      });
    },
    [setData]
  );

  // 기록 초기화
  const clearRecents = useCallback(() => {
    setData(initialData);
  }, [setData]);

  return {
    recents: data.items,
    addRecent,
    clearRecents,
  };
}

export default useRecents;
```

## 사용 예시

```tsx
// src/pages/StockDetailPage.tsx

import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import useRecents from '../hooks/useRecents';

export default function StockDetailPage() {
  const { stockCode } = useParams<{ stockCode: string }>();
  const { addRecent } = useRecents();

  // 페이지 진입 시 최근 본 목록에 추가
  useEffect(() => {
    if (stockCode) {
      addRecent(stockCode);
    }
  }, [stockCode, addRecent]);

  return (
    <div>
      {/* 종목 상세 내용 */}
    </div>
  );
}
```

# Hooks 조합

---

## HomePage에서 모든 훅 사용

```tsx
// src/pages/HomePage.tsx

import { useState, useEffect } from 'react';
import useFavorites from '../hooks/useFavorites';
import useRecents from '../hooks/useRecents';
import { getMarketSummary, getStockDetail } from '../services/api';

export default function HomePage() {
  const { favorites } = useFavorites();
  const { recents } = useRecents();

  const [favoriteStocks, setFavoriteStocks] = useState([]);
  const [recentStocks, setRecentStocks] = useState([]);

  // 즐겨찾기 종목 정보 로드
  useEffect(() => {
    if (favorites.length === 0) {
      setFavoriteStocks([]);
      return;
    }

    Promise.all(
      favorites.slice(0, 5).map(code => getStockDetail(code))
    ).then(setFavoriteStocks);
  }, [favorites]);

  // 최근 본 종목 정보 로드
  useEffect(() => {
    if (recents.length === 0) {
      setRecentStocks([]);
      return;
    }

    Promise.all(
      recents.slice(0, 5).map(code => getStockDetail(code))
    ).then(setRecentStocks);
  }, [recents]);

  return (
    <div className="home-page">
      {/* 즐겨찾기 섹션 */}
      {favoriteStocks.length > 0 && (
        <section className="favorites-section">
          <h2>즐겨찾기</h2>
          <div className="stock-list">
            {favoriteStocks.map(stock => (
              <StockCard key={stock.stockCode} stock={stock} />
            ))}
          </div>
        </section>
      )}

      {/* 최근 본 종목 섹션 */}
      {recentStocks.length > 0 && (
        <section className="recents-section">
          <h2>최근 본 종목</h2>
          <div className="stock-list horizontal-scroll">
            {recentStocks.map(stock => (
              <StockCard key={stock.stockCode} stock={stock} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

# 정리

---

| Hook | 역할 | 반환값 |
|------|------|--------|
| useDebounce | 입력 디바운스 | 디바운스된 값 |
| useLocalStorage | 로컬 스토리지 연동 | [값, 설정함수] |
| useFavorites | 즐겨찾기 관리 | { favorites, isFavorite, toggle, add, remove } |
| useRecents | 최근 본 종목 관리 | { recents, addRecent, clearRecents } |

Custom Hook의 장점:
- **로직 재사용**: 여러 컴포넌트에서 동일 로직 공유
- **관심사 분리**: UI와 로직 분리
- **테스트 용이**: 훅 단위로 테스트 가능

다음 글에서는 **API Layer**를 알아봅니다. Axios 설정과 타입 안전한 API 호출 방법입니다.

# Reference

---

- [Building Your Own Hooks - React](https://react.dev/learn/reusing-logic-with-custom-hooks)
- [useCallback - React](https://react.dev/reference/react/useCallback)
