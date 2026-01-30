---
title: "[StockInfo] 15. 인사이트 컴포넌트 - 10초 요약 UI"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Components]
---

# Introduction

---

Stock-Info의 핵심 기능은 **10초 요약**입니다. 복잡한 재무 지표를 초보자도 이해할 수 있게 요약합니다.

이 글에서는 종목/섹터 인사이트 컴포넌트의 구현을 알아봅니다.

# StockDetailSummary

---

## 설계 철학

"10초 안에 핵심만 전달"

```
┌─────────────────────────────────────────────┐
│  삼성전자 (005930)           점수: 72 STRONG│  ← 점수 배지
│                                              │
│  "실적 안정적, 장기 투자 검토해볼 만합니다"  │  ← 헤드라인
│                                              │
│  ✅ PER 업종 평균 이하 (저평가 가능성)       │
│  ✅ 배당 수익률 양호                         │  ← 긍정 카드
│  ⚠️ 최근 주가 변동성 다소 높음              │  ← 주의 카드
│                                              │
│  ➜ 재무제표와 업종 동향 추가 확인 추천       │  ← 행동 힌트
│                                              │
│  [자세히 보기 ▼]                            │
└─────────────────────────────────────────────┘
```

## 컴포넌트 구현

```tsx
// src/components/StockDetailSummary.tsx

import { useState } from 'react';
import type { StockInsight, ReasonCard } from '../types';
import ScoreBadge from './ScoreBadge';
import './StockDetailSummary.css';

interface StockDetailSummaryProps {
  insight: StockInsight;
  onExpandDetail?: () => void;
}

export default function StockDetailSummary({
  insight,
  onExpandDetail
}: StockDetailSummaryProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { entity, score, summary, reasons, meta } = insight;

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    if (!isExpanded && onExpandDetail) {
      onExpandDetail();
    }
  };

  return (
    <div className="stock-detail-summary">
      {/* 헤더: 종목명 + 점수 배지 */}
      <div className="summary-header">
        <div className="summary-title">
          <h2 className="stock-name">{entity.name}</h2>
          <span className="stock-code">{entity.code}</span>
        </div>
        <ScoreBadge
          score={score.value}
          label={score.grade}
          size="lg"
        />
      </div>

      {/* 한 줄 결론 (헤드라인) */}
      <p className={`summary-headline ${
        summary.tone === 'CAUTIOUS_GUIDE' ? 'cautious' : 'active'
      }`}>
        {summary.headline}
      </p>

      {/* 긍정/주의 카드 영역 */}
      <div className="reason-cards">
        {/* 긍정 카드 */}
        <div className="reason-section positive">
          {reasons.positive.map((card, index) => (
            <ReasonCardChip key={`pos-${index}`} card={card} />
          ))}
        </div>

        {/* 주의 카드 */}
        <div className="reason-section caution">
          {reasons.caution.map((card, index) => (
            <ReasonCardChip key={`cau-${index}`} card={card} />
          ))}
        </div>
      </div>

      {/* 행동 힌트 */}
      <div className="action-hint">
        <span className="hint-icon">➜</span>
        <span className="hint-text">{summary.actionHint.text}</span>
      </div>

      {/* 메타 정보 */}
      <div className="meta-info">
        <span className="meta-item">
          기준: {new Date(meta.asOf).toLocaleString('ko-KR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })}
        </span>
        <span className="meta-item">
          출처: {meta.sources.join(', ')}
        </span>
        {meta.coverage < 0.7 && (
          <span className="meta-item coverage-low">
            정보 일부 부족
          </span>
        )}
      </div>

      {/* 자세히 보기 토글 */}
      <button
        className="expand-toggle"
        onClick={handleToggleExpand}
      >
        {isExpanded ? '접기' : '자세히 보기'}
        <span className={`toggle-icon ${isExpanded ? 'expanded' : ''}`}>
          ▼
        </span>
      </button>

      {/* 확장 영역 */}
      {isExpanded && (
        <div className="expanded-content">
          <div className="triggered-rules">
            <h4>적용된 분석 규칙</h4>
            <div className="rules-list">
              {reasons.triggeredRules.map((rule, index) => (
                <span key={index} className="rule-tag">
                  {rule}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================
// 근거 카드 칩 컴포넌트
// ================================================
interface ReasonCardChipProps {
  card: ReasonCard;
}

function ReasonCardChip({ card }: ReasonCardChipProps) {
  const isPositive = card.polarity === 'POSITIVE';
  const icon = isPositive ? '✅' : '⚠️';

  return (
    <div className={`reason-card-chip ${card.polarity.toLowerCase()}`}>
      <span className="card-icon">{icon}</span>
      <span className="card-text">{card.text}</span>
    </div>
  );
}
```

