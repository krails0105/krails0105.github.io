---
title: "[ClaudeCode] 팀 협업과 CI/CD - 공유 설정부터 GitHub Actions까지"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, Collaboration, CICD, GitHubActions, HeadlessMode, TeamWorkflow]
---

# Introduction

---

Claude Code는 개인 도구로도 유용하지만, **팀 전체가 동일한 설정으로 사용**할 때 진가를 발휘합니다. CLAUDE.md, Skills, Hooks, 권한 설정 등을 Git으로 공유하면, 팀원 모두가 같은 컨벤션과 워크플로우로 Claude Code를 활용할 수 있습니다. 나아가 **Headless 모드**와 **GitHub Actions**를 활용하면 PR 자동 리뷰, 코드 분석, 문서 생성 같은 CI/CD 파이프라인에도 Claude Code를 통합할 수 있습니다.

이 글은 Claude Code의 팀 협업 기능, Headless 모드, CI/CD 통합, 그리고 다른 AI 코딩 도구와의 비교를 정리합니다.

# 1. "Claude Cowork"란?

---

**"Claude Cowork"라는 이름의 공식 제품은 없습니다.** 하지만 Claude Code는 팀 협업을 위한 여러 기능을 제공하며, 이를 통칭하여 "Claude Code 협업 기능"이라고 할 수 있습니다.

```text
Claude Code의 협업 기능:
  1. 공유 설정 파일 → Git으로 팀 전체에 배포
  2. Headless 모드 → CI/CD 파이프라인에 통합
  3. GitHub Actions → PR 자동 리뷰, 이슈 분석
  4. 팀/엔터프라이즈 플랜 → 세션 공유, 관리자 설정
```

# 2. 공유 설정으로 팀 컨벤션 통일

---

## Git에 포함되는 설정 파일

```text
project-root/
├── CLAUDE.md                    ← 프로젝트 컨텍스트
├── .claude/
│   ├── settings.json            ← 권한, Hook 설정
│   ├── mcp.json                 ← MCP 서버 설정
│   ├── skills/                  ← 팀 공용 스킬
│   │   ├── review-pr/
│   │   │   └── SKILL.md
│   │   └── commit/
│   │       └── SKILL.md
│   └── agents/                  ← 팀 공용 에이전트
│       └── code-reviewer/
│           └── CLAUDE.md
```

이 파일들을 Git에 포함하면, `git clone` 한 모든 팀원이 **동일한 Claude Code 환경**을 갖게 됩니다.

## 팀 CLAUDE.md 예시

```markdown
# MyProject

React 18 + TypeScript 프론트엔드, Express + PostgreSQL 백엔드

## Quick Start

​```bash
npm install
npm run dev         # 프론트 + 백엔드 동시 실행
npm test            # 전체 테스트
​```

## Architecture

- frontend/src/components/ - React 컴포넌트
- backend/src/routes/ - API 라우트
- backend/src/services/ - 비즈니스 로직

## Code Conventions

- 린트: `npm run lint:fix` (커밋 전 필수)
- 컴포넌트: PascalCase (Button.tsx)
- API: RESTful, 응답은 { data, error, meta } 형식
- 테스트: 새 기능은 반드시 테스트 포함

## Important

- /config 디렉토리 수정 금지 (DevOps 팀 관할)
- .env.example을 참고하여 .env 생성
- DB 마이그레이션은 `npm run db:migrate`
```

## 계층적 CLAUDE.md

```text
project-root/
├── CLAUDE.md              ← 프로젝트 전체 규칙
├── frontend/
│   └── CLAUDE.md          ← React/TypeScript 컨벤션
└── backend/
    └── CLAUDE.md          ← Express/DB 컨벤션
```

팀원이 `frontend/` 디렉토리에서 작업하면, 루트 CLAUDE.md + frontend/CLAUDE.md가 **함께 로드**됩니다. 각 팀(프론트, 백엔드)에 맞는 컨텍스트를 제공할 수 있습니다.

