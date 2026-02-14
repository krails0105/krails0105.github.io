---
title: "[ClaudeCode] Claude Code 필수 60가지 팁 - CLI부터 실전 워크플로우까지"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, CLI, Tips, CLAUDE.md, IDE, MCP, Workflow, SlashCommands]
---

# Introduction

---

Claude Code는 기능이 방대해서, 처음 사용할 때는 어디서부터 시작해야 할지 막막할 수 있습니다. 반대로 이미 익숙한 사용자도 모르고 지나친 유용한 기능들이 많습니다.

이 글은 Claude Code의 **필수 팁 60가지**를 다섯 가지 섹션으로 나누어 정리합니다. CLI 기본 명령어부터 IDE 연동, 그리고 Anthropic이 직접 권장하는 실전 워크플로우까지 포함하고 있어, 초보자와 숙련자 모두에게 유용합니다.

```text
구성:
  1. CLI 기본기 - 설치, 실행, 세션 관리
  2. 인터랙티브 모드 슬래시 커맨드 - 대화창에서 쓰는 명령어
  3. CLAUDE.md 마스터 클래스 - 프로젝트 컨텍스트 관리
  4. IDE 연동하기 - VS Code, JetBrains 플러그인 활용
  5. Anthropic이 알려주는 실전 꿀팁 - 생산성을 높이는 워크플로우
```

# 1. CLI 기본기

---

터미널에서 Claude Code를 실행하고, 세션을 관리하고, 다양한 모드를 활용하는 방법입니다.

## 1-1. 설치

```bash
npm install -g @anthropic-ai/claude-code
```

npm으로 전역 설치합니다. Node.js 18 이상이 필요합니다.

## 1-2. 시작

```bash
claude
```

프로젝트 디렉토리에서 `claude` 명령어를 입력하면 인터랙티브 대화창이 열립니다.

## 1-3. 프롬프트와 함께 실행

```bash
claude "이 프로젝트의 구조를 분석해줘"
```

`claude` 명령어 뒤에 프롬프트를 바로 입력하면, 프로젝트를 분석하면서 동시에 대화를 시작합니다. 매번 대화창을 열고 입력할 필요가 없습니다.

## 1-4. 데이터 파이핑

```bash
cat error.log | claude -p "이 에러 로그를 분석해줘"
git diff | claude -p "이 변경사항을 리뷰해줘"
```

파이프(`|`)를 통해 외부 데이터를 Claude Code에 주입할 수 있습니다. 로그 분석, diff 리뷰 등에서 Claude가 정확한 데이터를 기반으로 작업할 수 있어 유용합니다. Headless 모드(`-p`)와 함께 사용하면 자동화 스크립트에서도 활용 가능합니다.

## 1-5. 최근 세션 이어가기

```bash
claude -c
# 또는
claude --continue
```

현재 디렉토리에서 **가장 최근에 실행했던 세션**을 이어서 작업합니다. 터미널을 닫았다가 다시 열어도, 이전 대화 맥락이 유지됩니다.

## 1-6. 특정 세션 선택

```bash
claude -r
# 또는
claude --resume
```

여러 세션 목록이 표시되며, 원하는 세션을 선택하여 재개할 수 있습니다. `--continue`가 "가장 최근 세션"이라면, `--resume`은 "원하는 세션을 골라서 재개"하는 것입니다.

## 1-7. Claude 업데이트

```bash
claude update
```

Claude Code를 최신 버전으로 자동 업데이트합니다.

## 1-8. 특정 모델 선택

```bash
claude --model sonnet
claude --model opus
```

`--model` 플래그로 시작부터 원하는 모델을 지정할 수 있습니다. 기본값은 토큰 사용량에 따라 자동으로 모델이 전환되는 모드입니다.

## 1-9. Headless 모드

```bash
# 프롬프트 실행 후 바로 종료
claude -p "src/에서 TODO 주석을 모두 찾아줘"

# JSON 출력 포맷
claude -p "프로젝트 구조를 분석해줘" --output-format json
```

