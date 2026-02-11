---
title: "[ClaudeCode] 커스텀 슬래시 커맨드 만들기 - Commands, Skills, 그리고 CLAUDE.md의 역할 구분"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, CustomCommands, Skills, Automation, CLAUDE.md, SlashCommands]
---

# Introduction

---

Claude Code를 사용하다 보면 비슷한 작업을 반복하게 되는 경우가 있습니다. 예를 들어 개발 작업 후 블로그 포스트를 작성하거나, 특정 규칙에 따라 코드 리뷰를 수행하는 등의 작업입니다. 이런 반복 작업을 매번 긴 프롬프트로 지시하는 것은 비효율적입니다.

**커스텀 슬래시 커맨드(Custom Slash Commands)**를 만들면 이런 반복 작업을 `/커맨드명` 한 줄로 실행할 수 있습니다. `.claude/commands/` 디렉토리에 마크다운 파일을 만들면 곧바로 슬래시 커맨드로 등록됩니다.

이 글에서는 커맨드 파일 작성법, CLAUDE.md와의 역할 차이, 그리고 실전 커맨드 구현 예시를 정리합니다. 이전 [Skills 포스트](/claudecode/claude-code-skills/)에서 다룬 개념의 연장선이므로, 해당 글을 먼저 읽으면 이해가 수월합니다.

# 1. Commands와 Skills의 관계

---

Claude Code 공식 문서에는 다음과 같은 설명이 있습니다.

> Custom slash commands have been merged into skills. A file at `.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both create `/review` and work the same way. Your existing `.claude/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control whether you or Claude invokes them, and the ability for Claude to load them automatically when relevant.

정리하면 **Commands와 Skills는 같은 기능의 다른 이름**입니다. 둘 다 슬래시 커맨드를 만드는 방법이며, 차이는 파일 배치 방식뿐입니다.

## 두 가지 경로, 같은 결과

```text
방법 1 - Commands 스타일 (단일 파일):
  .claude/commands/review.md  →  /review 커맨드 등록

방법 2 - Skills 스타일 (디렉토리):
  .claude/skills/review/SKILL.md  →  /review 커맨드 등록
  .claude/skills/review/references/  ← 참고 자료 (선택사항)
  .claude/skills/review/examples/    ← 예시 (선택사항)
```

간단한 커맨드는 Commands 스타일(단일 `.md` 파일)이 편리하고, 참고 자료나 보조 스크립트가 필요한 복잡한 커맨드는 Skills 스타일(디렉토리)이 적합합니다. 이 글에서는 더 간결한 `.claude/commands/` 경로를 중심으로 설명합니다.

## Built-in Commands vs Custom Commands

Claude Code에는 기본 제공되는 내장 커맨드와 사용자가 직접 만드는 커스텀 커맨드가 있습니다.

```text
Built-in (내장 커맨드):
  /help, /clear, /compact, /cost, /model, /permissions, /hooks
  → Claude Code에 기본 제공, 수정 불가

Custom (커스텀 커맨드):
  .claude/commands/post.md   → /post
  .claude/commands/review.md → /review
  → 사용자가 .md 파일로 직접 정의
```

# 2. 커맨드 파일의 위치와 스코프

---

커스텀 커맨드는 두 위치에 만들 수 있으며, 위치에 따라 사용 범위(스코프)가 달라집니다.

## 프로젝트 레벨 vs 유저 레벨

```text
프로젝트 레벨 (Project Scope):
  <project-root>/.claude/commands/name.md
  → 현재 프로젝트에서만 사용
  → Git에 포함 → 팀원과 공유 가능
  → /help에서 커맨드명으로 표시

유저 레벨 (User Scope):
  ~/.claude/commands/name.md
  → 모든 프로젝트에서 사용 가능
  → Git에 포함되지 않음 (개인 설정)
  → /help에서 커맨드명 뒤에 "(user)" 표시
```

## 어느 위치에 만들 것인가?

