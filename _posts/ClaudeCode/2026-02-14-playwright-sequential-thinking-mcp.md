---
title: "[Claude Code] Playwright MCP와 Sequential Thinking MCP - 언제 필요할까?"
categories:
  - ClaudeCode
tags:
  - [Claude Code, MCP, Playwright, Sequential Thinking, Browser Automation, Problem Solving]
---

# Introduction

---

Claude Code를 사용하다 보면 "Playwright MCP를 설치해야 할까?", "Sequential Thinking MCP는 뭐가 다르지?"라는 질문이 생깁니다. MCP(Model Context Protocol)는 Claude Code의 기능을 확장하는 표준 프로토콜인데, 각 MCP 서버가 제공하는 기능과 목적이 다르기 때문에 올바르게 선택하지 않으면 불필요한 설치나 기대했던 효과를 얻지 못하는 상황이 발생할 수 있습니다.

이 글에서는 **Playwright MCP와 Sequential Thinking MCP의 정의, 동작 방식, 실무 활용 사례**를 정리합니다. 특히 각 MCP가 "왜 필요한지"와 "언제 사용하는지"를 중심으로, 일반 Claude Code와의 차이점, 실제 사용 시나리오, 설치/설정 방법, 필요성 판단 기준까지 다룹니다.

# 1. MCP(Model Context Protocol) 기본 개념

---

**MCP(Model Context Protocol)**는 AI 모델이 외부 데이터나 도구와 통합할 수 있게 하는 표준 프로토콜입니다. Claude Code는 기본적으로 파일 읽기/쓰기, 터미널 명령 실행 같은 기본 도구만 제공하지만, MCP 서버를 추가하면 브라우저 조작, 문서 검색, 데이터베이스 접근 같은 기능이 확장됩니다.

**MCP 서버 종류 (일부):**

| MCP 서버 | 기능 | 용도 |
|---------|------|------|
| **Playwright MCP** | 브라우저 조작 (페이지 열기, 클릭, 스크린샷) | E2E 테스트, UI 확인, 웹 스크래핑 |
| **Sequential Thinking MCP** | 복잡한 문제를 단계별로 분해 + 도구 추천 | 복잡한 문제 해결, 여러 MCP 조합 작업 |
| **Context7 MCP** | 기술 문서 검색 (공식 문서, 라이브러리 레퍼런스) | API 사용법 조회, 최신 문서 참조 |
| **Turso MCP** | Turso Cloud 데이터베이스 접근 | DB 쿼리 실행, 스키마 조회 |

이 글에서는 **Playwright MCP**와 **Sequential Thinking MCP** 두 가지를 중점적으로 다룹니다.

# 2. Playwright MCP - 브라우저를 조작하는 Claude

---

## 정의

**Playwright MCP**는 Claude Code가 브라우저를 직접 조작할 수 있게 해주는 MCP 서버입니다. Microsoft가 공식으로 제공하는 `@playwright/mcp` 패키지로, Playwright 브라우저 자동화 엔진을 MCP 서버 형태로 감싸 Claude가 브라우저와 상호작용할 수 있게 합니다.

**일반 Claude Code:**
- 터미널 명령어만 실행 가능 (파일 읽기/쓰기, git, npm 등)
- 웹 페이지의 시각적 UI를 볼 수 없음

**Claude Code + Playwright MCP:**
- 터미널 명령어 + 브라우저 조작 가능
- 웹 페이지 열기, 클릭, 스크롤, 폼 입력, 스크린샷 촬영
- JavaScript가 렌더링된 후의 실제 UI 확인 가능

## 핵심 동작 방식: Accessibility Snapshot 기반

Playwright MCP의 가장 중요한 특징은 **비전(vision) 모델 없이도 동작한다**는 점입니다. 기본 모드에서는 페이지의 **접근성 트리(Accessibility Snapshot)**를 읽어 구조화된 텍스트로 변환합니다. Claude는 이 스냅샷을 통해 페이지의 버튼, 링크, 입력 필드 등 인터랙티브 요소를 파악하고 조작합니다.

```
# browser_snapshot 도구의 반환 예시 (Accessibility Tree)
- button "Submit" [ref=e1]
- textbox "Email" [ref=e2]
- link "Sign up" [ref=e3]
- heading "Welcome" [level=1]
```

