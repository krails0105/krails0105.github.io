---
title: "[ClaudeCode] Claude Code 입문 - 터미널 기반 AI 코딩 에이전트"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, CLI, AIAgent, CLAUDE.md, Installation]
---

# Introduction

---

Claude Code는 Anthropic이 만든 **터미널 기반 AI 코딩 에이전트**입니다. 일반적인 AI 챗봇과 달리, 코드베이스를 직접 탐색하고, 파일을 수정하고, 명령어를 실행하고, Git 커밋까지 수행할 수 있습니다. 마치 터미널에 상주하는 시니어 개발자 페어 프로그래머처럼, 자연어로 지시하면 실제 작업을 수행합니다.

이 글은 Claude Code가 무엇인지, 기존 Claude(웹/API)와 어떻게 다른지, 설치 및 기본 사용법, 그리고 프로젝트 컨텍스트를 관리하는 CLAUDE.md까지 정리합니다.

# 1. Claude Code vs Claude Web/API

---

## 핵심 차이: "대화" vs "행동"

```text
Claude Web (claude.ai):
  사용자가 질문 → Claude가 텍스트로 답변
  코드 제안은 하지만 직접 수정하지 않음
  파일 시스템 접근 불가

Claude API:
  프로그래밍 방식으로 Claude 호출
  커스텀 애플리케이션에 통합
  직접 tool 구현 필요

Claude Code:
  터미널에서 자연어 → 실제 파일 수정, 명령어 실행
  코드베이스 전체를 이해하고 탐색
  Git, 테스트, 빌드 등 개발 워크플로우 직접 수행
  IDE(VS Code, JetBrains) 확장 프로그램으로도 사용 가능
```

## 비교표

| 항목 | Claude Web | Claude API | Claude Code |
|------|-----------|------------|-------------|
| **인터페이스** | 웹 브라우저 | HTTP API | 터미널 CLI |
| **파일 접근** | 업로드만 가능 | 불가 | 전체 파일 시스템 |
| **코드 수정** | 제안만 | 불가 | 직접 수정 |
| **명령어 실행** | 불가 | 불가 | Bash 실행 |
| **Git 연동** | 불가 | 불가 | 커밋/푸시/PR |
| **컨텍스트** | 대화 내용만 | 요청 내용만 | 코드베이스 전체 |
| **외부 도구** | 불가 | Tool Use API | MCP 서버 연동 |

핵심은 Claude Code가 **읽기(Read) + 쓰기(Write) + 실행(Execute)** 권한을 가진 에이전트라는 점입니다.

# 2. 설치

---

```bash
# 방법 1: 공식 설치 스크립트 (macOS / Linux)
curl -fsSL https://claude.ai/install.sh | bash

# 방법 2: npm
npm install -g @anthropic-ai/claude-code

# 방법 3: Homebrew (macOS)
brew install --cask claude-code

# 설치 확인
claude --version
```

설치 후 API 키 설정이 필요합니다:

```bash
# 환경 변수로 설정
export ANTHROPIC_API_KEY=sk-ant-...

# 또는 첫 실행 시 대화형으로 로그인
claude
```

# 3. 기본 사용법

---

## 대화형 모드 (Interactive)

```bash
# 프로젝트 디렉토리에서 시작
cd my-project
claude
```

터미널에서 자연어로 지시합니다:

```text
> 이 프로젝트의 구조를 설명해줘
> src/auth.ts에 JWT 검증 미들웨어를 추가해줘
> 테스트를 실행하고 실패하는 것들을 수정해줘
> 이 변경사항을 커밋해줘
```

## Headless 모드 (비대화형)

```bash
# 단일 프롬프트 실행 후 종료
claude -p "이 프로젝트의 TODO를 모두 찾아서 정리해줘"

# 파이프 입력
cat error.log | claude -p "이 에러 로그를 분석해줘"
```

CI/CD나 자동화 스크립트에서 유용합니다.

## 주요 슬래시 커맨드

```text
/help          도움말
/clear         대화 초기화
/compact       컨텍스트 압축 (토큰 절약)
/cost          현재 세션 비용 확인
/model         사용 모델 변경
/permissions   권한 설정
/hooks         Hook 설정
```

# 4. Claude Code의 도구 체계

---

Claude Code는 내부적으로 여러 **도구(Tool)**를 사용하여 작업을 수행합니다:

```text
파일 관련:
  Read   - 파일 읽기
  Write  - 파일 생성
  Edit   - 파일 수정 (정확한 문자열 치환)
  Glob   - 파일 패턴 검색
  Grep   - 파일 내용 검색

실행 관련:
  Bash   - 셸 명령어 실행

웹 관련:
  WebFetch   - URL 내용 가져오기
  WebSearch  - 웹 검색

에이전트 관련:
  Task       - 서브에이전트에 작업 위임
  Skill      - 스킬(슬래시 커맨드) 실행
```

