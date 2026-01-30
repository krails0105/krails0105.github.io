---
title: "[StockInfo] FE Phase 1 - 인사이트 컴포넌트"
categories:
  - StockInfo
tags:
  - [React, TypeScript, Components]
---

# Introduction

---

주식 초보자에게 가장 필요한 것은 **10초 안에 종목을 파악**할 수 있는 요약 정보다. 복잡한 재무제표를 읽지 않아도 "이 종목을 관심 리스트에 넣어야 할까?"를 빠르게 판단할 수 있어야 한다.

이 글에서는 종목 10초 요약을 보여주는 `StockDetailSummary`, 섹터 Top Picks를 보여주는 `SectorTopPicks`, 관련 뉴스 헤드라인을 보여주는 `NewsHeadlineList` 컴포넌트를 다룬다.

# StockDetailSummary 컴포넌트

---

## 설계 원칙

1. **점수 + 한줄 결론**: 한눈에 등급 파악
2. **긍정/주의 카드**: 구체적인 근거 제시
3. **행동 힌트**: 다음에 무엇을 확인해야 하는지 안내
4. **접기/펼치기**: 상세 정보는 필요할 때만

## 컴포넌트 구조

```typescript
// src/components/StockDetailSummary.tsx
interface StockDetailSummaryProps {
  insight: StockInsight;
  onExpandDetail?: () => void;
}

export default function StockDetailSummary({ insight, onExpandDetail }: StockDetailSummaryProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { entity, score, summary, reasons, meta } = insight;

  return (
    <div className="stock-detail-summary">
      {/* 헤더: 종목명 + 점수 배지 */}
      <div className="summary-header">
        <div className="summary-title">
          <h2 className="stock-name">{entity.name}</h2>
          <span className="stock-code">{entity.code}</span>
        </div>
        <ScoreBadge score={score.value} label={score.grade} size="lg" />
      </div>

      {/* 한 줄 결론 (헤드라인) */}
      <p className={`summary-headline ${summary.tone === 'CAUTIOUS_GUIDE' ? 'cautious' : 'active'}`}>
        {summary.headline}
      </p>

      {/* 긍정/주의 카드 영역 */}
      <div className="reason-cards">
        <div className="reason-section positive">
          {reasons.positive.map((card, index) => (
            <ReasonCardChip key={`pos-${index}`} card={card} />
          ))}
        </div>
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

      {/* ... */}
    </div>
  );
}
```

## ReasonCardChip 서브 컴포넌트

긍정/주의 카드를 칩 형태로 렌더링한다.

```typescript
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

## 톤에 따른 스타일링

헤드라인은 톤에 따라 색상이 달라진다:

- **ACTIVE_GUIDE**: 기본 색상 (긍정적)
- **CAUTIOUS_GUIDE**: 주의색 (경계 필요)

```css
.summary-headline.active {
  color: var(--text-primary);
}

.summary-headline.cautious {
  color: var(--color-caution);
}
```

# SectorTopPicks 컴포넌트

---

섹터 인사이트 페이지에서 "이 섹터에서 주목할 종목 5개"를 보여준다.

## 주요 기능

1. **섹터 브리핑**: 섹터 전체 흐름 한줄 요약
2. **Top 5 카드**: 점수 순으로 상위 종목 표시
3. **Role 배지**: 종목의 역할 표시 (대표/관찰)

```typescript
// src/components/SectorTopPicks.tsx
interface SectorTopPicksProps {
  insight: SectorInsight;
}

