---
title: "[StockInfo] 11. React 기초 - 컴포넌트, Props, State"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Frontend]
---

# Introduction

---

**React**는 Facebook(현 Meta)이 만든 UI 라이브러리입니다. 웹 페이지를 **컴포넌트** 단위로 쪼개서 개발합니다.

Stock-Info 프론트엔드는 React 19 + TypeScript + Vite로 구축되었습니다. 이 글에서는 React의 핵심 개념을 Stock-Info 코드와 함께 알아봅니다.

# 프로젝트 구조

---

```
stock-info-frontend/
├── src/
│   ├── components/       # 재사용 가능한 UI 컴포넌트
│   │   ├── MarketSummaryBar.tsx
│   │   ├── SectorCard.tsx
│   │   ├── ScoreBadge.tsx
│   │   └── StockPriceChart.tsx
│   ├── pages/            # 페이지 컴포넌트 (라우트별)
│   │   ├── HomePage.tsx
│   │   ├── SearchPage.tsx
│   │   ├── SectorDetailPage.tsx
│   │   └── StockDetailPage.tsx
│   ├── hooks/            # 커스텀 훅
│   ├── services/         # API 호출
│   │   └── api.ts
│   ├── types/            # TypeScript 타입
│   │   └── index.ts
│   ├── App.tsx           # 라우팅 설정
│   └── main.tsx          # 진입점
├── package.json
└── vite.config.ts
```

# 컴포넌트 (Component)

---

## 컴포넌트란?

컴포넌트는 **재사용 가능한 UI 조각**입니다. 레고 블록처럼 조합하여 화면을 만듭니다.

```
┌─────────────────────────────────────────┐
│              HomePage                    │
│  ┌───────────────────────────────────┐  │
│  │     MarketSummaryBar              │  │
│  │  코스피 2,850  코스닥 892         │  │
│  └───────────────────────────────────┘  │
│                                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │SectorCard│ │SectorCard│ │SectorCard│   │
│  │ 전기전자 │ │  자동차  │ │   금융   │   │
│  └─────────┘ └─────────┘ └─────────┘   │
└─────────────────────────────────────────┘
```

## 함수형 컴포넌트

React에서 컴포넌트는 **함수**로 정의합니다.

```tsx
// 가장 간단한 컴포넌트
function HelloWorld() {
  return <h1>Hello, World!</h1>;
}

// 사용
<HelloWorld />
```

## JSX

JSX는 JavaScript 안에서 HTML처럼 작성할 수 있는 문법입니다.

```tsx
function Greeting() {
  const name = "홍길동";
  const today = new Date().toLocaleDateString();

  return (
    <div className="greeting">
      <h1>안녕하세요, {name}님!</h1>
      <p>오늘은 {today}입니다.</p>
    </div>
  );
}
```

**주의사항:**
- `class` → `className` (class는 JavaScript 예약어)
- `{}` 안에 JavaScript 표현식 사용 가능
- 반드시 하나의 부모 요소로 감싸야 함

# Props

---

## Props란?

**Props(Properties)**는 부모 컴포넌트가 자식에게 전달하는 데이터입니다.

```tsx
// 부모에서 자식으로 데이터 전달
<ScoreBadge score={75} label="STRONG" />
```

```tsx
// 자식 컴포넌트에서 Props 받기
interface ScoreBadgeProps {
  score: number;
  label: string;
}

function ScoreBadge({ score, label }: ScoreBadgeProps) {
  return (
    <span className="score-badge">
      {score}점 ({label})
    </span>
  );
}
```

## Stock-Info의 ScoreBadge 컴포넌트

```tsx
// src/components/ScoreBadge.tsx

interface ScoreBadgeProps {
  score: number;
  label: string;          // "STRONG" | "NEUTRAL" | "WEAK"
  size?: 'sm' | 'md' | 'lg';  // 옵셔널 prop
}

export default function ScoreBadge({
  score,
  label,
  size = 'md'  // 기본값
}: ScoreBadgeProps) {

  // 라벨에 따른 색상 클래스
  const colorClass = {
    STRONG: 'badge-green',
    NEUTRAL: 'badge-yellow',
    WEAK: 'badge-red'
  }[label] || 'badge-gray';

  return (
    <span className={`score-badge ${colorClass} size-${size}`}>
      <span className="score-value">{score}</span>
      <span className="score-label">{label}</span>
    </span>
  );
}
```

