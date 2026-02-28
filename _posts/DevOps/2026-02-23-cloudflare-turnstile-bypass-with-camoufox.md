---
layout: post
title: "[DevOps] Cloudflare Turnstile 봇 감지 우회 — Camoufox로 자동 로그인 구현하기"
categories:
  - DevOps
tags:
  - [Cloudflare, Turnstile, Camoufox, Playwright, 웹 자동화, 봇 감지 우회, Firefox]
---

# Introduction

---

사내 대시보드 스크린샷을 매일 자동으로 캡처해 Slack에 전송하는 스크립트를 운영하고 있었다. 그런데 어느 날부터 로그인이 막혔다. Cloudflare Turnstile이 도입되어 Playwright의 Chromium이 봇으로 탐지되기 시작했기 때문이다.

이 글에서는 다음 내용을 다룬다:

- Chromium 기반 자동화 도구가 Turnstile **임베디드 위젯**을 왜 통과하지 못하는지
- Firefox 기반 안티디텍트 브라우저 **Camoufox**로 어떻게 해결했는지
- 쿠키 만료 시 자동 재로그인하는 다단계 fallback 플로우 설계

글을 끝까지 따라가면 Cloudflare Turnstile이 적용된 사이트에 대해 자동화 스크립트에서 로그인을 유지하는 방법을 이해할 수 있다.

## 선행 지식

이 글의 코드를 이해하려면 다음 배경지식이 필요하다:

