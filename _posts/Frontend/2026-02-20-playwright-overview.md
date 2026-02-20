---
title: "[Playwright] Playwright 완벽 가이드 - E2E 테스트와 브라우저 자동화"
categories:
  - Frontend
tags:
  - [Playwright, E2E, 테스트, 자동화, TypeScript]
---

# Introduction

---

웹 애플리케이션을 개발할 때 가장 중요한 것 중 하나는 실제 사용자가 겪을 수 있는 버그를 미리 찾아내는 것입니다. 단위 테스트(Unit Test)는 개별 함수나 클래스를 검증하지만, **실제 브라우저에서 사용자가 버튼을 클릭하고 폼을 제출하는 시나리오**는 테스트하지 못합니다.

이때 필요한 것이 **E2E(End-to-End) 테스트**입니다. Playwright는 Microsoft가 개발한 오픈소스 브라우저 자동화 및 E2E 테스트 프레임워크로, 실제 브라우저를 제어하여 사용자 행동을 시뮬레이션할 수 있습니다.

이 글에서는 다음 내용을 다룹니다.

- E2E 테스트의 개념과 필요성
- Playwright의 핵심 특징과 기본 사용법
- 실전 예제를 통한 테스트 작성 방법
- Page Object Model 등 심화 패턴
- Cypress, Selenium, Puppeteer와의 비교
- 실무에서 자주 만나는 함정과 해결책

# 1. E2E 테스트란?

---

## 테스트 피라미드

소프트웨어 테스트는 일반적으로 3단계로 나뉩니다.

| 테스트 종류 | 범위 | 속도 | 예시 |
|------------|------|------|------|
| **Unit Test** | 개별 함수/클래스 | 빠름 | `sum(1, 2) === 3` |
| **Integration Test** | 여러 모듈 간 상호작용 | 보통 | API 호출 -> DB 저장 확인 |
| **E2E Test** | 전체 애플리케이션 | 느림 | 로그인 -> 상품 검색 -> 구매 |

E2E 테스트는 **실제 사용자의 관점**에서 애플리케이션 전체를 검증합니다. 예를 들어:

- 사용자가 로그인 버튼을 클릭하면 로그인 페이지가 나타나는가?
- 이메일과 비밀번호를 입력하고 제출하면 대시보드로 이동하는가?
- API 응답이 실제 화면에 올바르게 표시되는가?

## 왜 E2E 테스트가 필요한가?

단위 테스트만으로는 발견할 수 없는 문제들이 있습니다.

- **통합 버그**: API는 정상이지만 프론트엔드에서 데이터를 잘못 파싱
- **UI 버그**: 특정 브라우저에서만 버튼이 클릭되지 않음
- **워크플로우 버그**: 결제 프로세스 중간 단계에서 세션이 끊김

Playwright는 이런 문제를 **실제 브라우저를 실행**하여 찾아냅니다.

# 2. Playwright란?

---

Playwright는 **Microsoft**가 2020년에 출시한 오픈소스 브라우저 자동화 라이브러리입니다. 주요 목적은 두 가지입니다.

1. **E2E 테스트 자동화**: 웹 애플리케이션의 사용자 시나리오를 자동으로 검증
2. **브라우저 작업 자동화**: 웹 스크래핑, 스크린샷 생성, PDF 저장 등

## 핵심 특징

### 1) 크로스 브라우저 지원

하나의 코드로 3개 브라우저 엔진을 모두 테스트할 수 있습니다.

| 브라우저 | 엔진 | 대응 실제 브라우저 |
|---------|------|------------------|
| **Chromium** | Blink | Chrome, Edge, Opera |
| **Firefox** | Gecko | Firefox |
| **WebKit** | WebKit | Safari |

### 2) Auto-wait (자동 대기)

전통적인 Selenium에서는 요소가 나타날 때까지 명시적으로 대기해야 했습니다.

```javascript
// Selenium (구식 방법)
await driver.wait(until.elementLocated(By.id('button')), 5000);
await driver.findElement(By.id('button')).click();
```

Playwright는 **자동으로 요소가 준비될 때까지 기다립니다**. Locator를 통해 요소를 찾으면, 해당 요소가 DOM에 부착되고(attached), 화면에 보이고(visible), 안정 상태(stable)가 될 때까지 자동으로 대기한 후 액션을 수행합니다.

