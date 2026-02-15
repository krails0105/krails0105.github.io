---
title: "[React] Node.js, React, Next.js 차이점 완벽 정리"
categories:
  - React
tags:
  - [Node.js, React, Next.js, 런타임, 프레임워크, 초보자]
---

# Introduction

---

React를 처음 배우면 Node.js, React, Next.js가 각각 무엇이고 어떤 관계인지 헷갈립니다. "React로 개발하는데 왜 Node.js가 필요하지?", "Next.js는 또 뭐지?"라는 질문이 생기죠.

이 글에서는 세 가지 기술의 **역할, 차이점, 의존 관계**를 명확히 정리하고, 프로젝트 상황에 따라 어떤 조합을 선택해야 하는지까지 다룹니다.

# 1. Node.js - JavaScript 런타임

---

## Node.js란?

**JavaScript를 브라우저 밖에서 실행할 수 있게 해주는 런타임 환경**입니다. Python이나 Java를 설치하면 `.py`, `.java` 파일을 실행할 수 있듯, Node.js를 설치하면 `.js` 파일을 컴퓨터에서 직접 실행할 수 있습니다.

```
핵심:
- JavaScript는 원래 웹 브라우저 안에서만 동작하는 언어
- Node.js가 Chrome V8 엔진을 브라우저에서 꺼내 독립 실행 환경으로 만듦
- 서버 개발, CLI 도구, 빌드 도구 등에 사용
- 웹 프레임워크가 아님!
```

## 기술적 특징

| 항목 | 설명 |
|------|------|
| 기반 엔진 | Chrome V8 JavaScript 엔진 |
| 역할 | JavaScript 런타임 (실행 환경) |
| I/O 모델 | 비동기(Non-blocking) 이벤트 기반 |
| 주요 용도 | 서버 개발, CLI 도구, 빌드 도구 실행 |
| 포함 도구 | npm (패키지 매니저), npx (패키지 임시 실행) |

## 코드 예시: 간단한 HTTP 서버

```javascript
// server.js
const http = require('node:http'); // Node.js 내장 http 모듈

const server = http.createServer((req, res) => {
  // 응답 헤더 설정: HTTP 200 OK, HTML 형식
  res.writeHead(200, { 'Content-Type': 'text/html' });
  // 응답 본문 전송 후 연결 종료
  res.end('<h1>Hello from Node.js!</h1>');
});

// 포트 3000에서 요청 대기
server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

```bash
node server.js  # Node.js로 JavaScript 파일 직접 실행
```

> **참고**: `require('node:http')`의 `node:` prefix는 Node.js 내장 모듈임을 명시하는 권장 방식입니다. `require('http')`도 동작하지만, npm 패키지와 구분하기 위해 `node:` prefix 사용이 권장됩니다.

핵심은 **브라우저 없이** JavaScript로 서버를 만들 수 있다는 점입니다. React 개발에서 Node.js가 필요한 이유도 여기에 있습니다. Vite, Webpack 같은 빌드 도구와 npm 패키지 매니저가 모두 Node.js 위에서 동작하기 때문입니다.

# 2. React - UI 라이브러리

---

## React란?

**컴포넌트 기반으로 사용자 인터페이스(UI)를 만드는 JavaScript 라이브러리**입니다. "프레임워크"가 아니라 "라이브러리"라는 점이 중요합니다. React는 화면을 그리는 일에만 집중하고, 나머지는 개발자가 직접 선택하도록 맡깁니다.

## 기술적 특징

| 항목 | 설명 |
|------|------|
| 유형 | UI 라이브러리 (프레임워크 아님) |
| 핵심 개념 | 컴포넌트, JSX, state/props, 가상 DOM |
| 실행 환경 | 기본적으로 브라우저 (클라이언트 사이드) |
| 없는 기능 | 라우팅, SSR, 빌드 시스템, API 서버, 이미지 최적화 |

## 라이브러리 vs 프레임워크

React가 "라이브러리"인 이유를 이해하려면 두 개념의 차이를 알아야 합니다.

| 구분 | 라이브러리 (React) | 프레임워크 (Next.js, Angular) |
|------|-------------------|------------------------------|
| 제어 흐름 | **개발자**가 라이브러리를 호출 | **프레임워크**가 개발자 코드를 호출 |
| 구조 | 자유롭게 결정 | 정해진 규칙을 따름 |
| 추가 도구 | 직접 선택·조합 | 내장되어 있음 |
| 유연성 | 높음 | 상대적으로 낮음 |

## React가 제공하지 않는 것

React만으로는 완전한 웹 애플리케이션을 만들기 어렵습니다. 아래 기능들은 별도 라이브러리나 도구로 해결해야 합니다.

| 기능 | React 단독 | 보완 방법 |
|------|-----------|-----------|
| 라우팅 (페이지 이동) | 미지원 | react-router 등 추가 |
| SSR (서버 사이드 렌더링) | 미지원 | Next.js 사용 또는 직접 구현 |
| 빌드 시스템 | 미지원 | Vite, Webpack 등 필요 |
| API 서버 (백엔드) | 미지원 | Express 등 별도 서버 필요 |
| 이미지 최적화 | 미지원 | 직접 처리 또는 Next.js Image |

## 코드 예시: React 컴포넌트

```jsx
// Button.jsx - 클릭 카운터 컴포넌트
import { useState } from 'react';