`-p` 플래그를 사용하면 인터랙티브 모드 없이 Claude Code를 실행합니다. 대화형 입력이 필요 없으므로 CI/CD 파이프라인이나 자동화 스크립트에 적합합니다. `--output-format json`을 추가하면 결과를 JSON으로 받아 프로그래밍 방식으로 처리할 수 있습니다.

## 1-10. 로그 확인 (Verbose)

```bash
claude --verbose
```

`--verbose` 플래그를 사용하면 요청에 대한 상세한 로그를 출력합니다. 도구 호출 과정, 토큰 사용량 등을 확인할 수 있어 디버깅에 유용합니다.

## CLI 기본기 요약

| 명령어 | 설명 |
|--------|------|
| `claude` | 인터랙티브 모드 시작 |
| `claude "프롬프트"` | 프롬프트와 함께 시작 |
| `claude -p "프롬프트"` | Headless 모드 (비대화형) |
| `claude -c` | 최근 세션 이어가기 |
| `claude -r` | 특정 세션 선택하여 재개 |
| `claude --model sonnet` | 모델 지정하여 시작 |
| `claude update` | 최신 버전 업데이트 |
| `claude --verbose` | 상세 로그 출력 |

# 2. 인터랙티브 모드 슬래시 커맨드

---

인터랙티브 모드에서 사용할 수 있는 내장 슬래시 커맨드들입니다. 대화창에서 `/`를 입력하면 사용 가능한 커맨드 목록이 표시됩니다.

## 2-1. /help

```text
/help
```

사용 가능한 **모든 커맨드와 기능**을 상세하게 안내합니다. 처음 사용할 때 가장 먼저 실행해 볼 커맨드입니다.

## 2-2. /clear

```text
/clear
```

대화 이력을 비워 **컨텍스트 윈도우를 확보**합니다. 새로운 주제를 다룰 때 자주 사용하면 할루시네이션 가능성을 줄일 수 있습니다. 이전 대화 맥락이 새로운 작업에 부정적 영향을 주는 것을 방지합니다.

## 2-3. /compact

```text
/compact
/compact "인증 관련 내용 위주로 유지해줘"
```

대화를 **요약하고 압축**하여 컨텍스트 윈도우를 확보합니다. 자동 압축(auto compact)은 원하지 않는 내용이 잘릴 수 있으므로, 중요한 맥락을 유지하고 싶다면 직접 실행하는 것을 권장합니다.

인자를 함께 전달하면 **특정 내용을 중점으로** 압축할 수 있습니다. 예를 들어 인증 구현 중이라면, 인증 관련 맥락을 유지하면서 나머지를 압축합니다.

## 2-4. /config

```text
/config
```

자동 압축 설정, 투두리스트 표시 여부 등 다양한 설정을 변경할 수 있습니다.

## 2-5. /model

```text
/model
```

**Opus와 Sonnet 모델** 중 선택하거나, 토큰 사용량에 따라 자동으로 모델이 전환되는 기본(default) 모드를 설정할 수 있습니다.

```text
사용 패턴:
  Opus   → 복잡한 아키텍처 설계, 어려운 버그 수정
  Sonnet → 간단한 수정, 파일 탐색, 빠른 응답이 필요할 때
  Auto   → 토큰 상황에 따라 자동 전환 (기본값)
```

## 2-6. /cost

```text
/cost
```

API 모드 사용 시 현재 세션의 **토큰 사용량과 비용**을 확인할 수 있습니다.

## 2-7. /status

```text
/status
```

계정 상태, 시스템 상태, 현재 사용 중인 모델 등을 확인합니다.

## 2-8. /doctor

```text
/doctor
```

설치 및 환경 문제를 **자동 점검**하여 체크리스트를 제공합니다. Claude Code가 정상 동작하지 않을 때 먼저 실행해 보세요.

## 2-9. /init

```text
/init
```

프로젝트를 초기화합니다. Claude Code가 **프로젝트를 분석**하여 구조, 빌드 명령어, 주요 패턴 등을 CLAUDE.md 파일에 자동으로 요약합니다.

## 2-10. /memory

```text
/memory
```

CLAUDE.md 파일(메모리 파일)을 직접 수정할 수 있습니다. 프로젝트 메모리와 사용자 메모리를 편집하거나, 빠르게 규칙을 추가할 수 있습니다.