```typescript
// Playwright (자동 대기)
// 요소가 나타나고 클릭 가능해질 때까지 자동 대기
await page.getByRole('button', { name: '제출' }).click();
```

이를 통해 **flaky test**(간헐적으로 실패하는 테스트)를 크게 줄일 수 있습니다.

### 3) 병렬 실행

여러 테스트를 동시에 실행하여 시간을 절약합니다.

```bash
# 4개 워커(worker)로 테스트를 동시에 실행
npx playwright test --workers=4
```

### 4) 네트워크 가로채기 (Network Interception)

실제 API를 호출하지 않고 **모의 응답**을 반환할 수 있습니다. `route.fulfill()`의 `json` 옵션을 사용하면 `Content-Type` 헤더가 자동으로 `application/json`으로 설정됩니다.

```typescript
// API 응답 모킹
await page.route('**/api/user', async route => {
  // json 옵션 사용 시 Content-Type이 자동으로 application/json으로 설정됨
  await route.fulfill({
    status: 200,
    json: { name: 'Test User', email: 'test@test.com' },
  });
});
```

이를 통해:
- 외부 API에 의존하지 않고 테스트 가능
- 에러 상황(500, 404 등)을 쉽게 재현
- 실제 API 응답을 수정하여 테스트 (응답 가로채기 후 변경)

### 5) 모바일 에뮬레이션

iPhone, Android 등 다양한 디바이스를 시뮬레이션할 수 있습니다. `devices` 객체에 사전 정의된 디바이스 설정을 스프레드 연산자로 적용합니다.

```typescript
import { devices } from '@playwright/test';

const iPhone = devices['iPhone 13'];

const context = await browser.newContext({
  ...iPhone,
  locale: 'ko-KR',
  geolocation: { latitude: 37.5665, longitude: 126.9780 },
});
```

`playwright.config.ts`에서 프로젝트 단위로 디바이스를 설정할 수도 있습니다.

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 13'] },
    },
  ],
});
```

# 3. Playwright 기본 사용법

---

## 설치 및 초기 설정

```bash
# 프로젝트 초기화 (대화형 설정)
npm init playwright@latest

# 설치 중 질문 예시:
# - 테스트 폴더: tests/
# - GitHub Actions CI 추가: Yes
# - 브라우저 설치: Yes
```

설치 후 생성되는 프로젝트 구조:

```
my-project/
├── tests/
│   └── example.spec.ts       # 예제 테스트 파일
├── tests-examples/
│   └── demo-todo-app.spec.ts  # TodoMVC 데모 테스트
├── playwright.config.ts        # Playwright 설정 파일
├── package.json
└── package-lock.json
```

## 첫 번째 테스트 작성

> **참고**: Playwright는 `page.fill()`, `page.click()` 같은 Page 수준 단축 메서드를 제공하지만, 공식 문서에서는 이들의 사용을 **자제(discouraged)**하도록 권장합니다. 대신 **Locator 기반 메서드**(`locator.fill()`, `locator.click()`)를 사용하는 것이 모범 사례입니다. Locator는 항상 최신 DOM 상태를 반영하며, 자동 대기(auto-wait)와 재시도(retry) 기능이 내장되어 있습니다.

```typescript
// tests/login.spec.ts
import { test, expect } from '@playwright/test';

test('사용자 로그인 테스트', async ({ page }) => {
  // 1. 로그인 페이지로 이동
  await page.goto('https://example.com/login');

  // 2. 이메일/비밀번호 입력 (Locator 기반 - 권장 방식)
  await page.getByLabel('이메일').fill('test@test.com');
  await page.getByLabel('비밀번호').fill('password123');

  // 3. 로그인 버튼 클릭
  await page.getByRole('button', { name: '로그인' }).click();

  // 4. 대시보드로 이동했는지 확인
  await expect(page).toHaveURL('https://example.com/dashboard');

  // 5. 사용자 이름이 표시되는지 확인
  await expect(page.getByText('Test User')).toBeVisible();
});
```

## 핵심 API

### Locator API (권장)

`Locator`는 페이지의 특정 요소를 찾고 상호작용하는 핵심 객체입니다. Locator는 매번 액션 수행 시 DOM에서 요소를 새로 찾기 때문에, 동적으로 변하는 페이지에서도 안정적으로 동작합니다.

```typescript
// 역할(Role)로 찾기 - 접근성 기반, 가장 권장되는 방법
const submitButton = page.getByRole('button', { name: '제출' });
const heading = page.getByRole('heading', { name: '환영합니다' });

