---
title: "[StockInfo] 디자인 시스템을 '토큰'으로 입히기 — 컴포넌트를 안 건드리고 애플 룩으로"
categories:
  - StockInfo
tags:
  - [디자인시스템, CSS변수, Tailwind, Next.js, 리팩터링]
---

# Introduction

---

이번에 Stock-Info의 프론트엔드(`web`, Next.js)에 **디자인 시스템**을 입혔습니다. claude.ai의 Claude Design으로 만든 "Lumen"이라는 시스템인데, 애플 웹사이트의 디자인 언어(단일 파란 강조색, 촘촘한 타이포, 밝은 면, 알약(pill) 버튼)를 중립 브랜드로 재현한 것입니다.

여기서 가장 중요했던 원칙은 이거였습니다.

> **컴포넌트 수십 개를 하나하나 뜯어고치지 않고, 어떻게 앱 전체 룩을 한 번에 바꿀까?**

답은 **디자인 토큰(design token)** 과 **시맨틱 매핑**이었습니다. 그리고 그 과정에서 초보자가 배울 만한 버그 두 개를 만났습니다 — (1) Tailwind v4에서 CSS `@import`가 통째로 사라지는 문제, (2) 다크 테마용 색이 밝은 배경에서 안 보이는 문제. 이 글에서 그 이야기를 풀어봅니다.

# 개념 설명 — 디자인 토큰과 시맨틱 매핑

---

**디자인 토큰**은 색·간격·글꼴 같은 디자인 값에 "이름"을 붙여 한 곳에서 관리하는 변수입니다. 예를 들어 색을 컴포넌트마다 `#ffffff`로 하드코딩하는 대신, `--surface`라는 이름을 만들어 두는 거죠.

토큰에는 두 층이 있습니다.

- **원시 토큰(primitive)**: `--color-canvas: #ffffff` 처럼 값 그 자체.
- **시맨틱 토큰(semantic)**: `--surface: var(--color-canvas)` 처럼 "쓰임새"에 이름을 붙인 것. 컴포넌트는 원시 값이 아니라 이 시맨틱 토큰만 바라봅니다.

핵심은 **컴포넌트가 시맨틱 토큰만 참조하면, 시맨틱 토큰의 값만 바꿔도 전체가 따라 바뀐다**는 점입니다. Stock-Info는 이미 `bg-surface`, `text-muted`, `border-border`, `bg-accent` 같은 시맨틱 유틸리티를 쓰고 있었기 때문에, **토큰의 값만 Lumen 값으로 갈아끼우면 컴포넌트 코드를 한 줄도 안 고치고 룩이 바뀝니다.**

# Stock-Info 구현

---

## 1) 토큰을 값만 갈아끼우기

`web`은 Tailwind v4를 쓰는데, v4는 `@theme inline`으로 CSS 변수를 Tailwind 유틸리티로 노출합니다. `globals.css`에서 앱의 시맨틱 토큰을 **Lumen 값으로 매핑**만 했습니다.

```css
:root {
  /* 앱 시맨틱 토큰을 Lumen 값으로 매핑 →
     bg-bg / bg-surface / border-border / text-muted / bg-accent 유틸이
     그대로 애플 룩을 입는다. 컴포넌트 코드는 손대지 않는다. */
  --bg:      var(--surface-page);       /* #f5f5f7 parchment(오프화이트) */
  --surface: var(--surface-card);       /* #ffffff 카드 면 */
  --border:  var(--border-card);        /* #e0e0e0 헤어라인 */
  --muted:   var(--color-ink-muted-48); /* #7a7a7a 보조 텍스트 */
  --accent:  var(--color-primary);      /* #0066cc 단일 강조색 */
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-border: var(--border);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
}
```

이 몇 줄만으로 `<div className="bg-surface border-border">`를 쓰던 기존 컴포넌트들이 전부 애플 룩으로 바뀝니다. **이게 토큰 기반 설계의 힘입니다.**

## 2) 버그 하나 — Tailwind v4가 `@import`를 삼켰다

Lumen 원시 토큰은 별도 파일 `lumen.css`에 두고, `globals.css` 맨 위에서 이렇게 불렀습니다.

```css
@import "tailwindcss";
@import "./lumen.css";   /* ← 이게 문제였다 */
```

그런데 화면이 **전부 새까맣게** 나왔습니다. 배경색이 안 먹고, 흰 글자만 둥둥 떠 있었죠.

원인을 추측하지 않고 **실제로 서빙되는 CSS를 까봤습니다.**

```bash
curl -s "http://localhost:3000/_next/static/chunks/....css" | grep -- '--color-canvas'
# → (아무것도 안 나옴)
```