## 2-11. /permissions

```text
/permissions
```

Claude Code가 사용할 수 있는 **도구의 권한**을 관리합니다. 특정 명령어를 자동 승인하거나 완전히 차단할 수 있습니다.

## 2-12. /bug

```text
/bug
```

Claude Code 관련 **버그 리포트를 Anthropic에 직접 제출**할 수 있습니다.

## 2-13. /review

```text
/review
```

연동된 GitHub 레포지토리에서 **풀 리퀘스트를 받아와 Claude Code가 직접 리뷰**합니다.

## 2-14. /pr-comment

```text
/pr-comment
```

특정 풀 리퀘스트의 **코멘트를 분석**하여 개선 사항을 도출합니다.

## 2-15. /login, /logout

```text
/login
/logout
```

계정을 전환하거나 로그아웃합니다. 여러 조직이나 계정을 사용하는 **멀티테넌시 환경**에서 유용합니다.

## 2-16. /terminal-setup

```text
/terminal-setup
```

Shift+Enter를 사용하여 **줄바꿈**을 할 수 있도록 터미널을 설정합니다. 기본적으로 Enter는 프롬프트 전송이므로, 여러 줄을 입력하려면 이 설정이 필요합니다.

## 2-17. /vim-mode

```text
/vim-mode
```

대화창에서 **Vim 단축키**를 사용할 수 있습니다. `hjkl` 이동, `dd` 삭제, `yy` 복사 등 Vim에 익숙한 사용자라면 텍스트 편집 속도를 크게 높일 수 있습니다.

## 2-18. /agents

```text
/agents
```

특정 작업에 특화된 **커스텀 서브에이전트**를 관리하고 설정할 수 있습니다. 서브에이전트는 독립된 컨텍스트에서 실행되어 메인 대화를 오염시키지 않습니다.

## 2-19. /mcp

```text
/mcp
```

현재 프로젝트와 연결된 **MCP(Model Context Protocol) 서버들의 상태**를 한눈에 확인할 수 있습니다. 어떤 MCP 도구가 활성화되어 있는지, 연결 상태는 정상인지 파악합니다.

## 2-20. /output-style

```text
/output-style
/output-style exploratory
/output-style learning
```

Claude Code의 **출력 스타일**을 변경합니다. `exploratory`는 탐색적인 설명을, `learning`은 학습 친화적인 설명을 제공하는 등 상황에 맞게 응답 스타일을 조절할 수 있습니다.

## 2-21. /status-line

```text
/status-line
```

하단 상태바에 **현재 사용 중인 모델 이름** 등 원하는 정보를 표시하도록 설정합니다. 어떤 모델로 작업 중인지 항상 확인할 수 있어 실수를 방지합니다.

## 슬래시 커맨드 요약

| 커맨드 | 용도 |
|--------|------|
| `/help` | 전체 도움말 |
| `/clear` | 대화 초기화 |
| `/compact` | 컨텍스트 압축 |
| `/model` | 모델 변경 |
| `/cost` | 비용 확인 |
| `/init` | 프로젝트 초기화 |
| `/memory` | CLAUDE.md 편집 |
| `/permissions` | 권한 관리 |
| `/review` | PR 리뷰 |
| `/terminal-setup` | 줄바꿈 설정 |
| `/vim-mode` | Vim 모드 |
| `/mcp` | MCP 상태 확인 |

# 3. CLAUDE.md 마스터 클래스

---

CLAUDE.md는 Claude Code의 **메모리 파일**입니다. 프로젝트의 구조, 규칙, 컨벤션 등을 기록하면 Claude Code가 매 세션마다 코드베이스를 처음부터 스캐닝할 필요 없이 효율적으로 작업합니다.

## 3-1. CLAUDE.md의 중요성

CLAUDE.md에 프로젝트 구조, 폴더 설명, 중요 기능, 빌드 명령어 등을 정리하면 두 가지 이점이 있습니다:

```text
1. 효율성: Claude가 전체 코드를 스캔하지 않고도 프로젝트를 이해
2. 정확성: 프로젝트 고유의 규칙과 컨벤션을 일관되게 적용
```

## 3-2. CLAUDE.md 파일의 네 가지 종류

