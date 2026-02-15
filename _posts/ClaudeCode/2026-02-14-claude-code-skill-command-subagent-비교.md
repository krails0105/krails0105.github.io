---
title: "[Claude Code] Skill vs Custom Command vs Subagent 완벽 비교"
categories:
  - ClaudeCode
tags:
  - [Claude Code, Skill, Custom Command, Subagent, Progressive Disclosure, 확장 메커니즘]
---

# Introduction

---

Claude Code를 사용하다 보면 "프로젝트 규칙을 CLAUDE.md에 넣어야 할까, Skill로 만들어야 할까?", "Custom Command와 Skill은 뭐가 다르지?"라는 질문이 생깁니다. 공식 문서에서 Skill, Custom Command, Custom Subagent, MCP라는 확장 메커니즘을 제공하는데, 각각의 설계 목적과 동작 방식이 다르기 때문에 올바르게 선택하지 않으면 컨텍스트 낭비나 의도하지 않은 자동 실행 같은 문제가 발생할 수 있습니다.

이 글에서는 **Claude Code 확장 메커니즘의 차이점과 선택 기준**을 정리합니다. 특히 Skill의 핵심 기능인 **Progressive Disclosure(단계적 공개)**와 **Invocation Control(호출 제어)** 개념을 중심으로, 각 메커니즘의 파일 구조, frontmatter 설정, 실행 환경까지 다룹니다.

# 1. CLAUDE.md vs Skill - 기본 차이

---

## CLAUDE.md - 프로젝트 메모리

**CLAUDE.md**는 프로젝트 디렉토리에 두는 Markdown 파일로, Claude Code 세션 시작 시 **자동으로 컨텍스트에 로드**됩니다. 프로젝트 전체에 항상 적용되는 규칙을 담는 "프로젝트 메모리" 역할을 합니다.

**CLAUDE.md 계층 구조:**

Claude Code는 CLAUDE.md를 다음 계층에서 찾아 로드합니다. 아래로 갈수록 우선순위가 높습니다.

| 메모리 유형 | 위치 | 용도 | 공유 범위 |
|-------------|------|------|-----------|
| **Managed policy** | OS별 시스템 경로 | 조직 전체 정책 | 조직 전체 |
| **User memory** | `~/.claude/CLAUDE.md` | 개인 전역 설정 | 본인 (모든 프로젝트) |
| **Project memory** | `./CLAUDE.md` 또는 `./.claude/CLAUDE.md` | 팀 공유 프로젝트 규칙 | 팀 (버전 관리) |
| **Project rules** | `./.claude/rules/*.md` | 주제별 모듈화된 규칙 | 팀 (버전 관리) |
| **Project local** | `./CLAUDE.local.md` | 개인 프로젝트 설정 | 본인 (현재 프로젝트) |
| **Auto memory** | `~/.claude/projects/<project>/memory/` | Claude 자동 학습 메모 | 본인 (프로젝트별) |

**로딩 동작:**

- 현재 작업 디렉토리에서 **루트 방향으로 재귀 탐색**하여 모든 CLAUDE.md를 로드
- 하위 디렉토리의 CLAUDE.md는 Claude가 해당 디렉토리의 파일을 읽을 때 **온디맨드 로드**
- Auto memory는 `MEMORY.md`의 **처음 200줄만** 시스템 프롬프트에 로드
- 더 구체적인 위치의 규칙이 상위 규칙보다 **우선**

**특징:**
- 세션 시작 시 자동 로드 (사용자 명령 불필요)
- 프로젝트 전역 규칙에 적합 ("항상 X 해라")
- 예시: 코드 스타일, 프로젝트 구조, 커밋 규칙, 자주 쓰는 빌드 명령어

## Skill - On-Demand 확장 기능

**Skill**은 `.claude/skills/<skill-name>/SKILL.md` 형태로 저장하는 확장 기능으로, **필요할 때만 로드**됩니다. 특정 워크플로우, 레퍼런스 문서, 복잡한 작업 절차를 담는 데 적합합니다.

**특징:**
- 사용자가 `/skill-name`으로 호출하거나, Claude가 필요하다고 판단할 때 로드
- 대용량 레퍼런스, 복잡한 워크플로우에 적합
- Progressive Disclosure로 컨텍스트를 효율적으로 사용
- 디렉토리 단위로 관리하여 보조 파일(템플릿, 스크립트 등) 포함 가능
- 예시: API 문서, 테스트 작성 가이드, 배포 절차

**Skill이 저장되는 위치:**

| 위치 | 경로 | 적용 범위 |
|------|------|-----------|
| **Enterprise** | 관리자 설정 경로 | 조직 전체 |
| **Personal** | `~/.claude/skills/<skill-name>/SKILL.md` | 본인의 모든 프로젝트 |
| **Project** | `.claude/skills/<skill-name>/SKILL.md` | 현재 프로젝트 |
| **Plugin** | `<plugin>/skills/<skill-name>/SKILL.md` | 플러그인 활성화된 프로젝트 |