function Button() {
  // useState: 컴포넌트의 상태(state)를 선언하는 Hook
  // count는 현재 값, setCount는 값을 업데이트하는 함수
  const [count, setCount] = useState(0);

  return (
    <button onClick={() => setCount(count + 1)}>
      클릭 횟수: {count}
    </button>
  );
}

export default Button;
```

`useState`는 React에서 가장 기본적인 Hook으로, 컴포넌트가 자체적으로 변하는 데이터(상태)를 관리할 수 있게 합니다. `setCount`를 호출하면 React가 자동으로 화면을 다시 그립니다.

# 3. Next.js - React 기반 풀스택 프레임워크

---

## Next.js란?

**React 위에 구축된 풀스택 프레임워크**로, React가 제공하지 않는 라우팅, SSR, API 서버 등을 모두 내장하고 있습니다. React가 "UI를 그리는 도구"라면, Next.js는 "React를 포함한 완성된 웹 애플리케이션 제작 도구"입니다.

```
핵심:
- React를 내부적으로 사용 (Next.js 설치 시 React 자동 포함)
- 파일 기반 라우팅, SSR/SSG, API 서버 등 내장
- 프론트엔드 + 백엔드를 하나의 프로젝트로 관리 가능
- 프레임워크 = 정해진 규칙과 구조를 따름
```

## React (+ Vite) vs Next.js 기능 비교

| 기능 | React + Vite | Next.js |
|------|-------------|---------|
| **라우팅** | 직접 설정 (react-router) | 파일 기반 자동 라우팅 |
| **렌더링** | CSR만 가능 | SSR, SSG, ISR, CSR 모두 지원 |
| **API 서버** | 별도 백엔드 필요 | Route Handlers로 내장 |
| **이미지 최적화** | 직접 처리 | `<Image>` 컴포넌트 내장 |
| **빌드 시스템** | Vite | 내장 (Turbopack) |
| **SEO** | 추가 작업 필요 (CSR 한계) | 메타데이터 API로 기본 지원 |
| **배포** | 정적 호스팅 | Vercel 원클릭 + 다양한 플랫폼 |

## 렌더링 방식 비교

Next.js의 가장 큰 장점 중 하나는 다양한 렌더링 전략을 지원한다는 것입니다.

| 방식 | 설명 | HTML 생성 시점 | 사용 예 |
|------|------|---------------|---------|
| **CSR** (Client-Side Rendering) | 브라우저에서 JavaScript로 렌더링 | 요청 시 (브라우저) | 인터랙티브 UI, 대시보드 |
| **SSR** (Server-Side Rendering) | 요청마다 서버에서 HTML 생성 | 요청 시 (서버) | 사용자별 다른 콘텐츠 |
| **SSG** (Static Site Generation) | 빌드 시 HTML 미리 생성 | 빌드 시 | 블로그, 문서 사이트 |
| **ISR** (Incremental Static Regeneration) | 정적 페이지를 주기적으로 재생성 | 빌드 시 + 주기적 | 자주 바뀌는 정적 콘텐츠 |

```
참고:
- SSG가 가장 빠름 (미리 만들어둔 HTML을 즉시 제공)
- SSR은 항상 최신 데이터를 보장하지만 매 요청마다 서버 부하 발생
- Next.js App Router는 기본적으로 서버 컴포넌트를 사용 (자동 최적화)
- React + Vite는 CSR만 가능하므로 SEO에 불리
```

## 코드 예시: Next.js 파일 기반 라우팅

Next.js App Router에서는 `app/` 디렉토리의 폴더 구조가 곧 URL 구조입니다.

```
app/
  ├── layout.tsx             → 전체 레이아웃 (공통 헤더/푸터)
  ├── page.tsx               → /
  ├── about/
  │   └── page.tsx           → /about
  └── products/
      ├── page.tsx           → /products
      └── [id]/
          └── page.tsx       → /products/1, /products/2, ...
