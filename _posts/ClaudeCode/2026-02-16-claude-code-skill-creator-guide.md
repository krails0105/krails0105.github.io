---
title: "[ClaudeCode] 효과적인 Skill 만들기 - Anthropic 공식 Skill Creator 가이드 정리"
categories:
  - ClaudeCode
tags:
  - [Claude Code, Skill, SKILL.md, Progressive Disclosure, Skill Creator, Bundled Resources]
---

# Introduction

---

Claude Code Skill을 만드는 것 자체는 어렵지 않습니다. `SKILL.md` 파일 하나만 작성하면 됩니다. 하지만 **"잘 동작하는" Skill**을 만드는 것은 다른 문제입니다. description이 모호해서 자동 호출이 안 되거나, 본문이 너무 길어서 컨텍스트를 낭비하거나, 참고 자료를 어디에 넣어야 할지 모르는 상황이 자주 발생합니다.

Anthropic은 이런 문제를 해결하기 위해 **Skill Creator**라는 공식 Skill을 제공합니다. "Skill을 잘 만드는 법을 가르쳐주는 Skill"입니다. 이 글은 [Skill Creator](https://skills.sh/anthropics/skills/skill-creator)의 내용을 정리하고, 핵심 설계 원칙과 실전 패턴을 쉽게 풀어 설명합니다.

이 글을 읽고 나면 다음을 할 수 있습니다:

- Skill의 3단계 로딩 구조를 이해하고, 각 레벨에 적합한 정보를 배치할 수 있다
- 자동 호출 확률을 높이는 description을 작성할 수 있다
- scripts/, references/, assets/를 언제, 왜 사용하는지 판단할 수 있다
- 6단계 프로세스에 따라 체계적으로 Skill을 만들 수 있다

기본적인 Skill 개념(스코프, frontmatter, 호출 방식 등)은 [이전 포스트](/ClaudeCode/claude-code-skills/)에서 다루었으므로, 이 글에서는 **설계 원칙과 구조화 전략**에 집중합니다.

# 1. Skill Creator란?

---

## Skill Creator 설치

Skill Creator는 Anthropic이 공식 제공하는 Skill로, `npx skills` 명령어로 설치할 수 있습니다.

```bash
npx skills add https://github.com/anthropics/skills --skill skill-creator
```

## 어떻게 사용하나?

설치 후 Claude Code에서 `/skill-creator`로 호출하면, Skill 생성에 관한 가이드라인이 컨텍스트에 로드됩니다. 새 Skill을 만들 때 이 Skill을 먼저 호출하면, Claude가 가이드라인에 따라 체계적으로 Skill을 설계해줍니다.

```text
사용 흐름:

1. /skill-creator 호출 → 설계 가이드라인이 컨텍스트에 로드됨
2. "PR 리뷰 Skill 만들어줘" 같은 요청
3. Claude가 가이드라인에 따라 SKILL.md + 리소스를 체계적으로 생성
```

직접 Skill을 작성할 때도, 이 가이드라인을 알고 있으면 더 효과적인 Skill을 만들 수 있습니다. 이하 섹션에서 핵심 내용을 하나씩 정리합니다.

# 2. 핵심 설계 원칙

---

Skill Creator가 제시하는 설계 원칙은 크게 두 가지입니다: **간결함**과 **자유도 설정**.

## "컨텍스트 윈도우는 공공재다"

Skill Creator가 가장 강조하는 원칙은 **간결함(Conciseness)**입니다.

> "The context window is a public good. Skills share the context window with everything else Claude needs."

컨텍스트 윈도우는 한정된 자원입니다. Skill이 차지하는 공간이 많을수록, 사용자의 코드나 대화를 위한 공간은 줄어듭니다. 따라서 SKILL.md에 넣는 모든 내용에 대해 **"Claude가 정말 이 정보를 필요로 하는가?"**를 질문해야 합니다.

Claude는 이미 대부분의 프로그래밍 언어, 프레임워크, 일반적인 작업 방법을 알고 있습니다. Skill에 넣어야 하는 것은 Claude가 **모르는 정보**(프로젝트 고유 규칙, 내부 API, 팀 컨벤션)이지, 일반적인 프로그래밍 지식이 아닙니다.

| 넣어야 할 것 | 넣지 말아야 할 것 |
|---|---|
| 프로젝트 고유 규칙 ("커밋 메시지는 한국어로, [type]: description 형식") | "Git은 버전 관리 시스템입니다" |
| 내부 API 스펙 ("사내 인증 서버의 엔드포인트와 응답 형식") | "REST API는 HTTP 메서드를 사용합니다" |
| 도메인 특화 지식 ("금융 거래 처리 시 반올림 규칙") | 프로그래밍 기초 지식 |

## 자유도(Degrees of Freedom) 설정

Skill의 지시사항을 얼마나 구체적으로 작성할지는 **작업의 신뢰성 요구 수준**에 따라 달라집니다. 레시피에 비유하면, "맛있는 파스타를 만들어"(높은 자유도)와 "소금 5g, 물 1L, 면 100g을 정확히 계량하여..."(낮은 자유도)의 차이입니다.

| 자유도 | 작성 방식 | 적합한 상황 | 예시 |
|:---:|---|---|---|
| **높음** | 텍스트 가이드라인 | 여러 접근 방식이 유효한 창작성 높은 작업 | 코드 리뷰, 문서 작성 |
| **중간** | 의사코드, 절차 목록 | 선호하는 패턴이 있지만 유연성이 필요한 작업 | API 엔드포인트 생성, 테스트 작성 |
| **낮음** | 실행 스크립트 | 결과가 반드시 동일해야 하는 결정론적 작업 | PDF 변환, 데이터 마이그레이션, 빌드 자동화 |

각 자유도별 SKILL.md 본문이 어떻게 달라지는지 비교해 봅니다.

```yaml
# 높은 자유도 - 텍스트 가이드라인
---
name: review-pr
description: >
  This skill should be used when the user asks to
  "PR 리뷰", "review this PR", or "코드 리뷰해줘".
---
보안, 성능, 가독성 관점에서 리뷰하세요.
심각도별로 분류하여 정리합니다.
```

```yaml
# 중간 자유도 - 절차 목록
---
name: create-api
description: >
  This skill should be used when the user asks to
  "API 만들어줘", "엔드포인트 추가", or "create endpoint".
---
1. Controller 클래스 생성 (@RestController)
2. Service 인터페이스 + 구현 클래스 생성
3. DTO 생성 (Request, Response 분리)
4. 단위 테스트 작성 (MockMvc 사용)
```

```yaml
# 낮은 자유도 - 스크립트 실행
---
name: rotate-pdf
description: >
  This skill should be used when the user asks to
  "PDF 회전", "rotate PDF", or "페이지 돌려줘".
---
scripts/rotate_pdf.py를 실행하여 PDF를 회전합니다.
인자: $1 = 파일 경로, $2 = 회전 각도
```

자유도가 낮을수록 결과가 일관되지만, Claude의 판단력을 활용하기 어렵습니다. 반대로 자유도가 높으면 유연하지만 결과가 매번 달라질 수 있습니다. 작업 성격에 맞게 적절한 수준을 선택하는 것이 중요합니다.

# 3. Progressive Disclosure 설계

---

Skill의 내용이 한 번에 전부 로드되는 것은 아닙니다. Claude Code는 **Progressive Disclosure(단계적 공개)** 방식으로 필요한 만큼만 로드합니다. 이 구조를 이해하면 "무엇을 어디에 넣어야 하는가"가 명확해집니다.

## 3단계 로딩 구조

| 레벨 | 로드되는 내용 | 로드 시점 | 크기 제한 |
|:---:|---|---|---|
| **1** | name + description | 항상 컨텍스트에 존재 | ~100 words |
| **2** | SKILL.md 본문 | Skill 트리거 시 | <5,000 words |
| **3** | Bundled Resources (scripts/, references/, assets/) | Claude가 필요하다고 판단할 때 | 제한 없음 |

이 구조가 중요한 이유는, **각 레벨에 넣어야 할 정보의 종류가 다르기 때문**입니다.

```text
레벨 1 (description):
  "이 Skill이 언제 필요한지" 판단 정보
  → 사용자 발화 문구, 트리거 조건

레벨 2 (SKILL.md 본문):
  "이 Skill을 어떻게 실행할지" 지시사항
  → 워크플로우 절차, 규칙, 제약 조건

레벨 3 (Bundled Resources):
  "실행에 필요한 상세 자료"
  → API 문서, 스키마, 템플릿, 스크립트
```

특히 레벨 3의 scripts/는 **실행 시 컨텍스트에 로드되지 않고** 직접 실행됩니다. 즉, 스크립트가 아무리 길어도 컨텍스트를 소비하지 않으므로, 복잡한 로직은 scripts/로 분리하는 것이 유리합니다.

## SKILL.md 크기 목표: 500줄 이내

SKILL.md 본문은 Skill이 트리거될 때마다 컨텍스트에 로드됩니다. 너무 길면 컨텍스트 낭비이고, 너무 짧으면 Claude가 작업을 수행하기 위한 정보가 부족합니다.

Skill Creator는 **500줄 이내**를 목표로 권장합니다. 이를 초과하는 내용은 레벨 3(references/, scripts/)으로 분리하세요.

참고로 references/ 파일도 너무 크면 비효율적입니다. **100줄을 넘는 참조 파일에는 목차(Table of Contents)를 추가**하여 Claude가 필요한 부분만 빠르게 찾을 수 있도록 합니다.

## Progressive Disclosure 패턴 3가지

### 패턴 1: 고수준 가이드 + 참조 파일

SKILL.md에는 핵심 워크플로우만 두고, 상세 내용은 references/로 분리합니다. 가장 일반적인 패턴입니다.

```text
skill-name/
├── SKILL.md            ← "Quick start + 간단한 사용법"
└── references/
    ├── patterns.md     ← 상세 패턴 설명
    └── advanced.md     ← 고급 기법
```

SKILL.md에서 references/를 참조하는 방법은 다음과 같습니다.

```markdown
# SKILL.md 본문 예시

# PDF Processing

## Quick Start
pdfplumber로 텍스트를 추출합니다: [핵심 코드]

## 고급 기능
- **폼 입력**: references/FORMS.md 참조
- **API 레퍼런스**: references/REFERENCE.md 참조
```

SKILL.md를 간결하게 유지하면서, Claude가 필요할 때만 references/를 읽어 상세 정보를 얻습니다. SKILL.md에서 references/ 파일을 **명시적으로 언급**해야 Claude가 해당 파일의 존재를 알고 찾아갈 수 있다는 점이 중요합니다.

### 패턴 2: 도메인별 분리

여러 도메인을 다루는 Skill의 경우, 도메인별로 references/를 분리합니다.

```text
bigquery-skill/
├── SKILL.md            ← 공통 쿼리 규칙
└── references/
    ├── finance.md      ← 재무 도메인 스키마/규칙
    ├── sales.md        ← 영업 도메인 스키마/규칙
    ├── product.md      ← 제품 도메인 스키마/규칙
    └── marketing.md    ← 마케팅 도메인 스키마/규칙
```

사용자가 "재무 데이터 조회해줘"라고 하면, Claude는 SKILL.md와 finance.md만 참조합니다. 다른 도메인 파일은 로드하지 않으므로 컨텍스트를 절약합니다.

### 패턴 3: 조건부 상세

복잡도에 따라 단계적으로 상세 문서를 참조하는 패턴입니다.

```markdown
# SKILL.md

# DOCX Processing

## 문서 생성
docx-js를 사용합니다. 상세 API는 references/DOCX-JS.md 참조.

## 문서 편집
- **변경 추적이 필요한 경우**: references/REDLINING.md 참조
- **OOXML 직접 조작이 필요한 경우**: references/OOXML.md 참조
```

단순한 문서 생성은 SKILL.md만으로 충분하고, 복잡한 편집이 필요할 때만 추가 문서를 참조합니다. SKILL.md에서 references/ 파일로의 참조 깊이는 **1단계**로 유지하는 것이 좋습니다. 즉, references/A.md가 다시 references/B.md를 참조하는 구조는 피합니다.

# 4. description 작성법 - 자동 호출의 핵심

---

Progressive Disclosure 레벨 1에서 Claude는 **description만 보고** Skill을 사용할지 결정합니다. description이 모호하면 자동 호출 확률이 떨어집니다. [이전 포스트](/ClaudeCode/claude-code-skill-auto-trigger-debugging/)에서 description 때문에 Skill이 자동 호출되지 않는 문제를 실제로 경험하고 해결한 과정을 다루었는데, 여기서는 Skill Creator가 제시하는 공식 작성 패턴을 정리합니다.

## 공식 권장 패턴

```yaml
description: >
  This skill should be used when the user asks to
  "구체적 문구 1", "구체적 문구 2", "구체적 문구 3",
  or mentions [관련 맥락].
  [Skill이 하는 일 한 줄 설명].
```

핵심은 **사용자가 실제로 말할 법한 문구**를 그대로 넣는 것입니다. Skill Creator 원문에서도 "Be concrete and specific"이라고 강조합니다.

## 좋은 예 vs 나쁜 예

```yaml
# 나쁜 예 - 기능 서술만 있음 (자동 호출 확률 낮음)
description: 개발 세션을 블로그 포스트로 변환하는 워크플로우

# 좋은 예 - 구체적 트리거 문구 포함 (자동 호출 확률 높음)
description: >
  This skill should be used when the user asks to
  "블로그 포스트 작성", "write a blog post", "세션 정리",
  or when a development session completes meaningful work.
  Converts session content into a Jekyll blog post draft.
```

나쁜 예에서는 "블로그 포스트 작성해줘"라는 요청과 description 사이에 직접적인 매칭 포인트가 없습니다. 좋은 예에서는 사용자가 실제로 말할 문구가 description 안에 명시되어 있어 Claude가 매칭하기 쉽습니다.

## description에 넣어야 할 것과 넣지 말아야 할 것

| 넣어야 할 것 | 넣지 말아야 할 것 |
|---|---|
| 사용자 발화 문구 ("블로그 포스트 작성") | 내부 구현 상세 ("dev-to-blog-draft 에이전트 호출") |
| Skill의 기능 한 줄 요약 | 전체 워크플로우 설명 |
| 트리거 맥락 ("개발 세션 완료 시") | 파일 경로, 설정값 |

description은 "언제 사용할지"를 알려주는 역할이고, "어떻게 실행할지"는 SKILL.md 본문의 역할입니다. 이 둘을 혼동하면 description이 불필요하게 길어집니다. **"사용 시점(when to use)" 정보는 description에 넣고, 본문에는 넣지 마세요.** description만 레벨 1에서 항상 로드되기 때문입니다.

# 5. Bundled Resources 활용법

---

SKILL.md 외에 Skill 디렉토리에 넣을 수 있는 리소스는 크게 세 가지입니다. 각각 용도와 로딩 방식이 다릅니다.

## 전체 디렉토리 구조

Context7에서 확인한 공식 Skill 디렉토리 구조는 다음과 같습니다.

```text
skill-name/
├── SKILL.md              ← 핵심 지시사항 (레벨 2)
├── references/            ← 참조 문서 - 필요 시 컨텍스트에 로드
│   ├── api-guide.md
│   └── authentication.md
├── examples/              ← 예시 파일 - 참조 문서와 동일하게 동작
│   ├── basic-example.js
│   └── advanced-example.js
├── scripts/               ← 실행 스크립트 - 컨텍스트에 로드되지 않고 직접 실행
│   ├── run-tests.sh
│   └── generate-report.py
└── assets/                ← 정적 파일 - 출력물에 사용
    └── template.json
```

## scripts/ - 결정론적 실행

Claude가 매번 코드를 새로 작성하는 대신, 미리 작성된 스크립트를 실행합니다.

**사용 기준**: 다음 중 하나에 해당하면 scripts/를 사용합니다.

| 기준 | 설명 |
|---|---|
| **결정론적 결과가 필요** | 같은 입력에 항상 같은 결과 (데이터 변환, 파일 처리) |
| **Claude가 반복 작성하는 코드** | 매번 비슷한 코드를 생성하는 패턴 |
| **에러에 취약한 작업** | 미세한 차이가 큰 문제를 일으키는 작업 (마이그레이션, 빌드) |

스크립트의 가장 큰 장점은 **컨텍스트를 소비하지 않는다**는 것입니다. Claude가 코드를 생성하면 수백~수천 토큰을 소비하지만, 기존 스크립트를 실행하면 실행 명령어 한 줄로 끝납니다. Skill Creator 원문에서도 이 점을 "unlimited since scripts execute without context loading"이라고 설명합니다.

## references/ - 참조 문서

Claude가 작업 중 **필요할 때만** 컨텍스트에 로드하는 참조 자료입니다.

```text
skill-name/
└── references/
    ├── api_docs.md         ← 내부 API 문서
    ├── schema.md           ← 데이터베이스 스키마
    ├── policies.md         ← 팀 정책/규칙
    └── domain_knowledge.md ← 도메인 지식
```

**사용 기준**: SKILL.md에 넣기에는 길지만, Claude가 작업 수행에 참조해야 하는 문서. API 문서, 스키마 정의, 코딩 표준 등이 해당합니다.

SKILL.md에서 references/ 파일을 **명시적으로 언급**해야 Claude가 찾을 수 있습니다.

```markdown
# SKILL.md 본문에서 참조 연결

## 데이터 모델
데이터베이스 스키마는 references/schema.md를 참조하세요.

## 인증 처리
인증 API 사양은 references/api_docs.md를 참조하세요.
```

## assets/ - 템플릿과 정적 파일

최종 결과물에 사용될 파일입니다. references/와 달리 컨텍스트에 로드하는 것이 목적이 아니라, **출력물의 재료**로 사용됩니다.

```text
skill-name/
└── assets/
    ├── template.pptx       ← 프레젠테이션 템플릿
    ├── logo.png            ← 로고 이미지
    ├── boilerplate/        ← 프로젝트 보일러플레이트
    └── config.template.yml ← 설정 파일 템플릿
```

**사용 기준**: Claude가 생성하는 것이 아니라, **그대로 복사하거나 채워 넣어야 하는** 파일.

## 리소스 유형별 비교

| 디렉토리 | 용도 | 컨텍스트 로딩 | 예시 |
|---|---|---|---|
| **scripts/** | 결정론적 실행 | 로드하지 않음 (직접 실행) | PDF 변환, 스키마 검증, 리포트 생성 |
| **references/** | 참조 문서 | 필요할 때만 로드 | API 문서, 코딩 표준, 도메인 지식 |
| **examples/** | 예시 코드/문서 | 필요할 때만 로드 | 좋은 리뷰 예시, 코드 샘플 |
| **assets/** | 정적 파일 | 출력물 재료로 사용 | 템플릿, 로고, 보일러플레이트 |

## 포함하면 안 되는 것

Skill 디렉토리에 넣지 말아야 할 파일도 명확합니다.

| 포함 금지 파일 | 이유 |
|---|---|
| README.md | Skill의 설명은 SKILL.md가 담당 |
| INSTALLATION_GUIDE.md | 설치는 패키지 매니저가 처리 |
| QUICK_REFERENCE.md | SKILL.md 자체가 퀵 레퍼런스 |
| CHANGELOG.md | 버전 관리는 Git으로 |

이런 부가적 문서는 컨텍스트만 차지하고 실제 Skill 실행에는 사용되지 않습니다.

# 6. 6단계 Skill 생성 프로세스

---

Skill Creator가 제시하는 체계적인 생성 프로세스입니다. 각 단계의 목적과 구체적인 방법을 정리합니다.

## Step 1: 구체적 예시로 이해하기

Skill을 만들기 전에, **실제로 어떤 작업을 자동화할 것인지** 구체적인 예시를 먼저 정리합니다. 막연히 "블로그 포스트 Skill을 만들겠다"가 아니라, 구체적인 시나리오를 그려봅니다.

```text
예시: 블로그 포스트 자동 생성 Skill

1. 개발 세션에서 Spring Boot 캐시 설정을 논의했다
2. 논의 내용을 기반으로 블로그 포스트 초안을 작성한다
3. Context7으로 기술적 정확성을 검증한다
4. Jekyll 포맷에 맞게 파일을 저장한다
```

이렇게 구체적인 사용 시나리오가 있어야, 어떤 정보를 SKILL.md에 넣고 어떤 것을 references/로 분리할지 판단할 수 있습니다.

## Step 2: 재사용 가능 콘텐츠 계획

Step 1의 예시를 보고, **스크립트로 만들 것**, **참조 문서로 넣을 것**, **템플릿으로 준비할 것**을 분류합니다. 이 분류 기준이 앞서 설명한 scripts/, references/, assets/의 용도와 직결됩니다.

```text
예시 분류:

scripts/:
  (없음 - 이 Skill은 Claude의 생성 능력이 핵심)

references/:
  - coding-standards.md    ← 블로그 포스트 작성 규칙
  - frontmatter-guide.md   ← Jekyll frontmatter 가이드

examples/:
  - good-post-example.md   ← 잘 작성된 포스트 예시

assets/:
  - post-template.md       ← 포스트 뼈대 템플릿
```

## Step 3: Skill 초기화

Skill Creator에는 초기화 스크립트가 포함되어 있습니다.

```bash
# Skill 디렉토리 구조 자동 생성
scripts/init_skill.py my-skill --path ~/.claude/skills/

# 결과:
# ~/.claude/skills/my-skill/
# ├── SKILL.md          ← TODO 자리표시자가 포함된 템플릿
# ├── references/
# ├── scripts/
# └── assets/
```

직접 수동으로 생성해도 됩니다.

```bash
mkdir -p ~/.claude/skills/my-skill/{references,scripts,examples,assets}
touch ~/.claude/skills/my-skill/SKILL.md
```

## Step 4: SKILL.md 편집

이 단계에서 지금까지 다룬 설계 원칙을 모두 적용합니다. 실전 예시를 통해 완성된 SKILL.md가 어떤 모습인지 확인합니다.

### 완성 예시: 블로그 포스트 생성 Skill

```yaml
---
name: write-post
description: >
  This skill should be used when the user asks to
  "블로그 포스트 작성", "write a blog post", "세션 정리",
  "포스트 작성해줘", or when a development session completes
  meaningful work such as feature implementation or bug fix.
  Converts development session content into a Jekyll blog post draft.
---

# Blog Post Writer

## 워크플로우

1. 현재 세션의 핵심 주제를 파악합니다
2. 기존 포스트의 포맷을 확인합니다
   - 같은 카테고리의 최근 포스트 1~2개를 references/format-guide.md와 대조
3. Context7으로 기술적 정확성을 검증합니다
4. 포스트를 작성합니다
   - front matter: references/frontmatter-guide.md 참조
   - 구조: Introduction → 번호 섹션 → 정리 → Reference
5. `_posts/{카테고리}/YYYY-MM-DD-제목.md`에 저장합니다

## 규칙

- 한국어로 작성
- 코드 블록에는 반드시 언어 태그 지정
- 프로젝트 고유 정보는 일반화 (DB명, 함수명 등)
```

이 예시에서 적용된 원칙을 확인합니다:

| 원칙 | 적용 위치 |
|---|---|
| 구체적 트리거 문구 | description에 한국어/영어 발화 문구 |
| 간결한 본문 | 워크플로우 5단계 + 규칙 3줄 |
| references/ 분리 | 상세 포맷 가이드는 references/로 |
| Claude가 아는 것은 생략 | "Jekyll이란 무엇인가" 같은 설명 없음 |

### 본문 작성 가이드라인

```text
본문 작성 시 지켜야 할 것:

- 명령형/부정사 형태로 작성 ("~하세요", "~합니다")
- 500줄 이내 유지
- 상세한 참조 자료는 references/로 분리
- Claude가 이미 아는 일반 지식은 제외
- "사용 시점(when to use)" 정보는 본문이 아닌 description에만 작성
```

### 리소스 구현 및 테스트

scripts/의 스크립트는 독립적으로 실행 가능하도록 작성합니다. Claude가 실행할 때 외부 의존성 문제가 발생하지 않도록 확인합니다.

```bash
# 스크립트가 독립적으로 동작하는지 테스트
cd ~/.claude/skills/my-skill
python scripts/my_script.py --help    # 의존성 문제 없이 실행되는지 확인
```

## Step 5: 패키징 (배포용)

커뮤니티에 배포할 Skill이라면, 패키징 스크립트로 배포 파일을 생성합니다. 개인용 Skill이라면 이 단계는 건너뛰어도 됩니다.

```bash
# 검증 + 패키징
scripts/package_skill.py ~/.claude/skills/my-skill

# 출력 경로 지정
scripts/package_skill.py ~/.claude/skills/my-skill ./dist
```

패키징 시 자동으로 검증하는 항목:

| 검증 항목 | 설명 |
|---|---|
| YAML frontmatter | 형식 오류, 필수 필드 (name, description) 누락 |
| 디렉토리 구조 | 명명 규칙, 불필요한 파일 포함 여부 |
| description 품질 | 트리거 문구의 구체성, 길이 적절성 |
| 리소스 참조 | SKILL.md에서 참조하는 파일이 실제로 존재하는지 |

## Step 6: 반복 개선

Skill은 한 번 만들고 끝이 아닙니다. 실제로 사용하면서 개선합니다.

```text
반복 개선 사이클:

1. 실제 작업에서 Skill 사용
2. 불편한 점, 비효율적인 부분 파악
   - "이 Skill이 자동 호출이 안 되네" → description 개선
   - "매번 같은 코드를 생성하네" → scripts/로 분리
   - "이 정보가 없어서 결과가 부정확해" → references/ 추가
   - "본문이 너무 길어졌어" → references/로 분리하여 500줄 이내 유지
3. SKILL.md 또는 리소스 수정
4. 재테스트
```

# 7. 흔한 실수와 해결법

---

Skill을 만들 때 자주 겪는 문제와 해결 방법을 정리합니다.

| 증상 | 원인 | 해결 |
|------|------|------|
| Skill이 자동 호출되지 않음 | description이 모호하거나 기능 서술만 있음 | "This skill should be used when..." 패턴으로 구체적 발화 문구 추가 |
| Skill이 너무 자주 호출됨 | description이 너무 넓은 범위를 커버 | description을 더 구체적이고 좁은 범위로 수정 |
| 컨텍스트 사용량이 과도함 | SKILL.md 본문이 너무 길거나, 일반 지식을 포함 | 500줄 이내로 줄이고, references/로 분리 |
| Claude가 references/ 파일을 찾지 못함 | SKILL.md에서 명시적으로 언급하지 않음 | SKILL.md 본문에서 references/파일명을 직접 언급 |
| 일부 Skill이 제외됨 | description 총 문자 수가 예산(기본 15,000자)을 초과 | `/context` 명령으로 확인, 불필요한 Skill 정리 |

자동 호출이 불안정한 경우, CLAUDE.md에 강제 규칙을 추가하는 "이중 장치" 전략도 효과적입니다. 이 내용은 [Skill 자동 발동 디버깅 포스트](/ClaudeCode/claude-code-skill-auto-trigger-debugging/)에서 상세히 다루었습니다.

# 정리

---

Skill Creator의 핵심 내용을 하나의 흐름으로 정리합니다.

```text
Skill 설계 흐름:

1. 설계 원칙 결정
   ├── 간결함: "Claude가 이 정보를 필요로 하는가?"
   └── 자유도: 텍스트(높음) / 의사코드(중간) / 스크립트(낮음)

2. Progressive Disclosure 배치
   ├── 레벨 1 (description): 트리거 조건 → ~100 words
   ├── 레벨 2 (SKILL.md): 워크플로우 → <5k words, 500줄 이내
   └── 레벨 3 (Resources): 상세 자료 → 제한 없음
       ├── scripts/     → 결정론적 실행 (컨텍스트 미사용)
       ├── references/  → 참조 문서 (필요 시 로드)
       ├── examples/    → 예시 (필요 시 로드)
       └── assets/      → 템플릿/정적 파일 (출력 재료)

3. 6단계 프로세스
   예시 이해 → 콘텐츠 계획 → 초기화 → 편집 → 패키징 → 반복
```

| 개념 | 설명 |
|------|------|
| **컨텍스트 윈도우는 공공재** | Claude가 모르는 정보만 넣고, 일반 지식은 제외 |
| **자유도 설정** | 작업 신뢰성에 따라 텍스트(높음) ~ 스크립트(낮음) 선택 |
| **Progressive Disclosure** | description(항상) → SKILL.md(트리거 시) → Resources(필요 시) 3단계 로딩 |
| **description이 트리거의 핵심** | "This skill should be used when..." + 구체적 발화 문구 |
| **500줄 규칙** | SKILL.md는 500줄 이내, references/는 100줄 넘으면 목차 추가 |
| **리소스 분류** | scripts(실행) vs references(참조) vs examples(예시) vs assets(정적 파일) |
| **반복 개선** | 실사용 → 불편 파악 → 수정 → 재테스트 사이클 |

## 핵심 체크리스트

| 항목 | 확인 |
|------|------|
| description에 "This skill should be used when..." 패턴을 사용했는가? | |
| description에 사용자가 실제로 말할 발화 문구가 포함되어 있는가? | |
| SKILL.md 본문이 500줄 이내인가? | |
| Claude가 이미 아는 일반 지식은 제외했는가? | |
| 상세 참조 자료를 references/로 분리했는가? | |
| 반복 생성되는 코드를 scripts/로 옮겼는가? | |
| SKILL.md에서 references/ 파일을 명시적으로 언급했는가? | |
| README, CHANGELOG 같은 부가 문서를 제외했는가? | |

```text
좋은 Skill 설계 = 간결한 SKILL.md + 구체적 description + 적절한 리소스 분리
```

# Reference

---

- [Skill Creator (skills.sh)](https://skills.sh/anthropics/skills/skill-creator) - Anthropic 공식 Skill Creator
- [Claude Code Skills 공식 문서](https://code.claude.com/docs/en/skills) - Skill 시스템 전체 개요
- [Skill Creator 원본 (GitHub)](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/references/skill-creator-original.md) - Skill Creator 전체 원문
- [Skills - 커스텀 슬래시 커맨드로 반복 작업 자동화](/ClaudeCode/claude-code-skills/) - Skill 기본 개념 (이전 포스트)
- [Skill이 자동 발동되지 않는 이유 - 삽질부터 해결까지](/ClaudeCode/claude-code-skill-auto-trigger-debugging/) - description 트리거 디버깅 사례