각 요소에는 `[ref=e1]`과 같은 참조(ref) ID가 부여되어, 이후 `browser_click`이나 `browser_type` 같은 도구에서 해당 요소를 지정할 때 사용합니다. 스크린샷 이미지를 분석하는 것이 아니라 **텍스트 기반의 구조화된 데이터**를 사용하므로, 비전 모델이 없어도 정확한 요소 조작이 가능합니다.

> **비전 모드는 선택 사항입니다.** `--caps=vision` 옵션을 활성화하면 좌표 기반 마우스 조작(`browser_mouse_click_xy`, `browser_mouse_move_xy` 등)도 사용할 수 있지만, 대부분의 작업은 기본 접근성 스냅샷 모드로 충분합니다.

## 제공 도구 목록

Playwright MCP는 크게 **Core 도구**와 **Optional 도구**로 나뉩니다. Core 도구는 기본으로 활성화되고, Optional 도구는 `--caps` 옵션으로 활성화합니다.

### Core 도구 (기본 제공)

| 도구 | 설명 |
|------|------|
| `browser_navigate` | URL로 이동 |
| `browser_navigate_back` | 뒤로가기 |
| `browser_click` | 요소 클릭 (ref 기반) |
| `browser_type` | 텍스트 입력 |
| `browser_fill_form` | 여러 폼 필드 한번에 입력 |
| `browser_select_option` | 드롭다운 선택 |
| `browser_hover` | 요소 위에 마우스 올리기 |
| `browser_drag` | 드래그 앤 드롭 |
| `browser_press_key` | 키보드 키 입력 |
| `browser_file_upload` | 파일 업로드 |
| `browser_handle_dialog` | JavaScript 다이얼로그 처리 (alert, confirm 등) |
| `browser_evaluate` | JavaScript 실행 |
| `browser_run_code` | Playwright 코드 직접 실행 |
| `browser_snapshot` | 접근성 트리 스냅샷 |
| `browser_take_screenshot` | 스크린샷 캡처 |
| `browser_console_messages` | 콘솔 로그 조회 |
| `browser_network_requests` | 네트워크 요청 로그 조회 |
| `browser_tabs` | 탭 관리 |
| `browser_resize` | 브라우저 창 크기 조절 |
| `browser_wait_for` | 조건 대기 |
| `browser_close` | 브라우저 닫기 |
| `browser_install` | 브라우저 설치 |

### Optional 도구 (`--caps` 옵션으로 활성화)

| 옵션 | 도구 | 설명 |
|------|------|------|
| `vision` | `browser_mouse_click_xy` | 좌표 기반 클릭 |
| `vision` | `browser_mouse_move_xy` | 좌표 기반 마우스 이동 |
| `vision` | `browser_mouse_drag_xy` | 좌표 기반 드래그 |
| `vision` | `browser_mouse_down/up` | 마우스 버튼 누르기/떼기 |
| `vision` | `browser_mouse_wheel` | 스크롤 휠 |
| `pdf` | `browser_pdf_save` | PDF 생성 |
| `testing` | `browser_generate_locator` | 테스트용 로케이터 생성 |
| `testing` | `browser_verify_element_visible` | 요소 가시성 검증 |
| `testing` | `browser_verify_text_visible` | 텍스트 가시성 검증 |
| `testing` | `browser_verify_value` | 값 검증 |

## 설치 및 설정

### MCP 설정 파일 (mcp.json)

Claude Code에서 Playwright MCP를 사용하려면 `.mcp.json` 또는 프로젝트의 MCP 설정 파일에 다음과 같이 추가합니다.

**기본 설정 (headed 모드):**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}
```

**headless 모드 (서버 환경, CI/CD):**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--headless"
      ]
    }
  }
}
```

**Optional 기능 활성화 (vision, PDF, testing):**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--caps=pdf,vision,testing"
      ]
    }
  }
}
```

### 상세 설정 파일 (config.json)

복잡한 설정이 필요하면 별도 설정 파일을 만들어 `--config` 옵션으로 지정할 수 있습니다.

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "headless": false,
      "channel": "chrome"
    },
    "contextOptions": {
      "viewport": { "width": 1280, "height": 720 }
    }
  },
  "capabilities": ["core", "pdf", "vision"],
  "network": {
    "allowedOrigins": ["https://example.com"],
    "blockedOrigins": ["https://ads.example.com"]
  },
  "timeouts": {
    "action": 5000,
    "navigation": 60000
  }
}
```

