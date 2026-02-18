---
title: "[ClaudeCode] Skill이 자동 발동되지 않는 이유 - 삽질부터 해결까지"
categories:
  - ClaudeCode
tags:
  - [Claude Code, Skill, SKILL.md, CLAUDE.md, Auto-Trigger, Progressive Disclosure]
---

# Introduction

---

Claude Code에서 블로그 포스트 작성용 `/post` Skill을 만들어 두고 "블로그 포스트 작성해줘"라고 요청했는데, Skill이 한 번도 자동으로 발동되지 않는 문제를 겪었습니다. Claude는 Skill을 무시하고 Task 도구로 에이전트를 직접 호출하고 있었습니다.

처음에는 "설정 파일에 문제가 있나?" 정도로 생각했지만, 원인을 파고들어 보니 Claude Code의 Skill 시스템 전체 구조를 잘못 이해하고 있었습니다. 더 심각했던 것은, **공식 문서를 직접 확인하지 않고 추측과 AI(Claude)의 잘못된 분석에 의존**했다는 점입니다.

이 글에서는 다음 내용을 다룹니다:

1. 문제 발견 -> 잘못된 분석 -> 공식 문서 확인 -> 해결까지의 전체 과정
2. AI(Claude)가 실수한 부분과 그 원인
3. Skill 자동 발동의 실제 메커니즘 (Progressive Disclosure, Model Invocation)
4. SKILL.md와 CLAUDE.md의 강제성 차이
5. 확실한 해결 방법과 실무 팁

**핵심 교훈**: AI가 답변한 내용도 반드시 공식 문서로 검증해야 합니다. 특히 Claude Code, MCP처럼 빠르게 변화하는 도구일수록 더욱 그렇습니다.

# 1. 문제 발견 - 예상과 다른 동작

---

## 상황 설명

블로그 개발 세션을 마치고 "블로그 포스트 작성해줘"라고 요청했을 때, 예상과 실제 동작이 달랐습니다.

| 구분 | 예상 동작 | 실제 동작 |
|------|-----------|-----------|
| **실행 흐름** | `/post` Skill이 자동 발동되어 정의된 워크플로우 실행 | Claude가 Skill을 무시하고 Task 도구로 에이전트를 직접 호출 |
| **경로** | 사용자 요청 -> Skill invoke -> 서브에이전트 실행 | 사용자 요청 -> Task 도구 직접 호출 |

## Claude의 응답

Claude는 "이미 내용을 알고 있어서 직접 호출했다"고 답변했습니다. 즉, Skill의 존재를 인지하고 있었지만, **자동 발동 대신 중간 단계를 건너뛰고 최종 목적지로 직행**한 것입니다.

## 당시 설정 파일

당시 `~/.claude/skills/post/SKILL.md` 파일은 다음과 같았습니다.

```yaml
---
name: post
description: 개발 세션을 Jekyll 블로그 포스트로 변환하는 워크플로우
triggers:
  - blog post
  - 블로그 포스트
  - 포스트 작성
---

## Auto-Trigger Conditions

다음 조건이 모두 충족되면 자동으로 실행:
1. 사용자가 블로그 포스트 작성을 요청
2. 개발 세션에 대한 내용 존재
3. Jekyll 블로그 디렉토리 존재
```

설정은 명확해 보였습니다. 그런데 왜 발동되지 않았을까요?

# 2. 초기 원인 분석 - 일부 맞고 일부 틀린 진단

---

이 단계에서 Claude(AI)에게 원인 분석을 요청했습니다. 분석 결과 중 맞는 부분과 틀린 부분이 함께 섞여 있었습니다.

## 맞게 분석한 부분

### "적용되어 있다"와 "발동된다"는 다르다

Skill 설정이 로드되어 있다고 해서 반드시 발동되는 것은 아닙니다. system-reminder에 Skill 목록이 표시되는 것은 **description만 로드된 상태**(레벨 1)라는 의미이지, 자동 발동을 보장하지 않습니다.

### SKILL.md의 Auto-Trigger 조건은 프로그래밍적 강제가 아니다

SKILL.md 본문에 "다음 조건이 모두 충족되면 자동으로 실행"이라고 적어도, 이것은 **AI에게 주는 텍스트 힌트**에 불과합니다. if-else 조건문처럼 시스템이 자동으로 검증하는 것이 아닙니다.

### CLAUDE.md가 SKILL.md보다 강제성이 높다

