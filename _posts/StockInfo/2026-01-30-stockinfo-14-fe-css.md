---
title: "[StockInfo] 14. CSS 스타일링 - 디자인 토큰과 컴포넌트 스타일"
categories:
  - StockInfo
tags:
  - [React, CSS, Design System]
---

# Introduction

---

Stock-Info는 **Fintech Clean** 디자인 컨셉을 따릅니다. 깔끔하고 신뢰감 있는 UI를 목표로 합니다.

이 글에서는 CSS 디자인 토큰, 컴포넌트 스타일링, 로딩/빈 상태 처리를 알아봅니다.

# 디자인 토큰

---

## 디자인 토큰이란?

디자인 시스템의 **기본 단위**입니다. 색상, 간격, 폰트 등을 변수로 정의합니다.

```css
/* CSS 변수 (Custom Properties) */
:root {
  --color-primary: #4f46e5;
  --spacing-md: 16px;
  --radius-md: 8px;
}

/* 사용 */
.button {
  background: var(--color-primary);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}
```

## Stock-Info의 디자인 토큰

```css
/* src/index.css */

:root {
  /* ============================
     색상 팔레트
     ============================ */

  /* 프라이머리: Indigo */
  --color-primary-50: #eef2ff;
  --color-primary-100: #e0e7ff;
  --color-primary-500: #6366f1;
  --color-primary-600: #4f46e5;
  --color-primary-700: #4338ca;

  /* 그레이스케일 */
  --color-gray-50: #f9fafb;
  --color-gray-100: #f3f4f6;
  --color-gray-200: #e5e7eb;
  --color-gray-300: #d1d5db;
  --color-gray-400: #9ca3af;
  --color-gray-500: #6b7280;
  --color-gray-600: #4b5563;
  --color-gray-700: #374151;
  --color-gray-800: #1f2937;
  --color-gray-900: #111827;

  /* 시맨틱 색상 */
  --color-success: #10b981;  /* 상승, 긍정 */
  --color-danger: #ef4444;   /* 하락, 부정 */
  --color-warning: #f59e0b;  /* 주의 */
  --color-info: #3b82f6;     /* 정보 */

  /* 주가 색상 (한국 관례: 상승=빨강, 하락=파랑) */
  --color-price-up: #dc2626;
  --color-price-down: #2563eb;
  --color-price-flat: #6b7280;

  /* ============================
     간격 스케일
     ============================ */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-2xl: 48px;

  /* ============================
     타이포그래피
     ============================ */
  --font-family: 'Pretendard', -apple-system, BlinkMacSystemFont,
                 'Segoe UI', Roboto, sans-serif;

  --font-size-xs: 12px;
  --font-size-sm: 14px;
  --font-size-md: 16px;
  --font-size-lg: 18px;
  --font-size-xl: 20px;
  --font-size-2xl: 24px;

  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  --line-height-tight: 1.25;
  --line-height-normal: 1.5;
  --line-height-relaxed: 1.75;

  /* ============================
     그림자
     ============================ */
  --shadow-subtle: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);
  --shadow-elevated: 0 20px 25px rgba(0, 0, 0, 0.15);

  /* ============================
     둥근 모서리
     ============================ */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* ============================
     트랜지션
     ============================ */
  --transition-fast: 150ms ease;
  --transition-normal: 200ms ease;
  --transition-slow: 300ms ease;
}
```

# 카드 스타일

---

## 기본 카드

```css
/* src/components/Card.css */

.card {
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-subtle);
  padding: var(--spacing-md);
  transition: transform var(--transition-normal),
              box-shadow var(--transition-normal);
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
}

.card-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-gray-900);
}

.card-subtitle {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
}

.card-content {
  color: var(--color-gray-700);
  line-height: var(--line-height-normal);
}
```

## SectorCard 스타일