```bash
npx @playwright/mcp@latest --config path/to/config.json
```

### Headless vs Headed 모드

| 모드 | 설명 | 사용 시점 |
|------|------|-----------|
| **Headed** (기본) | 실제 브라우저 창이 열림 | 로컬 개발, UI 디버깅 |
| **Headless** (`--headless`) | 화면 없이 백그라운드 실행 | CI/CD, 서버 환경, 자동화 |

Playwright MCP는 기본적으로 **headed 모드**로 실행됩니다. `--headless` 플래그를 추가하면 화면 없이 동작하여 서버 환경이나 CI/CD 파이프라인에서 사용할 수 있습니다.

## 실제 사용 시나리오

### 시나리오 1: UI 버그 확인

**문제 상황:**
사용자가 "로그인 페이지 UI가 깨진 것 같아"라고 보고했을 때, 코드만 보고는 문제를 파악하기 어렵습니다.

**Playwright MCP 활용:**
1. Claude가 브라우저 열기
2. 로그인 페이지의 접근성 스냅샷 + 스크린샷 촬영
3. CSS 파일 확인 후 수정
4. 브라우저 새로고침 후 다시 스크린샷
5. "수정 완료" 확인

```
사용자: "로그인 페이지 레이아웃이 모바일에서 깨져 보여"

Claude (Playwright MCP 사용):
1. browser_navigate → "http://localhost:3000/login"
2. browser_resize → width: 375, height: 667  // iPhone SE 크기
3. browser_take_screenshot → "before.png"
4. Read("src/styles/login.css")
5. Edit(...)  // CSS 수정
6. browser_navigate → "http://localhost:3000/login"  // 새로고침
7. browser_take_screenshot → "after.png"
8. "수정 전후 스크린샷을 비교해보세요."
```

### 시나리오 2: E2E 테스트

**문제 상황:**
"회원가입 -> 로그인 -> 주문" 플로우가 실제로 동작하는지 확인하고 싶지만, 수동으로 테스트하기 번거롭습니다.

**Playwright MCP 활용:**
1. 회원가입 페이지 열기 -> 폼 입력 -> 제출
2. 로그인 페이지 열기 -> 인증 정보 입력 -> 제출
3. 주문 페이지 열기 -> 상품 선택 -> 결제 진행
4. 각 단계에서 예상 결과 확인 (리다이렉트, 메시지 표시 등)

```
사용자: "회원가입 플로우가 잘 동작하는지 테스트해줘"

Claude (Playwright MCP 사용):
1. browser_navigate → "http://localhost:3000/signup"
2. browser_snapshot → 폼 요소의 ref 확인
3. browser_click → ref=e2 (Email 입력 필드)
4. browser_type → "test@example.com"
5. browser_click → ref=e3 (Password 입력 필드)
6. browser_type → "Test1234!"
7. browser_click → ref=e5 (Submit 버튼)
8. browser_wait_for → url 변경 대기
9. browser_take_screenshot → "signup-success.png"
10. "회원가입이 성공했고, 대시보드로 리다이렉트되었습니다."
```

위 예시에서 `ref=e2`, `ref=e3` 같은 값은 `browser_snapshot`이 반환한 접근성 트리에서 확인한 요소 참조입니다. CSS 셀렉터 대신 ref ID를 사용하므로 **페이지 구조가 바뀌어도 접근성 트리 기반으로 정확한 요소를 찾을 수 있습니다.**

### 시나리오 3: 웹 스크래핑

**문제 상황:**
동적으로 렌더링되는 웹 페이지(React, Vue 등)에서 데이터를 추출해야 하는데, `curl`로는 JavaScript 실행 전의 HTML만 받아집니다.

**Playwright MCP 활용:**
1. 브라우저에서 페이지 열기 (JavaScript 실행됨)
2. 필요한 데이터가 로드될 때까지 대기
3. 접근성 스냅샷 또는 JavaScript 실행으로 데이터 추출
4. JSON이나 CSV로 저장

