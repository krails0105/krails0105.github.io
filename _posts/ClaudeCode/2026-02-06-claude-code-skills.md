---
title: "[ClaudeCode] Skills - 커스텀 슬래시 커맨드로 반복 작업 자동화"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, Skills, SlashCommands, Automation, CustomCommands]
---

# Introduction

---

Claude Code에서 같은 종류의 작업을 반복할 때마다 매번 상세한 프롬프트를 작성하는 것은 비효율적입니다. **Skills(스킬)**는 재사용 가능한 프롬프트와 절차를 패키징한 것으로, `/skill-name` 형태의 슬래시 커맨드로 즉시 호출할 수 있습니다. 자주 쓰는 작업을 매크로처럼 등록해두는 것과 비슷합니다.

이 글은 Skills의 개념, 기본 제공 vs 커스텀 스킬의 차이, 커스텀 스킬 작성법, 그리고 실전 활용 패턴을 정리합니다.

# 1. Skill이란?

---

## 개념

Skill은 `SKILL.md` 파일에 정의된 **재사용 가능한 지시사항**입니다. Claude Code가 특정 작업을 수행할 때 따라야 할 절차, 규칙, 참고 자료를 묶어놓은 패키지입니다.

```text
일반 프롬프트:
  "이 PR을 리뷰해줘. 보안 취약점, 성능 이슈, 코딩 컨벤션 위반을 확인하고,
   심각도별로 분류해서 마크다운으로 정리해줘..."

Skill 사용:
  /review-pr 123
```

## Skill vs 일반 프롬프트

| 항목 | 일반 프롬프트 | Skill |
|------|-------------|-------|
| **재사용성** | 매번 작성 | 한 번 작성, 계속 호출 |
| **일관성** | 매번 다른 결과 가능 | 동일한 절차 보장 |
| **공유** | 복사/붙여넣기 | Git으로 팀 공유 |
| **유지보수** | 산재된 프롬프트 | 한 파일에서 관리 |
| **도구 제한** | 불가 | `allowed-tools`로 제한 가능 |

# 2. Skill의 종류와 위치

---

## 스코프별 분류

```text
사용자 스킬 (User Scope):
  ~/.claude/skills/<skill-name>/SKILL.md
  → 모든 프로젝트에서 사용 가능
  → 개인 워크플로우 자동화

프로젝트 스킬 (Project Scope):
  .claude/skills/<skill-name>/SKILL.md
  → 현재 프로젝트에서만 사용
  → Git에 포함 → 팀원과 공유

플러그인 스킬 (Plugin Scope):
  <plugin>/skills/<skill-name>/SKILL.md
  → 플러그인 활성화 시 사용 가능
  → 커뮤니티/조직 배포
```

## 디렉토리 구조

```text
.claude/skills/
└── review-pr/
    ├── SKILL.md              ← 핵심 지시사항
    ├── references/            ← 참고 자료
    │   └── coding-standards.md
    ├── examples/              ← 예시
    │   └── good-review.md
    └── scripts/               ← 보조 스크립트
        └── collect-diff.sh
```

`SKILL.md`가 핵심이며, 나머지 디렉토리는 선택사항입니다. 복잡한 스킬일 때 참고 자료나 예시를 분리하여 관리합니다.

# 3. SKILL.md 작성법

---

## 기본 구조

```markdown
---
name: review-pr
description: PR을 보안, 성능, 컨벤션 관점에서 리뷰합니다
---

PR 리뷰 시 다음 절차를 따르세요:

1. 변경된 파일 목록을 확인합니다
2. 각 파일에 대해 다음을 검사합니다:
   - 보안 취약점 (SQL Injection, XSS 등)
   - 성능 이슈 (N+1 쿼리, 불필요한 루프)
   - 코딩 컨벤션 위반
3. 발견한 이슈를 심각도별로 분류합니다
4. 마크다운 형식으로 리포트를 출력합니다
```

**YAML Frontmatter**: 스킬의 메타데이터 (이름, 설명, 설정)
**Markdown Content**: Claude가 실행할 구체적 지시사항

## Frontmatter 옵션

```yaml
---
name: skill-name                    # 스킬 이름 (필수)
description: 언제 사용하는지 설명    # 자동 호출 판단에 사용
allowed-tools: Read, Grep, Glob     # 사용 가능한 도구 제한
model: sonnet                       # 실행 모델 지정
argument-hint: [파일경로]           # 인자 힌트
disable-model-invocation: true      # 수동 호출만 허용
user-invocable: false               # 자동 호출만 허용
context: fork                       # 서브에이전트에서 실행
---
```

## 주요 옵션 설명

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `allowed-tools` | 전체 | 스킬 실행 중 사용할 도구 제한 |
| `model` | 세션 모델 | 스킬 전용 모델 지정 (비용 최적화) |
| `disable-model-invocation` | false | true면 `/name`으로만 호출 가능 |
| `user-invocable` | true | false면 Claude가 자동으로만 호출 |
| `context: fork` | 없음 | 별도 서브에이전트에서 실행 (컨텍스트 분리) |

# 4. 동적 인자와 파일 참조

---

## 인자 전달