## CSS 스타일

```css
/* src/components/StockDetailSummary.css */

.stock-detail-summary {
  background: white;
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-subtle);
}

/* 헤더 */
.summary-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--spacing-md);
}

.summary-title {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.stock-name {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--color-gray-900);
  margin: 0;
}

.stock-code {
  font-size: var(--font-size-sm);
  color: var(--color-gray-500);
}

/* 헤드라인 */
.summary-headline {
  font-size: var(--font-size-md);
  line-height: var(--line-height-relaxed);
  margin: 0 0 var(--spacing-md) 0;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
}

.summary-headline.active {
  background: var(--color-primary-50);
  color: var(--color-primary-700);
}

.summary-headline.cautious {
  background: #fef3c7;
  color: #92400e;
}

/* 근거 카드 */
.reason-cards {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
}

.reason-section {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.reason-card-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

.reason-card-chip.positive {
  background: #dcfce7;
  color: #166534;
}

.reason-card-chip.negative {
  background: #fef3c7;
  color: #92400e;
}

.card-icon {
  font-size: var(--font-size-xs);
}

/* 행동 힌트 */
.action-hint {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm);
  background: var(--color-gray-50);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-md);
}

.hint-icon {
  color: var(--color-primary-600);
  font-weight: var(--font-weight-bold);
}

.hint-text {
  font-size: var(--font-size-sm);
  color: var(--color-gray-700);
}

/* 메타 정보 */
.meta-info {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  font-size: var(--font-size-xs);
  color: var(--color-gray-500);
  margin-bottom: var(--spacing-md);
}

.coverage-low {
  color: var(--color-warning);
}

/* 확장 토글 */
.expand-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  width: 100%;
  padding: var(--spacing-sm);
  background: none;
  border: 1px solid var(--color-gray-200);
  border-radius: var(--radius-md);
  color: var(--color-gray-600);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.expand-toggle:hover {
  background: var(--color-gray-50);
}

.toggle-icon {
  transition: transform var(--transition-normal);
}

.toggle-icon.expanded {
  transform: rotate(180deg);
}

/* 확장 영역 */
.expanded-content {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--color-gray-100);
}

.triggered-rules h4 {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-700);
  margin: 0 0 var(--spacing-sm) 0;
}

.rules-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.rule-tag {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  background: var(--color-gray-100);
  color: var(--color-gray-600);
  border-radius: var(--radius-sm);
  font-family: monospace;
}
```

# SectorTopPicks

---

## 설계

섹터 상세 페이지에서 "이 섹터의 주목할 종목"을 보여줍니다.

```
┌─────────────────────────────────────────────┐
│  전기전자 섹터 브리핑                        │
│                                              │
│  "반도체 업황 개선 기대감으로 강세"          │
│                                              │
│  주목할 종목                                 │
│  ┌─────────────────────────────────────────┐│
│  │ 삼성전자     72,500원  +0.69%  [대표]   ││
│  │ SK하이닉스  178,000원  -1.11%  [관찰]   ││
│  │ LG전자      105,000원  +0.48%           ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

## 컴포넌트 구현

```tsx
// src/components/SectorTopPicks.tsx

import { Link } from 'react-router-dom';
import type { SectorInsight, TopPickItem } from '../types';
import ScoreBadge from './ScoreBadge';
import './SectorTopPicks.css';

interface SectorTopPicksProps {
  insight: SectorInsight;
}