이름이 같은 Skill이 여러 위치에 있으면 enterprise > personal > project 순으로 우선순위가 적용됩니다.

## 선택 기준

| 질문 | CLAUDE.md | Skill |
|------|-----------|-------|
| **항상 적용되어야 하는가?** | Yes | No (필요할 때만) |
| **특정 작업에만 필요한가?** | No | Yes |
| **보조 파일(스크립트, 템플릿)이 필요한가?** | No | Yes |
| **레퍼런스 성격인가?** | No | Yes |

```
간단한 규칙:
- "항상 X 해라" → CLAUDE.md
- "Y 작업할 때 이렇게 해라" → Skill
```

# 2. Custom Command는 Skill에 통합됨

---

공식 문서에 따르면, **Custom Command는 Skill에 통합(merge)**되었습니다. 기존 Custom Command 파일은 계속 동작하며, Skill과 동일한 frontmatter를 지원합니다.

**파일 위치:**
- Custom Command: `.claude/commands/review.md`
- Skill: `.claude/skills/review/SKILL.md`

**호출 방법:**
- 두 형식 모두 `/review`로 호출 가능
- 같은 이름의 Skill과 Custom Command가 동시에 존재하면, **Skill이 우선**

**Skill이 Custom Command보다 나은 점:**
- 디렉토리 구조로 **보조 파일**(참조 문서, 스크립트, 템플릿 등)을 함께 관리 가능
- `disable-model-invocation`, `user-invocable` 등 **호출 제어 옵션** 제공
- Claude가 필요 시 **자동으로 로드**하는 기능 지원

**권장 사항:**
- 새로 만들 때는 Skill 형식 사용
- 기존 Custom Command는 굳이 마이그레이션하지 않아도 됨

> **참고**: 이 글에서 비교 목적으로 "Custom Command"를 별도로 언급하지만, 현재 공식 문서에서는 모두 "Skill"로 통합되었습니다.

# 3. MCP와의 비교

---

MCP(Model Context Protocol)는 Claude가 **외부 시스템에 접근**하기 위한 프로토콜입니다. GitHub, Slack, 데이터베이스 등에 직접 접근해야 할 때 사용합니다.

| 기준 | Skill | MCP |
|------|-------|-----|
| **역할** | 업무 매뉴얼 (절차/규칙 제공) | 외부 시스템 연결 (도구 제공) |
| **작동 방식** | 자연스러운 대화 중 자동 사용 또는 `/name` 호출 | 자연스러운 대화 중 자동 사용 |
| **이식성** | 모든 Claude 제품에서 동작 | MCP를 지원하는 플랫폼에서 동작 |
| **메모리 효율** | Progressive Disclosure (3단계 로딩) | 도구 정의를 한꺼번에 로딩 |
| **스크립트 실행** | 미리 작성된 스크립트 직접 실행 | 서버가 실행 (Claude는 결과만 받음) |
| **적합한 상황** | 반복 작업 자동화, 워크플로우 정의 | GitHub API, DB 조회 등 외부 연동 |

Skill과 MCP는 서로 보완적입니다. Skill이 "어떻게 작업할지"를 정의하고, MCP가 "어떤 도구로 접근할지"를 제공합니다. 예를 들어, PR 리뷰 Skill이 MCP를 통해 GitHub API에 접근하는 식으로 함께 사용할 수 있습니다.

# 4. Skill vs Custom Subagent - 핵심 비교

---

Custom Command가 Skill에 통합되었으므로, 실질적으로 선택해야 하는 것은 **Skill과 Custom Subagent** 두 가지입니다. 각각 **파일 위치, 실행 방식, 컨텍스트 관리, 실행 환경**에서 차이가 있습니다.

## 파일 위치와 구조

```
.claude/
├── skills/                          # Skill
│   └── review/
│       ├── SKILL.md                 # 필수 - 메인 지침
│       ├── examples/
│       │   └── sample.md            # 선택 - 예제
│       └── scripts/
│           └── validate.sh          # 선택 - 실행 스크립트
│
├── agents/                          # Custom Subagent
│   └── code-reviewer.md             # 서브에이전트 정의 파일
│
└── commands/                        # Custom Command (레거시)
    └── review.md                    # Skill과 동일하게 동작
```

Skill은 **디렉토리 단위**(`SKILL.md` + 보조 파일들)이고, Subagent는 **단일 Markdown 파일**입니다.

## 이식성 (Portability)

| 메커니즘 | 동작 범위 |
|----------|----------|
| **Skill** | **모든 Claude 제품** (Claude Code, Claude Desktop, Claude.ai 등) |
| **Custom Command** | Claude Code 전용 |
| **Custom Subagent** | Claude Code 전용 |
| **MCP** | MCP를 지원하는 플랫폼 |