```text
1. 엔터프라이즈 파일 (Enterprise)
   위치: 관리자가 설정
   용도: 회사 전체 코딩 표준, 보안 규칙
   공유: 조직 전체

2. 프로젝트 메모리 파일 (Project)
   위치: <project-root>/CLAUDE.md
   용도: 이 프로젝트의 구조, 빌드 방법, 컨벤션
   공유: Git에 포함 → 팀원과 공유

3. 사용자 메모리 파일 (User)
   위치: ~/.claude/CLAUDE.md
   용도: 개인 작업 스타일, 선호 설정
   공유: 모든 프로젝트에 적용, Git 미포함

4. 프로젝트 로컬 메모리 파일 (Project Local)
   위치: <project-root>/.claude/CLAUDE.local.md
   용도: 이 프로젝트에서의 개인 규칙
   공유: Git 미포함 (개인 설정)
```

| 종류 | 위치 | 공유 범위 | 용도 |
|------|------|-----------|------|
| Enterprise | 관리자 설정 | 조직 전체 | 회사 코딩 표준 |
| Project | `CLAUDE.md` | 팀 (Git 포함) | 프로젝트 규칙 |
| User | `~/.claude/CLAUDE.md` | 개인 전체 | 개인 스타일 |
| Project Local | `.claude/CLAUDE.local.md` | 개인 (Git 미포함) | 개인 프로젝트 규칙 |

## 3-3. 파일 태그하기 (@)

```text
> @src/auth/jwt.ts 이 파일을 리팩토링해줘
> @/Users/me/reference.md 이 문서를 참고해줘
```

`@` 기호로 파일을 태그하면 해당 파일의 내용이 Claude Code에 직접 주입됩니다. 상대 경로와 절대 경로 모두 지원합니다.

## 3-4. CLAUDE.md 파일 중첩

```text
project-root/
├── CLAUDE.md              ← 항상 로드
├── frontend/
│   └── CLAUDE.md          ← frontend/ 작업 시 추가 로드
├── backend/
│   └── CLAUDE.md          ← backend/ 작업 시 추가 로드
└── scripts/
    └── CLAUDE.md          ← scripts/ 작업 시 추가 로드
```

하위 폴더에 CLAUDE.md를 두면 **해당 폴더에서 작업할 때만** 파일이 로드됩니다. 이렇게 하면:

- 루트 CLAUDE.md가 비대해지는 것을 방지
- 컨텍스트 사용을 최적화 (불필요한 정보를 로드하지 않음)
- 서브 프로젝트별로 독립적인 규칙 관리 가능

# 4. IDE 연동하기

---

Claude Code는 터미널뿐 아니라 VS Code, JetBrains 등 IDE와 연동하여 사용할 수 있습니다.

## 4-1. 플러그인 설치

VS Code Extension이나 JetBrains Plugin을 설치하면 IDE 내부에서 Claude Code 터미널을 열 수 있습니다.

## 4-2. 빠른 실행

```text
Mac:     Cmd + Esc
Windows: Ctrl + Esc
```

단축키로 IDE 내에서 바로 Claude Code를 실행할 수 있습니다.

## 4-3. 영역 하이라이트

코드 영역을 마우스로 선택(하이라이트)하면, 해당 코드가 **자동으로 Claude Code에 문맥으로 주입**됩니다. "이 부분을 리팩토링해줘"처럼 선택한 코드를 기반으로 작업을 지시할 수 있습니다.

## 4-4. Diff 기능 연동

VS Code나 IntelliJ의 **Diff 뷰**와 연동됩니다. Claude Code가 파일을 수정하면 변경 전/후를 IDE의 Diff 뷰에서 확인하고, 필요하면 특정 변경만 수락하거나 거부할 수 있습니다.

## 4-5. 파일 참조 단축키

```text
Mac:     Cmd + Option + K
Windows: Alt + Ctrl + K
```

이 단축키로 현재 열려 있는 파일을 Claude Code에 자동으로 참조시킬 수 있습니다.

## 4-6. 외부 IDE 연동

```text
/ide
```

현재 터미널이 아닌 **다른 웹 IDE**와 Claude Code를 연동할 수 있습니다.