export default function SectorTopPicks({ insight }: SectorTopPicksProps) {
  const { sectorName, briefing, topPicks } = insight;

  // Role에 따른 섹션 타이틀
  const hasRepresentative = topPicks.some(
    p => p.role === 'REPRESENTATIVE'
  );
  const sectionTitle = hasRepresentative
    ? '이 섹터의 대표 종목'
    : '관심 종목';

  return (
    <div className="sector-top-picks">
      {/* 섹터 브리핑 */}
      <div className="sector-briefing">
        <h2 className="briefing-title">{sectorName} 섹터 브리핑</h2>
        <p className="briefing-text">{briefing.headline}</p>
      </div>

      {/* Top Picks 목록 */}
      <div className="top-picks-section">
        <h3 className="picks-title">{sectionTitle}</h3>

        <div className="picks-list">
          {topPicks.map((pick) => (
            <TopPickCard key={pick.code} pick={pick} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ================================================
// Top Pick 카드 컴포넌트
// ================================================
interface TopPickCardProps {
  pick: TopPickItem;
}

function TopPickCard({ pick }: TopPickCardProps) {
  const priceChangeClass = pick.changeRate >= 0 ? 'up' : 'down';
  const priceChangeSign = pick.changeRate >= 0 ? '+' : '';

  return (
    <Link
      to={`/stock/${pick.code}`}
      className="top-pick-card"
    >
      <div className="pick-main">
        <div className="pick-info">
          <span className="pick-name">{pick.name}</span>
          {pick.role && (
            <span className={`pick-role role-${pick.role.toLowerCase()}`}>
              {pick.role === 'REPRESENTATIVE' ? '대표' : '관찰'}
            </span>
          )}
        </div>
        <ScoreBadge
          score={pick.score}
          label={pick.label}
          size="sm"
        />
      </div>

      <div className="pick-price">
        <span className="price-value">
          {pick.price.toLocaleString()}원
        </span>
        <span className={`price-change ${priceChangeClass}`}>
          {priceChangeSign}{pick.changeRate.toFixed(2)}%
        </span>
      </div>

      {pick.reason && (
        <p className="pick-reason">{pick.reason}</p>
      )}
    </Link>
  );
}
```

## CSS 스타일

```css
/* src/components/SectorTopPicks.css */

.sector-top-picks {
  background: white;
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  box-shadow: var(--shadow-subtle);
}

/* 섹터 브리핑 */
.sector-briefing {
  margin-bottom: var(--spacing-lg);
  padding-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-gray-100);
}

.briefing-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-gray-900);
  margin: 0 0 var(--spacing-sm) 0;
}

.briefing-text {
  font-size: var(--font-size-md);
  color: var(--color-gray-700);
  line-height: var(--line-height-relaxed);
  margin: 0;
}

/* Top Picks 섹션 */
.picks-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-700);
  margin: 0 0 var(--spacing-md) 0;
}

.picks-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

/* Top Pick 카드 */
.top-pick-card {
  display: block;
  padding: var(--spacing-md);
  background: var(--color-gray-50);
  border-radius: var(--radius-md);
  text-decoration: none;
  transition: all var(--transition-fast);
}

.top-pick-card:hover {
  background: var(--color-gray-100);
  transform: translateX(4px);
}

.pick-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xs);
}

.pick-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.pick-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-900);
}

.pick-role {
  font-size: var(--font-size-xs);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}

.pick-role.role-representative {
  background: var(--color-primary-100);
  color: var(--color-primary-700);
}

.pick-role.role-watchlist_priority {
  background: var(--color-gray-200);
  color: var(--color-gray-700);
}

.pick-price {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.price-value {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-gray-800);
}

.price-change {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
}

.price-change.up {
  color: var(--color-price-up);
}

.price-change.down {
  color: var(--color-price-down);
}

.pick-reason {
  font-size: var(--font-size-xs);
  color: var(--color-gray-500);
  margin: var(--spacing-xs) 0 0 0;
}
```

# NewsHeadlineList

---

## 설계

관련 뉴스를 태그와 함께 목록으로 보여줍니다.

```tsx
// src/components/NewsHeadlineList.tsx

import type { NewsHeadline } from '../types';
import './NewsHeadlineList.css';

interface NewsHeadlineListProps {
  headlines: NewsHeadline[];
  maxItems?: number;
}

export default function NewsHeadlineList({
  headlines,
  maxItems = 5
}: NewsHeadlineListProps) {

  if (headlines.length === 0) {
    return (
      <div className="news-empty">
        <p>관련 뉴스가 없습니다</p>
      </div>
    );
  }

  const displayHeadlines = headlines.slice(0, maxItems);

  return (
    <div className="news-headline-list">
      {displayHeadlines.map((news, index) => (
        <a
          key={index}
          href={news.url}
          target="_blank"
          rel="noopener noreferrer"
          className="news-item"
        >
          <div className="news-content">
            <h4 className="news-title">{news.title}</h4>
            <div className="news-meta">
              <span className="news-publisher">{news.publisher}</span>
              <span className="news-time">
                {formatTimeAgo(news.publishedAt)}
              </span>
            </div>
          </div>

          {/* 태그 (최대 2개) */}
          {news.tags && news.tags.length > 0 && (
            <div className="news-tags">
              {news.tags.slice(0, 2).map((tag) => (
                <span key={tag} className={`news-tag tag-${tag.toLowerCase()}`}>
                  {getTagLabel(tag)}
                </span>
              ))}
            </div>
          )}
        </a>
      ))}
    </div>
  );
}