사용자가 "이 파일을 수정해줘"라고 하면, Claude Code는 내부적으로 `Read` → `Edit` 도구를 순서대로 호출합니다. 도구 호출 시 사용자에게 **권한 확인**을 요청하며, 승인된 작업만 실행됩니다.

# 5. CLAUDE.md - 프로젝트 컨텍스트 파일

---

## 개념

CLAUDE.md는 Claude Code가 **세션 시작 시 자동으로 읽는 프로젝트 설명 파일**입니다. 프로젝트의 구조, 빌드 명령어, 코딩 컨벤션, 주의사항 등을 기록하면, Claude Code가 매번 코드베이스를 처음부터 파악할 필요 없이 맥락을 이해합니다. 새로 합류한 개발자에게 건네는 온보딩 문서와 같은 역할입니다.

## 위치와 우선순위

```text
project-root/
├── CLAUDE.md              ← 프로젝트 전체 컨텍스트 (항상 로드)
├── frontend/
│   └── CLAUDE.md          ← frontend/ 작업 시 추가 로드
└── backend/
    └── CLAUDE.md          ← backend/ 작업 시 추가 로드
```

하위 디렉토리의 CLAUDE.md는 해당 디렉토리에서 작업할 때 프로젝트 루트의 CLAUDE.md에 **추가로** 로드됩니다.

## 권장 구조

```markdown
# Project Name

프로젝트 한 줄 설명

## Quick Start

​```bash
npm install
npm run dev
npm test
​```

## Architecture

- Frontend: React 18 + TypeScript
- Backend: Express + PostgreSQL
- 디렉토리 구조 설명

## Build Commands

​```bash
npm run dev        # 개발 서버
npm run build      # 프로덕션 빌드
npm test           # 테스트 실행
npm run lint:fix   # 린트 자동 수정
​```

## Code Conventions

- 파일 네이밍, 임포트 규칙
- 린터/포매터 사용 방법

## Important Notes

- 수정하면 안 되는 파일/디렉토리
- 환경 변수 설정 방법
```

## 작성 원칙

```text
✅ 포함할 것:
  - Claude가 코드만으로 추론하기 어려운 정보
  - 빌드/테스트 명령어
  - 프로젝트 고유의 컨벤션이나 제약사항
  - 자주 사용하는 워크플로우

❌ 피할 것:
  - 일반적인 프로그래밍 지식 (Claude가 이미 앎)
  - 코드 스타일 규칙 (린터 설정으로 대체)
  - 300줄 이상의 장문 (핵심만 간결하게)
```

# 6. 설정과 권한

---

## 설정 파일 계층

```text
우선순위 (높은 순):
  1. CLI 플래그         → 이번 세션만
  2. 프로젝트 설정      → .claude/settings.json (Git에 포함)
  3. 프로젝트 로컬 설정  → .claude/settings.local.json (Git 미포함)
  4. 사용자 설정        → ~/.claude/settings.json (모든 프로젝트)
```

## 권한 모드

```text
default          도구 사용 시마다 승인 요청
acceptEdits      파일 수정은 자동 승인, 나머지는 요청
plan             읽기 전용 (수정 불가)
bypassPermissions  모든 도구 자동 승인 (주의!)
```

## 권한 규칙 설정

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Bash(git *)",
      "Bash(npm run *)",
      "Edit"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ]
  }
}
```

`allow`에 패턴을 추가하면 해당 도구 사용 시 승인 없이 자동 실행됩니다. `deny`는 해당 패턴을 완전히 차단합니다.

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **Claude Code** | 터미널 기반 AI 코딩 에이전트, 파일 수정/명령 실행/Git 연동 |
| **vs Claude Web** | Web은 대화만, Code는 대화 + 실제 작업 수행 |
| **CLAUDE.md** | 프로젝트 컨텍스트 파일, 세션 시작 시 자동 로드 |
| **도구 체계** | Read/Write/Edit/Bash/Grep 등 내장 도구로 작업 수행 |
| **권한 시스템** | 도구별 allow/deny 규칙으로 안전성 확보 |
| **Headless 모드** | `claude -p`로 비대화형 실행 (CI/CD 활용) |

```text
핵심:
  Claude Code = Claude의 두뇌 + 터미널의 손
  "코드를 제안하는 AI"가 아니라 "코드를 직접 작성하는 AI 에이전트"
```

# Reference

---

- [Claude Code 공식 문서](https://docs.anthropic.com/en/docs/claude-code)
- [CLAUDE.md 작성 가이드](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Claude Code GitHub](https://github.com/anthropics/claude-code)