# 5. Anthropic이 직접 알려주는 꿀팁

---

이 섹션은 Claude Code를 더 효과적으로 사용하기 위한 실전 워크플로우와 고급 팁입니다.

## 5-1. Git CLI 설치

```bash
# GitHub CLI 설치
brew install gh   # macOS
# 또는
sudo apt install gh  # Ubuntu
```

Git CLI(gh)를 설치하면 Claude Code가 **커밋 분석, 롤백, 풀 리퀘스트 생성/리뷰** 등 복잡한 Git 워크플로우를 쉽게 처리합니다.

## 5-2. MCP 활용

```text
유용한 MCP 서버 예시:
  Playwright  → 웹 페이지 스크린샷, E2E 테스트
  Supabase    → 데이터베이스 조회/수정
  Context7    → 라이브러리 공식 문서 조회
  Sentry      → 에러 모니터링 데이터 조회
```

MCP(Model Context Protocol) 서버를 연결하면 Claude Code의 기능 범위를 LLM 자체 능력 너머로 확장할 수 있습니다. 데이터베이스 조회, 웹 브라우징, 외부 API 호출 등이 가능해집니다.

## 5-3. 커스텀 슬래시 커맨드

자주 반복하는 작업은 커스텀 커맨드로 만들어 자동화합니다.

```bash
# 커맨드 파일 생성
mkdir -p .claude/commands
```

```markdown
<!-- .claude/commands/test-and-fix.md -->
---
description: 테스트를 실행하고 실패한 테스트를 자동으로 수정합니다
---

1. 프로젝트의 테스트를 실행하세요
2. 실패한 테스트가 있으면 원인을 분석하세요
3. 코드를 수정하여 테스트를 통과시키세요
4. 모든 테스트가 통과하면 결과를 보고하세요
```

`$ARGUMENTS`를 사용하면 커맨드 실행 시 인자를 받을 수 있습니다. 자세한 내용은 [커스텀 슬래시 커맨드 만들기](/claudecode/claude-code-custom-commands/) 포스트를 참고하세요.

## 5-4. 커맨드의 스코프 조절

```text
프로젝트 스코프:
  <project>/.claude/commands/name.md
  → 이 프로젝트에서만 사용, 팀원과 공유 (Git 포함)

유저 스코프:
  ~/.claude/commands/name.md
  → 모든 프로젝트에서 사용, 개인 전용 (Git 미포함)
```

팀 공통 워크플로우는 프로젝트 스코프에, 개인 워크플로우는 유저 스코프에 배치합니다.

## 5-5. "Explain → Plan → Commit" 순서 따르기

Claude Code와의 대화는 모두 컨텍스트에 포함됩니다. 충분한 시간을 들여 다음 순서를 따르는 것이 좋습니다:

```text
Step 1 - Explain (분석):
  "이 프로젝트의 인증 흐름을 설명해줘"
  "이 버그의 원인이 뭘까?"

Step 2 - Plan (계획):
  "JWT 인증으로 전환하는 계획을 세워줘"
  "이 버그를 수정하는 방법을 정리해줘"

Step 3 - Commit (실행):
  "계획대로 구현해줘"
  "변경사항을 커밋해줘"
```

바로 "구현해줘"로 시작하는 것보다, 분석과 계획을 거치면 결과물의 품질이 훨씬 높아집니다.

## 5-6. Thinking 토큰 활용

```text
레벨 1: think            → 기본 추론
레벨 2: think think      → 더 깊은 추론
레벨 3: think think think → 매우 깊은 추론
레벨 4: ultrathink       → 최대 추론 토큰 배정
```

복잡한 문제에는 thinking 레벨을 높이면 더 정확한 답을 얻을 수 있습니다. 단, 레벨이 높을수록 응답 시간이 길어지므로 항상 `ultrathink`가 좋은 것은 아닙니다. 간단한 질문에는 기본 레벨, 복잡한 아키텍처 설계에는 높은 레벨을 사용하세요.

## 5-7. TDD 적극 활용