`lumen.css`의 토큰이 **번들에 아예 없었습니다.** Tailwind v4 + Turbopack 환경에서 `globals.css` 안의 로컬 `@import`가 처리 단계에서 드롭된 것이죠. 토큰이 없으니 `background: var(--color-canvas)`가 무효가 되고 → 배경이 투명해져 → 뒤의 다크 body가 비쳐 보였던 겁니다.

**해결**: CSS `@import` 대신, `layout.tsx`에서 `globals.css`와 똑같이 **JS로 import**하면 Turbopack이 확실히 번들합니다.

```tsx
// src/app/layout.tsx
import "./lumen.css";   // globals.css 보다 먼저 로드
import "./globals.css";
```

교훈: **"안 보인다"는 증상은 추측하지 말고, 실제 산출물(번들된 CSS)을 직접 확인하라.** grep 한 줄이 원인을 정확히 짚어줬습니다.

## 3) 버그 둘 — 다크용 색은 밝은 배경에서 안 보인다

Lumen은 **밝은(라이트) 디자인 시스템**입니다. 그런데 Stock-Info의 종목 상세 컴포넌트 상당수는 예전 **다크 테마**로 만들어져 있었습니다. 예를 들어 스탠스 칩:

```tsx
// Before — 다크 배경 가정: 흰 배경에선 대비가 약해 흐릿함
const STANCE_CLASS = {
  CONSIDER: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WATCH:    "bg-amber-500/15 text-amber-300 border-amber-500/30",
  AVOID:    "bg-red-500/15 text-red-300 border-red-500/30",
};
```

`text-emerald-300`(연한 초록)은 어두운 배경에선 또렷하지만, 흰 카드 위에선 거의 안 보입니다. 그래서 **의미(초록=고려, 주황=관망, 빨강=회피)는 유지하되, 밝은 면용 명도로 통일**했습니다.

```tsx
// After — 라이트 면 기준(scorecardView 팔레트와 동일한 -100/-800)
const STANCE_CLASS = {
  CONSIDER: "bg-emerald-100 text-emerald-800 border-emerald-200",
  WATCH:    "bg-amber-100 text-amber-800 border-amber-200",
  AVOID:    "bg-red-100 text-red-800 border-red-200",
};
```

같은 원리로 `text-gray-300 → text-muted`, `bg-gray-900/40 → bg-surface` 같은 **다크→라이트 매핑 규칙**을 정해 8개 넘는 컴포넌트에 일괄 적용했습니다.

특히 잊기 쉬운 곳이 **SVG 안의 색**이었습니다. 5축 레이더 차트의 축 라벨이 이렇게 돼 있었죠.

```tsx
// 다크 배경용으로 연회색 → 흰 카드에선 거의 안 보임
<text fill="#e5e7eb">{lp.axis}</text>
// 수정: 흰 배경에서 읽히는 어두운 slate 로
<text fill="#475569">{lp.axis}</text>
```

Tailwind 유틸리티만 훑으면 이 SVG `fill`을 놓칩니다. **색을 뒤집을 땐 CSS 클래스뿐 아니라 인라인 스타일·SVG 속성까지 전수로 봐야 한다**는 걸 배웠습니다.

# 정리

---

- **디자인 토큰 + 시맨틱 매핑**: 컴포넌트가 `bg-surface` 같은 시맨틱 토큰만 바라보게 해두면, 토큰 값만 바꿔 앱 전체를 한 번에 리스킨할 수 있다. (이번엔 코드 한 줄 안 고치고 색·폰트가 전부 바뀌었다.)
- **번들을 직접 확인하라**: Tailwind v4 + Turbopack에서 로컬 `@import`가 드롭됐다. 추측 대신 서빙된 CSS를 `grep`해서 원인을 특정하고, JS import로 우회했다.
- **테마를 뒤집을 땐 대비를 전수 점검하라**: 다크용 `-300` 색은 밝은 면에서 안 보인다. CSS 클래스뿐 아니라 SVG `fill`·인라인 스타일까지 훑어야 한다.

검증은 `tsc`/`eslint` 0, 다크색 잔재 스캔 0, 홈·상세 페이지 HTTP 200으로 마쳤습니다. 데이터 로직과 컴포넌트 동작, 안전 고지(경고색)는 그대로 두고 **시각 셸만** 교체한 것이 이번 작업의 핵심입니다.

# Reference

---

- Tailwind CSS v4 — Theme variables / `@theme`: <https://tailwindcss.com/docs/theme>
- MDN — CSS custom properties (변수): <https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties>
- Next.js — Global CSS 임포트: <https://nextjs.org/docs/app/building-your-application/styling>