- **CLAUDE.md**: `"MUST follow exactly as written"` 수준의 시스템 지시로 주입됩니다.
- **SKILL.md description**: `"이런 Skill이 있다"` 수준의 참고 정보로 노출됩니다.

## 잘못 분석한 부분

여기부터 문제가 시작되었습니다. Claude(AI)가 `Skill("post")`를 시도했더니 `"Unknown skill: post"` 에러가 발생했고, 이를 근거로 다음과 같은 **잘못된 결론**을 내렸습니다.

### 틀린 분석 1: "~/.claude/skills/ 독립 Skill은 공식 문서에 없다"

> "Claude Code 공식 문서에는 플러그인 경로만 나와 있고, 사용자 스코프 독립 Skill 경로는 명시되지 않았다."

**실제**: `~/.claude/skills/<skill-name>/SKILL.md`는 **공식 지원 Personal Skill 경로**입니다. 공식 문서에도 명확히 나와 있으며, `mkdir -p ~/.claude/skills/explain-code`와 같은 예시까지 제공하고 있습니다.

### 틀린 분석 2: "Skill 도구로 호출하려면 플러그인 등록이 필수"

> "독립 Skill을 Skill 도구로 invoke하려면 플러그인 메타데이터(.claude-plugin.yml)가 필요하다."

**실제**: Personal Skill은 플러그인 구조 없이 `~/.claude/skills/` 디렉토리에 넣으면 **자동으로 discover**됩니다.

### 틀린 분석 3: "에러 하나로 시스템 구조 한계를 단정"

`"Unknown skill: post"` 에러를 보고 "시스템이 이 경로를 지원하지 않는다"고 단정 지었습니다.

**실제**: 해당 에러는 당시 세션에서의 Skill 로딩 문제였을 가능성이 높습니다. 에러 하나로 전체 구조를 판단한 것은 성급한 결론이었습니다.

### 왜 이런 실수가 발생했나

| 원인 | 설명 |
|------|------|
| 불완전한 검색 | Context7으로 플러그인 개발 문서만 참조, **공식 Skills 문서 페이지를 직접 읽지 않음** |
| 자체 결론에 대한 과신 | 공식 문서를 직접 확인하지 않고 AI 자체 추론에 의존 |
| 에러 과대 해석 | 단일 에러를 시스템 구조적 한계로 일반화 |

# 3. 공식 문서 확인 - 사용자의 반박과 정정

---

AI의 분석이 틀렸음을 알아차린 것은 **사용자가 공식 문서를 직접 확인**했기 때문입니다.

## 사용자가 제시한 근거