```css
/* src/components/SectorCard.css */

.sector-card {
  background: white;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-subtle);
  padding: var(--spacing-lg);
  cursor: pointer;
  transition: transform var(--transition-normal),
              box-shadow var(--transition-normal);
}

.sector-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.sector-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
}

.sector-name {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-gray-900);
}

.sector-stock-count {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
}

.sector-score {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.sector-top-stocks {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--color-gray-100);
}

.top-stock-item {
  display: flex;
  justify-content: space-between;
  padding: var(--spacing-xs) 0;
  font-size: var(--font-size-sm);
}

.top-stock-name {
  color: var(--color-gray-700);
}

.top-stock-price {
  font-weight: var(--font-weight-medium);
}

.top-stock-price.up {
  color: var(--color-price-up);
}

.top-stock-price.down {
  color: var(--color-price-down);
}
```

# ScoreBadge 스타일

---

```css
/* src/components/ScoreBadge.css */

.score-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  font-weight: var(--font-weight-medium);
}

/* 크기 변형 */
.score-badge.size-sm {
  font-size: var(--font-size-xs);
  padding: 2px 6px;
}

.score-badge.size-md {
  font-size: var(--font-size-sm);
  padding: 4px 10px;
}

.score-badge.size-lg {
  font-size: var(--font-size-md);
  padding: 6px 14px;
}

/* 색상 변형 */
.score-badge.badge-green {
  background: #dcfce7;
  color: #166534;
}

.score-badge.badge-yellow {
  background: #fef9c3;
  color: #854d0e;
}

.score-badge.badge-red {
  background: #fee2e2;
  color: #991b1b;
}

.score-badge.badge-gray {
  background: var(--color-gray-100);
  color: var(--color-gray-600);
}

.score-value {
  font-weight: var(--font-weight-bold);
}

.score-label {
  font-size: 0.85em;
  opacity: 0.9;
}
```

# Skeleton 컴포넌트

---

## 로딩 상태 UI

데이터를 불러오는 동안 보여주는 플레이스홀더입니다.

```tsx
// src/components/Skeleton.tsx

import './Skeleton.css';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'circular' | 'rectangular';
  className?: string;
}

export default function Skeleton({
  width,
  height,
  variant = 'rectangular',
  className = ''
}: SkeletonProps) {
  return (
    <div
      className={`skeleton skeleton-${variant} ${className}`}
      style={{ width, height }}
    />
  );
}

// 프리셋: 카드 스켈레톤
export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-card-header">
        <Skeleton width={120} height={20} />
        <Skeleton width={60} height={24} variant="circular" />
      </div>
      <Skeleton width="100%" height={16} className="mt-2" />
      <Skeleton width="80%" height={16} className="mt-2" />
    </div>
  );
}

// 프리셋: 시장 지수 스켈레톤
export function SkeletonMarket() {
  return (
    <div className="skeleton-market">
      <Skeleton width={80} height={16} />
      <Skeleton width={100} height={24} className="mt-1" />
      <Skeleton width={60} height={14} className="mt-1" />
    </div>
  );
}
```

```css
/* src/components/Skeleton.css */

.skeleton {
  background: linear-gradient(
    90deg,
    var(--color-gray-200) 25%,
    var(--color-gray-100) 50%,
    var(--color-gray-200) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius-sm);
}

.skeleton-text {
  border-radius: var(--radius-sm);
}

.skeleton-circular {
  border-radius: var(--radius-full);
}

.skeleton-rectangular {
  border-radius: var(--radius-md);
}

@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

/* 프리셋 스타일 */
.skeleton-card {
  background: white;
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  box-shadow: var(--shadow-subtle);
}

.skeleton-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.skeleton-market {
  padding: var(--spacing-md);
}

.mt-1 { margin-top: var(--spacing-xs); }
.mt-2 { margin-top: var(--spacing-sm); }
```

# EmptyState 컴포넌트

---

## 빈 상태 UI

데이터가 없을 때 보여주는 화면입니다.