Skill은 Claude 제품군 전체에서 동작하는 유일한 확장 메커니즘입니다. 작성한 Skill을 Claude Code에서 테스트하고, 동일한 파일을 Claude Desktop에서도 사용할 수 있습니다.

## 실행 방식 (Invocation)

| 메커니즘 | 호출 방법 |
|----------|----------|
| **Skill** | 사용자 `/skill-name`으로 수동 호출 + Claude가 필요 시 자동 로드 |
| **Custom Subagent** | Claude가 작업 특성을 보고 자동 위임 |

- Skill은 **Invocation Control** 옵션으로 호출 방식을 제어할 수 있습니다 (뒤에서 자세히 설명).
- Custom Subagent는 Claude가 Subagent의 `description`을 보고 "이 작업에 전문가가 필요하다"고 판단하면 자동으로 위임합니다. 사용자가 "code-reviewer subagent를 사용해서 리뷰해줘"처럼 명시적으로 요청할 수도 있습니다.

## 컨텍스트 관리 (Context Usage)

| 메커니즘 | 컨텍스트 로드 방식 |
|----------|------------------|
| **Skill** | Progressive Disclosure - description만 항상 로드, 본문과 참조 파일은 필요할 때만 로드 |
| **Custom Subagent** | 격리된 별도 컨텍스트에서 실행, 시스템 프롬프트(본문) 전체 로드 |

- Skill의 Progressive Disclosure는 이 글의 핵심 개념으로, 다음 섹션에서 자세히 다룹니다.
- Subagent는 메인 대화의 컨텍스트와 완전히 분리되므로, 대화 이력에 접근할 수 없지만 메인 세션 컨텍스트를 보존하는 장점이 있습니다.

## 실행 환경 (Execution Context)

| 메커니즘 | 실행 위치 | 도구 접근 |
|----------|----------|-----------|
| **Skill** | 메인 에이전트 (`context: fork` 설정 시 서브에이전트) | 메인 세션 도구 + `allowed-tools`로 제한 가능 |
| **Custom Subagent** | 항상 격리된 서브에이전트 | `tools`, `disallowedTools`로 제어 |

- Skill의 `context: fork` 설정은 Skill을 별도 서브에이전트에서 실행하는 옵션입니다 (7장에서 자세히 설명).
- Custom Subagent는 **항상** 격리된 환경에서 실행되며, 독자적인 모델 선택(`model`), 권한 모드(`permissionMode`), 지속 메모리(`memory`) 등을 설정할 수 있습니다.

## Frontmatter 필드 비교

두 메커니즘의 frontmatter에서 설정 가능한 필드가 다릅니다.

| 필드 | Skill | Subagent | 설명 |
|------|:-----:|:--------:|------|
| `name` | O | O (필수) | 식별자 |
| `description` | O (권장) | O (필수) | 용도 및 트리거 조건 설명 |
| `allowed-tools` | O | - | Skill 활성 시 허용 도구 |
| `tools` | - | O | Subagent 사용 가능 도구 |
| `disallowedTools` | - | O | Subagent 사용 금지 도구 |
| `disable-model-invocation` | O | - | Claude 자동 호출 방지 |
| `user-invocable` | O | - | 사용자 메뉴 노출 제어 |
| `context` | O (`fork`) | - | 서브에이전트 실행 여부 |
| `agent` | O | - | fork 시 사용할 에이전트 타입 |
| `model` | O | O | 사용할 모델 (sonnet, opus, haiku) |
| `argument-hint` | O | - | 자동완성 시 인자 힌트 |
| `permissionMode` | - | O | 권한 처리 모드 |
| `maxTurns` | - | O | 최대 에이전트 턴 수 |
| `skills` | - | O | 사전 로드할 Skill 목록 |
| `memory` | - | O | 지속 메모리 스코프 (user, project, local) |
| `hooks` | O | O | 라이프사이클 훅 |

# 5. Composable - 여러 Skill의 자동 조합

---

Skill의 중요한 특성 중 하나는 **여러 Skill을 자동으로 조합**하여 복잡한 작업을 완성할 수 있다는 것입니다. Claude가 작업에 필요한 Skill을 자동으로 파악하고 조합합니다.

예를 들어, "워드 문서에 데이터 차트를 넣어줘"라고 요청하면 Claude는 문서 생성 스킬과 차트 생성 스킬을 자동으로 조합하여 사용합니다. 사용자가 어떤 Skill을 사용할지 명시적으로 지정할 필요가 없습니다.

이것은 Custom Command나 Subagent와 다른 특성입니다.

| 메커니즘 | 자동 조합 | 이유 |
|----------|----------|------|
| **Skill** | 가능 | description 기반으로 Claude가 필요한 Skill을 선별하여 조합 |
| **Custom Command** | 불가 | 사용자가 명시적으로 호출해야 함 |
| **Custom Subagent** | 제한적 | Claude가 하나의 Subagent에 위임. 다만 Subagent가 Skill을 사전 로드(`skills` 필드)할 수는 있음 |

# 6. Progressive Disclosure - Skill의 핵심 기능