### 코드 분석

**TypeScript Interface**

Props의 타입을 명시합니다.

```tsx
interface ScoreBadgeProps {
  score: number;       // 필수
  label: string;       // 필수
  size?: 'sm' | 'md' | 'lg';  // 옵셔널 (?)
}
```

**구조 분해 할당 (Destructuring)**

Props 객체에서 필요한 값만 추출합니다.

```tsx
// 원래 방식
function ScoreBadge(props: ScoreBadgeProps) {
  return <span>{props.score}</span>;
}

// 구조 분해
function ScoreBadge({ score, label }: ScoreBadgeProps) {
  return <span>{score}</span>;
}
```

**기본값 설정**

```tsx
function ScoreBadge({ size = 'md' }: ScoreBadgeProps) {
  // size가 전달되지 않으면 'md' 사용
}
```

# State

---

## State란?

**State**는 컴포넌트 내부에서 관리하는 **변할 수 있는 데이터**입니다.

```tsx
import { useState } from 'react';

function Counter() {
  // [현재값, 업데이트함수] = useState(초기값)
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>카운트: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        증가
      </button>
    </div>
  );
}
```

**주의:** State가 변경되면 컴포넌트가 **리렌더링**됩니다.

## Props vs State

| 구분 | Props | State |
|------|-------|-------|
| 출처 | 부모 컴포넌트 | 컴포넌트 내부 |
| 변경 | 읽기 전용 | 변경 가능 |
| 용도 | 데이터 전달 | 내부 상태 관리 |

## Stock-Info의 State 사용 예시

```tsx
// src/components/StockDetailSummary.tsx

import { useState } from 'react';

export default function StockDetailSummary({ insight }: Props) {
  // 확장 상태 관리
  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);  // 토글
  };

  return (
    <div className="stock-detail-summary">
      {/* 요약 내용 */}
      <div className="summary-content">
        {/* ... */}
      </div>

      {/* 자세히 보기 버튼 */}
      <button onClick={handleToggleExpand}>
        {isExpanded ? '접기' : '자세히 보기'}
      </button>

      {/* 확장 영역 (조건부 렌더링) */}
      {isExpanded && (
        <div className="expanded-content">
          <h4>적용된 분석 규칙</h4>
          {/* ... */}
        </div>
      )}
    </div>
  );
}
```

### 조건부 렌더링

```tsx
// && 연산자: 조건이 true일 때만 렌더링
{isExpanded && <div>확장 내용</div>}

// 삼항 연산자: 조건에 따라 다른 내용 렌더링
{isExpanded ? '접기' : '자세히 보기'}
```

# useEffect

---

## useEffect란?

**부수 효과(Side Effect)**를 처리하는 Hook입니다.

- API 호출
- DOM 조작
- 타이머 설정
- 이벤트 구독

```tsx
import { useState, useEffect } from 'react';

function StockPrice({ code }: { code: string }) {
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // 컴포넌트가 마운트될 때 API 호출
  useEffect(() => {
    async function fetchPrice() {
      setLoading(true);
      try {
        const data = await api.getStockDetail(code);
        setPrice(data.closingPrice);
      } catch (error) {
        console.error('Failed to fetch price', error);
      } finally {
        setLoading(false);
      }
    }

    fetchPrice();
  }, [code]);  // code가 변경될 때마다 다시 실행

  if (loading) return <div>로딩 중...</div>;
  if (price === null) return <div>가격 정보 없음</div>;

  return <div>현재가: {price.toLocaleString()}원</div>;
}
```

## 의존성 배열