- Python 3.10 이상 기본 문법 (dataclass, context manager, type hint)
- [Playwright Python](https://playwright.dev/python/) 기초 사용법 (브라우저 실행, 페이지 이동, 셀렉터)
- Cloudflare의 봇 감지가 무엇인지 개념적 이해

# 배경 (Problem & Context)

---

## Cloudflare Turnstile이란

[Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)은 전통적인 CAPTCHA를 대체하는 봇 감지 솔루션이다. 사이트 운영자가 로그인 폼 등에 삽입하면, 사용자는 복잡한 이미지 퍼즐 없이 **체크박스 클릭** 한 번으로 인증을 통과한다.

공식 문서에 따르면 Turnstile 위젯은 세 가지 모드를 제공한다:

| 모드 | 동작 방식 |
|------|-----------|
| **Managed** (권장) | 클라이언트 신호와 리스크 평가에 따라 자동으로 인터랙티브 체크박스를 표시하거나 자동 통과 |
| **Non-Interactive** | 사용자 상호작용 없이 백그라운드에서 챌린지 실행 (로딩 스피너 표시) |
| **Invisible** | 사용자에게 완전히 보이지 않게 챌린지 실행 |

여기서 중요한 구분이 있다. Turnstile **위젯**은 사이트 운영자가 직접 폼에 삽입하는 컴포넌트이고, Cloudflare **Challenge Platform**의 인터스티셜 페이지("Verifying you are human" 전체 화면)와는 별개의 메커니즘이다. 이 글에서 다루는 문제는 **로그인 폼에 임베디드된 Turnstile 위젯**이다.

## Playwright + Chromium이 Turnstile을 통과 못 하는 이유

Turnstile의 Managed 모드에서 체크박스를 클릭하면, 내부적으로 마우스 좌표, 클릭 패턴, 브라우저 환경 등 수십 가지 신호를 검사한다.

여기서 **Chromium 전용 버그**가 문제다. CDP(Chrome DevTools Protocol)로 제어되는 Chromium은 iframe 내부 클릭 좌표를 iframe 기준이 아닌 **페이지 전체 기준**으로 전달한다. Turnstile은 이 좌표 불일치를 감지하여 봇으로 판단한다.

흔히 시도하는 우회 방법들도 효과가 없다:

- `channel="chrome"` (실제 Chrome 바이너리 사용)
- `navigator.webdriver`를 `undefined`로 마스킹
- `--disable-blink-features=AutomationControlled` 플래그

이 방법들은 Cloudflare의 **인터스티셜 챌린지 페이지**(전체 화면 "Verifying you are human")는 통과할 수 있다. 하지만 로그인 폼에 **내장된 Turnstile 위젯**은 별개의 문제다. CDP 좌표 누출은 Chromium 엔진 자체의 동작 방식이므로 스크립트 수준에서 패치할 수 없다.

## 기존 플로우의 한계

기존 스크립트는 Chrome 브라우저의 로그인 쿠키를 `browser_cookie3`로 추출하는 방식으로 동작했다. 로컬 Chrome에 로그인만 해두면 쿠키를 가져와 Playwright에 주입하는 구조다. 하지만 두 가지 문제가 있었다:

1. **쿠키 만료 시 수동 개입 필요**: 쿠키가 만료되면 브라우저에서 직접 로그인해야 했다.
2. **서버 배포 불가**: 서버 환경에서는 로컬 Chrome이 없으므로 자동화가 불가능했다.

# 접근 방법 (Approach)

---

## Camoufox: Firefox 기반 안티디텍트 브라우저

[Camoufox](https://github.com/daijro/camoufox)는 Playwright를 백엔드로 사용하지만 **Firefox** 엔진으로 동작하는 안티디텍트 브라우저다. Firefox는 CDP 대신 자체 원격 제어 프로토콜을 사용하므로 Chromium의 iframe 좌표 누출 버그가 존재하지 않는다. 따라서 Turnstile의 체크박스 클릭이 정상적으로 동작한다.

Camoufox의 Python sync API는 context manager 패턴을 제공한다:

```python
from camoufox.sync_api import Camoufox

with Camoufox(headless=False, humanize=True) as browser:
    page = browser.new_page()
    page.goto("https://example.com")
```

이 프로젝트에서 사용하는 핵심 설정 세 가지:

| 설정 | 이유 |
|------|------|
| `humanize=True` | 커서 이동 경로를 인간처럼 곡선으로 처리. Camoufox가 제공하는 built-in 기능이다. |
| `i_know_what_im_doing=True` | 기본 보호 설정을 우회할 때 필요한 확인 플래그. `block_webgl=True`처럼 탐지 위험이 있는 옵션과 함께 사용한다. <!-- TODO: verify - disable_coop 옵션은 Context7 공식 문서에서 확인되지 않음. Camoufox 소스코드 또는 이슈에서 확인 필요 --> |
| `extra_http_headers={"accept-encoding": "gzip, deflate"}` | macOS zstd 렌더링 버그 우회. `browser.new_page()` 호출 시 Playwright 옵션으로 전달한다. ([Camoufox #473](https://github.com/daijro/camoufox/issues/473)) |

> **참고**: 초안에서 사용했던 `disable_coop=True` 옵션(Cross-Origin-Opener-Policy 비활성화)은 Camoufox 공식 문서에서 명시적으로 문서화되어 있지 않다. 실제 사용 시 Camoufox 소스코드나 이슈 트래커에서 해당 옵션의 지원 여부를 확인할 것을 권장한다.

## 다단계 Fallback 로그인 플로우

쿠키 만료 시나리오를 대비해 두 단계의 fallback을 설계했다:

```
login_and_save_cookies()
  |-- 1단계: Chrome 쿠키 추출 (browser_cookie3)
  |         +-- 성공 -> Playwright 프로필에 주입 -> 완료
  |         +-- 만료/실패 ->
  |-- 2단계: Camoufox로 자동 로그인
  |         +-- 성공 -> 쿠키 추출 -> Playwright 프로필에 주입 -> 완료
  |         +-- 실패 ->
  +-- Slack 알림 전송 + RuntimeError
```

이 설계의 핵심은 **기존 방식을 1순위로 유지**한다는 점이다. Chrome 쿠키가 유효하면 Camoufox를 실행할 필요가 없으므로 실행 시간과 리소스를 절약한다. Camoufox는 쿠키 만료 시에만 동작하는 fallback이다.

# 구현 (Key Code & Commands)

---

## 1. Camoufox 로그인 함수

전체 로그인 함수의 핵심 구조를 먼저 살펴보자.

```python
# screenshot_and_notify.py

def _login_with_camoufox(config: Config) -> list[dict] | None:
    """Camoufox로 자동 로그인 후 쿠키를 반환한다."""
    from camoufox.sync_api import Camoufox

    with Camoufox(
        headless=config.headless,
        humanize=True,           # 커서 이동을 인간처럼 곡선으로 처리
        i_know_what_im_doing=True,
    ) as browser:
        # macOS zstd 렌더링 버그 우회 (camoufox#473)
        # extra_http_headers는 Playwright의 new_page() 옵션
        page = browser.new_page(
            extra_http_headers={"accept-encoding": "gzip, deflate"}
        )

        # 홈페이지 먼저 방문 (Cloudflare 쿠키 워밍업)
        page.goto("https://example-dashboard.com", wait_until="domcontentloaded")
        page.wait_for_timeout(3000)
        _wait_for_cloudflare(page, config.turnstile_wait_ms)

        # 이메일/비밀번호 입력 (사람처럼 타이핑)
        email_input = page.locator('input[type="email"]').first
        email_input.click()
        email_input.press_sequentially(config.email, delay=80)  # 80ms 딜레이로 타이핑
        ...
```

홈페이지를 먼저 방문하는 이유는 Cloudflare가 신뢰 쿠키(`cf_clearance`)를 발급하는 시간을 확보하기 위해서다. 바로 로그인 페이지로 접근하면 챌린지가 더 까다롭게 동작할 수 있다.

> **API 참고**: Playwright Python 최신 API에서 `locator.type()`은 deprecated이다. 문자를 한 글자씩 입력하려면 `locator.press_sequentially(text, delay=ms)` 를 사용한다. 단순히 값을 설정만 하면 되는 경우에는 `locator.fill()`이 더 적합하다. 여기서는 봇 감지를 우회하기 위해 실제 키보드 입력을 시뮬레이션해야 하므로 `press_sequentially`를 사용했다.

## 2. Turnstile 체크박스 클릭

Turnstile iframe이 로드될 때까지 폴링한 뒤, iframe의 화면 좌표를 계산해 클릭한다.

```python
# screenshot_and_notify.py

turnstile_clicked = False
for attempt in range(10):
    for frame in page.frames:
        if "challenges.cloudflare.com" in frame.url:
            try:
                # frame.frame_element()로 iframe의 DOM 엘리먼트를 가져온다
                frame_element = frame.frame_element()
                box = frame_element.bounding_box()
                if box:
                    # 체크박스는 iframe 좌측에 위치
                    click_x = box["x"] + box["width"] / 9
                    click_y = box["y"] + box["height"] / 2
                    page.mouse.click(x=click_x, y=click_y)
                    turnstile_clicked = True
                    break
            except Exception:
                pass  # iframe이 아직 준비되지 않은 경우 다음 시도
    if turnstile_clicked:
        break
    page.wait_for_timeout(1000)  # 1초 대기 후 재시도
```

왜 `frame.locator("input").click()` 대신 `page.mouse.click()`을 사용하는가? Turnstile iframe은 cross-origin이라 내부 DOM에 직접 접근할 수 없다. `page.mouse.click(x, y)`은 화면 좌표 기반으로 클릭하므로 cross-origin 제약을 우회한다. Playwright 공식 API에서 `mouse.click(x, y)`는 mousedown과 mouseup 이벤트를 순차적으로 발생시키는 단순한 좌표 클릭이다.

## 3. Cloudflare 인터스티셜 챌린지 대기

로그인 페이지 접속 시 전체 화면 챌린지("Verifying you are human")가 뜰 수 있다. 이것은 Turnstile 위젯과 다른 Cloudflare Challenge Platform의 인터스티셜 페이지다. 텍스트 감지 + `wait_for_function`으로 통과를 대기한다.

```python
# screenshot_and_notify.py

def _wait_for_cloudflare(page, timeout_ms: int = 15000) -> bool:
    """Cloudflare 인터스티셜 챌린지 페이지가 있으면 통과를 대기한다."""
    is_challenge = (
        page.locator("text=보안 확인 수행 중").count() > 0
        or page.locator("text=Verifying you are human").count() > 0
        or page.locator("#challenge-running").count() > 0
    )
    if not is_challenge:
        return True  # 챌린지가 없으면 즉시 통과

    # 챌린지 텍스트가 사라질 때까지 대기
    page.wait_for_function(
        """() => {
            const body = document.body ? document.body.innerText : '';
            return !body.includes('보안 확인 수행 중')
                && !body.includes('Verifying you are human');
        }""",
        timeout=timeout_ms,
    )
    page.wait_for_timeout(3000)  # 리다이렉트 후 안정화 대기
    return True
```

`page.wait_for_function(expression, timeout=ms)`은 Playwright에서 브라우저 컨텍스트 내의 JavaScript 표현식이 truthy 값을 반환할 때까지 폴링하는 메서드다. 기본 폴링 방식은 `requestAnimationFrame` 주기이며, timeout 기본값은 30초다.

## 4. 로그인 버튼 클릭 (JS 직접 클릭 fallback)

Cookie Consent 배너를 닫아도 로그인 버튼이 Playwright 기준으로 "hidden" 상태로 판단되는 경우가 있다. `page.evaluate()`로 JavaScript 직접 클릭을 fallback으로 추가했다.

```python
# screenshot_and_notify.py

try:
    submit_btn.wait_for(state="visible", timeout=10000)
    submit_btn.click()
except Exception:
    # Playwright가 hidden으로 판단할 경우 JS로 직접 클릭
    clicked = page.evaluate("""() => {
        const btn = document.querySelector('button.btn-sign-in');
        if (btn) { btn.click(); return true; }
        // fallback: 텍스트로 버튼 탐색
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
            if (b.textContent.includes('Log in') ||
                b.textContent.includes('로그인')) {
                b.click();
                return true;
            }
        }
        return false;
    }""")
```

`page.evaluate(expression)`은 브라우저 컨텍스트에서 JavaScript를 실행하고 결과값을 Python으로 반환한다. Playwright의 actionability 체크(visible, enabled, stable 등)를 우회해야 할 때 유용하다. 다만 이 방식은 Playwright의 자동 대기, 재시도 메커니즘을 건너뛰므로 **fallback 용도로만** 사용해야 한다.

## 5. 세션 만료 시 자동 재로그인

`take_screenshot()` 내부에서 로그인 상태를 확인하고, 만료되면 `login_and_save_cookies()`를 호출한 뒤 재귀로 다시 캡처를 시도한다.

```python
# screenshot_and_notify.py

if not _is_logged_in(page):
    print("  세션 만료 감지, 자동 재로그인 시도...")
    context.close()
    login_and_save_cookies(config)
    return take_screenshot(config, dashboard)  # 재귀 호출 (1회만)
```

재귀 깊이를 제한하지 않으면 무한 루프에 빠질 수 있으므로, 실제 구현에서는 `retry_count` 파라미터를 추가해 1회만 재시도하도록 제한하는 것을 권장한다.

## 6. 의존성 추가

```toml
# pyproject.toml
dependencies = [
    "camoufox[geoip]>=0.4.11",
    # ...
]
```

`[geoip]` 옵션을 붙이면 Camoufox가 IP에 맞는 지역 정보(언어, 타임존)를 자동 설정한다. 봇 감지 신호 중 하나인 "IP와 브라우저 지역 불일치"를 방지하는 역할을 한다.

설치 후 Camoufox 브라우저 바이너리도 별도로 다운로드해야 한다:

```bash
# 의존성 설치
uv sync

# Camoufox가 사용하는 Firefox 바이너리는 최초 실행 시 자동 다운로드됨
# 또는 명시적으로: python -m camoufox fetch
```

# 주의할 점 (Gotchas)

---

## 1. macOS에서 페이지가 깨져 보임 (zstd 렌더링 버그)

**증상**: 스크린샷이 노이즈 픽셀로 가득 찬 깨진 이미지로 저장된다.

**원인**: Firefox 146에서 `Accept-Encoding`에 `zstd`가 추가되었는데, Camoufox의 `Accept-Encoding` 스푸핑 로직이 HTTPS용(`mHttpsAcceptEncodings`)만 설정하고 HTTP용(`mHttpAcceptEncodings`)은 미초기화 상태로 남긴다. 서버가 zstd로 응답하면 브라우저가 제대로 디코딩하지 못한다.

**해결**: `browser.new_page()` 호출 시 `extra_http_headers={"accept-encoding": "gzip, deflate"}`로 zstd를 명시적으로 제외한다.

```python
# zstd 우회 적용
page = browser.new_page(
    extra_http_headers={"accept-encoding": "gzip, deflate"}
)
```

## 2. headless 모드에서는 Turnstile 통과 불가

Cloudflare는 headless 브라우저를 별도로 탐지한다. **headed 모드**(`headless=False`)가 필수다.

이 스크립트는 서버가 아닌 데스크탑 환경에서 cron으로 실행하는 구조이므로 headed 모드가 가능하다. 서버 환경이라면 Xvfb와 같은 가상 디스플레이가 필요하다:

```bash
# 서버 환경에서 headed 모드를 사용하려면
apt-get install xvfb
xvfb-run python screenshot_and_notify.py
```

## 3. Cookie Consent 배너가 로그인 버튼을 가림

일부 접속 상황에서 Cookie Consent 배너가 로그인 버튼 위에 렌더링되어 Playwright가 버튼을 `hidden`으로 판단한다. `_login_with_camoufox()` 내부에서 먼저 배너를 닫는 로직을 넣었지만, 그래도 실패하는 경우를 대비해 JavaScript 직접 클릭을 fallback으로 추가했다 (위 "로그인 버튼 클릭" 섹션 참고).

## 4. Turnstile 체크박스 클릭 타이밍

iframe이 DOM에 삽입되었더라도 실제로 상호작용 가능한 상태가 되기까지 시간이 걸린다. 10회 폴링(1초 간격)으로 iframe을 기다린 뒤 클릭하고, 클릭 후에도 "Success!" 텍스트가 나타날 때까지 추가로 대기한다. 네트워크 환경이 느리다면 폴링 횟수와 간격을 늘려야 할 수 있다.

## 5. Camoufox `i_know_what_im_doing` 플래그

이 플래그는 커스텀 핑거프린트 주입이나 WebGL 비활성화 등 **탐지 위험이 있는 설정**을 사용할 때 필수다. 이 플래그 없이 위험 설정을 사용하면 Camoufox가 경고와 함께 실행을 중단한다. 자신이 무엇을 하는지 정확히 알고 있을 때만 설정할 것.

# 요약 (Key Takeaways)

---

| 항목 | 내용 |
|------|------|
| **핵심 문제** | Chromium의 CDP가 iframe 클릭 좌표를 잘못 전달하여 Turnstile 위젯이 봇으로 탐지 |
| **해결책** | Camoufox (Firefox 기반) 사용 -- CDP 좌표 누출 버그 없음 |
| **핵심 설정** | `humanize=True`, `extra_http_headers`로 zstd 제외, headed 모드 필수 |
| **아키텍처** | Chrome 쿠키 우선 사용 -> 실패 시 Camoufox fallback -> 실패 시 Slack 알림 |
| **주의점** | headless 불가, macOS zstd 버그, iframe 클릭 타이밍 폴링 필요 |

# 다음 단계 (Next Steps)

---

- **세션 유효성 사전 체크**: 스크린샷 캡처 전 쿠키 만료 여부를 먼저 확인해 불필요한 Playwright 실행을 줄인다.
- **Camoufox headless 지원**: Camoufox 업스트림이 headless Turnstile 우회를 지원하게 되면 서버 배포로 전환 가능하다.
- **쿠키 만료 시간 추적**: `token` 쿠키의 `expires` 필드를 읽어 만료 예정일을 미리 Slack으로 알림.
- **재귀 호출 제한**: `take_screenshot()`의 재로그인 재귀 호출에 `max_retries` 파라미터를 추가해 무한 루프를 방지.

# Reference

---

- `screenshot_and_notify.py` -- 메인 스크립트 (`_login_with_camoufox`, `_wait_for_cloudflare`, `login_and_save_cookies`)
- `test_screenshot_and_notify.py` -- 단위 테스트 35개
- `pyproject.toml` -- `camoufox[geoip]` 의존성
- [Camoufox GitHub](https://github.com/daijro/camoufox) -- Firefox 기반 안티디텍트 브라우저
- [Camoufox Issue #473](https://github.com/daijro/camoufox/issues/473) -- macOS zstd 렌더링 버그
- [Cloudflare Turnstile 공식 문서](https://developers.cloudflare.com/turnstile/) -- 위젯 모드 및 동작 원리
- [Playwright Python API](https://playwright.dev/python/docs/api/class-page) -- `page.evaluate`, `page.mouse.click`, `wait_for_function`