---

**Progressive Disclosure(단계적 공개)**는 Skill이 컨텍스트를 효율적으로 사용하는 핵심 메커니즘입니다. 필요한 정보만 단계적으로 로드하여 **컨텍스트 낭비를 줄이고 할루시네이션을 감소**시킵니다.

## 3단계 로딩 구조

Skill의 내용은 다음 세 단계로 나뉘어 로드됩니다.

### 레벨 1: Description (항상 로드)

`SKILL.md`의 `description` 필드는 **세션 시작 시 항상 컨텍스트에 로드**됩니다. Claude는 이 정보를 보고 "이 Skill이 현재 작업에 필요한가?"를 판단합니다.

```yaml
# .claude/skills/api-docs/SKILL.md
---
name: api-reference
description: Internal REST API documentation with endpoints, request/response schemas, and authentication details. Use when asking about API endpoints or integration.
---
```

- `description`이 명확하고 구체적일수록 Claude가 적절한 타이밍에 Skill을 로드합니다. 공식 문서에서는 사용자가 말할 법한 **구체적 트리거 문구**를 포함하도록 권장합니다.
- `description`이 생략되면 본문의 첫 문단이 대신 사용됩니다.
- 이 단계에서 소모되는 컨텍스트는 극히 적습니다 (description 1~2줄).
- Skill description의 총 크기는 **컨텍스트 윈도우의 2%** (fallback: 16,000자)까지 허용됩니다. 이 한도를 초과하면 일부 Skill이 제외될 수 있으며, `/context` 명령어로 확인할 수 있습니다.

### 레벨 2: 본문 (Skill 트리거 시 로드)

사용자가 `/api-reference`로 호출하거나, Claude가 "이 Skill이 필요하다"고 판단하면 **`SKILL.md`의 본문 전체**가 로드됩니다.

- 본문은 **500줄 이하 권장** (강제 제한이 아니라 가이드라인)
- 본문에서 다른 파일을 참조할 수 있습니다 (레벨 3으로 이어짐)

### 레벨 3+: 보조 파일 (Claude가 필요하다고 판단할 때만 로드)

본문에서 `reference.md`, `examples.md` 같은 보조 파일을 참조하면, Claude는 **필요하다고 판단할 때만** 해당 파일을 읽습니다.

```markdown
# SKILL.md 본문 예시 - 보조 파일 참조

This skill provides API documentation.

## Additional resources

- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

- 사용자가 "사용자 API 사용 예제 보여줘"라고 물으면 `examples.md`만 읽습니다.
- API 상세 스펙이 필요 없으면 `reference.md`는 로드되지 않습니다.

## Progressive Disclosure의 장점

| 장점 | 설명 |
|------|------|
| **컨텍스트 절약** | 필요한 정보만 로드하여 토큰 낭비 방지 |
| **할루시네이션 감소** | 불필요한 정보가 컨텍스트에 없으므로 혼동 가능성 감소 |
| **대용량 문서 지원** | 수천 줄짜리 API 문서도 효율적으로 관리 가능 |
| **컨텍스트 윈도우 확장** | 같은 컨텍스트로 더 많은 정보를 다룰 수 있음 |

## 예시: API 문서 Skill 구조

```
.claude/skills/api-docs/
├── SKILL.md                    # description + 개요 (레벨 1, 2)
├── reference.md                # API 상세 스펙 (레벨 3)
├── examples.md                 # 사용 예제 (레벨 3)
├── endpoints/
│   ├── users.md               # 사용자 API (레벨 3)
│   ├── products.md            # 상품 API (레벨 3)
│   └── orders.md              # 주문 API (레벨 3)
└── scripts/
    └── helper.py              # 유틸리티 스크립트 (실행 전용)