| 커맨드 유형 | 적합한 위치 | 예시 |
|-----------|-----------|------|
| **프로젝트 공통 작업** | `.claude/commands/` | 프로젝트 테스트 실행, PR 리뷰 규칙 |
| **프로젝트 고유 규칙** | `.claude/commands/` | 특정 코딩 컨벤션 체크, 배포 절차 |
| **개인 워크플로우** | `~/.claude/commands/` | 개인 블로그 포스트 작성, 일정 메모 |
| **범용 유틸리티** | `~/.claude/commands/` | JSON 포맷팅, 로그 분석, 코드 설명 |

팀원과 공유해야 하는 커맨드는 프로젝트 레벨에, 개인적으로만 쓰는 커맨드는 유저 레벨에 만드는 것이 원칙입니다.

# 3. 커맨드 파일 작성법

---

커맨드 파일은 **YAML Frontmatter + Markdown 본문** 구조입니다. Frontmatter는 선택사항이며, 본문만으로도 동작합니다.

## 기본 구조

```markdown
---
description: 커맨드가 하는 일을 간단히 설명
argument-hint: [인자1] [인자2]
allowed-tools: Read, Write, Bash(git:*)
---

여기에 Claude가 실행할 지시사항을 마크다운으로 작성합니다.

1. 첫 번째 단계
2. 두 번째 단계
3. 결과를 사용자에게 보고
```

**파일명이 곧 커맨드명**입니다. `review.md`로 저장하면 `/review`로 호출합니다.

## Frontmatter 옵션

| 옵션 | 설명 | 예시 |
|------|------|------|
| `description` | 커맨드 설명. Claude가 자동 호출 판단에도 사용 | `"PR을 리뷰합니다"` |
| `argument-hint` | 사용자에게 보여줄 인자 힌트 | `[파일경로]`, `[pr-number]` |
| `allowed-tools` | 실행 중 사용 가능한 도구 제한 | `Read, Grep, Glob` |

`allowed-tools`를 지정하면 커맨드 실행 중 해당 도구만 사용할 수 있습니다. 읽기 전용 커맨드에는 `Read, Grep, Glob`만 허용하여 실수로 파일을 수정하는 것을 방지할 수 있습니다.

## 동적 요소: 인자, 파일 참조, 셸 실행

커맨드 본문에서 사용할 수 있는 세 가지 동적 요소가 있습니다.

### 인자 전달 ($ARGUMENTS)

```markdown
---
description: 파일을 분석하고 설명합니다
argument-hint: [파일경로]
---

다음 파일을 분석하고 설명해주세요: $ARGUMENTS

1. 파일의 전체 구조를 파악합니다
2. 핵심 로직을 단계별로 설명합니다
3. 주의할 점을 정리합니다
```

호출 시 `/explain src/auth/jwt.ts`처럼 입력하면 `$ARGUMENTS`가 `"src/auth/jwt.ts"`로 치환됩니다.

인자가 여러 개인 경우 위치 인자를 사용할 수 있습니다.

```text
$ARGUMENTS  → 전체 인자 문자열
$1          → 첫 번째 인자
$2          → 두 번째 인자

예시:
  /compare src/old.ts src/new.ts
  → $1 = "src/old.ts", $2 = "src/new.ts"
```

### 파일 참조 (@path)

`@` 문법으로 외부 파일의 내용을 커맨드에 포함할 수 있습니다.

```markdown
---
description: 코딩 표준에 따라 코드를 리뷰합니다
---

다음 코딩 표준을 참고하여 코드를 리뷰하세요:
@references/coding-standards.md

리뷰 대상: $ARGUMENTS
```

Skills 스타일 디렉토리 구조를 사용하면 `references/` 폴더에 참고 자료를 분리하여 관리할 수 있습니다.

### 셸 명령 실행 (!`command`)

`` !`command` `` 문법으로 커맨드 로드 시점에 셸 명령을 실행하고 그 결과를 본문에 포함합니다.