```tsx
// 마운트 시 1회만 실행
useEffect(() => {
  // ...
}, []);

// code가 변경될 때마다 실행
useEffect(() => {
  // ...
}, [code]);

// 매 렌더링마다 실행 (권장하지 않음)
useEffect(() => {
  // ...
});
```

## Stock-Info의 HomePage

```tsx
// src/pages/HomePage.tsx

import { useState, useEffect } from 'react';
import { getMarketSummary, getSectorScoreboard } from '../services/api';
import type { MarketSummary, SectorScore } from '../types';

export default function HomePage() {
  // 상태 정의
  const [marketData, setMarketData] = useState<MarketSummary[]>([]);
  const [sectors, setSectors] = useState<SectorScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 데이터 로드
  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);

        // 병렬로 API 호출
        const [marketResult, sectorResult] = await Promise.all([
          getMarketSummary(),
          getSectorScoreboard()
        ]);

        setMarketData(marketResult);
        setSectors(sectorResult.sectors);
      } catch (err) {
        setError('데이터를 불러오는데 실패했습니다.');
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);  // 마운트 시 1회만 실행

  // 로딩 상태
  if (loading) {
    return <div className="loading">로딩 중...</div>;
  }

  // 에러 상태
  if (error) {
    return <div className="error">{error}</div>;
  }

  // 정상 렌더링
  return (
    <div className="home-page">
      <MarketSummaryBar data={marketData} />
      <SectorListGrid sectors={sectors} />
    </div>
  );
}
```

### Promise.all로 병렬 호출

```tsx
// 순차 호출 (느림)
const market = await getMarketSummary();
const sectors = await getSectorScoreboard();

// 병렬 호출 (빠름)
const [market, sectors] = await Promise.all([
  getMarketSummary(),
  getSectorScoreboard()
]);
```

# 이벤트 처리

---

## 이벤트 핸들러

```tsx
function Button() {
  const handleClick = () => {
    alert('클릭!');
  };

  return <button onClick={handleClick}>클릭</button>;
}
```

## 이벤트 객체

```tsx
function SearchInput() {
  const [keyword, setKeyword] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setKeyword(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();  // 기본 동작 방지
    console.log('검색:', keyword);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={keyword}
        onChange={handleChange}
        placeholder="종목 검색..."
      />
      <button type="submit">검색</button>
    </form>
  );
}
```

# 리스트 렌더링

---

## map으로 리스트 렌더링

```tsx
interface SectorScore {
  name: string;
  score: number;
  label: string;
}

function SectorListGrid({ sectors }: { sectors: SectorScore[] }) {
  return (
    <div className="sector-grid">
      {sectors.map((sector) => (
        <SectorCard
          key={sector.name}  // 고유 key 필수!
          name={sector.name}
          score={sector.score}
          label={sector.label}
        />
      ))}
    </div>
  );
}
```

**key가 필요한 이유:**

React가 어떤 항목이 변경/추가/삭제되었는지 효율적으로 파악하기 위함입니다.

```tsx
// 나쁜 예: index를 key로 사용
{items.map((item, index) => (
  <Item key={index} data={item} />
))}

// 좋은 예: 고유 ID를 key로 사용
{items.map((item) => (
  <Item key={item.id} data={item} />
))}
```

# 정리

---

| 개념 | 설명 |
|------|------|
| 컴포넌트 | 재사용 가능한 UI 조각 (함수) |
| Props | 부모 → 자식으로 전달하는 데이터 |
| State | 컴포넌트 내부의 변할 수 있는 데이터 |
| useState | State를 관리하는 Hook |
| useEffect | 부수 효과(API 호출 등)를 처리하는 Hook |
| JSX | JavaScript 안에서 HTML처럼 작성 |
| 조건부 렌더링 | `&&`, `? :` 연산자 |
| 리스트 렌더링 | `map()` + `key` |

다음 글에서는 **Custom Hooks**를 알아봅니다. 재사용 가능한 로직을 훅으로 추출하는 방법입니다.

# Reference

---

- [React Documentation](https://react.dev/)
- [TypeScript with React](https://www.typescriptlang.org/docs/handbook/react.html)