// 레이블로 찾기 - 폼 요소에 적합
const emailInput = page.getByLabel('이메일');

// 플레이스홀더로 찾기
const searchInput = page.getByPlaceholder('검색어를 입력하세요');

// 텍스트로 찾기
const link = page.getByText('로그인');

// 테스트 ID로 찾기 - 위 방법들이 불가능할 때 대안
const card = page.getByTestId('product-card');

// CSS 선택자 (다른 방법이 불가능할 때 사용)
const element = page.locator('.custom-class');
```

Locator 우선순위 가이드:

| 우선순위 | 메서드 | 사용 시점 |
|---------|--------|----------|
| 1순위 | `getByRole()` | 버튼, 링크, 입력 필드 등 대부분의 요소 |
| 2순위 | `getByLabel()` | 폼 입력 필드 |
| 3순위 | `getByPlaceholder()` | 레이블이 없는 입력 필드 |
| 4순위 | `getByText()` | 비-인터랙티브 텍스트 요소 |
| 5순위 | `getByTestId()` | 위 방법으로 찾을 수 없을 때 |
| 6순위 | `locator()` | CSS/XPath가 유일한 방법일 때 |

### Page API

`page`는 하나의 브라우저 탭을 나타냅니다. 페이지 수준의 동작(이동, 스크린샷 등)에 사용합니다.

| 메서드 | 설명 | 예시 |
|--------|------|------|
| `goto(url)` | URL로 이동 | `await page.goto('https://example.com')` |
| `screenshot(options)` | 스크린샷 저장 | `await page.screenshot({ path: 'result.png' })` |
| `route(url, handler)` | 네트워크 요청 가로채기 | `await page.route('**/api/**', handler)` |
| `waitForURL(url)` | URL 변경 대기 | `await page.waitForURL('**/dashboard')` |

> **참고**: `page.click()`, `page.fill()` 등의 메서드도 존재하지만, 공식 문서에서는 Locator 기반 메서드 사용을 권장합니다.

### Assertions (검증)

Playwright의 Assertion은 **Web-First** 방식으로, 조건이 만족될 때까지 자동으로 재시도합니다. 기본 타임아웃은 5초입니다.

```typescript
// Page 단위 검증
await expect(page).toHaveURL('https://example.com/home');
await expect(page).toHaveTitle('대시보드');

// 요소 가시성 확인
await expect(page.getByText('성공')).toBeVisible();

// 텍스트 내용 확인
await expect(page.getByRole('heading')).toHaveText('대시보드');

// 텍스트 포함 확인 (부분 일치)
await expect(page.getByRole('heading')).toContainText('대시');

// 요소 개수 확인 (정확한 숫자만 가능)
await expect(page.getByTestId('product-item')).toHaveCount(10);

// 요소 속성 확인
await expect(page.getByRole('button')).toBeEnabled();
await expect(page.getByRole('checkbox')).toBeChecked();
```

# 4. 실전 예제: 검색 기능 테스트

---

실제 웹사이트에서 검색 기능을 테스트하는 시나리오입니다.

```typescript
// tests/search.spec.ts
import { test, expect } from '@playwright/test';