```
사용자: "이 뉴스 사이트에서 최신 기사 제목 10개 추출해줘"

Claude (Playwright MCP 사용):
1. browser_navigate → "https://news.example.com"
2. browser_wait_for → ".article-list" 셀렉터 대기
3. browser_snapshot → 접근성 트리에서 기사 제목 추출
   또는
   browser_evaluate → document.querySelectorAll(".article-title")로 텍스트 추출
4. Write("titles.json", ...)
```

## 필요한 경우 vs 불필요한 경우

**필요한 경우:**
- 프론트엔드 개발 (React, Vue, Angular 등)
- 풀스택 웹 애플리케이션 개발
- E2E 테스트 작성/실행
- 웹 스크래핑 (JavaScript로 렌더링되는 페이지)
- UI/UX 버그 확인

**불필요한 경우:**
- 백엔드 API만 개발 (브라우저 필요 없음)
- CLI 도구 개발 (터미널만 사용)
- 블로그 포스트 작성 (코드 편집만 필요)
- Python/Java 라이브러리 개발 (UI 없음)

> **핵심**: Playwright MCP는 "브라우저가 필요한 작업"에만 유용합니다. 백엔드만 개발한다면 설치할 필요가 없습니다.

# 3. Sequential Thinking MCP - 복잡한 문제를 단계별로 해결

---

## 정의

**Sequential Thinking MCP**(`mcp-sequentialthinking-tools`)는 복잡한 문제를 작은 단계로 쪼개고, 각 단계마다 어떤 MCP 도구를 쓸지 추천해주는 MCP 서버입니다. "사고 과정을 구조화"하여 Claude가 더 체계적으로 문제를 해결하도록 돕습니다.

**일반 LLM (Claude, GPT 등):**
- 질문을 받으면 한 번에 전체 답변 생성
- 중간 과정이 블랙박스 (어떤 단계로 생각했는지 불명확)
- 실수하면 처음부터 다시 시작

**Sequential Thinking MCP:**
- 문제를 명시적인 단계(thought)로 분해
- 각 단계마다 사용할 도구와 신뢰도 점수(confidence) 제시
- 새로운 정보가 나오면 이전 단계만 수정 (revision)
- 대안적 접근법 탐색 시 사고 흐름 분기 (branching)

## 핵심 API: `sequentialthinking_tools`

Sequential Thinking MCP는 `sequentialthinking_tools`라는 단일 도구를 제공합니다. 이 도구를 반복 호출하면서 사고 단계를 진행합니다.

### 주요 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|---------|------|:----:|------|
| `available_mcp_tools` | `string[]` | O | 현재 사용 가능한 MCP 도구 이름 배열 |
| `thought` | `string` | O | 현재 사고 단계의 내용 |
| `thought_number` | `integer` | O | 현재 사고 번호 (1부터 시작) |
| `total_thoughts` | `integer` | O | 예상 총 사고 단계 수 |
| `next_thought_needed` | `boolean` | O | 다음 사고 단계가 필요한지 여부 |
| `is_revision` | `boolean` | - | 이전 사고를 수정하는지 여부 |
| `revises_thought` | `integer` | - | 수정 대상 사고 번호 |
| `branch_from_thought` | `integer` | - | 분기 시작점 사고 번호 |
| `branch_id` | `string` | - | 분기 식별자 |
| `needs_more_thoughts` | `boolean` | - | 추가 사고가 필요한지 여부 |
| `current_step` | `object` | - | 현재 단계의 추천 정보 |
| `previous_steps` | `array` | - | 이전 단계 추천 이력 |
| `remaining_steps` | `array` | - | 남은 단계 설명 (고수준) |

### `current_step` 객체 구조

`current_step`은 각 단계의 도구 추천 정보를 담고 있습니다.

```typescript
interface StepRecommendation {
  step_description: string;     // 이 단계에서 할 일
  recommended_tools: [          // 추천 도구 배열
    {
      tool_name: string;        // 도구 이름
      confidence: number;       // 신뢰도 점수 (0.0 ~ 1.0)
      rationale: string;        // 추천 이유
      priority: number;         // 추천 우선순위
      suggested_inputs?: {};    // 제안 입력값 (선택)
      alternatives?: string[];  // 대안 도구 (선택)
    }
  ];
  expected_outcome: string;     // 예상 결과
  next_step_conditions?: string[]; // 다음 단계 진행 조건
}
```

