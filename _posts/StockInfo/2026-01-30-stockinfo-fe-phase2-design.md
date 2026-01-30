---
title: "[StockInfo] FE Phase 2.5 - Fintech Clean 디자인"
categories:
  - StockInfo
tags:
  - [React, CSS, Design System]
---

# Introduction

---

주식 정보 서비스는 신뢰감이 중요하다. 화려한 디자인보다 깔끔하고 전문적인 느낌을 주는 **Fintech Clean** 컨셉을 선택했다. 이 글에서는 CSS 디자인 토큰, Skeleton 컴포넌트, EmptyState 컴포넌트, 마이크로 모션을 다룬다.

# Fintech Clean 컨셉

---

## 디자인 원칙

1. **정보 우선**: 장식보다 데이터에 집중
2. **일관성**: 색상, 간격, 둥근모서리 통일
3. **신뢰감**: 차분한 색상, 적절한 그림자
4. **반응성**: 호버/클릭 시 즉각적인 피드백

## 레퍼런스

- Robinhood, Fidelity 등 핀테크 앱의 깔끔한 UI
- 과도한 색상 대신 그레이 + 포인트 컬러 조합

# CSS 디자인 토큰

---

## 색상 팔레트

Indigo를 포인트 컬러로 사용한다. 상승(빨강)/하락(파랑)은 한국 증시 관례를 따른다.

```css
/* src/App.css (또는 별도 tokens.css) */
:root {
  /* 기본 색상 */
  --bg-base: #ffffff;
  --bg-surface: #f8fafc;
  --bg-secondary: #f1f5f9;

  /* 텍스트 */
  --text-primary: #1e293b;
  --text-secondary: #475569;
  --text-muted: #94a3b8;

  /* 포인트 컬러 (Indigo) */
  --accent-primary: #4f46e5;
  --accent-primary-hover: #4338ca;
  --accent-subtle: #eef2ff;

  /* 상태 색상 */
  --color-positive: #dc2626;  /* 상승 - 빨강 */
  --color-negative: #2563eb;  /* 하락 - 파랑 */
  --color-caution: #f59e0b;   /* 주의 - 주황 */

  /* 테두리 */
  --border-default: #e2e8f0;
  --border-subtle: #f1f5f9;
}
```

## 간격 스케일

4px 기반의 간격 시스템을 사용한다.

```css
:root {
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;
}
```

## 그림자 토큰

깊이감을 표현하는 3단계 그림자:

```css
:root {
  --shadow-subtle: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.08);
  --shadow-elevated: 0 4px 16px rgba(0, 0, 0, 0.12);
}
```

## 둥근모서리

```css
:root {
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
}
```

# Skeleton 컴포넌트

---

로딩 중일 때 콘텐츠 영역을 대체하는 스켈레톤 컴포넌트다.

## 기본 Skeleton

```typescript
// src/components/Skeleton.tsx
interface SkeletonProps {
  variant?: 'text' | 'rectangular' | 'circular';
  width?: string | number;
  height?: string | number;
  className?: string;
}

function Skeleton({
  variant = 'rectangular',
  width,
  height,
  className = ''
}: SkeletonProps) {
  const style = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  };

  return (
    <div
      className={`skeleton skeleton--${variant} ${className}`}
      style={style}
    />
  );
}
```

## 프리셋 컴포넌트

자주 사용하는 패턴을 미리 정의한다.

```typescript
// 카드 스켈레톤
export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-card__header">
        <Skeleton variant="text" width="60%" height={20} />
        <Skeleton variant="rectangular" width={60} height={28} />
      </div>
      <Skeleton variant="text" width="80%" height={14} />
      <Skeleton variant="text" width="70%" height={14} />
    </div>
  );
}

// 마켓바 스켈레톤
export function SkeletonMarketItem() {
  return (
    <div className="skeleton-market-item">
      <Skeleton variant="text" width="40%" height={12} />
      <Skeleton variant="text" width="70%" height={20} />
      <Skeleton variant="text" width="50%" height={14} />
    </div>
  );
}

// 픽 카드 스켈레톤
export function SkeletonPickCard() {
  return (
    <div className="skeleton-pick-card">
      <div className="skeleton-pick-card__header">
        <div>
          <Skeleton variant="text" width={80} height={16} />
          <Skeleton variant="text" width={50} height={12} />
        </div>
        <Skeleton variant="rectangular" width={50} height={24} />
      </div>
      <div className="skeleton-pick-card__badges">
        <Skeleton variant="rectangular" width={40} height={20} />
        <Skeleton variant="rectangular" width={60} height={20} />
      </div>
      <Skeleton variant="text" width="90%" height={13} />
      <Skeleton variant="text" width="75%" height={13} />
    </div>
  );
}
```