```markdown
---
name: explain
argument-hint: [파일경로]
---

다음 파일을 분석하고 설명해주세요: $ARGUMENTS

1. 파일의 전체 구조를 파악합니다
2. 핵심 로직을 단계별로 설명합니다
3. 주의할 점을 정리합니다
```

호출:

```text
/explain src/auth/jwt.ts
→ $ARGUMENTS = "src/auth/jwt.ts"
```

## 위치 인자

```markdown
$ARGUMENTS    전체 인자 문자열
$1            첫 번째 인자
$2            두 번째 인자
$3            세 번째 인자
```

예시:

```text
/compare src/old.ts src/new.ts
→ $1 = "src/old.ts", $2 = "src/new.ts"
```

## 파일 참조

`@` 문법으로 파일 내용을 스킬에 포함할 수 있습니다:

```markdown
---
name: review-code
---

다음 코딩 표준을 참고하여 코드를 리뷰하세요:
@references/coding-standards.md

리뷰 대상: $ARGUMENTS
```

## 셸 명령 실행

`` !`command` `` 문법으로 스킬 실행 전에 셸 명령을 실행하고 결과를 포함할 수 있습니다:

```markdown
---
name: review-pr
---

현재 브랜치의 변경사항:
!`git diff main...HEAD --stat`

위 변경사항을 리뷰하세요.
```

# 5. 호출 방식

---

## 수동 호출 (Slash Command)

```text
/skill-name [arguments]

예시:
/review-pr 123
/explain src/auth.ts
/commit
```

사용자가 직접 `/`를 입력하여 호출합니다.

## 자동 호출 (Model Invocation)

```text
사용자: "이 코드를 리뷰해줘"
Claude: (description이 매칭되는 스킬을 자동으로 호출)
```

`description` 필드를 기반으로 Claude가 상황에 맞는 스킬을 자동으로 선택합니다. `disable-model-invocation: true`로 자동 호출을 비활성화할 수 있습니다.

## 호출 방식 설정

```text
disable-model-invocation: false, user-invocable: true   → 수동 + 자동 (기본)
disable-model-invocation: true,  user-invocable: true   → 수동만
disable-model-invocation: false, user-invocable: false   → 자동만
```

# 6. 실전 예시

---

## 커밋 메시지 작성 스킬

```markdown
---
name: commit
description: 변경사항을 분석하여 컨벤션에 맞는 커밋을 생성합니다
allowed-tools: Bash, Read
---

1. `git status`와 `git diff --staged`로 변경사항을 확인합니다
2. 커밋 메시지 형식: `[type]: description`
   - type: feat, fix, refactor, docs, test, chore
3. 메시지는 한국어로, 50자 이내
4. 본문에 변경 이유를 간단히 설명합니다
```

## 블로그 포스트 점검 스킬

```markdown
---
name: check-post
description: 블로그 포스트의 기술적 정확성과 포맷을 점검합니다
allowed-tools: Read, Grep, Glob
argument-hint: [포스트 파일 경로]
---

대상 포스트: $ARGUMENTS

1. Front matter 형식 확인 (title, categories, tags)
2. 섹션 구조 확인 (Introduction → 번호 섹션 → 정리 → Reference)
3. 코드 블록의 언어 지정 확인
4. 기술 용어의 정확성 검증
5. 발견한 문제를 목록으로 정리
```

## 보안 점검 스킬

```markdown
---
name: security-check
description: 코드의 보안 취약점을 점검합니다
allowed-tools: Read, Grep, Glob
disable-model-invocation: true
context: fork
---

다음 항목을 점검합니다:
1. SQL Injection 가능성
2. XSS 취약점
3. 하드코딩된 시크릿/API 키
4. 안전하지 않은 의존성
5. 인증/인가 누락

발견한 취약점을 CVSS 심각도 기준으로 분류합니다.
```

# 7. Skill 작성 팁

---

```text
✅ 좋은 습관:
  - SKILL.md는 500줄 이내로 유지
  - 상세한 참고 자료는 references/에 분리
  - description을 명확하게 작성 (자동 호출 정확도에 영향)
  - 부작용이 있는 스킬은 disable-model-invocation: true
  - 읽기 전용 스킬은 allowed-tools를 Read, Grep, Glob으로 제한

❌ 피할 것:
  - 하나의 스킬에 여러 목적을 혼합
  - description 없이 자동 호출 기대
  - allowed-tools 미설정으로 불필요한 권한 노출
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Skill** | SKILL.md에 정의된 재사용 가능한 지시사항 패키지 |
| **스코프** | User (~/.claude), Project (.claude), Plugin 3단계 |
| **호출 방식** | 수동 (/name), 자동 (description 매칭), 또는 둘 다 |
| **Frontmatter** | name, description, allowed-tools, model 등 메타데이터 |
| **동적 요소** | $ARGUMENTS(인자), @path(파일), !`cmd`(셸 실행) |
| **vs 일반 프롬프트** | 재사용성, 일관성, 팀 공유, 도구 제한 가능 |

```text
핵심:
  Skill = "잘 작성된 프롬프트" + "메타데이터" + "참고 자료"
  자주 반복하는 작업이 있다면 Skill로 만들어 팀과 공유하세요.
```

# Reference

---

- [Claude Code Skills 공식 문서](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Claude Code Plugin Development](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