test.describe('검색 기능', () => {
  test.beforeEach(async ({ page }) => {
    // 각 테스트 전에 홈페이지로 이동
    await page.goto('https://example.com');
  });

  test('검색어 입력 후 결과 표시', async ({ page }) => {
    // 검색 입력란에 키워드 입력
    const searchInput = page.getByPlaceholder('검색어를 입력하세요');
    await searchInput.fill('JavaScript');

    // Enter 키 입력
    await searchInput.press('Enter');

    // 검색 결과 페이지로 이동 확인
    await expect(page).toHaveURL(/search\?q=JavaScript/);

    // 검색 결과가 최소 1개 이상인지 확인
    // toHaveCount()는 정확한 숫자만 지원하므로, 개수가 0보다 큰지 직접 확인
    const results = page.locator('.search-result');
    await expect(results.first()).toBeVisible();

    // 첫 번째 결과에 "JavaScript" 텍스트 포함 확인
    await expect(results.first()).toContainText('JavaScript');
  });

  test('검색 결과 없을 때 메시지 표시', async ({ page }) => {
    // 존재하지 않는 검색어 입력
    const searchInput = page.getByPlaceholder('검색어를 입력하세요');
    await searchInput.fill('asdfqwerzxcv12345');
    await searchInput.press('Enter');

    // "결과 없음" 메시지 확인
    await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
  });

  test('검색 자동완성', async ({ page }) => {
    const searchInput = page.getByPlaceholder('검색어를 입력하세요');

    // 검색어 일부 입력
    await searchInput.fill('Java');

    // 자동완성 목록이 나타날 때까지 대기
    const suggestions = page.locator('.autocomplete-item');
    await expect(suggestions.first()).toBeVisible();

    // 첫 번째 자동완성 항목 클릭
    await suggestions.first().click();

    // 검색 결과 페이지로 이동
    await expect(page).toHaveURL(/search/);
  });
});
```

## 테스트 실행

```bash
# 모든 테스트 실행
npx playwright test

# 특정 파일만 실행
npx playwright test search.spec.ts

# 헤드 모드 (브라우저 화면을 보면서 실행)
npx playwright test --headed

# 특정 브라우저(프로젝트)만 실행
npx playwright test --project=chromium

# UI 모드 (테스트를 시각적으로 탐색하며 실행)
npx playwright test --ui

# 디버그 모드 (Playwright Inspector 연동)
npx playwright test --debug
```

실행 결과 확인:

```bash
# HTML 리포트 열기 (테스트 완료 후)
npx playwright show-report
```

# 5. 주요 기능 심화

---

## 1) Page Object Model (POM)

반복적인 UI 조작을 클래스로 캡슐화하여 재사용성과 유지보수성을 높이는 패턴입니다. 페이지의 요소와 동작을 한 곳에 모아두면, UI가 변경될 때 해당 클래스만 수정하면 됩니다.

```typescript
// pages/LoginPage.ts
import type { Page, Locator } from '@playwright/test';

export class LoginPage {
  // 페이지 요소를 Locator로 선언
  private readonly emailInput: Locator;
  private readonly passwordInput: Locator;
  private readonly submitButton: Locator;
  private readonly errorMessage: Locator;

  constructor(public readonly page: Page) {
    this.emailInput = page.getByLabel('이메일');
    this.passwordInput = page.getByLabel('비밀번호');
    this.submitButton = page.getByRole('button', { name: '로그인' });
    this.errorMessage = page.locator('.error-message');
  }

  async goto() {
    await this.page.goto('https://example.com/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async getErrorMessage() {
    return await this.errorMessage.textContent();
  }
}
```

```typescript
// tests/login.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

test('잘못된 비밀번호로 로그인 시 에러 메시지 표시', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('test@test.com', 'wrongpassword');

  const error = await loginPage.getErrorMessage();
  expect(error).toContain('비밀번호가 일치하지 않습니다');
});

test('올바른 자격 증명으로 로그인 성공', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('test@test.com', 'correctpassword');

  await expect(page).toHaveURL(/dashboard/);
});
```

## 2) API 테스트

Playwright는 브라우저뿐 아니라 **REST API**도 테스트할 수 있습니다. `request` fixture를 사용하면 별도의 HTTP 클라이언트 없이 API를 호출할 수 있습니다.

```typescript
import { test, expect } from '@playwright/test';

test('API 응답 확인', async ({ request }) => {
  // GET 요청
  const response = await request.get('https://api.example.com/users/1');

  expect(response.ok()).toBeTruthy();
  expect(response.status()).toBe(200);

  const data = await response.json();
  expect(data).toHaveProperty('id', 1);
  expect(data.name).toBeTruthy();
});