사용자가 [https://code.claude.com/docs/ko/skills](https://code.claude.com/docs/ko/skills) 페이지 스크린샷을 제시하며 AI의 분석이 틀렸음을 지적했습니다.

1. `~/.claude/skills/<skill-name>/SKILL.md`는 **공식 지원 Personal Skill 경로**이다
2. 기본값으로 Claude가 Skill을 자동 호출할 수 있다 (`disable-model-invocation: false`가 기본)
3. Commands는 Skills로 통합(merged)되었다
4. 우선순위: **enterprise > personal > project**

## WebFetch로 공식 문서 직접 확인

이후 AI가 직접 [https://code.claude.com/docs/ko/skills](https://code.claude.com/docs/ko/skills) 페이지를 WebFetch로 읽어서 핵심 내용을 확인했습니다. 아래에서 확인된 주요 개념들을 정리합니다.

# 4. 핵심 개념 정리 - Progressive Disclosure와 Model Invocation

---

공식 문서에서 확인한 Skill 시스템의 두 가지 핵심 개념입니다.

## Progressive Disclosure 3단계

Skill 로딩은 **단계적 공개(Progressive Disclosure)** 구조로 작동합니다. 한 번에 모든 내용을 컨텍스트에 넣는 것이 아니라, 필요한 시점에 필요한 만큼만 로드합니다.

| 레벨 | 로드되는 내용 | 로드 시점 | AI의 판단 |
|:---:|---|---|---|
| **1** | name + description (~100 words) | 항상 컨텍스트에 존재 | "이 Skill이 지금 필요한가?" 판단 |
| **2** | SKILL.md 본문 (<5k words) | Skill 트리거 시 로드 | 워크플로우 실행 |
| **3** | references/ 파일들 | 필요 시 로드 | 보조 정보 참조 |

**핵심 포인트**: 레벨 1에서 Claude는 **description만 보고** "이 Skill을 지금 사용할지"를 판단합니다. description이 모호하면 매칭 확률이 떨어집니다.

공식 문서에서도 이 점을 명확히 설명하고 있습니다:

> Claude matches your task against skill descriptions to decide which are relevant. If descriptions are vague or overlap, Claude may load the wrong skill or miss one that would help.

즉, description이 구체적이지 않으면 Claude가 해당 Skill을 "관련 없음"으로 판단하고 건너뛸 수 있습니다.

## 호출 제어 옵션

| Frontmatter 설정 | 사용자 `/` 호출 | Claude 자동 호출 | description 로드 |
|---|:---:|:---:|:---:|
| 기본값 (미설정) | O | O | O (항상) |
| `disable-model-invocation: true` | O | X | X (미로드) |

`disable-model-invocation: true`를 설정하면 description 자체가 컨텍스트에 로드되지 않습니다. Claude가 해당 Skill의 존재 자체를 모르게 되므로, 자동 호출이 원천 차단됩니다. 공식 문서 표현으로는 "invisible to Claude until you invoke them"입니다.

<!-- TODO: verify - 초안에 user-invocable: false 옵션이 있었으나, Context7 공식 문서에서 해당 옵션의 존재를 직접 확인하지 못했습니다. 공식 Skills 문서 페이지에서 직접 확인 필요합니다. -->

## 트러블슈팅 가이드 (공식 문서 기반)

공식 문서에서 제시하는 자동 발동 문제 해결법입니다.

| 문제 | 해결 방법 |
|------|----------|
| Skill이 트리거되지 않음 | description에 자연스러운 키워드와 구체적 트리거 문구 포함 |
| Skill이 너무 자주 트리거됨 | description을 더 구체적이고 좁은 범위로 수정 |
| Claude가 모든 Skill을 보지 못함 | 문자 예산(기본 15,000자) 초과 가능성 확인 (`/context` 명령으로 확인) |

## description 권장 패턴

공식 문서가 권장하는 description 작성 패턴은 다음과 같습니다.

```yaml
# 공식 예시
---
name: Hook Management Skill
description: >
  This skill should be used when the user asks to
  "create a hook", "add a PreToolUse hook", "validate tool use",
  "implement prompt-based hooks", or mentions hook events
  (PreToolUse, PostToolUse, Stop).
---
```

**패턴**: `"This skill should be used when the user asks to [구체적 발화 문구]"` 형태로, 사용자가 실제로 말할 법한 문구를 명시하는 것이 핵심입니다.

# 5. 실제 파일 구조 확인 - 두 번째 발견

---

공식 문서를 확인한 뒤, 실제 파일 구조를 점검해 보니 또 다른 문제를 발견했습니다.

## ~/.claude/skills/ 디렉토리가 비어 있었다

```bash
$ ls -la ~/.claude/skills/
total 0
```

당시 post Skill의 실제 위치는 다음과 같았습니다.

```
~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/skills/post/SKILL.md
```

즉, 처음부터 Personal Skill이 아니라 **플러그인 Skill**로 만들어져 있었던 것입니다. 플러그인 구조로 만들어진 Skill은 `~/.claude/skills/`가 아니라 플러그인 cache 경로에 위치합니다.

## 문자 예산 분석

전체 Skill의 description 합계를 확인한 결과입니다.

| 항목 | 수치 |
|------|------|
| 고유 Skill 수 | 약 19개 |
| description 총 문자 수 | 5,531자 |
| 예산 한도 | 15,000자 (기본값) |
| 사용률 | 36.9% |

**결론**: 예산 초과는 아니었습니다. post Skill이 문자 예산 때문에 밀려나서 로드되지 않은 것은 아니었습니다.

# 6. 근본 원인과 해결 방법

---

공식 문서와 실제 구조를 종합한 결과, 자동 발동이 안 된 근본 원인과 해결 방법은 다음과 같습니다.

## 근본 원인 3가지

### 원인 1: description이 구체적이지 않았음

```yaml
# 기존 (모호한 기능 서술)
description: 개발 세션을 Jekyll 블로그 포스트로 변환하는 워크플로우
```

이 description은 Skill의 기능을 서술하고 있지만, "블로그 포스트 작성해줘"라는 사용자 요청과 매칭되기에는 **너무 간접적**이었습니다. Progressive Disclosure 레벨 1에서 Claude가 description만 보고 판단하는데, 사용자가 실제로 말할 법한 구체적 트리거 문구가 없으니 매칭 확률이 낮았던 것입니다.

### 원인 2: Claude가 이미 최종 목적지를 알고 있었음

Claude는 Skill 목록을 로드하면서 `/post` Skill이 결국 `dev-to-blog-draft` 에이전트를 호출한다는 것을 파악한 상태였습니다. 이미 최종 도착지를 알고 있으니, **중간 경유지(Skill)를 거치지 않고 직행**하는 것이 더 효율적이라고 판단한 것입니다.

### 원인 3: 시스템 프롬프트의 단순성 지향

Claude Code의 시스템 프롬프트에는 다음 지침이 포함되어 있습니다.

```
"Avoid over-engineering. Keep solutions simple."
```

이 지침이 간접 레이어(Skill)를 건너뛰고 직접적인 경로(Task 도구)를 선택하게 만드는 요인이 될 수 있습니다.

## 해결 방법

### 해결 1: description을 공식 패턴으로 수정

```yaml
# Before (모호한 기능 설명 + 비공식 triggers 필드)
---
description: 개발 세션을 Jekyll 블로그 포스트로 변환하는 워크플로우
triggers:
  - blog post
  - 블로그 포스트
---

# After (공식 권장 패턴)
---
description: >
  This skill should be used when the user asks to "블로그 포스트 작성",
  "write a blog post", "세션 정리", or when a development session completes
  meaningful work such as feature implementation, bug fix, refactoring, or
  technical discussion.
---
```

**변경 포인트**:
- `"This skill should be used when the user asks to"` 패턴 적용
- 사용자가 실제로 말할 법한 구체적 문구를 description 안에 명시
- 비공식 `triggers` frontmatter 필드 제거 (공식 문서에 없는 필드)

### 해결 2: 플러그인 Skill을 Personal Skill로 이동

```bash
# Before (플러그인 cache 내부)
~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/skills/post/SKILL.md

# After (Personal Skill 경로)
~/.claude/skills/post/SKILL.md
```

개인용 Skill에 플러그인 구조는 불필요합니다. Personal Skill은 `~/.claude/skills/` 디렉토리에 넣기만 하면 자동으로 discover됩니다.

### 해결 3: CLAUDE.md에 강제 규칙 추가

```markdown
# ~/.claude/CLAUDE.md

## 블로그 포스트 작성 규칙

사용자가 블로그 포스트 작성을 요청할 경우,
**반드시 /post Skill을 사용해야 합니다**.

Task 도구로 에이전트를 직접 호출하지 말고,
/post Skill을 invoke하여 정의된 워크플로우를 따르세요.
```

CLAUDE.md는 `"MUST follow exactly as written"` 래퍼로 주입되므로, Skill description보다 훨씬 높은 우선순위를 가집니다.

### 해결 4: 불필요한 플러그인 정리

사용하지 않는 플러그인을 비활성화하여 description 문자 예산을 절약합니다. 현재 예산 사용률이 36.9%로 여유가 있지만, Skill이 늘어날 것을 대비하는 차원입니다.

# 7. SKILL.md vs CLAUDE.md 강제성 비교

---

이번 디버깅 과정에서 가장 중요한 인사이트는 **SKILL.md와 CLAUDE.md의 강제성 차이**를 정확히 이해한 것입니다.

## 주입 방식의 차이

### SKILL.md description이 주입되는 형태

```xml
<!-- Skill 목록으로 노출 -->
<system-reminder>
Available skills:
- post: This skill should be used when the user asks to...
- test: This skill should be used when...
</system-reminder>
```

### CLAUDE.md가 주입되는 형태

```xml
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
Codebase and user instructions are shown below.
IMPORTANT: These instructions OVERRIDE any default behavior
and you MUST follow them exactly as written.

Contents of /Users/username/.claude/CLAUDE.md:
[여기에 CLAUDE.md 내용이 들어감]
</system-reminder>
```

**핵심 차이**: CLAUDE.md에는 **"OVERRIDE any default behavior"**와 **"MUST follow them exactly as written"**이라는 강력한 시스템 지시가 붙습니다.

## 상세 비교

| 기준 | SKILL.md description | CLAUDE.md 규칙 |
|------|---------------------|----------------|
| **로드 시점** | Skill 목록으로 description만 노출 | 매 세션마다 시스템 지시로 전체 주입 |
| **강제성** | "이런 Skill이 있다" (참고 정보) | "MUST follow exactly as written" (강제 지시) |
| **AI 인식** | 여러 선택지 중 하나 | 반드시 따라야 하는 규칙 |
| **역할** | "Y 작업할 때 이 Skill을 쓸 수 있다" | "항상 X 해라" |
| **설계 의도** | 필요할 때만 로드되는 On-Demand 기능 | 항상 적용되는 프로젝트 메모리 |

둘 다 프롬프트 레벨에서 동작하지만, CLAUDE.md가 시스템에서 부여하는 우선순위가 높아서 **실효성 차이가 큽니다**.

## 공식 문서의 설명

> CLAUDE.md loads automatically every session and is best for "always do X" rules. Skills load on demand and are suitable for reference material or workflows you trigger with a specific command.

정리하면:
- **CLAUDE.md**: "항상 이렇게 해라"를 위한 도구
- **Skill**: "이 작업을 할 때 이렇게 해라"를 위한 도구

용도가 다르기 때문에 강제성도 다른 것입니다.

# 8. 왜 자동 호출은 프로그래밍적 강제가 아닌가

---

"description에 트리거 문구를 넣으면 자동 발동되어야 하는 것 아닌가?"라는 의문이 들 수 있습니다. Skill 자동 호출을 if-else 조건 매칭이 아니라 AI 판단에 맡긴 이유를 생각해 보면 다음과 같습니다.

| 이유 | 설명 |
|------|------|
| **유연성** | AI가 맥락을 종합적으로 고려해서 판단하는 것이 조건 매칭보다 유연함 |
| **복잡성 회피** | 정규식이나 키워드 매칭 로직을 시스템에 넣으면 오히려 사용성이 저하됨 |
| **프롬프트 기반 설계** | Claude Code 전체가 프롬프트 엔지니어링으로 동작을 제어하는 아키텍처 |
| **의도적 설계** | description은 "힌트"로 설계된 것이지, "조건문"으로 설계된 것이 아님 |

공식 문서에서도 Skill이 예상대로 트리거되지 않으면 **"description을 수정하거나, `/skill-name`으로 직접 호출하라"**고 안내합니다. 즉, 자동 호출이 실패할 수 있다는 것을 전제한 설계입니다.

# 실무에서 주의할 점

---

이번 디버깅 경험에서 얻은 실무 팁을 정리합니다.

## 1. 공식 문서를 직접 확인하라

AI(Claude)가 답변한 내용도 반드시 공식 문서로 검증해야 합니다. 특히 다음 상황에서 주의가 필요합니다:

- **빠르게 변화하는 도구**: Claude Code, MCP, AI 도구 생태계
- **최신 버전 API**: 기본값 변경, deprecated 여부
- **시스템 구조**: 파일 경로, 설정 옵션, 지원 범위

이번 세션에서도 AI가 `"~/.claude/skills/는 비공식 경로"`라고 잘못 답변했지만, 사용자가 공식 문서를 직접 확인하여 정정할 수 있었습니다.

## 2. description은 사용자 발화 문구로 작성하라

```yaml
# 나쁜 예 (모호한 기능 설명, 자동 호출 확률 낮음)
description: 블로그 포스트 관련 작업

# 좋은 예 (구체적인 트리거 문구, 자동 호출 확률 높음)
description: >
  This skill should be used when the user asks to
  "write a blog post", "블로그 포스트 작성",
  or "포스트 작성해줘".
```

공식 문서의 표현을 빌리면, description은 "Be concrete and specific"해야 합니다. 사용자가 실제로 말할 법한 문구를 그대로 넣는 것이 가장 효과적입니다.

## 3. Skill description 총량에 한도가 있다

모든 Skill의 description 합계는 기본 **15,000자**까지 허용됩니다 (환경 변수 `SLASH_COMMAND_TOOL_CHAR_BUDGET`으로 조정 가능). 이 한도를 초과하면 일부 Skill의 description이 제외되어 Claude가 해당 Skill의 존재를 모르게 됩니다.

```bash
# 제외된 Skill이 있는지 확인하는 명령어
/context
```

## 4. CLAUDE.md가 500줄을 넘으면 Skill로 분리하라

공식 문서는 CLAUDE.md를 **약 500줄 이하**로 유지하라고 권장합니다.

```text
CLAUDE.md에 담을 것:
  - "항상 X 해라" (코드 스타일, 커밋 규칙, 빌드 명령어)
  - "Y 작업 시 반드시 /skill-name을 사용해라" (강제 라우팅)

Skill로 분리할 것:
  - API 레퍼런스 문서 (대용량, 필요할 때만 로드)
  - 복잡한 워크플로우 절차서
  - 코드 템플릿, 예제
```

## 5. 확실한 발동이 필요하면 이중 장치를 사용하라

description 개선만으로 자동 호출이 보장되지 않으므로, 중요한 Skill에는 이중 장치를 걸어두는 것이 좋습니다.

```yaml
# 장치 1: description 구체화 (SKILL.md frontmatter)
description: >
  This skill should be used when the user asks to
  "블로그 포스트 작성", "write a blog post", "세션 정리"
```

```markdown
# 장치 2: 강제 규칙 (CLAUDE.md)
사용자가 블로그 포스트 작성을 요청할 경우,
**반드시 /post Skill을 사용해야 합니다**.
```

이렇게 하면 description 매칭이 실패해도 CLAUDE.md 규칙이 백업으로 동작합니다.

## 6. 가장 확실한 방법은 슬래시 커맨드

```text
# 자동 호출에 의존 (불확실)
> 블로그 포스트 작성해줘

# 직접 호출 (확실)
> /post
```

슬래시 커맨드(`/skill-name`)로 호출하면 Claude의 판단 과정을 거치지 않고 **즉시 Skill이 실행**됩니다.

# 정리

---

## 핵심 교훈

| 교훈 | 설명 |
|------|------|
| **공식 문서를 직접 확인하라** | AI 답변도 공식 문서로 검증 필수 (특히 빠르게 변화하는 도구) |
| **Skill 자동 호출은 AI 판단이다** | description은 프로그래밍적 조건문이 아니라 AI에게 주는 힌트 |
| **CLAUDE.md가 더 강력하다** | 우선순위: 시스템 프롬프트 > CLAUDE.md > Skill description > 기본 동작 |
| **AI는 효율적인 경로를 선택한다** | 이미 최종 도착지를 알면 중간 경유지(Skill)를 건너뛸 수 있음 |
| **확실한 발동에는 이중 장치** | description 개선 + CLAUDE.md 강제 규칙 조합이 가장 효과적 |

## 선택 가이드

```text
"반드시 이 Skill을 사용해야 한다"
  -> CLAUDE.md에 강제 규칙 작성 + description 구체화

"자연스럽게 자동 호출되면 좋겠다"
  -> description에 사용자 발화 문구를 구체적으로 포함

"절대 자동으로 실행되면 안 된다"
  -> disable-model-invocation: true 설정

"가장 확실하게 실행하고 싶다"
  -> /skill-name 슬래시 커맨드 직접 호출
```

## AI가 실수한 것과 교훈

| 실수 | 올바른 접근 |
|------|-------------|
| Context7으로만 검색, 공식 문서 페이지 미확인 | 공식 문서 페이지를 직접 WebFetch로 읽기 |
| "Unknown skill" 에러를 구조적 한계로 오판 | 에러 하나로 전체 구조를 단정짓지 않기 |
| 사용자 피드백 없이 자체 결론 도출 | 확신이 없으면 공식 문서를 직접 확인 |

# Reference

---

### 공식 문서

- [Claude Code Skills 공식 문서](https://code.claude.com/docs/en/skills) - Progressive Disclosure, Model Invocation, description 패턴
- [Claude Code Slash Commands](https://code.claude.com/docs/en/slash-commands) - disable-model-invocation, 문자 예산
- [Claude Code Features Overview](https://code.claude.com/docs/en/features-overview) - 컨텍스트 로딩 전략, Skill 로딩 방식
- [Claude Code Memory (CLAUDE.md)](https://code.claude.com/docs/en/memory) - "Always do X" vs On-Demand

### 관련 파일

- `~/.claude/CLAUDE.md` - 사용자 전역 규칙 (시스템 레벨 우선순위)
- `~/.claude/skills/post/SKILL.md` - 블로그 포스트 생성 Skill

### 관련 포스트

이 포스트는 기존 [Claude Code Skill이 자동 발동되지 않는 이유 - description 기반 트리거의 실체](/ClaudeCode/claude-code-skill-not-triggered/) 포스트를 대폭 확장하고 정확성을 개선한 버전입니다. 실수 과정과 공식 문서 검증 과정을 추가했습니다.