```tsx
// src/components/EmptyState.tsx

import './EmptyState.css';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export default function EmptyState({
  icon,
  title,
  description,
  action
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}

      <h3 className="empty-state-title">{title}</h3>

      {description && (
        <p className="empty-state-description">{description}</p>
      )}

      {action && (
        <button
          className="empty-state-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
```

```css
/* src/components/EmptyState.css */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  text-align: center;
}

.empty-state-icon {
  width: 64px;
  height: 64px;
  margin-bottom: var(--spacing-md);
  color: var(--color-gray-400);
}

.empty-state-icon svg {
  width: 100%;
  height: 100%;
}

.empty-state-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-gray-900);
  margin-bottom: var(--spacing-sm);
}

.empty-state-description {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
  max-width: 300px;
  margin-bottom: var(--spacing-md);
}

.empty-state-action {
  background: var(--color-primary-600);
  color: white;
  border: none;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.empty-state-action:hover {
  background: var(--color-primary-700);
}
```

## 사용 예시

```tsx
// 즐겨찾기가 비어있을 때
<EmptyState
  icon={<StarIcon />}
  title="즐겨찾기가 비어있습니다"
  description="관심 있는 종목을 즐겨찾기에 추가해보세요"
  action={{
    label: "종목 탐색하기",
    onClick: () => navigate('/sectors')
  }}
/>

// 검색 결과가 없을 때
<EmptyState
  icon={<SearchIcon />}
  title="검색 결과가 없습니다"
  description={`"${keyword}"에 해당하는 종목을 찾을 수 없습니다`}
/>
```

# 마이크로 모션

---

## Hover 효과

```css
/* 카드 호버 */
.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

/* 버튼 호버 */
.button:hover {
  transform: scale(1.02);
}

/* 링크 호버 - 화살표 등장 */
.link-with-arrow {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.link-with-arrow .arrow {
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--transition-fast),
              transform var(--transition-fast);
}

.link-with-arrow:hover .arrow {
  opacity: 1;
  transform: translateX(0);
}
```

## 숫자 애니메이션

```tsx
// src/components/AnimatedNumber.tsx

import { useEffect, useState } from 'react';

interface AnimatedNumberProps {
  value: number;
  duration?: number;
  formatter?: (n: number) => string;
}

export default function AnimatedNumber({
  value,
  duration = 500,
  formatter = (n) => n.toLocaleString()
}: AnimatedNumberProps) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const startValue = displayValue;
    const diff = value - startValue;
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // easeOutQuad
      const eased = 1 - (1 - progress) * (1 - progress);
      const current = startValue + diff * eased;

      setDisplayValue(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [value, duration]);

  return <span>{formatter(Math.round(displayValue))}</span>;
}
```

# 아이콘 (lucide-react)

---

## 일관된 아이콘 사용

```tsx
import {
  Star,
  Search,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  AlertCircle,
  CheckCircle
} from 'lucide-react';

// 사용
<Star size={20} className="icon-star" />
<TrendingUp size={16} color="var(--color-price-up)" />
```

```css
/* 아이콘 스타일 */
.icon {
  flex-shrink: 0;
}

.icon-sm { width: 16px; height: 16px; }
.icon-md { width: 20px; height: 20px; }
.icon-lg { width: 24px; height: 24px; }
```

# 정리

---

| 개념 | 설명 |
|------|------|
| 디자인 토큰 | 색상, 간격, 폰트 등의 CSS 변수 |
| CSS 변수 | `--name: value;` 와 `var(--name)` |
| Skeleton | 로딩 중 플레이스홀더 |
| EmptyState | 데이터 없을 때 UI |
| 마이크로 모션 | hover, transition 효과 |

디자인 시스템의 장점:
- **일관성**: 동일한 디자인 토큰 사용
- **유지보수**: 한 곳에서 변경하면 전체 반영
- **확장성**: 새 컴포넌트도 같은 규칙 적용

다음 글에서는 **인사이트 컴포넌트**를 알아봅니다.

# Reference

---

- [CSS Custom Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties)
- [Lucide Icons](https://lucide.dev/)
