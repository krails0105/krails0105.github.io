---
title: "[StockInfo] FE Phase 2 - 정렬과 필터링"
categories:
  - StockInfo
tags:
  - [React, TypeScript, UX]
---

# Introduction

---

섹터 페이지에서 수십 개의 종목을 보여줄 때, 사용자가 원하는 기준으로 정렬하고 위험한 종목을 필터링할 수 있어야 한다. 이 글에서는 5종 정렬 프리셋과 초보자 보호 필터를 다룬다.

# 5종 정렬 프리셋

---

## 프리셋 정의

사용자 목적에 따라 다른 정렬 기준을 제공한다.

| 프리셋 | 레이블 | 정렬 기준 |
|--------|--------|----------|
| beginner | 초보자 추천 | 종합 점수 내림차순 |
| stable | 안정 우선 | 변동성 낮은 순 (등락률 절댓값) |
| growth | 성장 기대 | 성장 가능성 높은 순 |
| momentum | 모멘텀 | 상승률 높은 순 |
| value | 저평가 | PER 낮은 순 (적자 제외) |

```typescript
// src/pages/SectorDetailPage.tsx
type SortPreset = 'beginner' | 'stable' | 'growth' | 'momentum' | 'value';

const SORT_PRESETS: { value: SortPreset; label: string; description: string }[] = [
  { value: 'beginner', label: '초보자 추천', description: '종합 점수 높은 순' },
  { value: 'stable', label: '안정 우선', description: '변동성 낮은 종목 우선' },
  { value: 'growth', label: '성장 기대', description: '성장 가능성 높은 순' },
  { value: 'momentum', label: '모멘텀', description: '상승률 높은 순' },
  { value: 'value', label: '저평가', description: 'PER 낮은 순 (적자 제외)' },
];
```

## 정렬 로직

`useMemo`를 사용하여 정렬된 결과를 캐싱한다.

```typescript
// 등락률 문자열에서 숫자 추출
function parseChangeRate(changeRate: string): number {
  return parseFloat(changeRate) || 0;
}

const filteredAndSortedStocks = useMemo(() => {
  let result = [...stocks];

  // 필터 적용 (아래 섹션에서 설명)
  // ...

  // 정렬 적용
  switch (sortPreset) {
    case 'beginner':
      // 종합 점수 내림차순
      result.sort((a, b) => b.score - a.score);
      break;

    case 'stable':
      // 변동성 낮은 순, 동점이면 점수 높은 순
      result.sort((a, b) => {
        const volA = Math.abs(parseChangeRate(a.changeRate));
        const volB = Math.abs(parseChangeRate(b.changeRate));
        if (volA !== volB) return volA - volB;
        return b.score - a.score;
      });
      break;

    case 'growth':
      // 현재 데이터로는 점수 기반 (추후 확장 가능)
      result.sort((a, b) => b.score - a.score);
      break;

    case 'momentum':
      // 상승률 높은 순
      result.sort((a, b) =>
        parseChangeRate(b.changeRate) - parseChangeRate(a.changeRate)
      );
      break;

    case 'value':
      // PER 낮은 순 (적자/null 제외)
      result = result.filter((s) => s.per != null && s.per > 0);
      result.sort((a, b) => (a.per ?? 999) - (b.per ?? 999));
      break;
  }

  return result;
}, [stocks, sortPreset, filters]);
```

# 초보자 보호 필터

---

## 문제

적자 종목, 급등락 종목은 초보자에게 위험하다. 기본적으로 이런 종목을 숨기고, 왜 숨겼는지 설명해야 한다.

## 필터 정의

```typescript
interface ProtectionFilters {
  hideDeficit: boolean;    // 적자 종목 숨기기 (PER <= 0)
  hideVolatile: boolean;   // 급등락 종목 숨기기 (|changeRate| > 5%)
}

// 기본값: 둘 다 ON
const [filters, setFilters] = useState<ProtectionFilters>({
  hideDeficit: true,
  hideVolatile: true,
});
```

## 필터 적용

```typescript
const filteredAndSortedStocks = useMemo(() => {
  let result = [...stocks];

  // 적자 종목 제외 (PER이 null, undefined, 0 이하)
  if (filters.hideDeficit) {
    result = result.filter((s) => s.per != null && s.per > 0);
  }

  // 급등락 종목 제외 (등락률 절댓값 > 5%)
  if (filters.hideVolatile) {
    result = result.filter((s) => Math.abs(parseChangeRate(s.changeRate)) <= 5);
  }

  // 정렬 적용...
  return result;
}, [stocks, sortPreset, filters]);
```

## 필터 UI - 툴팁으로 이유 설명

```tsx
<div className="sector-detail__filters">
  <span className="sector-detail__filter-label">초보자 보호:</span>

  {/* 적자 제외 체크박스 */}
  <label
    className="sector-detail__checkbox"
    title="PER 계산이 무의미한 종목을 숨깁니다"  // 툴팁
  >
    <input
      type="checkbox"
      checked={filters.hideDeficit}
      onChange={(e) => setFilters((f) => ({ ...f, hideDeficit: e.target.checked }))}
    />
    적자 제외
  </label>

  {/* 급등락 제외 체크박스 */}
  <label
    className="sector-detail__checkbox"
    title="단기 급변 종목을 숨깁니다 (초보자 보호)"  // 툴팁
  >
    <input
      type="checkbox"
      checked={filters.hideVolatile}
      onChange={(e) => setFilters((f) => ({ ...f, hideVolatile: e.target.checked }))}
    />
    급등락 제외
  </label>
</div>
```