// 태그 한글 라벨
function getTagLabel(tag: string): string {
  const labels: Record<string, string> = {
    EARNINGS: '실적',
    CONTRACT: '계약',
    BUYBACK_DIVIDEND: '배당',
    REGULATION_RISK: '규제',
    MA: 'M&A',
    INDUSTRY: '산업',
    RUMOR: '루머'
  };
  return labels[tag] || tag;
}

// 상대 시간 포맷
function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) return '방금 전';
  if (diffHours < 24) return `${diffHours}시간 전`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}일 전`;
  return date.toLocaleDateString('ko-KR');
}
```

# 페이지에서 인사이트 사용

---

```tsx
// src/pages/StockDetailPage.tsx

import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { getStockDetail, getStockInsight } from '../services/api';
import StockDetailSummary from '../components/StockDetailSummary';
import NewsHeadlineList from '../components/NewsHeadlineList';
import StockPriceChart from '../components/StockPriceChart';
import FavoriteButton from '../components/FavoriteButton';
import useRecents from '../hooks/useRecents';
import type { StockDetail, StockInsight } from '../types';

export default function StockDetailPage() {
  const { stockCode } = useParams<{ stockCode: string }>();
  const { addRecent } = useRecents();

  const [detail, setDetail] = useState<StockDetail | null>(null);
  const [insight, setInsight] = useState<StockInsight | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!stockCode) return;

    async function loadData() {
      setLoading(true);
      try {
        const [detailData, insightData] = await Promise.all([
          getStockDetail(stockCode),
          getStockInsight(stockCode)
        ]);

        setDetail(detailData);
        setInsight(insightData);

        // 최근 본 종목에 추가
        addRecent(stockCode);
      } catch (error) {
        console.error('Failed to load stock data:', error);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [stockCode, addRecent]);

  if (loading) return <SkeletonStockDetail />;
  if (!detail || !insight) return <div>종목 정보를 찾을 수 없습니다</div>;

  return (
    <div className="stock-detail-page">
      {/* 헤더: 종목명 + 즐겨찾기 */}
      <header className="page-header">
        <h1>{detail.stockName}</h1>
        <FavoriteButton stockCode={stockCode!} />
      </header>

      {/* 10초 요약 */}
      <StockDetailSummary insight={insight} />

      {/* 가격 정보 */}
      <section className="price-section">
        <div className="current-price">
          {detail.closingPrice.toLocaleString()}원
        </div>
        <div className={`price-change ${
          detail.priceChange >= 0 ? 'up' : 'down'
        }`}>
          {detail.priceChange >= 0 ? '+' : ''}
          {detail.priceChange.toLocaleString()}원
          ({detail.changeRate >= 0 ? '+' : ''}{detail.changeRate.toFixed(2)}%)
        </div>
      </section>

      {/* 차트 */}
      <StockPriceChart stockCode={stockCode!} />

      {/* 재무 지표 */}
      <section className="metrics-section">
        <h3>재무 지표</h3>
        <div className="metrics-grid">
          <MetricItem label="PER" value={detail.per?.toFixed(2) || '-'} />
          <MetricItem label="PBR" value={detail.pbr?.toFixed(2) || '-'} />
          <MetricItem label="EPS" value={detail.eps?.toLocaleString() || '-'} />
          <MetricItem label="BPS" value={detail.bps?.toLocaleString() || '-'} />
          <MetricItem
            label="배당수익률"
            value={detail.dividendYield ? `${detail.dividendYield.toFixed(2)}%` : '-'}
          />
        </div>
      </section>

      {/* 관련 뉴스 */}
      <section className="news-section">
        <h3>관련 뉴스</h3>
        <NewsHeadlineList headlines={insight.news || []} />
      </section>
    </div>
  );
}
```

# 정리

---

| 컴포넌트 | 역할 |
|---------|------|
| StockDetailSummary | 종목 10초 요약 (점수, 헤드라인, 카드) |
| SectorTopPicks | 섹터 브리핑 + 주목 종목 목록 |
| NewsHeadlineList | 뉴스 목록 (태그 포함) |
| ReasonCardChip | 긍정/주의 근거 카드 |
| TopPickCard | 주목 종목 카드 |

인사이트 컴포넌트의 핵심:
- **10초 요약**: 핵심만 빠르게 전달
- **시각적 구분**: 긍정(녹색)/주의(노랑) 카드
- **계층 구조**: 헤드라인 → 카드 → 힌트 → 상세

다음 글에서는 **검색/즐겨찾기/차트** 등 인터랙티브 기능을 알아봅니다.

# Reference

---

- [Compound Components Pattern](https://kentcdodds.com/blog/compound-components-with-react-hooks)
- [React Component Composition](https://react.dev/learn/passing-props-to-a-component)