신뢰도 점수(confidence)는 `current_step.recommended_tools` 배열 안의 각 도구에 포함됩니다. 0.0에서 1.0 사이의 값으로, 해당 도구가 현재 단계에 얼마나 적합한지를 나타냅니다.

## 핵심 기능

### 1. 단계별 분해 (Step-by-Step Breakdown)

복잡한 문제를 관리 가능한 작은 단계로 나눕니다. 각 단계는 독립적으로 검증하고 수정할 수 있습니다.

```
문제: "Svelte 5의 universal reactivity를 기존 프로젝트에 적용하는 방법"

사고 1: "Svelte 5의 universal reactivity 개념 조사"
사고 2: "기존 프로젝트의 상태 관리 패턴 파악"
사고 3: "마이그레이션 전략 수립"
사고 4: "적용 후 테스트 계획"
```

### 2. 도구 추천 + 신뢰도 점수 (Tool Recommendation with Confidence)

각 단계에 적합한 MCP 도구를 추천하고, 신뢰도 점수(0.0~1.0)를 제공합니다.

```json
{
  "thought": "Svelte 5의 universal reactivity 조사",
  "thought_number": 1,
  "total_thoughts": 5,
  "next_thought_needed": true,
  "available_mcp_tools": ["mcp-omnisearch", "mcp-turso-cloud"],
  "current_step": {
    "step_description": "Svelte 5 공식 문서에서 universal reactivity 관련 내용 검색",
    "recommended_tools": [
      {
        "tool_name": "mcp-omnisearch",
        "confidence": 0.95,
        "rationale": "최신 기술 문서 검색에 적합",
        "priority": 1
      }
    ],
    "expected_outcome": "universal reactivity의 핵심 개념과 사용법 파악"
  }
}
```

### 3. Revision (수정)

새로운 정보가 나오면 이전 단계의 결론을 수정합니다. 전체 과정을 다시 시작하지 않고, 해당 단계만 업데이트합니다. `is_revision: true`와 `revises_thought`로 수정 대상을 지정합니다.

```json
{
  "thought": "수정: 문서를 확인해보니 universal reactivity는 생각보다 단순한 개념",
  "thought_number": 3,
  "total_thoughts": 5,
  "is_revision": true,
  "revises_thought": 2,
  "next_thought_needed": true,
  "available_mcp_tools": ["mcp-omnisearch", "mcp-turso-cloud"],
  "current_step": {
    "step_description": "기존 코드에서 수정이 필요한 부분만 식별",
    "recommended_tools": [
      {
        "tool_name": "mcp-turso-cloud",
        "confidence": 0.85,
        "rationale": "코드 저장소에서 수정 대상 패턴 검색",
        "priority": 1
      }
    ],
    "expected_outcome": "최소한의 변경으로 마이그레이션 가능한 코드 목록"
  }
}
```

### 4. Branching (분기)

대안적 접근법을 탐색할 때 사고 흐름을 분기합니다. `branch_from_thought`로 분기 시작점을, `branch_id`로 분기를 식별합니다.

```json
{
  "thought": "대안 탐색: Svelte 5의 runes 방식은 어떨까?",
  "thought_number": 4,
  "total_thoughts": 6,
  "branch_from_thought": 3,
  "branch_id": "runes-alternative",
  "next_thought_needed": true,
  "available_mcp_tools": ["mcp-omnisearch", "mcp-fetch"],
  "current_step": {
    "step_description": "Svelte 5 runes API 조사",
    "recommended_tools": [
      {
        "tool_name": "mcp-omnisearch",
        "confidence": 0.95,
        "rationale": "Svelte 5 runes 공식 문서 검색",
        "priority": 1,
        "alternatives": ["mcp-fetch"]
      }
    ],
    "expected_outcome": "runes vs 전통 reactive 선언 비교"
  }
}
```

여러 분기를 만들어 각각 독립적으로 탐색한 뒤, 최종적으로 가장 적합한 경로를 선택할 수 있습니다.