```

- 사용자가 "상품 API는 어떻게 써?"라고 물으면, Claude는 `endpoints/products.md`만 읽습니다.
- `users.md`, `orders.md`, `reference.md`는 컨텍스트에 로드되지 않습니다.
- `scripts/` 디렉토리의 스크립트는 Claude가 실행하는 용도이며 컨텍스트에 로드하지 않습니다.

# 7. Invocation Control - Skill 호출 제어

---

Skill의 `SKILL.md` frontmatter에서 **누가 Skill을 호출할 수 있는지** 제어할 수 있습니다. 이는 의도하지 않은 자동 실행을 방지하는 안전 장치입니다.

## disable-model-invocation

```yaml
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---
```

- `disable-model-invocation: true`로 설정하면 **사용자만 `/deploy`로 호출 가능**하고, Claude는 자동으로 호출하지 못합니다.
- `/deploy`, `/commit` 같은 **부작용이 있는 작업**에 사용합니다.
- **description이 컨텍스트에 로드되지 않습니다.** Claude가 이 Skill의 존재를 모르기 때문에 자동 호출 자체가 불가능합니다.

**공식 문서의 설명:**
> "You don't want Claude deciding to deploy because your code looks ready."

Claude가 "코드가 괜찮아 보이네, 배포하자!"라고 자동으로 배포하는 상황을 방지합니다.

## user-invocable

```yaml
---
name: legacy-system-context
description: Internal legacy system architecture and migration notes
user-invocable: false
---
```

- `user-invocable: false`로 설정하면 **Claude만 호출 가능**하고, 사용자의 `/` 메뉴에는 나타나지 않습니다.
- 배경지식, 레거시 시스템 문서처럼 "Claude가 필요할 때 참고하면 되는" 정보에 사용합니다.
- `/legacy-system-context`는 사용자가 직접 실행할 의미가 없는 명령이므로, 메뉴에서 숨기는 것이 적절합니다.

## 기본 동작과 비교표

기본값은 **사용자와 Claude 모두 호출 가능**입니다.

| 설정 | 사용자 호출 | Claude 호출 | 컨텍스트 로딩 |
|------|-----------|------------|--------------|
| 기본 (미설정) | O | O | description 항상 로드, 본문은 호출 시 로드 |
| `disable-model-invocation: true` | O | X | description 미로드, 본문은 사용자 호출 시 로드 |
| `user-invocable: false` | X | O | description 항상 로드, 본문은 호출 시 로드 |

> **참고**: `user-invocable` 필드는 `/` 메뉴 노출만 제어합니다. Claude의 Skill 도구 접근 자체를 차단하려면 `disable-model-invocation: true`를 사용하세요.

# 8. 스크립트 번들링 - Skill의 강력한 패턴

---

Skill은 디렉토리 구조를 가지므로 **스크립트 파일을 함께 번들링**하여, Claude가 직접 실행하도록 지시할 수 있습니다. 이를 통해 LLM의 비결정적 특성을 보완하거나, 시각적 출력을 생성할 수 있습니다.

## LLM의 비결정성 문제

Claude를 포함한 모든 LLM은 **비결정적(non-deterministic)**입니다. 동일한 질문에도 매번 다른 답변을 생성할 수 있습니다. 이는 다음 상황에서 문제가 됩니다.

- 코드베이스 구조를 일관된 형태로 시각화
- 로그 파일에서 정해진 포맷으로 파싱
- 정형화된 데이터 변환이나 검증

## Skill의 스크립트 번들링

Skill 디렉토리에 Python, Shell 등의 스크립트를 포함하고, `SKILL.md`에서 Claude가 해당 스크립트를 실행하도록 지시합니다.

```yaml
# .claude/skills/codebase-visualizer/SKILL.md
---
name: codebase-visualizer
description: Generate an interactive tree visualization of your codebase. Use when exploring a new repo or understanding project structure.
allowed-tools: Bash(python *)
---

# Codebase Visualizer

Run the visualization script from your project root:

```bash
python ~/.claude/skills/codebase-visualizer/scripts/visualize.py .
```

This creates `codebase-map.html` and opens it in your browser.
```

```
.claude/skills/codebase-visualizer/
├── SKILL.md                          # 지침 (Claude가 읽음)
└── scripts/
    └── visualize.py                  # 실행 스크립트 (Claude가 실행함)