## 팀 공유 vs 개인 설정

| 파일 | Git 포함 | 용도 |
|------|----------|------|
| `CLAUDE.md` | O | 프로젝트 컨텍스트 |
| `.claude/settings.json` | O | 팀 공통 권한/Hook |
| `.claude/settings.local.json` | X (.gitignore) | 개인 설정 오버라이드 |
| `.claude/skills/` | O | 팀 공용 스킬 |
| `.claude/mcp.json` | O | 팀 공용 MCP 서버 |
| `~/.claude/settings.json` | - | 개인 전역 설정 |

# 3. Headless 모드

---

## 개념

Headless 모드는 Claude Code를 **대화형 없이 단일 프롬프트로 실행**하는 모드입니다. 결과를 stdout으로 출력하고 종료합니다.

```bash
# 기본 사용
claude -p "이 프로젝트의 README를 업데이트해줘"

# 모델 지정
claude -p "테스트 실패 원인을 분석해줘" --model sonnet

# 파이프 입력
cat error.log | claude -p "이 에러를 분석하고 해결 방법을 알려줘"

# 특정 도구 차단
claude -p "코드 리뷰해줘" --disallowedTools "Bash(rm *)"
```

## 대화형 vs Headless

| 항목 | 대화형 | Headless |
|------|--------|----------|
| **인터페이스** | 터미널 대화 | 단일 프롬프트 |
| **종료** | 사용자가 종료 | 실행 후 자동 종료 |
| **출력** | 터미널 UI | stdout (텍스트) |
| **적합한 곳** | 개발 중 사용 | CI/CD, 자동화 스크립트 |

# 4. GitHub Actions 통합

---

## 공식 Action

Anthropic은 `claude-code-action`이라는 공식 GitHub Action을 제공합니다.

```yaml
name: Claude Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Claude Code PR 리뷰
        uses: anthropics/claude-code-action@v1
        with:
          prompt: |
            이 PR의 변경사항을 리뷰해주세요.
            보안 취약점, 성능 이슈, 코딩 컨벤션 위반을 확인하고
            심각도별로 정리해주세요.
          model: sonnet
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## 활용 시나리오

```text
PR 자동 리뷰:
  PR이 열리면 → Claude가 코드 리뷰 → 코멘트로 결과 게시

테스트 실패 분석:
  CI 테스트 실패 → 로그를 Claude에게 전달 → 원인 분석 + 수정 제안

문서 자동 생성:
  코드 변경 감지 → Claude가 관련 문서 업데이트 → 자동 커밋

이슈 분류:
  새 이슈 등록 → Claude가 내용 분석 → 라벨 자동 부여
```

## Headless 모드 직접 사용

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Analyze Code
        run: |
          claude -p "src/ 디렉토리의 코드 품질을 분석하고 보고서를 작성해줘" \
            --model haiku \
            > analysis-report.md
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: code-analysis
          path: analysis-report.md
```

# 5. CI/CD 활용 팁

---

## 비용 최적화

```text
리뷰/분석 (읽기 위주): haiku 모델 → 빠르고 저렴
코드 수정 (쓰기 위주): sonnet 모델 → 정확도 중요
아키텍처 분석:         opus 모델 → 깊은 추론 필요
```

## 보안

```text
✅ API 키는 GitHub Secrets에 저장
✅ --disallowedTools로 위험한 명령 차단
✅ 읽기 전용 작업에는 Write/Edit 도구 차단
✅ CLAUDE.md로 접근 범위 명시

❌ 환경 변수에 API 키 직접 노출
❌ 프로덕션 DB 접근 허용
❌ bypassPermissions 모드 사용
```

## 점진적 도입 전략

```text
Phase 1: 읽기 전용 작업
  - PR 코드 리뷰 (코멘트만)
  - 테스트 실패 분석 (보고서만)
  - 코드 품질 보고

Phase 2: 제한된 쓰기
  - 린트 자동 수정
  - 문서 자동 생성
  - 테스트 코드 생성

Phase 3: 자율적 작업
  - 이슈 기반 자동 코딩
  - PR 자동 생성
  - 릴리스 노트 생성
```