```markdown
---
description: 현재 브랜치의 변경사항을 리뷰합니다
---

현재 브랜치의 변경 파일 목록:
!`git diff main...HEAD --stat`

위 변경사항을 보안, 성능, 컨벤션 관점에서 리뷰하세요.
```

셸 명령은 **커맨드가 로드되는 시점**에 실행됩니다. Claude가 판단하여 실행하는 것이 아니라, 커맨드 호출 즉시 결정적으로 실행된다는 점이 중요합니다.

# 4. CLAUDE.md vs Commands - 역할 구분

---

초보자가 가장 혼란스러워하는 부분이 "CLAUDE.md에 쓸 것인가, Commands로 만들 것인가"입니다. 공식 문서의 설명은 다음과 같습니다.

> CLAUDE.md loads automatically every session and is best for "always do X" rules, such as coding conventions, build commands, or project structure. Skills, which load on demand, are suitable for reference material Claude needs occasionally or for workflows you trigger with a specific command.

## 핵심 차이

```text
CLAUDE.md:
  - 세션 시작 시 자동으로 로드
  - 사용자 호출 불필요
  - "항상 적용되는 규칙"에 적합
  - 예: 코드 스타일, 빌드 명령어, 디렉토리 구조, 프로젝트 컨벤션

Commands (.md 파일):
  - /name으로 명시적 호출 필요
  - 사용자가 실행 타이밍 결정
  - "가끔 실행하는 워크플로우"에 적합
  - 예: PR 리뷰, 블로그 포스트 작성, 테스트 실행, 배포
```

## 비교표

| 항목 | CLAUDE.md | Commands |
|------|----------|----------|
| **로드 시점** | 세션 시작 시 자동 | `/name` 호출 시 |
| **용도** | 프로젝트 규칙/지침 | 반복 작업 자동화 |
| **영향 범위** | 모든 Claude 응답에 적용 | 커맨드 실행 중에만 적용 |
| **내용 예시** | 코딩 컨벤션, 빌드 방법 | 테스트 실행, 포스트 작성 |
| **권장 길이** | 약 500줄 이내 | 작업에 필요한 만큼 |
| **변경 빈도** | 낮음 (프로젝트 초기 설정) | 보통 (워크플로우 개선 시) |

## 판단 기준

```text
CLAUDE.md에 넣을 것:
  - "항상 이렇게 해야 한다" → 코딩 컨벤션, 네이밍 규칙
  - "이 프로젝트는 이런 구조다" → 디렉토리 레이아웃, 아키텍처
  - "빌드는 이 명령어로" → 참조 정보

Commands로 만들 것:
  - "이 작업을 자동화하고 싶다" → 반복 워크플로우
  - "여러 단계를 한 번에 실행" → 파이프라인, 체이닝
  - "특정 상황에서만 필요하다" → 조건부 실행
```

## 흔한 실수

```text
잘못된 사용:
  CLAUDE.md에 "코드를 수정할 때마다 초보자용 주석을 상세히 달아줘"
  → 모든 응답에 영향을 줌. 과도한 주석이 항상 생성됨.

올바른 사용:
  CLAUDE.md에 "주석은 JSDoc 스타일로 작성한다" (규칙만 명시)
  Commands에 /add-docs "대상 파일에 초보자용 상세 주석을 추가한다" (필요할 때만 호출)
```

CLAUDE.md가 500줄을 넘어간다면, 참고 자료 성격의 내용은 Skills로 분리하는 것이 좋습니다. CLAUDE.md는 매 세션마다 전부 로드되므로 핵심 규칙만 남기고 나머지는 필요할 때 로드되도록 하는 것이 토큰 효율상 유리합니다.

# 5. 실전 예시: `/post` 커맨드

---

여기서는 실제로 사용 중인 블로그 포스트 작성 커맨드를 예시로 보겠습니다.

## 요구사항

개발 작업을 마친 후 블로그 포스트를 작성하는 워크플로우는 다음과 같습니다.