### 5. 컨텍스트 유지 (Context Maintenance)

`previous_steps`와 `remaining_steps` 파라미터를 통해 전체 사고 과정이 기록됩니다. Claude가 "왜 이 결정을 내렸는지"를 추적할 수 있고, 단계 간 맥락이 보존되어 일관된 결론에 도달합니다.

## 일반 LLM vs Sequential Thinking 비교

| 기준 | 일반 LLM | Sequential Thinking MCP |
|------|---------|------------------------|
| **사고 과정** | 블랙박스 (한 번에 답변) | 명시적 단계 (각 thought 기록) |
| **도구 선택** | 직감적 선택 | 신뢰도 기반 추천 (confidence 0.0~1.0) |
| **오류 수정** | 처음부터 다시 | 해당 단계만 revision (`is_revision`, `revises_thought`) |
| **대안 탐색** | 순차적 시도 | 분기로 여러 경로 동시 탐색 (`branch_from_thought`, `branch_id`) |
| **컨텍스트 관리** | 대화 이력 의존 | 구조화된 사고 그래프 (`previous_steps`, `remaining_steps`) |

## 실제 동작 흐름 예시

**문제:** "프로젝트의 의존성 충돌 해결"

```
사고 1: "의존성 트리 분석"
  - thought_number: 1, total_thoughts: 5
  - recommended_tools: [{ tool_name: "Bash", confidence: 0.95 }]
  - 실행: npm list --all

사고 2: "충돌하는 패키지 식별"
  - thought_number: 2, total_thoughts: 5
  - recommended_tools: [{ tool_name: "Grep", confidence: 0.9 }]
  - 실행: package-lock.json에서 충돌 패턴 검색

사고 3 (최초): "모든 패키지를 최신 버전으로 업데이트"
  ↓
사고 3 (수정): "특정 패키지만 다운그레이드"
  - is_revision: true
  - revises_thought: 3
  - 이유: 사고 2에서 핵심 충돌 원인 발견

사고 4a (분기): "방법 A - 패키지 X를 v2로 고정"
  - branch_id: "downgrade"
  - branch_from_thought: 3

사고 4b (분기): "방법 B - 패키지 Y를 v3로 업그레이드"
  - branch_id: "upgrade"
  - branch_from_thought: 3

사고 5: "방법 A 선택 (더 안전)"
  - next_thought_needed: false
  - 근거: 사고 4a와 4b 비교 후 리스크 평가
```

## 공식 문서의 설계 목적

공식 문서에서는 Sequential Thinking MCP의 목적을 다음과 같이 설명합니다:

> "designed for complex problem-solving tasks that require breaking down problems into steps, coordinating multiple tools, and maintaining context -- where the full solution path isn't immediately clear"

즉, "해결 경로가 명확하지 않은 복잡한 문제"를 위해 설계되었습니다. 핵심 가치는 (1) 문제 분해, (2) 도구 조율, (3) 컨텍스트 유지 세 가지입니다.

## 유용한 경우 vs 불필요한 경우

**유용한 경우:**
- 해결 경로가 불분명한 복잡한 문제
- 여러 MCP 도구를 조합해야 하는 작업
- 중간에 방향 수정이 필요한 탐색 작업
- 여러 대안을 비교 평가해야 하는 결정
- 사고 과정을 명시적으로 추적하고 싶은 경우

**불필요한 경우:**
- 간단한 작업 ("이 파일 읽어줘", "테스트 실행해줘")
- 해결 방법이 명확한 경우 ("git commit 만들어줘")
- MCP 도구를 사용하지 않는 작업 (순수 코드 작성)
- 빠른 답변이 필요한 단순 질문

> **핵심**: Sequential Thinking MCP는 "복잡하고 불확실한 문제"에만 유용합니다. 간단한 작업에는 오히려 오버헤드가 됩니다.

# 4. 언제 어떤 MCP를 선택할까?

---

## 상황별 MCP 선택 기준