test('API를 통해 데이터 생성', async ({ request }) => {
  // POST 요청
  const response = await request.post('https://api.example.com/users', {
    data: {
      name: 'New User',
      email: 'new@test.com',
    },
  });

  expect(response.status()).toBe(201);

  const created = await response.json();
  expect(created.name).toBe('New User');
});
```

## 3) 스크린샷 및 비디오 녹화

### 스크린샷

```typescript
test('스크린샷 저장', async ({ page }) => {
  await page.goto('https://example.com');

  // 전체 페이지 스크린샷
  await page.screenshot({ path: 'homepage.png', fullPage: true });

  // 특정 요소만 스크린샷
  await page.locator('.product-card').screenshot({ path: 'product.png' });
});
```

### 비디오 녹화

비디오는 `playwright.config.ts`에서 활성화합니다.

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    // 'on': 모든 테스트 녹화
    // 'retain-on-failure': 실패한 테스트만 녹화 (CI 환경에서 권장)
    // 'on-first-retry': 첫 번째 재시도부터 녹화
    video: 'retain-on-failure',
  },
});
```

# 6. Playwright vs 경쟁 도구 비교

---

| 특징 | Playwright | Cypress | Selenium | Puppeteer |
|------|-----------|---------|----------|-----------|
| **개발사** | Microsoft | Cypress.io | OpenQA | Google |
| **출시** | 2020 | 2017 | 2004 | 2017 |
| **지원 언어** | JS/TS, Python, Java, C# | JavaScript/TypeScript | 다수 (Java, Python, C# 등) | JavaScript/TypeScript |
| **브라우저** | Chromium, Firefox, WebKit | Chromium 중심 (Firefox, WebKit 실험적) | 모든 브라우저 | Chromium 전용 |
| **속도** | 빠름 | 빠름 | 느림 | 빠름 |
| **병렬 실행** | 기본 지원 (무료) | 유료 (Cypress Cloud) | 별도 설정 필요 | 별도 구현 필요 |
| **자동 대기** | 기본 지원 | 기본 지원 | 미지원 | 부분적 |
| **네트워크 가로채기** | 기본 지원 | 기본 지원 | 미지원 | 기본 지원 |
| **다중 탭/창** | 지원 | 미지원 | 지원 | 지원 |
| **모바일 에뮬레이션** | 지원 | 제한적 지원 | 미지원 | 지원 |
| **내장 테스트 러너** | 지원 | 지원 | 미지원 (별도 필요) | 미지원 (별도 필요) |
| **학습 곡선** | 보통 | 쉬움 | 어려움 | 보통 |

## 언제 어떤 도구를 선택할까?

| 상황 | 추천 도구 | 이유 |
|------|----------|------|
| 크로스 브라우저 E2E 테스트 | **Playwright** | Chromium, Firefox, WebKit 모두 안정적으로 지원 |
| 프론트엔드 개발자가 빠르게 시작 | **Cypress** | 직관적인 UI, 쉬운 학습 곡선 |
| 레거시 브라우저 지원 필요 | **Selenium** | 가장 넓은 브라우저 호환성 |
| Chrome 전용 스크래핑/자동화 | **Puppeteer** | 가볍고, Chrome DevTools Protocol 직접 활용 |
| Python/Java에서 E2E 테스트 | **Playwright** | 다중 언어 공식 지원 |

# 7. 주의할 점 (Gotchas)

---

## 1) page.fill(), page.click() 대신 Locator 사용

Playwright 공식 문서에서 `page.fill()`, `page.click()` 등의 Page 수준 메서드는 **discouraged(사용 자제)**로 표기되어 있습니다.

```typescript
// 사용 자제 (discouraged)
await page.fill('#email', 'test@test.com');
await page.click('button[type="submit"]');

// 권장 방식 (Locator 기반)
await page.getByLabel('이메일').fill('test@test.com');
await page.getByRole('button', { name: '로그인' }).click();
```

Locator를 사용하면 매번 액션 수행 시 DOM에서 요소를 새로 찾기 때문에 동적 페이지에서 안정적이며, 더 읽기 쉬운 테스트 코드를 작성할 수 있습니다.

## 2) Flaky 테스트 방지

간헐적으로 실패하는 테스트는 대부분 **타이밍 문제**입니다.