```

`[id]`처럼 대괄호로 감싼 폴더는 **동적 라우트**입니다. URL의 해당 부분이 변수로 전달됩니다.

```tsx
// app/products/[id]/page.tsx - 동적 라우트 페이지
export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Next.js 15부터 params는 Promise이므로 await 필요
  const { id } = await params;

  return <h1>상품 ID: {id}</h1>;
}
```

> **주의**: Next.js 15부터 `params`가 `Promise`로 변경되었습니다. 이전 버전에서는 `params.id`로 바로 접근했지만, 15 이상에서는 반드시 `await params`로 먼저 풀어야 합니다. 버전 업그레이드 시 주의가 필요합니다.

## 코드 예시: Next.js Route Handler (API)

별도 Express 서버 없이 `app/api/` 디렉토리에 `route.ts` 파일을 만들면 API 엔드포인트가 자동 생성됩니다.

```typescript
// app/api/users/route.ts - GET 요청을 처리하는 Route Handler
export async function GET() {
  const users = [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ];

  // Web API 표준 Response 객체 사용
  return Response.json(users);
}
```

```bash
# 자동으로 API 엔드포인트 생성
# GET http://localhost:3000/api/users
# 응답: [{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]
```

Route Handler는 `GET`, `POST`, `PUT`, `DELETE` 등 HTTP 메서드명을 함수 이름으로 export하면 해당 메서드의 요청을 처리합니다.

# 4. 세 기술의 관계와 의존 구조

---

## 계층 구조

세 기술은 서로 다른 레벨에서 동작하며, 다음과 같은 계층을 이룹니다.

```
Node.js (런타임 환경 - 가장 아래층)
  └── React (UI 라이브러리 - Node.js 위의 npm 패키지)
  └── Next.js (풀스택 프레임워크 - React + 추가 기능)
        └── React를 내부적으로 포함