```

**동작 방식:**
1. 사용자: "이 프로젝트 구조를 시각화해줘"
2. Claude: description을 보고 Skill 로드 → 본문의 지시대로 스크립트 실행
3. 스크립트가 결정론적으로 HTML 파일 생성
4. Claude는 실행 결과만 받아서 사용자에게 전달

**핵심:**
- Claude는 스크립트 코드를 컨텍스트에 로드하지 않고 **실행만** 합니다.
- 스크립트의 **결정론적 특성**으로 동일 입력에 동일 출력을 보장합니다.
- `allowed-tools: Bash(python *)`로 필요한 도구만 허용하여 보안을 강화합니다.
- 이 패턴은 의존성 그래프, 테스트 커버리지 리포트, DB 스키마 시각화 등에 활용할 수 있습니다.

## 동적 컨텍스트 주입 (Dynamic Context Injection)

Skill은 `` !`command` `` 구문으로 쉘 명령의 출력을 본문에 삽입할 수 있습니다. 명령은 Claude가 내용을 보기 **전에** 실행되어, 결과가 자동으로 대치됩니다.

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

`` !`gh pr diff` `` 부분이 실행된 후, Claude는 실제 diff 결과가 포함된 프롬프트를 받습니다. 이는 전처리 과정이지 Claude가 실행하는 것이 아닙니다.

# 9. Context: Fork - Skill을 서브에이전트에서 실행

---

`context: fork` 설정은 Skill을 **별도 서브에이전트**에서 실행하도록 합니다. Skill의 본문이 서브에이전트의 작업(task/prompt)이 됩니다.

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:

1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

**동작 방식:**
1. Skill이 호출되면 새로운 격리된 컨텍스트 생성
2. `agent` 필드로 지정된 에이전트 타입이 실행 환경(모델, 도구, 권한)을 결정
3. SKILL.md 본문이 서브에이전트의 프롬프트로 전달됨
4. 서브에이전트가 작업 완료 후 결과가 요약되어 메인 세션에 반환

**`agent` 필드 옵션:**

| 에이전트 타입 | 모델 | 도구 | 용도 |
|---------------|------|------|------|
| `Explore` | Haiku (빠름) | 읽기 전용 | 코드베이스 탐색, 검색 |
| `Plan` | 메인 세션과 동일 | 읽기 전용 | 계획 수립을 위한 리서치 |
| `general-purpose` | 메인 세션과 동일 | 전체 도구 | 복잡한 다단계 작업 |
| 커스텀 에이전트 | 설정에 따라 | 설정에 따라 | `.claude/agents/`에 정의된 커스텀 |

`agent`를 생략하면 기본값은 `general-purpose`입니다.

**장점:**
- 메인 세션 컨텍스트 보존 (대화 흐름 유지)
- 서브에이전트가 복잡한 작업을 독립적으로 수행
- 여러 Skill을 병렬로 실행 가능 (각각 독립적 서브에이전트)

**Skill `context: fork`와 Subagent의 관계:**

이 두 메커니즘은 방향이 반대이지만, 내부적으로는 같은 시스템을 사용합니다.

| 방식 | 시스템 프롬프트 | 작업 내용 | 함께 로드되는 것 |
|------|----------------|-----------|-----------------|
| Skill + `context: fork` | agent 타입에서 결정 | SKILL.md 본문 | CLAUDE.md |
| Subagent + `skills` 필드 | Subagent의 본문 | Claude의 위임 메시지 | 사전 로드된 Skill + CLAUDE.md |

**언제 `context: fork`를 사용하는가:**
- 웹 검색, 긴 분석, 여러 파일 읽기 등 **컨텍스트를 많이 소모하는 작업**
- 메인 대화 흐름을 방해하지 않고 독립적 작업 수행

> **주의**: `context: fork`는 명확한 작업 지시가 있는 Skill에만 의미가 있습니다. "이 API 컨벤션을 따라라" 같은 가이드라인만 있고 구체적 작업이 없으면, 서브에이전트가 할 일이 없어 의미 있는 결과를 반환하지 못합니다.

# 10. SKILL.md Frontmatter 전체 레퍼런스

---

Skill의 `SKILL.md`에서 사용할 수 있는 모든 frontmatter 필드를 정리합니다. 모든 필드는 선택사항이며, `description`만 권장됩니다.

```yaml
---
name: my-skill
description: What this skill does and when to use it
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Grep, Glob
model: sonnet
context: fork
agent: Explore
argument-hint: [filename] [format]
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---

Skill instructions here...
```

| 필드 | 필수 | 기본값 | 설명 |
|------|:----:|--------|------|
| `name` | X | 디렉토리명 | Skill 식별자. 소문자, 숫자, 하이픈만 허용 (최대 64자) |
| `description` | 권장 | 본문 첫 문단 | Claude가 Skill을 언제 사용할지 판단하는 기준 |
| `disable-model-invocation` | X | `false` | `true`: 사용자만 호출 가능, Claude 자동 호출 방지 |
| `user-invocable` | X | `true` | `false`: `/` 메뉴에서 숨김, Claude만 호출 가능 |
| `allowed-tools` | X | 대화 권한 상속 | Skill 활성 시 허용 도구 (예: `Read, Write, Bash(git:*)`) |
| `model` | X | 상속 | 사용할 모델: `sonnet`, `opus`, `haiku` |
| `context` | X | - | `fork`로 설정 시 서브에이전트에서 실행 |
| `agent` | X | `general-purpose` | `context: fork` 시 사용할 에이전트 타입 |
| `argument-hint` | X | - | 자동완성 시 표시할 인자 힌트 (예: `[issue-number]`) |
| `hooks` | X | - | Skill 라이프사이클에 스코프된 훅 |

**인자 전달 (`$ARGUMENTS`):**

Skill 호출 시 인자를 전달할 수 있습니다. `/fix-issue 123`으로 호출하면 `$ARGUMENTS`가 `123`으로 치환됩니다.

```yaml
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.
```

개별 인자는 `$ARGUMENTS[0]` 또는 축약형 `$0`으로 접근합니다.

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the $0 component from $1 to $2.
```

`/migrate-component SearchBar React Vue`로 호출하면 `$0=SearchBar`, `$1=React`, `$2=Vue`가 됩니다.

# 11. Standalone vs Plugin - 배치 방식 선택

---

Skill을 배치하는 방식은 **Standalone**과 **Plugin** 두 가지입니다.

**Standalone** (`.claude/` 디렉토리에 직접 배치):
- 개인 워크플로우, 프로젝트별 커스터마이징, 빠른 실험에 적합
- `/skill-name`으로 바로 호출
- 설정 파일 등록이 불필요