```text
TDD 워크플로우:
  1. Claude에게 예상 입력/출력 기반 테스트 코드 작성 지시
  2. 테스트 실행 → 실패 확인 (Red)
  3. 테스트를 통과하는 구현 코드 작성 지시 (Green)
  4. 모든 테스트 통과 확인
  5. 커밋
```

테스트를 먼저 작성하면 Claude Code에게 **명확한 성공 기준**을 제공하는 셈이므로, 구현 정확도가 크게 올라갑니다.

## 5-8. 스크린샷 적극 활용

Playwright나 Puppeteer MCP를 연결하면 Claude Code가 **자동으로 웹 페이지 스크린샷**을 찍고 확인할 수 있습니다. UI 버그 수정이나 프론트엔드 작업에서 "이렇게 보이는 게 맞아?"를 Claude가 스스로 판단할 수 있어 작업 효율이 높아집니다.

## 5-9. 권한 자동 승인 설정

```json
{
  "permissions": {
    "allow": [
      "Read", "Edit", "Write",
      "Bash(git *)",
      "Bash(npm run *)"
    ]
  }
}
```

숙련자라면 자주 사용하는 도구를 자동 승인으로 설정하여 매번 확인하는 시간을 절약할 수 있습니다. Docker 컨테이너 안에서 실행하면 보안 위험을 최소화하면서도 자유롭게 사용할 수 있습니다.

> **주의**: `bypassPermissions` 모드는 모든 도구를 자동 승인합니다. 반드시 격리된 환경(Docker 등)에서만 사용하세요.

## 5-10. Claude Code를 선생님으로 활용

새로운 코드베이스에 합류했을 때, Claude Code에게 단계적으로 질문합니다:

```text
전반적 이해:
  "이 프로젝트의 전체 아키텍처를 설명해줘"
  "어떤 기술 스택을 사용하고 있어?"

세부 탐색:
  "인증 흐름을 단계별로 설명해줘"
  "이 함수가 호출되는 경로를 추적해줘"

심층 분석:
  "이 코드에서 성능 병목이 될 수 있는 부분은?"
  "이 패턴을 사용한 이유가 뭘까?"
```

## 5-11. 프롬프트는 항상 상세하게

```text
나쁜 예:
  "테스트를 작성해줘"

좋은 예:
  "src/auth/jwt.ts의 테스트를 작성해줘.
   사용자가 로그인된 상태인 edge case를 포함하고,
   외부 API는 mock하지 말고 실제 호출해줘"
```

구체적으로 명시할수록 Claude Code가 의도에 맞는 결과를 생성합니다. 파일 경로, edge case, 제약 조건 등을 명확하게 포함하세요.

## 5-12. 이미지 전달

```text
방법 1: 파일 드래그 앤 드롭
방법 2: 스크린샷 후 Ctrl+V (Mac에서도 Ctrl+V)
방법 3: 파일 경로 태그 → @screenshot.png
```

디자인 시안, UI 스크린샷, 에러 화면 등을 이미지로 전달하면 Claude Code가 시각적 정보를 기반으로 작업할 수 있습니다. Mac에서도 붙여넣기는 `Cmd+V`가 아닌 **`Ctrl+V`**입니다.

## 5-13. 파일 직접 태그

```text
> @[Tab키로 파일 탐색]
```

`@`를 입력하면 파일 리스트가 표시되며, **Tab 키**로 디렉토리를 탐색하고 원하는 파일을 빠르게 태그할 수 있습니다.

## 5-14. Esc를 두려워하지 마세요

Claude Code가 잘못된 방향으로 구현을 진행하고 있다면, **과감하게 Esc를 눌러 작업을 중단**하세요.

```text
Esc를 누르면:
  - 현재 진행 중인 작업 취소
  - 이미 완료된 파일 변경은 유지됨
  - 컨텍스트가 잘못된 내용으로 오염되는 것을 방지

Esc를 눌러야 할 때:
  - Claude가 요청하지 않은 파일을 수정하기 시작할 때
  - 의도와 다른 방향으로 구현할 때
  - 불필요한 리팩토링을 시작할 때
```

## 5-15. 롤백 활용

```text
"방금 한 변경사항을 되돌려줘"
"마지막 커밋을 롤백해줘"
"src/auth.ts만 원래대로 복구해줘"
```