```

## 프로젝트별 의존 관계

| 항목 | Next.js 프로젝트 | React + Vite 프로젝트 |
|------|-----------------|---------------------|
| Node.js | 필요 (런타임) | 필요 (개발 도구 실행) |
| React | 자동 포함 | 직접 설치 |
| 라우팅 | 내장 (파일 기반) | react-router 수동 설정 |
| SSR | 내장 | 직접 구현 (매우 복잡) |
| API 서버 | Route Handlers 내장 | Express 등 별도 서버 |
| 빌드 도구 | Turbopack 내장 | Vite |

# 5. 프로젝트별 선택 가이드

---

## 상황별 권장 조합

| 상황 | 권장 도구 | 이유 |
|------|----------|------|
| 간단한 SPA (Single Page App) | React + Vite | 가볍고 빠른 개발 |
| 관리자 대시보드, 내부 툴 | React + Vite | SEO 불필요, CSR로 충분 |
| 블로그, 마케팅 사이트 (SEO 중요) | Next.js | SSG/SSR로 SEO 최적화 |
| E-커머스, 뉴스 사이트 | Next.js | SEO + 동적 콘텐츠 + API |
| 풀스택 애플리케이션 | Next.js | 프론트 + API 통합 관리 |
| 백엔드가 이미 따로 있음 | React + Vite | 프론트엔드만 담당 |

## 빠른 판단 기준

```
판단 흐름:
1. SEO가 필요한가? → Yes → Next.js
2. API도 같이 만들고 싶은가? → Yes → Next.js
3. 서버 사이드 렌더링이 필요한가? → Yes → Next.js
4. 위 모두 No → React + Vite
```

# 6. 실무에서 자주 하는 실수

---

초보자가 세 기술을 학습할 때 자주 겪는 혼동과 실수를 정리합니다.

| 실수 | 올바른 이해 |
|------|------------|
| "Node.js는 웹 프레임워크다" | Node.js는 **런타임**(실행 환경)이다. Express, Fastify 등이 웹 프레임워크 |
| "React만 설치하면 웹사이트 완성" | React는 UI만 담당. 라우팅, 빌드 도구 등을 직접 구성해야 함 |
| "Next.js는 React와 별개 기술" | Next.js는 React **위에** 만들어진 프레임워크. React 문법 그대로 사용 |
| "CSR이면 SEO 불가능" | 불가능은 아니지만 매우 불리. 검색 엔진이 JavaScript를 실행해야 콘텐츠를 볼 수 있음 |
| "SSR이 항상 SSG보다 좋다" | SSR은 매 요청마다 서버 비용 발생. 변경이 적은 페이지는 SSG가 성능상 유리 |
| "Next.js를 쓰면 Node.js 몰라도 된다" | 배포, 디버깅, 환경 설정 등에서 Node.js 기본 지식은 필수 |

# 7. 보너스 - 정적 사이트 생성기(SSG) 비교

---

블로그나 문서 사이트처럼 콘텐츠 중심 사이트를 만들 때는 전용 **정적 사이트 생성기**도 선택지입니다.

| 도구 | 언어 | 빌드 속도 | 장점 | 단점 |
|------|------|----------|------|------|
| **Jekyll** | Ruby | 느림 | GitHub Pages 네이티브 지원 | Ruby 의존성, 유지보수 모드 |
| **Hugo** | Go | 매우 빠름 | 단일 바이너리, 의존성 없음 | 템플릿 문법 복잡 |
| **Astro** | JavaScript | 빠름 | Content Collections, Islands 아키텍처 | 상대적으로 작은 생태계 |
| **Next.js** | JavaScript | 중간 | React 생태계 활용, MDX 지원 | 빌드 설정 복잡도 높음 |
| **11ty** | JavaScript | 빠름 | Jekyll과 유사한 철학, 유연함 | 상대적으로 작은 생태계 |

```
블로그 선택 기준:
- GitHub Pages로 무료 호스팅? → Jekyll
- 빌드 속도 최우선? → Hugo
- React 컴포넌트를 활용하고 싶다면? → Next.js 또는 Astro
```

# 정리

---

| 도구 | 유형 | 역할 | 대표 사용 예 |
|------|------|------|-------------|
| **Node.js** | 런타임 | JavaScript 실행 환경 | `node server.js` |
| **React** | 라이브러리 | UI 컴포넌트 작성 | `<Button />`, `useState` |
| **Next.js** | 프레임워크 | 풀스택 웹 애플리케이션 | 파일 라우팅 + Route Handlers + SSR |

```
한 문장 정리:
- Node.js는 JavaScript를 컴퓨터에서 실행하게 해주는 "런타임 환경"이고,
- React는 화면(UI)을 컴포넌트 단위로 그리는 "라이브러리"이며,
- Next.js는 React에 라우팅, SSR, API 서버를 추가한 "풀스택 프레임워크"입니다.
```

# Reference

---

- [Node.js 공식 사이트](https://nodejs.org/)
- [Node.js HTTP 모듈 문서](https://nodejs.org/api/http.html)
- [React 공식 문서](https://react.dev/)
- [React - useState Hook](https://react.dev/reference/react/useState)
- [Next.js 공식 문서](https://nextjs.org/docs)
- [Next.js App Router - Routing](https://nextjs.org/docs/app/building-your-application/routing)
- [Next.js Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
- [Jamstack 정적 사이트 생성기 목록](https://jamstack.org/generators/)