1. 세션에서 다룬 내용을 분석하여 블로그 초안 생성
2. 초안을 기술적으로 검증하고 퀄리티 개선

이 과정을 매번 프롬프트로 작성하는 대신, `/post` 한 줄로 실행하고 싶습니다.

## 구현

유저 레벨에 배치하여 어느 프로젝트에서든 호출할 수 있도록 합니다.

```markdown
// 파일 위치: ~/.claude/commands/post.md

---
description: 현재 세션 내용을 분석하여 블로그 포스트를 작성하고 퀄리티를 개선합니다
---

현재 세션에서 다룬 내용을 기반으로 블로그 포스트를 작성하고 퀄리티를 높여주세요.

## 대상 세션 유형

이 커맨드는 다음 두 가지 경우 모두에 사용할 수 있습니다:

1. **개발 작업 세션**: 코드 구현, 버그 수정, 리팩토링 등 코드 변경이 있는 경우
2. **기술 개념 학습 세션**: 기술적 개념 논의, 도구 사용법 비교, 설정 방법 등 코드 변경 없이 지식을 다룬 경우

세션 내용을 분석하여 어떤 유형인지 판단하고, 그에 맞는 블로그 포스트를 작성하세요.

## 워크플로우

다음 두 단계를 **순서대로** 실행하세요:

### Step 1: 초안 작성

Task 도구로 서브에이전트를 실행하여 블로그 초안을 작성하세요.

- **개발 작업 세션**: 코드 변경, 구현 내역 등을 기반으로 초안 생성
- **기술 개념 학습 세션**: 세션에서 논의된 개념, 비교, 사용법 등을 정리하여 초안 생성
- 완료되면 생성된 파일 경로를 확인

### Step 2: 퀄리티 개선

Step 1에서 생성된 초안 파일 경로를 전달하여 폴리셔 서브에이전트를 실행하세요.

- 구조 개선, 기술 정확성 검증, 코드 예시 보강
- Context7 MCP를 활용한 라이브러리/API 레퍼런스 검증

## 주의사항

- Step 1이 완료된 후에 Step 2를 실행하세요 (순차 실행)
- Step 1에서 생성된 파일 경로를 Step 2 프롬프트에 명시적으로 전달하세요
- 최종 결과물의 파일 경로를 사용자에게 알려주세요
```

## 이 커맨드의 핵심 패턴

위 커맨드에는 실전에서 자주 쓰이는 세 가지 패턴이 들어 있습니다.

```text
1. 서브에이전트 체이닝 (Subagent Chaining):
   - Task 도구로 초안 작성 에이전트 실행
   - 그 결과(파일 경로)를 퀄리티 개선 에이전트에 전달
   - 각 서브에이전트는 독립된 컨텍스트에서 실행
   - 메인 컨텍스트가 오염되지 않는 장점

2. 조건부 로직:
   - 세션 유형(개발 작업 vs 개념 학습)을 Claude가 판단
   - 유형에 따라 다른 방식으로 초안 생성

3. 도구 연계:
   - Task 도구 (서브에이전트 실행)
   - Read/Write 도구 (파일 조작)
   - Context7 MCP (기술 정확성 검증)
```

## 사용 방법

```bash
# 개발 작업 완료 후
cd my-project
claude

> 배당금 API를 구현했어요. (작업 내용에 대한 대화 진행)
> /post

# Claude Code가 자동으로:
# 1. 세션 컨텍스트를 분석
# 2. 서브에이전트로 초안 생성
# 3. 서브에이전트로 퀄리티 개선
# 4. 최종 파일 경로 반환
```

# 6. 커맨드 작성 팁

---

## 좋은 커맨드의 조건