## 필터 결과 안내

몇 개의 종목이 숨겨졌는지 표시한다.

```tsx
// 필터로 제외된 종목 수
const filteredOutCount = stocks.length - filteredAndSortedStocks.length;

// JSX
{filteredOutCount > 0 && (
  <div className="sector-detail__filter-info">
    {filteredOutCount}개 종목이 필터로 숨겨졌습니다.
  </div>
)}
```

# TOP3 표본 필터

---

## 문제

백엔드에서 `sampleSize` (섹터 내 종목 수)를 제공한다. 종목이 5개 미만인 섹터에서 "Top 3"를 보여주면 신뢰도가 낮다.

## 해결

`stockCount >= 5`인 섹터만 Top 3 표시를 활성화한다.

```tsx
// SectorTopPicks 컴포넌트 내부
{insight.isTop3Reliable ? (
  <div className="top-picks-grid">
    {topPicks.map((pick, index) => (
      <TopPickCard key={pick.code} pick={pick} rank={index + 1} />
    ))}
  </div>
) : (
  <div className="top-picks-notice">
    <p>
      이 섹터는 종목 수가 적어 ({insight.sampleSize}개) Top 3 추천을 제공하지 않습니다.
    </p>
    <p>전체 종목 목록을 확인해 주세요.</p>
  </div>
)}
```

# 전체 컴포넌트 구조

---

```tsx
// src/pages/SectorDetailPage.tsx
function SectorDetailPage() {
  const { sectorName } = useParams<{ sectorName: string }>();
  const [sector, setSector] = useState<SectorScore | null>(null);
  const [stocks, setStocks] = useState<StockScore[]>([]);
  const [sortPreset, setSortPreset] = useState<SortPreset>('beginner');
  const [filters, setFilters] = useState<ProtectionFilters>({
    hideDeficit: true,
    hideVolatile: true,
  });

  // 데이터 로딩...

  return (
    <div className="sector-detail">
      <Link to="/" className="back-link">← 홈으로</Link>

      {/* 섹터 인사이트 (있을 때만) */}
      {insight && <SectorTopPicks insight={insight} />}

      {/* 섹터 헤더 */}
      <header className="sector-detail__header">
        <h1>{sector.sectorName}</h1>
        <ScoreBadge score={sector.score} label={sector.label} size="lg" />
      </header>

      {/* 종목 랭킹 테이블 */}
      <section className="sector-detail__stocks">
        <h2>종목 랭킹</h2>

        {/* 정렬/필터 컨트롤 */}
        <div className="sector-detail__controls">
          {/* 정렬 드롭다운 */}
          <div className="sector-detail__sort">
            <label htmlFor="sort-preset">정렬:</label>
            <select
              id="sort-preset"
              value={sortPreset}
              onChange={(e) => setSortPreset(e.target.value as SortPreset)}
            >
              {SORT_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="sector-detail__sort-desc">
              {SORT_PRESETS.find((p) => p.value === sortPreset)?.description}
            </span>
          </div>

          {/* 필터 체크박스 */}
          <div className="sector-detail__filters">
            {/* ... 위에서 설명한 체크박스들 */}
          </div>

          {/* 필터 결과 안내 */}
          {filteredOutCount > 0 && (
            <div className="sector-detail__filter-info">
              {filteredOutCount}개 종목이 필터로 숨겨졌습니다.
            </div>
          )}
        </div>

        {/* 종목 테이블 */}
        <StockRankingTable stocks={filteredAndSortedStocks} showPer showPbr />
      </section>
    </div>
  );
}
```

# CSS 스타일링

---

```css
/* src/pages/SectorDetailPage.css */
.sector-detail__controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
  padding: var(--space-md);
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.sector-detail__sort {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.sector-detail__select {
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  font-size: 14px;
}

.sector-detail__sort-desc {
  color: var(--text-muted);
  font-size: 12px;
}

.sector-detail__filters {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.sector-detail__checkbox {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-size: 14px;
}

.sector-detail__filter-info {
  width: 100%;
  padding: var(--space-sm);
  background: var(--bg-warning-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-warning);
}
```

# Conclusion

---

Phase 2 정렬과 필터링의 핵심:

1. **5종 정렬 프리셋**: 초보자/안정/성장/모멘텀/저평가
2. **초보자 보호 필터**: 적자 제외 + 급등락 제외 (기본 ON)
3. **툴팁으로 이유 설명**: 왜 숨기는지 사용자에게 안내
4. **TOP3 표본 필터**: stockCount < 5이면 Top 3 비활성화

이 기능으로 초보자가 위험한 종목에 노출되는 것을 줄이고, 목적에 맞는 종목을 빠르게 찾을 수 있게 되었다.

# Reference

---

- [React useMemo Hook](https://react.dev/reference/react/useMemo)