**Plugin** (`.claude-plugin/plugin.json`이 있는 패키지):
- 팀원과 공유, 커뮤니티 배포, 버전 관리가 필요할 때 사용
- Skill + Agent + MCP 서버를 하나로 묶어 배포 가능
- `/plugin-name:skill-name`으로 네임스페이스가 붙어 호출
- marketplace 등록, plugin.json 매니페스트 등 배포 인프라 포함

| 기준 | Standalone | Plugin |
|------|-----------|--------|
| **파일 위치** | `~/.claude/skills/` 또는 `.claude/skills/` | `<plugin>/skills/` |
| **호출 방식** | `/skill-name` | `/plugin-name:skill-name` |
| **설정 필요** | 없음 (파일만 두면 동작) | plugin.json + 설치 등록 |
| **배포** | 불가 (로컬 전용) | marketplace를 통해 배포 가능 |
| **적합한 경우** | 개인 사용, 빠른 실험 | 팀/커뮤니티 배포 |

**개인 용도라면 Standalone으로 충분합니다.** 예를 들어 블로그 포스트 자동화 Skill을 만든다면, `~/.claude/skills/post/SKILL.md` 하나만 두면 `/post`로 호출할 수 있습니다. Plugin의 marketplace 등록이나 plugin.json 매니페스트는 배포를 위한 구조이므로 혼자 쓸 스킬에는 불필요한 복잡성입니다.

# 12. 실무 활용 - 어떤 메커니즘을 선택할까?

---

## CLAUDE.md vs Skill

| 질문 | 답변 | 선택 |
|------|------|------|
| 모든 작업에 적용되어야 하는가? | Yes | CLAUDE.md |
| 특정 상황에만 필요한가? | Yes | Skill |
| 보조 파일(스크립트, 템플릿)이 필요한가? | Yes | Skill |
| 대용량 레퍼런스 문서인가? | Yes | Skill |

## Skill vs Subagent

| 상황 | 권장 메커니즘 | 이유 |
|------|-------------|------|
| **대용량 레퍼런스 문서** | Skill | Progressive Disclosure로 필요한 부분만 로드 |
| **복잡한 워크플로우 (배포, 테스트)** | Skill + `disable-model-invocation` | 단계별 실행 + 사용자 제어 |
| **결정론적 작업 (파싱, 시각화)** | Skill + 스크립트 | 스크립트 번들링으로 일관된 결과 |
| **독립적인 전문가 역할 (코드 리뷰)** | Subagent | 격리된 환경 + 독자적 시스템 프롬프트 |
| **모델/권한을 다르게 설정** | Subagent | Subagent별 model, permissionMode 설정 가능 |
| **컨텍스트를 많이 소모하는 탐색** | Skill + `context: fork` 또는 Subagent | 메인 세션 컨텍스트 보존 |
| **세션 간 학습 지속** | Subagent + `memory` | 지속 메모리로 지식 축적 |

## 실무 예시

**CLAUDE.md에 담을 내용:**
- 프로젝트 코드 스타일 (항상 적용)
- 커밋 메시지 규칙
- 프로젝트 아키텍처 설명
- 자주 쓰는 빌드/테스트 명령어

**Skill로 만들 내용:**
- API 문서 (대용량, Progressive Disclosure 활용)
- 배포 절차 (`disable-model-invocation: true`로 안전하게)
- 코드베이스 시각화 (스크립트 번들링)
- PR 요약 (`context: fork` + 동적 컨텍스트 주입)

**Subagent로 만들 내용:**
- 코드 리뷰어 (읽기 전용 도구만 허용, 독자적 프롬프트)
- 디버거 (문제 진단 + 수정, 전체 도구 접근)
- 데이터 분석가 (특정 모델 지정, 도메인 전문 프롬프트)

# 13. 주의할 점

---

## Progressive Disclosure는 완벽하지 않다

Claude가 "필요한 파일을 판단"하는 과정은 여전히 LLM 기반입니다. 따라서:
- 가끔 필요한 파일을 로드하지 않을 수 있음
- 또는 불필요한 파일을 로드할 수 있음
- `description`에 **사용자가 말할 법한 구체적 트리거 문구**를 포함하여 정확도를 높일 수 있음
- Skill이 예상대로 트리거되지 않으면 `/skill-name`으로 직접 호출하거나, description을 수정

## SKILL.md 본문 크기는 500줄 이하 권장

공식 문서는 **500줄 이하**를 권장합니다. 이는 강제 제한이 아니라 가이드라인입니다. Progressive Disclosure의 효과를 최대화하려면 본문을 간결하게 유지하고, 상세 내용은 별도 보조 파일로 분리하는 것이 좋습니다.

## Skill description 총량에 한도가 있다

Skill description은 **컨텍스트 윈도우의 2%** (fallback: 16,000자)까지 로드됩니다. Skill이 많아서 이 한도를 초과하면 일부 Skill의 description이 제외됩니다. `/context` 명령어로 제외된 Skill이 있는지 확인할 수 있으며, `SLASH_COMMAND_TOOL_CHAR_BUDGET` 환경변수로 한도를 조절할 수 있습니다.