## Shimmer 애니메이션

```css
/* src/components/Skeleton.css */
.skeleton {
  background: linear-gradient(
    90deg,
    var(--bg-secondary) 0%,
    var(--bg-surface) 50%,
    var(--bg-secondary) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius-sm);
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

.skeleton--text {
  border-radius: var(--radius-sm);
}

.skeleton--circular {
  border-radius: 50%;
}

.skeleton-card {
  padding: var(--space-md);
  background: var(--bg-base);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-subtle);
}

.skeleton-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
}

.skeleton-card__line {
  margin-top: var(--space-sm);
}
```

# EmptyState 컴포넌트

---

데이터가 없을 때 보여주는 빈 상태 UI다.

## 컴포넌트 구현

```typescript
// src/components/EmptyState.tsx
import { Search, AlertCircle, Star, Clock } from 'lucide-react';
import './EmptyState.css';

interface EmptyStateProps {
  variant?: 'search' | 'error' | 'favorites' | 'recents';
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const ICONS = {
  search: Search,
  error: AlertCircle,
  favorites: Star,
  recents: Clock,
};

function EmptyState({
  variant = 'search',
  title,
  description,
  action
}: EmptyStateProps) {
  const Icon = ICONS[variant];

  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Icon size={48} strokeWidth={1.5} />
      </div>
      <h3 className="empty-state__title">{title}</h3>
      {description && (
        <p className="empty-state__description">{description}</p>
      )}
      {action && (
        <button
          className="empty-state__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export default EmptyState;
```

## 사용 예시

```tsx
// 검색 결과 없음
<EmptyState
  variant="search"
  title="검색 결과가 없습니다"
  description={`"${query}"에 대한 결과를 찾을 수 없습니다`}
/>

// 즐겨찾기 없음
<EmptyState
  variant="favorites"
  title="즐겨찾기가 비어있습니다"
  description="관심 있는 종목을 즐겨찾기에 추가해 보세요"
  action={{
    label: "종목 검색하기",
    onClick: () => navigate('/search')
  }}
/>

// 에러 상태
<EmptyState
  variant="error"
  title="오류가 발생했습니다"
  description={error}
  action={{
    label: "다시 시도",
    onClick: () => refetch()
  }}
/>
```

## CSS 스타일

```css
/* src/components/EmptyState.css */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-2xl);
  text-align: center;
}

.empty-state__icon {
  color: var(--text-muted);
  margin-bottom: var(--space-lg);
  opacity: 0.6;
}

.empty-state__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--space-sm);
}

.empty-state__description {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 300px;
  margin-bottom: var(--space-lg);
}

.empty-state__action {
  padding: var(--space-sm) var(--space-lg);
  background: var(--accent-primary);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease;
}

.empty-state__action:hover {
  background: var(--accent-primary-hover);
}
```

# lucide-react 아이콘

---

일관된 아이콘 스타일을 위해 lucide-react를 사용한다.

```bash
npm install lucide-react
```

```typescript
import {
  TrendingUp,    // 상승 추세
  TrendingDown,  // 하락 추세
  Star,          // 즐겨찾기
  Search,        // 검색
  ArrowLeft,     // 뒤로가기
  RefreshCw,     // 새로고침
  AlertCircle,   // 경고
  Building2,     // 섹터
  Clock,         // 시간/최근
} from 'lucide-react';

// 사용 예시
<TrendingUp size={18} strokeWidth={2} color="var(--color-positive)" />
```

# 마이크로 모션

---

## Hover 효과

카드에 호버 시 살짝 올라오는 효과:

```css
.card {
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
```

## 화살표 Fade-in

```css
.arrow-icon {
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.card:hover .arrow-icon {
  opacity: 1;
  transform: translateX(0);
}
```

## 버튼 피드백

```css
.button {
  transition: background 0.15s ease, transform 0.1s ease;
}

.button:hover {
  background: var(--accent-primary-hover);
}

.button:active {
  transform: scale(0.98);
}
```

# Conclusion

---

Fintech Clean 디자인 시스템의 핵심:

1. **CSS 토큰**: 색상/간격/그림자/둥근모서리 일관성
2. **Skeleton**: shimmer 애니메이션 + 프리셋 컴포넌트
3. **EmptyState**: SVG 아이콘 + CTA 버튼
4. **lucide-react**: 일관된 아이콘 스타일
5. **마이크로 모션**: translateY(-2px), fade-in

이 디자인 시스템 덕분에 UI 개발 속도가 빨라지고 일관된 사용자 경험을 제공할 수 있게 되었다.

# Reference

---

- [Lucide Icons](https://lucide.dev/)
- [Design Tokens](https://spectrum.adobe.com/page/design-tokens/)