Claude Code는 컨텍스트에 있는 변경 사항이나 커밋을 **매우 정확하게 롤백**할 수 있습니다. 결과가 마음에 들지 않으면 원하는 형태를 설명하기만 하면 됩니다.

## 5-16. 체크리스트/스크래치패드 활용

여러 단계에 걸친 복잡한 작업은 **마크다운 체크리스트**를 활용합니다:

```text
"다음 체크리스트를 순서대로 진행해줘:
 - [ ] 현재 테스트 커버리지 확인
 - [ ] 누락된 엣지 케이스 파악
 - [ ] 테스트 추가
 - [ ] 전체 테스트 통과 확인
 - [ ] 커밋"
```

롱러닝 태스크에서 Claude Code가 단계를 빠뜨리지 않고 체계적으로 작업을 수행합니다.

## 5-17. 작업과 검증 분리

하나의 Claude Code 세션에서 코딩 작업을 완료한 후, **독립된 관점으로 검증**합니다:

```text
방법 1 - /clear 후 검증:
  (작업 완료) → /clear → "src/auth.ts를 리뷰해줘"

방법 2 - 서브에이전트로 검증:
  (작업 완료) → "서브에이전트를 생성해서 이 코드를 리뷰해줘"
```

같은 컨텍스트에서 작성하고 리뷰하면 자기 확인 편향이 발생할 수 있습니다. 대화를 초기화하거나 서브에이전트를 활용하면 **독립적인 관점**에서 코드 품질을 검증할 수 있습니다.

## 5-18. Git Worktree 활용

```bash
# 기능 브랜치용 워크트리 생성
git worktree add ../my-project-feature feature-branch

# 각 워크트리에서 별도 Claude Code 실행
cd ../my-project-feature && claude
```

Git Worktree를 사용하면 **여러 브랜치를 동시에** 독립적으로 작업할 수 있습니다. 각 워크트리에서 별도의 Claude Code 세션을 실행하면, 기능 개발과 버그 수정을 병렬로 진행하고 각각 풀 리퀘스트로 병합할 수 있습니다.

# 6. 정리

---

## 섹션별 핵심 요약

| 섹션 | 핵심 |
|------|------|
| **CLI 기본기** | `claude -p`(Headless), `claude -c`(세션 이어가기), `--model`(모델 선택) |
| **슬래시 커맨드** | `/clear`(초기화), `/compact`(압축), `/model`(모델 변경), `/init`(초기화) |
| **CLAUDE.md** | 4가지 스코프, 파일 중첩으로 컨텍스트 최적화 |
| **IDE 연동** | Cmd+Esc(빠른 실행), 하이라이트 주입, Diff 뷰 연동 |
| **실전 꿀팁** | Explain→Plan→Commit, TDD, Esc 활용, 작업/검증 분리 |

## 가장 중요한 5가지 습관

```text
1. /clear를 자주 사용하라
   → 새로운 주제로 넘어갈 때 컨텍스트를 정리하면 할루시네이션이 줄어듦

2. Explain → Plan → Commit 순서를 따르라
   → 바로 "구현해줘"보다 분석과 계획을 거치면 품질이 올라감

3. Esc를 두려워하지 마라
   → 잘못된 방향의 작업을 빨리 중단하는 것이 컨텍스트 낭비를 방지

4. CLAUDE.md를 잘 관리하라
   → 프로젝트 규칙을 명확히 기록하면 매번 설명할 필요 없음

5. 프롬프트를 구체적으로 작성하라
   → 파일 경로, edge case, 제약 조건을 명시하면 정확도가 올라감
```

# Reference

---

- [Claude Code 공식 문서](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code Best Practices - Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Claude Code GitHub](https://github.com/anthropics/claude-code)
- 관련 포스트: [Claude Code 입문 - 터미널 기반 AI 코딩 에이전트](/claudecode/claude-code-introduction/)
- 관련 포스트: [커스텀 슬래시 커맨드 만들기](/claudecode/claude-code-custom-commands/)
- 관련 포스트: [MCP 서버 연동](/claudecode/claude-code-mcp-servers/)
- 관련 포스트: [Hooks와 서브에이전트](/claudecode/claude-code-hooks-subagents/)