| 상황 | 추천 MCP | 이유 |
|------|---------|------|
| **프론트엔드 개발** | Playwright MCP | UI 확인, E2E 테스트 필요 |
| **백엔드 API 개발** | 불필요 | 브라우저 사용 안 함 |
| **웹 스크래핑** | Playwright MCP | JavaScript 렌더링 필요 |
| **복잡한 버그 디버깅** | Sequential Thinking MCP | 단계별 원인 추적 |
| **새 기술 학습/적용** | Sequential Thinking MCP | 문서 조사 -> 예제 -> 적용 단계 분해 |
| **간단한 코드 수정** | 불필요 | 기본 Claude Code로 충분 |
| **의존성 충돌 해결** | Sequential Thinking MCP | 원인 분석 -> 대안 비교 -> 선택 |

## 실무 예시

### 예시 1: 프론트엔드 개발

**상황:** React 프로젝트에서 새 기능 추가

**필요한 MCP:**
- **Playwright MCP**: 개발한 기능이 실제 브라우저에서 동작하는지 확인
- **Sequential Thinking MCP** (선택): 복잡한 상태 관리 로직이 있으면 단계별 접근

```
작업 흐름:
1. 컴포넌트 코드 작성 (기본 Claude Code)
2. browser_navigate → 렌더링 확인 (Playwright MCP)
3. browser_resize → 다양한 화면 크기에서 테스트 (Playwright MCP)
4. browser_take_screenshot → 디자인 검증 (Playwright MCP)
```

### 예시 2: 백엔드 API 개발

**상황:** Spring Boot REST API 엔드포인트 추가

**필요한 MCP:**
- **없음**: 터미널로 테스트 실행, 코드 작성만으로 충분

```
작업 흐름:
1. Controller/Service 코드 작성 (기본 Claude Code)
2. 단위 테스트 작성 (기본 Claude Code)
3. ./gradlew test 실행 (기본 Claude Code의 Bash)
```

### 예시 3: 복잡한 기술 적용

**상황:** 기존 프로젝트에 GraphQL 도입

**필요한 MCP:**
- **Sequential Thinking MCP**: 단계별 계획 수립
- **Context7 MCP** (선택): GraphQL 공식 문서 조회
- **Playwright MCP** (선택): GraphQL Playground UI 확인

```
Sequential Thinking 흐름:
사고 1: "GraphQL 기본 개념 조사" (Context7 MCP, confidence: 0.95)
사고 2: "기존 REST API 구조 분석" (Grep, Read, confidence: 0.9)
사고 3: "마이그레이션 전략 수립"
  ├─ 사고 4a: "점진적 마이그레이션 (REST + GraphQL 병행)" (branch_id: "gradual")
  └─ 사고 4b: "일괄 전환" (branch_id: "full-switch")
사고 5: "점진적 마이그레이션 선택 (리스크 낮음)" (next_thought_needed: false)
사고 6: "첫 엔드포인트 구현" (코드 작성)
사고 7: "Playground에서 테스트" (Playwright MCP)
```

# 5. 주의할 점

---

## Playwright MCP

### Accessibility Snapshot의 한계

기본 모드는 접근성 트리 기반이므로, **접근성 속성이 없는 커스텀 요소**는 인식하지 못할 수 있습니다. 이런 경우 `browser_evaluate`로 JavaScript를 직접 실행하거나, `--caps=vision` 옵션을 활성화하여 좌표 기반 조작을 사용하세요.

### 성능 오버헤드

브라우저 실행은 터미널 명령보다 느립니다. 간단한 HTML 파일은 `curl`로 충분하고, JavaScript 렌더링이 필요한 경우에만 Playwright를 사용하세요.

```
Bad:
  browser_navigate → "https://example.com"  // 정적 페이지
  (브라우저를 띄워서 정적 페이지를 로드할 필요가 없음)

Good:
  Bash → "curl https://example.com"  // 더 빠름
```

### 네트워크 필터링

설정 파일에서 `allowedOrigins`와 `blockedOrigins`를 지정하여 접근 가능한 도메인을 제한할 수 있습니다. 보안이 중요한 환경에서는 허용된 도메인만 설정하는 것을 권장합니다.

### 권한 문제

일부 웹사이트는 자동화 도구 접근을 차단합니다. 로그인이 필요한 페이지나 CAPTCHA가 있으면 Playwright로 접근하기 어렵습니다. `userDataDir` 옵션으로 기존 브라우저 프로필을 재사용하면 로그인 세션을 유지할 수 있습니다.