## disable-model-invocation은 안전장치

`/deploy`, `/commit` 같은 작업은 **반드시** `disable-model-invocation: true`를 설정하세요. Claude가 "코드가 준비된 것 같으니 자동으로 배포하자"라고 판단하는 상황을 방지합니다. 다만 공식 문서는 이 옵션을 과도하게 사용하면 Claude의 자율성을 제한하므로, **필요한 경우에만 사용**할 것을 권장합니다.

## context: fork는 만능이 아니다

서브에이전트가 독립적으로 동작하므로:
- 메인 세션의 대화 이력에 접근하지 못함
- 결과 반환 시 요약될 수 있음 (세부 정보 손실 가능)
- **명확한 작업 지시**가 있는 Skill에만 적합 (가이드라인만 담은 Skill에는 부적합)
- 가이드라인 성격의 Skill은 `context: fork` 없이 인라인으로 실행하는 것이 적절

## Subagent는 다른 Subagent를 생성할 수 없다

Subagent 내부에서 또 다른 Subagent를 호출하는 중첩은 불가능합니다. 다단계 워크플로우가 필요하면 메인 대화에서 Subagent를 **순차적으로 체인**하는 방식을 사용합니다.

# 정리

---

## 4가지 확장 메커니즘 종합 비교

| 기준 | Skill | Custom Command | Subagent | MCP |
|------|-------|---------------|----------|-----|
| **작동 방식** | 자동 + `/name` 호출 | `/name`으로 직접 호출 | Claude 자동 위임 | 자연스러운 대화 중 자동 사용 |
| **이식성** | 모든 Claude 제품 | Claude Code 전용 | Claude Code 전용 | MCP 지원 플랫폼 |
| **메모리 효율** | Progressive Disclosure (3단계 로딩) | 한꺼번에 로딩 | 격리된 별도 컨텍스트 | 도구 정의 한꺼번에 로딩 |
| **스크립트 실행** | 미리 작성된 스크립트 실행, 결과만 저장 | Claude가 매번 코드 생성 | Claude가 매번 코드 생성 | 서버가 실행, 결과만 반환 |
| **결과 일관성** | 스크립트로 100% 일관 | 확률적 (매번 다를 수 있음) | 확률적 | 서버 로직에 따라 일관 |
| **조합 사용** | 여러 Skill 자동 조합 | 불가 | 제한적 | 도구 단위 조합 |

## Skill vs Custom Subagent 핵심 비교

| 기준 | Skill | Custom Subagent |
|------|-------|-----------------|
| **파일 위치** | `.claude/skills/<name>/SKILL.md` | `.claude/agents/<name>.md` |
| **호출 방식** | 사용자 + Claude 자동 (제어 가능) | Claude 자동 위임 |
| **컨텍스트 효율** | Progressive Disclosure | 격리된 별도 컨텍스트 |
| **실행 환경** | 메인 에이전트 (fork 가능) | 항상 서브에이전트 |
| **보조 파일** | 디렉토리 구조로 지원 | 미지원 |
| **스크립트 번들링** | 가능 | 미지원 |
| **모델/권한 커스터마이징** | `model`, `allowed-tools` | `model`, `tools`, `permissionMode`, `memory` 등 |

## Progressive Disclosure 3단계

1. **레벨 1**: `description` (항상 로드 - `disable-model-invocation` 제외)
2. **레벨 2**: `SKILL.md` 본문 (Skill 트리거 시)
3. **레벨 3+**: 보조 파일들 (Claude가 필요 시)

## Invocation Control

| 설정 | 사용자 | Claude | 컨텍스트 로딩 |
|------|--------|--------|--------------|
| 기본 | O | O | description 항상 로드 |
| `disable-model-invocation: true` | O | X | description 미로드 |
| `user-invocable: false` | X | O | description 항상 로드 |

## 선택 기준 한 문장 정리

```
- "항상 적용되는 규칙" → CLAUDE.md
- "필요할 때 로드 + 보조 파일" → Skill
- "독립적 전문가 + 격리 실행" → Subagent
- "외부 시스템 연동" → MCP
- "부작용 있는 작업" → Skill + disable-model-invocation
- "결정론적 실행" → Skill + 스크립트 번들링
- "context: fork" → Skill을 Subagent처럼 실행
- "개인 워크플로우" → Standalone Skill (~/.claude/skills/)
- "팀/커뮤니티 배포" → Plugin Skill
```

# Reference

---

- [Claude Code 공식 문서 - Skills](https://code.claude.com/docs/en/skills)
- [Claude Code 공식 문서 - Custom Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code 공식 문서 - Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory)
- [Claude Code 공식 문서 - Permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code 공식 문서 - Plugins](https://code.claude.com/docs/en/plugins)
- [Agent Skills 오픈 표준](https://agentskills.io)