# 6. Claude Code vs 대안 도구 비교

---

## 주요 AI 코딩 도구

| 도구 | 유형 | 특징 |
|------|------|------|
| **Claude Code** | 터미널 에이전트 | 코드베이스 이해, MCP 확장, Headless 모드 |
| **GitHub Copilot** | IDE 확장 | 실시간 자동완성, GitHub 네이티브 |
| **Cursor** | AI 네이티브 IDE | 프로젝트 인식 IDE, Composer 모드 |
| **Aider** | CLI 에이전트 | 터미널 중심, Git 자동 커밋 |

## 상세 비교

| 기능 | Claude Code | Copilot | Cursor | Aider |
|------|-----------|---------|--------|-------|
| **파일 수정** | 직접 수정 | 에이전트 모드로 수정 가능 | 직접 수정 | 직접 수정 |
| **MCP 확장** | O | X | X | X |
| **커스텀 에이전트** | O | X | X | X |
| **Headless/CI** | O | X | X | 제한적 |
| **IDE 통합** | 확장 프로그램 | 네이티브 | 네이티브 | X |
| **자동완성** | X | O (실시간) | O (실시간) | X |
| **Git 연동** | 커밋/PR/리뷰 | PR 코멘트 | 기본 | 자동 커밋 |
| **과금** | 토큰 기반 | 월정액 | 월정액 | 토큰 기반 |

## 사용 시나리오별 추천

```text
일상적인 코딩 (자동완성 중심):
  → GitHub Copilot 또는 Cursor
  → 타이핑하면서 실시간 제안

대규모 리팩토링, 아키텍처 변경:
  → Claude Code
  → 코드베이스 전체 이해 + 계획 수립 + 실행

외부 시스템 연동 (DB, Jira, Slack):
  → Claude Code + MCP
  → 유일하게 표준 프로토콜로 외부 도구 연결

CI/CD 자동화:
  → Claude Code Headless + GitHub Actions
  → PR 리뷰, 코드 분석, 문서 생성

팀 컨벤션 관리:
  → Claude Code (CLAUDE.md + Skills + Hooks)
  → Git으로 공유되는 AI 워크플로우
```

## 실무에서의 조합

많은 팀이 **여러 도구를 함께 사용**합니다:

```text
일상 코딩:     Copilot (실시간 자동완성)
복잡한 작업:   Claude Code (코드베이스 이해 + 에이전트)
CI/CD:        Claude Code Headless (자동 리뷰/분석)
```

도구마다 강점이 다르므로, 작업 유형에 맞게 선택하는 것이 효율적입니다.

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **팀 협업** | CLAUDE.md, Skills, Hooks 등을 Git으로 공유 → 동일 환경 |
| **계층적 CLAUDE.md** | 루트 + 하위 디렉토리별 컨텍스트 분리 |
| **Headless 모드** | `claude -p` 비대화형 실행 → CI/CD 통합 |
| **GitHub Actions** | PR 리뷰, 코드 분석, 문서 생성 자동화 |
| **vs Copilot** | Copilot은 자동완성, Claude Code는 에이전트 |
| **vs Cursor** | Cursor는 AI IDE, Claude Code는 CLI + MCP 확장 |

```text
핵심:
  Claude Code의 협업 = "설정 파일을 Git으로 공유"
  모든 팀원이 같은 CLAUDE.md, Skills, Hooks를 사용
  → AI 도구의 동작이 팀 전체에서 일관됨

  CI/CD 통합 = Headless 모드 + GitHub Actions
  → 코드 리뷰, 분석, 문서 생성을 자동화
```

# Reference

---

- [Claude Code 공식 문서](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code GitHub Actions](https://github.com/anthropics/claude-code-action)
- [CLAUDE.md 작성 가이드](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Claude Code vs GitHub Copilot 비교](https://docs.anthropic.com/en/docs/claude-code/overview)