## Sequential Thinking MCP

### 오버헤드

단순한 작업에 Sequential Thinking을 사용하면 오히려 느려집니다. "파일 읽어줘" 같은 명령은 기본 Claude Code로 충분합니다. `available_mcp_tools` 배열에 현재 사용 가능한 도구를 정확히 전달해야 적절한 추천을 받을 수 있습니다.

### 신뢰도 점수는 참고만

confidence score(0.0~1.0)는 해당 도구가 현재 단계에 적합한 정도를 나타내는 추정치입니다. 절대적 기준이 아니므로, 점수가 낮아도 실제로는 최선의 도구일 수 있습니다. `alternatives` 필드에 대안 도구가 함께 제시되므로 참고하세요.

### `total_thoughts`는 예상치

`total_thoughts`는 처음에 예상한 총 단계 수이지만, 진행하면서 변경될 수 있습니다. `needs_more_thoughts: true`로 추가 단계가 필요함을 표시할 수 있고, 마지막 단계에서 `next_thought_needed: false`로 종료를 선언합니다.

### Revision의 한계

revision은 이전 단계의 결론만 수정하지, 이미 실행된 도구의 결과는 되돌릴 수 없습니다. 예를 들어, 잘못된 명령으로 파일을 삭제했으면 revision으로 복구할 수 없습니다.

## 일반적 주의사항

### MCP는 선택사항

모든 작업에 MCP가 필요한 것은 아닙니다. 기본 Claude Code로도 대부분의 개발 작업이 가능합니다. MCP는 **필요할 때만** 추가하세요.

### 설치와 설정

MCP 서버는 별도 설치가 필요합니다. 프로젝트 또는 사용자 레벨의 MCP 설정 파일(`.mcp.json`)에 서버 정보를 추가하며, Node.js 런타임이 필요합니다. Playwright MCP의 경우 `npx @playwright/mcp@latest`로 실행하므로 별도 전역 설치 없이 바로 사용할 수 있습니다.

# 정리

---

## Playwright MCP vs Sequential Thinking MCP

| 기준 | Playwright MCP | Sequential Thinking MCP |
|------|---------------|------------------------|
| **패키지** | `@playwright/mcp` (Microsoft 공식) | `mcp-sequentialthinking-tools` |
| **목적** | 브라우저 조작 | 복잡한 문제 단계별 분해 |
| **동작 방식** | 접근성 스냅샷 기반 (비전 모드 선택) | 구조화된 사고 단계 + 도구 추천 |
| **핵심 기능** | navigate, click, snapshot, screenshot | thought 분해, confidence 점수, revision, branching |
| **필요한 경우** | 프론트엔드, E2E 테스트, 웹 스크래핑 | 해결 경로 불명확, 여러 도구 조합, 대안 비교 |
| **불필요한 경우** | 백엔드만 개발, CLI 도구 | 간단한 작업, 해결 방법 명확 |
| **속도** | 느림 (브라우저 실행) | 보통 (단계별 처리) |

## 선택 기준 한 문장 정리

```
- 브라우저가 필요한 작업 → Playwright MCP
- 복잡하고 불확실한 문제 → Sequential Thinking MCP
- 간단한 파일/터미널 작업 → 기본 Claude Code
```

## MCP 설치 전 체크리스트

- [ ] 이 작업에 브라우저가 필요한가? (Yes -> Playwright MCP)
- [ ] 문제가 복잡하고 해결 경로가 불분명한가? (Yes -> Sequential Thinking MCP)
- [ ] 여러 MCP 도구를 조합해야 하는가? (Yes -> Sequential Thinking MCP)
- [ ] 기본 Claude Code로 해결 가능한가? (Yes -> MCP 불필요)

# Reference

---

- [Playwright MCP - GitHub (Microsoft 공식)](https://github.com/microsoft/playwright-mcp)
- [Sequential Thinking MCP - GitHub](https://github.com/spences10/mcp-sequentialthinking-tools)
- [Model Context Protocol (MCP) 공식 사이트](https://modelcontextprotocol.io)
- [Playwright 공식 문서](https://playwright.dev)