```typescript
// 잘못된 예: 하드코딩된 대기 시간
await page.getByRole('button', { name: '제출' }).click();
await new Promise(resolve => setTimeout(resolve, 2000)); // 임의의 2초 대기
const result = page.locator('.result');
// result가 아직 나타나지 않았을 수 있음

// 올바른 예: Playwright의 자동 대기 활용
await page.getByRole('button', { name: '제출' }).click();
await expect(page.locator('.result')).toBeVisible(); // 조건 만족 시까지 자동 재시도
```

`setTimeout`이나 `page.waitForTimeout()` 같은 하드코딩된 대기는 피하고, Playwright의 **Web-First Assertions** (`expect(locator).toBeVisible()` 등)을 활용하면 안정적인 테스트를 작성할 수 있습니다.

## 3) 테스트 격리

각 테스트는 독립적으로 실행되어야 합니다. Playwright는 기본적으로 **각 테스트마다 새로운 브라우저 컨텍스트(BrowserContext)**를 생성하므로 쿠키, 로컬 스토리지 등이 자동으로 격리됩니다.

만약 `test.describe` 내에서 상태가 공유되는 문제가 발생한다면, `beforeEach`에서 명시적으로 초기화할 수 있습니다.

```typescript
test.beforeEach(async ({ page }) => {
  // 필요한 경우 쿠키 초기화
  await page.context().clearCookies();
  await page.goto('https://example.com');
});
```

## 4) toHaveCount()는 정확한 숫자만 지원

`toHaveCount()`에는 정확한 숫자를 전달해야 합니다. "최소 N개 이상"을 확인하려면 다른 방법을 사용합니다.

```typescript
// 정확히 5개인지 확인
await expect(page.locator('.item')).toHaveCount(5);

// 최소 1개 이상인지 확인하려면: 첫 번째 요소가 보이는지 확인
await expect(page.locator('.item').first()).toBeVisible();

// 또는 count()로 직접 비교
const count = await page.locator('.item').count();
expect(count).toBeGreaterThan(0);
```

## 5) CI/CD에서 브라우저 미설치

GitHub Actions 등에서 브라우저가 설치되지 않으면 테스트가 실패합니다. `--with-deps` 플래그는 브라우저 실행에 필요한 OS 수준 의존성(라이브러리)도 함께 설치합니다.

```yaml
# .github/workflows/playwright.yml
name: Playwright Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright Browsers
        run: npx playwright install --with-deps
      - name: Run Playwright tests
        run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

# 8. 핵심 요약

---

**Playwright = 코드로 브라우저를 조종하는 E2E 테스트 프레임워크**

| 핵심 기능 | 설명 |
|-----------|------|
| **E2E 테스트** | 실제 사용자 시나리오를 자동으로 검증 |
| **크로스 브라우저** | Chromium, Firefox, WebKit 모두 지원 |
| **자동 대기 (Auto-wait)** | 요소가 준비될 때까지 자동으로 기다려 flaky test 방지 |
| **네트워크 모킹** | API 응답을 가로채서 다양한 상황 재현 |
| **모바일 에뮬레이션** | iPhone, Android 등 디바이스 시뮬레이션 |
| **병렬 실행** | 여러 워커로 동시 테스트 실행 (무료) |

## 기본 워크플로우 (Locator 기반)

```typescript
// 1. 페이지 이동
await page.goto('https://example.com');

// 2. 입력 (Locator 기반 - 권장)
await page.getByLabel('이메일').fill('test@test.com');

// 3. 클릭 (Locator 기반 - 권장)
await page.getByRole('button', { name: '로그인' }).click();

// 4. 검증 (Web-First Assertions)
await expect(page.getByText('환영합니다')).toBeVisible();
```

## 경쟁 도구 대비 장점

- Selenium보다 **빠르고** 자동 대기가 내장되어 있음
- Cypress보다 **다양한 브라우저** 지원 및 다중 탭/창 처리 가능
- Puppeteer보다 **테스트 기능이 풍부**하고 다중 언어 지원

# Reference

---

- [Playwright 공식 문서](https://playwright.dev/)
- [Playwright API Reference](https://playwright.dev/docs/api/class-playwright)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright Locators 가이드](https://playwright.dev/docs/locators)
- [Playwright Assertions 가이드](https://playwright.dev/docs/test-assertions)
- [Playwright vs Cypress 비교](https://playwright.dev/docs/why-playwright)