```text
1. 명확한 단계 정의:
   "1. 이것을 한다", "2. 그 다음 저것을 한다"
   모호한 지시 대신 구체적인 절차를 나열

2. 오류 처리 명시:
   "파일이 없으면 사용자에게 알려줘"
   "테스트가 실패하면 실패 원인을 분석해"

3. 출력 형식 지정:
   "결과를 마크다운 테이블로 정리"
   "최종 파일 경로를 사용자에게 반환"

4. 도구 제한 활용:
   읽기 전용 커맨드는 allowed-tools를 Read, Grep, Glob으로 제한
   파일 수정이 필요한 커맨드만 Write, Edit 허용
```

## 피해야 할 패턴

```text
너무 일반적인 지시:
  "코드를 개선해줘" → 무엇을 어떤 기준으로 개선할 것인지 불분명

단계 누락:
  "테스트하고 커밋해" → 테스트 실패 시 어떻게 할 것인지 없음

CLAUDE.md와 중복:
  Commands에 코딩 스타일 규칙을 또 작성 → CLAUDE.md에만 유지

과도한 자동 권한:
  "모든 파일을 자동으로 수정하고 커밋해" → 사용자 확인 단계 필요
```

## 네임스페이싱

커맨드가 많아지면 파일명에 접두사를 붙여 분류할 수 있습니다.

```text
.claude/commands/
├── blog-draft.md       → /blog-draft
├── blog-polish.md      → /blog-polish
├── review-pr.md        → /review-pr
├── review-security.md  → /review-security
└── test-unit.md        → /test-unit
```

# 7. 자주 겪는 문제와 해결법

---

| 증상 | 원인 | 해결 |
|------|------|------|
| `/name` 입력해도 커맨드가 안 뜸 | 파일 위치가 잘못됨 | `.claude/commands/name.md` 경로 확인 |
| 인자가 전달되지 않음 | `$ARGUMENTS` 오타 | 대소문자 정확히 `$ARGUMENTS` 또는 `$1` 사용 |
| 커맨드가 예상과 다르게 동작 | frontmatter YAML 문법 오류 | `---`로 시작과 끝을 정확히 감싸는지 확인 |
| 자동 호출이 안 됨 | `description` 미설정 | frontmatter에 `description` 추가 |
| 팀원이 커맨드를 못 씀 | 유저 레벨에 저장됨 | `~/.claude/` 대신 프로젝트의 `.claude/`로 이동 |
| `@path` 파일이 포함 안 됨 | 경로가 잘못됨 | 커맨드 파일 기준 상대 경로 확인 |

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Commands = Skills** | 동일한 기능. `.claude/commands/name.md` 또는 `.claude/skills/name/SKILL.md` |
| **파일 위치** | `~/.claude/commands/` (유저, 전체 프로젝트) 또는 `.claude/commands/` (프로젝트 전용) |
| **호출 방식** | `/name` (수동 호출) 또는 Claude가 description 기반으로 자동 호출 |
| **vs CLAUDE.md** | CLAUDE.md는 매 세션 자동 로드(규칙), Commands는 명시적 호출(워크플로우) |
| **동적 요소** | `$ARGUMENTS` (인자), `@path` (파일 포함), `` !`cmd` `` (셸 실행) |
| **Frontmatter** | `description`, `argument-hint`, `allowed-tools`로 메타데이터 설정 |

```text
핵심:
  CLAUDE.md = "이 프로젝트는 이런 규칙을 따른다" (항상 적용)
  Commands  = "이 작업을 자동화하자" (필요할 때 호출)

  자주 반복하는 작업이 있다면 Commands로 만들어 효율을 높이세요.
  CLAUDE.md가 500줄을 넘기면, 참고 자료를 Skills로 분리하는 것을 검토하세요.
```

# Reference

---

- [Claude Code Slash Commands 공식 문서](https://code.claude.com/docs/en/slash-commands)
- [Claude Code 기능 비교 (CLAUDE.md vs Skills)](https://code.claude.com/docs/en/features-overview)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- 관련 포스트: [Skills - 커스텀 슬래시 커맨드로 반복 작업 자동화](/claudecode/claude-code-skills/)