export default function SectorTopPicks({ insight }: SectorTopPicksProps) {
  const { briefing, topPicks, news } = insight;

  return (
    <div className="sector-top-picks">
      {/* 섹터 브리핑 */}
      <div className="sector-briefing">
        <h3>섹터 브리핑</h3>
        <p>{briefing.headline}</p>
      </div>

      {/* Top Picks */}
      <div className="top-picks-grid">
        {topPicks.map((pick, index) => (
          <TopPickCard key={pick.code} pick={pick} rank={index + 1} />
        ))}
      </div>
    </div>
  );
}
```

## TopPickCard

각 추천 종목을 카드 형태로 표시한다.

```typescript
function TopPickCard({ pick, rank }: { pick: TopPick; rank: number }) {
  return (
    <Link to={`/stock/${pick.code}`} className="top-pick-card">
      <div className="top-pick-header">
        <span className="rank-badge">#{rank}</span>
        <span className="stock-name">{pick.name}</span>
        <ScoreBadge score={pick.score} label={pick.label} size="sm" />
      </div>

      {/* Role 배지 */}
      <div className="pick-role">
        {pick.role === 'REPRESENTATIVE' && (
          <span className="role-badge representative">대표</span>
        )}
        {pick.role === 'WATCHLIST_PRIORITY' && (
          <span className="role-badge watchlist">관찰</span>
        )}
      </div>

      {/* 선정 이유 */}
      <ul className="pick-reasons">
        {pick.reasons.slice(0, 2).map((reason, idx) => (
          <li key={idx}>{reason}</li>
        ))}
      </ul>
    </Link>
  );
}
```

# NewsHeadlineList 컴포넌트

---

관련 뉴스를 간결하게 보여준다.

## 주요 기능

1. **태그 표시**: 최대 2개 (EARNINGS, REGULATION_RISK 등)
2. **빈 상태 처리**: 뉴스가 없을 때 외부 검색 링크 제공

```typescript
// src/components/NewsHeadlineList.tsx
interface NewsHeadlineListProps {
  news: NewsItem[];
  maxItems?: number;
  searchKeyword?: string;  // 빈 상태 시 외부 검색용
}

export default function NewsHeadlineList({
  news,
  maxItems = 5,
  searchKeyword
}: NewsHeadlineListProps) {
  // 빈 상태 처리
  if (!news || news.length === 0) {
    return (
      <div className="news-empty">
        <p>관련 뉴스가 없습니다</p>
        {searchKeyword && (
          <a
            href={`https://www.google.com/search?q=${encodeURIComponent(searchKeyword + ' 주식 뉴스')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="external-search-link"
          >
            Google에서 검색하기 →
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="news-headline-list">
      <h3>관련 뉴스</h3>
      <ul>
        {news.slice(0, maxItems).map((item, index) => (
          <NewsHeadlineItem key={index} item={item} />
        ))}
      </ul>
    </div>
  );
}
```

## NewsHeadlineItem

```typescript
function NewsHeadlineItem({ item }: { item: NewsItem }) {
  return (
    <li className="news-item">
      <a href={item.url} target="_blank" rel="noopener noreferrer">
        <span className="news-title">{item.title}</span>

        {/* 태그 최대 2개 표시 */}
        <div className="news-tags">
          {item.tags.slice(0, 2).map((tag) => (
            <span key={tag} className={`news-tag ${tag.toLowerCase()}`}>
              {getTagLabel(tag)}
            </span>
          ))}
        </div>

        <span className="news-meta">
          {item.publisher} · {formatRelativeTime(item.publishedAt)}
        </span>
      </a>
    </li>
  );
}

function getTagLabel(tag: string): string {
  const labels: Record<string, string> = {
    EARNINGS: '실적',
    CONTRACT: '계약',
    REGULATION_RISK: '규제',
    BUYBACK_DIVIDEND: '배당',
    MA: 'M&A',
  };
  return labels[tag] || tag;
}
```

# API 연동 패턴

---

인사이트 API를 호출하고 컴포넌트에 데이터를 전달하는 패턴:

```typescript
// src/pages/StockDetailPage.tsx
function StockDetailPage() {
  const { stockCode } = useParams<{ stockCode: string }>();
  const [insight, setInsight] = useState<StockInsight | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!stockCode) return;

    setLoading(true);
    getStockInsight(stockCode)
      .then(setInsight)
      .catch(() => setInsight(null))
      .finally(() => setLoading(false));
  }, [stockCode]);

  if (loading) return <Skeleton />;

  return (
    <div className="stock-detail-page">
      {insight && <StockDetailSummary insight={insight} />}
      {/* ... */}
    </div>
  );
}
```

# Conclusion

---

Stock-Info 인사이트 컴포넌트의 핵심 설계:

1. **StockDetailSummary**: 점수 배지 + 헤드라인 + 긍정/주의 카드 + 행동 힌트
2. **SectorTopPicks**: 섹터 브리핑 + Top 5 카드 + Role 배지
3. **NewsHeadlineList**: 태그 2개 표시 + 빈 상태 처리

초보자가 10초 안에 "이 종목/섹터를 더 살펴볼 가치가 있는가?"를 판단할 수 있도록 정보를 구조화했다.

# Reference

---

- [React Component Patterns](https://reactpatterns.com/)
