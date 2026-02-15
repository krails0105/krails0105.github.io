---
title: "[ClaudeCode] Extended Thinking - Claude Code의 확장 추론 기능 완전 가이드"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, ExtendedThinking, Reasoning, AdaptiveThinking, EffortLevel, Performance]
---

# Introduction

---

Claude Code에서 복잡한 아키텍처를 설계하거나 어려운 버그를 분석할 때, 단순히 프롬프트를 상세하게 작성하는 것만으론 부족할 때가 있습니다. 이럴 때 Claude Code가 **더 깊이 생각하도록** 만들 수 있다면 어떨까요?

바로 이것이 **Extended Thinking(확장 추론)** 기능입니다. Claude Code에서 기본적으로 활성화되어 있으며, Claude가 응답 전에 내부적으로 추론 토큰을 사용하여 문제를 단계별로 깊이 분석합니다. 그리고 이 추론의 **깊이를 조절하는 실제 메커니즘**은 많은 사람이 생각하는 것과 다릅니다.

이 글에서는 Extended Thinking의 개념, 실제 동작 원리, Effort Level을 통한 제어 방법, 그리고 흔한 오해를 바로잡는 내용을 다룹니다.

# 1. Extended Thinking이란?

---

## 1-1. 개념

Extended Thinking은 Claude Code가 사용자에게 응답하기 전에 **내부적으로 추론 단계를 거치도록** 만드는 기능입니다. Claude Code에서는 **기본적으로 활성화**되어 있습니다.

일반적으로 LLM은 프롬프트를 받으면 바로 응답을 생성하지만, Extended Thinking이 활성화되면 Claude는 다음과 같은 추가 단계를 거칩니다.

```text
1. 문제 분석 (Problem Analysis)
   → "이 프롬프트에서 핵심 문제는 무엇인가?"

2. 접근 방법 탐색 (Approach Exploration)
   → "어떤 방법들이 가능하고, 각각의 장단점은 무엇인가?"

3. 코드베이스 맥락 통합 (Context Integration)
   → "프로젝트의 기존 패턴과 어떻게 통합할 수 있을까?"

4. Edge Case 고려 (Edge Case Analysis)
   → "예외 상황은 무엇이 있고, 어떻게 처리해야 하나?"

5. 최종 답변 구성 (Response Composition)
   → "가장 적합한 답변은 무엇인가?"
```

이 과정은 사용자에게 직접 보이지 않지만(verbose 모드에서 요약을 볼 수 있음), 최종 응답의 품질과 정확도를 크게 향상시킵니다.

## 1-2. 동작 원리

Extended Thinking은 Claude의 **출력 토큰 budget 중 일부를 내부 추론에 할당**합니다.

```text
Thinking 비활성:
  User Prompt → [추론 없음] → Response

Thinking 활성 (기본값):
  User Prompt → [추론 토큰: 최대 31,999개] → Response

참고 - API 레벨에서의 설정:
  thinking: { type: "enabled", budget_tokens: 10000 }    ← Sonnet 등
  thinking: { type: "adaptive" } + effort: "high"         ← Opus 4.6 (권장)
```

Claude Code에서는 이 API 파라미터를 사용자가 직접 조작하지 않습니다. 대신 Effort Level, `MAX_THINKING_TOKENS` 환경 변수, `/config` 토글로 간접 제어합니다 (3장에서 상세 설명).

추론 토큰이 많을수록 Claude는 다음을 수행합니다.

- **Chain-of-thought reasoning**이 더 길어지고 상세해짐
- 여러 대안을 탐색하고 비교하는 시간 확보
- 코드베이스의 패턴을 더 꼼꼼하게 분석
- Edge case를 더 많이 발견하고 처리

단, 추론 토큰은 **출력 토큰으로 과금**되므로, 추론이 깊어질수록 응답 시간이 길어지고 비용이 증가합니다.

## 1-3. Claude Code에서의 기본 상태

Claude Code에서 Extended Thinking은 **기본적으로 활성화**되어 있습니다.

```text
기본 설정:
  - Thinking: 활성 (enabled)
  - 최대 budget: 31,999 토큰
  - Opus 4.6: Effort Level = high (기본값)
```

별도 설정 없이 Claude Code를 실행하면, Claude는 이미 확장 추론을 사용하고 있습니다.

# 2. 흔한 오해: "think", "ultrathink" 키워드

---

Extended Thinking에 대해 가장 널리 퍼진 오해가 있습니다. 프롬프트에 `think`, `think hard`, `think harder`, `ultrathink` 같은 키워드를 넣으면 **추론 레벨이 달라진다**는 것입니다.

## 2-1. 공식 문서의 명시적 설명

Claude Code 공식 문서는 이에 대해 명확하게 설명합니다.

> Phrases like "think", "think hard", "ultrathink", and "think more" are **interpreted as regular prompt instructions** and **don't allocate thinking tokens**.
>
> -- [Claude Code 공식 문서 - Common Workflows](https://code.claude.com/docs/en/common-workflows)

즉, 이 키워드들은 **추론 토큰 budget에 어떤 영향도 주지 않습니다.** 일반적인 프롬프트 텍스트로 처리될 뿐입니다.

## 2-2. 오해가 퍼진 이유

이 오해가 널리 퍼진 데는 몇 가지 이유가 있습니다.

```text
1. Claude API의 Thinking 파라미터와 혼동:
   - API에서는 thinking: { type: "enabled", budget_tokens: N }으로 추론을 제어
   - 이 API 파라미터와 프롬프트 키워드를 혼동

2. 체감 효과:
   - "think hard"라고 쓰면 Claude가 더 상세하게 답변하는 것처럼 느껴짐
   - 이는 추론 토큰 증가가 아니라, 프롬프트 지시에 따라 텍스트 응답이 상세해진 것

3. Skills/Subagents에서의 ultrathink:
   - Skill 파일 안에 "ultrathink"을 포함하면 서브에이전트에서 확장 추론이 활성화됨
   - 이 기능이 일반 프롬프트에서도 작동한다고 오해
```

## 2-3. 키워드 vs 실제 제어 메커니즘

| 항목 | "think hard" 등 키워드 | Effort Level / 설정 |
|------|----------------------|---------------------|
| **추론 토큰 영향** | 없음 | 있음 (직접 제어) |
| **공식 지원** | 일반 텍스트로 처리 | 공식 기능 |
| **작동 방식** | 프롬프트 지시로 응답 스타일에만 영향 | 실제 추론 토큰 budget 변경 |
| **설정 방법** | 프롬프트에 텍스트 입력 | `/model`, 환경 변수, `/config` |

## 2-4. 예외: Skills에서의 "ultrathink"

한 가지 예외가 있습니다. **Skill 파일(커스텀 슬래시 커맨드)** 안에 `ultrathink`을 포함하면, 해당 **서브에이전트**에서 확장 추론이 활성화됩니다.

```text
Skill 파일에서의 ultrathink (동작함):
  .claude/skills/review/SKILL.md 안에 "ultrathink" 포함
  → 이 skill이 서브에이전트로 실행될 때 확장 추론 활성화

일반 프롬프트에서의 ultrathink (동작하지 않음):
  "ultrathink: 이 버그를 분석해줘"
  → 일반 텍스트로 처리, 추론 토큰 변화 없음
```

이 차이를 이해하는 것이 중요합니다. 서브에이전트에 대한 자세한 내용은 [Hooks & Subagents 포스트](/claudecode/claude-code-hooks-subagents/)를 참고하세요.

# 3. 실제 제어 방법: Effort Level과 설정

---

Extended Thinking을 실제로 제어하는 메커니즘은 **Effort Level**, **환경 변수**, **토글 설정**입니다.

## 3-1. Effort Level (Opus 4.6)

Opus 4.6에서 도입된 **Adaptive Reasoning(적응형 추론)**은 Effort Level에 따라 추론 깊이를 **동적으로 조절**합니다. 고정된 토큰 budget 대신, 작업 복잡도에 맞게 추론량을 자동으로 배분합니다.

| Effort Level | 추론 깊이 | 응답 속도 | 비용 | 권장 사용 |
|-------------|----------|----------|------|----------|
| **high** (기본값) | 최대 | 느림 | 높음 | 복잡한 추론, 아키텍처 설계 |
| **medium** | 중간 | 보통 | 중간 | 일반적인 개발 작업 |
| **low** | 최소 | 빠름 | 낮음 | 단순 작업, 빠른 응답 필요 시 |

## 3-2. Effort Level 설정 방법

```text
방법 1 - /model 메뉴에서 조절:
  /model 입력 후 → 좌우 화살표 키로 Effort 슬라이더 조절

방법 2 - 환경 변수:
  export CLAUDE_CODE_EFFORT_LEVEL=low    # 빠른 응답
  export CLAUDE_CODE_EFFORT_LEVEL=medium # 균형
  export CLAUDE_CODE_EFFORT_LEVEL=high   # 깊은 추론 (기본값)

방법 3 - 설정 파일:
  // .claude/settings.json 또는 ~/.claude/settings.json
  {
    "effortLevel": "medium"
  }
```

## 3-3. Thinking 활성화/비활성화

Extended Thinking 자체를 켜고 끌 수도 있습니다.

```text
방법 1 - 키보드 토글:
  Option+T (macOS) 또는 Alt+T (Windows/Linux)
  → 현재 세션에서 Thinking on/off 전환

방법 2 - /config 메뉴:
  /config 입력 → Thinking 설정 토글
  → 전역 기본값으로 저장 (~/.claude/settings.json의 alwaysThinkingEnabled)

방법 3 - 환경 변수로 비활성화:
  export MAX_THINKING_TOKENS=0
  → 모든 모델에서 Thinking 완전 비활성화
```

## 3-4. MAX_THINKING_TOKENS 환경 변수

Opus 4.6 이외의 모델(Sonnet 등)에서는 `MAX_THINKING_TOKENS`로 추론 토큰 budget을 직접 제어합니다.

```bash
# 기본값: 31,999 토큰 (최대)
export MAX_THINKING_TOKENS=31999

# 중간 수준으로 제한
export MAX_THINKING_TOKENS=10000

# 낮은 수준으로 제한
export MAX_THINKING_TOKENS=4000

# 완전 비활성화
export MAX_THINKING_TOKENS=0
```

**주의**: Opus 4.6에서는 `MAX_THINKING_TOKENS`가 무시됩니다 (0으로 설정하여 완전 비활성화하는 경우는 예외). Opus 4.6은 Adaptive Reasoning이 Effort Level에 따라 추론 깊이를 자동 조절하기 때문입니다.

## 3-5. 모델별 제어 방식 비교

| 항목 | Opus 4.6 | Sonnet, 기타 모델 |
|------|---------|------------------|
| **추론 방식** | Adaptive Reasoning (동적) | 고정 budget (최대 31,999 토큰) |
| **주요 제어** | Effort Level (low/medium/high) | `MAX_THINKING_TOKENS` 환경 변수 |
| **기본 설정** | Effort = high | Budget = 31,999 |
| **MAX_THINKING_TOKENS** | 무시됨 (0 제외) | 직접 budget 제한 |
| **Thinking 토글** | `Option+T` / `/config` | `Option+T` / `/config` |

# 4. Thinking 과정 확인하기

---

Claude Code에서 Thinking 과정은 기본적으로 숨겨져 있지만, 확인하는 방법이 있습니다.

## 4-1. Verbose 모드

```text
Ctrl+O → Verbose 모드 토글

Verbose 모드 활성 시:
  - Claude의 내부 추론이 회색 이탤릭 텍스트로 표시
  - Claude 4 모델에서는 전체 추론이 아닌 요약본이 표시됨
  - 요약본이지만 핵심 추론 과정은 확인 가능
```

## 4-2. Claude 4 모델의 Summarized Thinking

Claude 4 이상의 모델은 전체 thinking 출력 대신 **요약본(Summarized Thinking)**을 반환합니다.

```text
중요 포인트:
  - 과금은 요약본이 아닌 실제 생성된 전체 추론 토큰 기준
  - 요약본은 핵심 추론 과정을 보존하면서 간결하게 정리
  - Claude Sonnet 3.7만 전체 thinking 출력을 반환
  - 요약에 의해 응답 품질이 저하되지는 않음
```

# 5. 사용 시나리오별 가이드

---

## 5-1. 깊은 추론이 필요한 경우

다음과 같은 상황에서는 Effort Level을 high로 유지하거나, Thinking이 활성화되어 있는지 확인하세요.

### 복잡한 아키텍처 설계

```text
마이크로서비스 아키텍처를 설계해줘.
- 서비스 간 통신은 gRPC와 Kafka를 혼용
- 이벤트 소싱 패턴 적용
- 분산 트랜잭션 고려
```

### 어려운 버그의 근본 원인 분석

```text
특정 사용자에게만 간헐적으로 발생하는 인증 실패를 분석해줘.
- 로그를 보니 JWT 토큰은 정상
- Redis 세션은 존재함
- 타임존이 다른 지역에서 주로 발생
```

### 대규모 리팩토링 계획

```text
레거시 모놀리스를 마이크로서비스로 분리하는 계획을 세워줘.
- 현재 코드베이스는 10만 줄 이상
- 서비스 경계를 최소 5개로 나눠야 함
- 점진적 마이그레이션 전략 필요
```

## 5-2. 빠른 응답이 필요한 경우

단순한 작업에서는 Effort Level을 낮추면 응답 속도와 비용을 절약할 수 있습니다.

```text
Effort Level을 low로 설정하면 좋은 경우:
  - 파일 읽기, 간단한 수정
  - 변수명 변경, 단순 함수 추가
  - 파일 탐색, 검색
  - 간단한 질문

설정 방법:
  /model → 좌우 화살표로 effort를 low로 조절
  또는
  export CLAUDE_CODE_EFFORT_LEVEL=low
```

## 5-3. 비용 최적화 전략

```text
전략 1 - Effort Level 조절 (Opus 4.6):
  복잡한 분석 → high (기본값 유지)
  일반 작업   → medium
  단순 작업   → low

전략 2 - MAX_THINKING_TOKENS 제한 (Sonnet 등):
  복잡한 분석 → 31,999 (기본값)
  일반 작업   → 10,000
  단순 작업   → 4,000

전략 3 - Thinking 비활성화:
  /config에서 Thinking 끄기 또는 MAX_THINKING_TOKENS=0
  → 단순 작업 위주 세션에서 비용 절감
```

# 6. 실전 팁

---

## 6-1. Explain → Plan → Commit과 결합

Extended Thinking은 **Explain → Plan → Commit** 워크플로우에서 특히 효과적입니다. 분석/계획 단계에서 높은 Effort를, 실행 단계에서 낮은 Effort를 사용하면 품질과 속도를 모두 확보할 수 있습니다.

```text
Step 1 - Explain (분석, Effort: high):
  이 프로젝트의 인증 흐름을 분석해줘

Step 2 - Plan (계획, Effort: high):
  JWT 인증으로 전환하는 단계별 계획을 세워줘

Step 3 - Commit (실행, Effort: medium 또는 low):
  /model → effort를 medium으로 조절
  계획대로 구현해줘
```

## 6-2. TDD와 결합

테스트를 먼저 작성할 때 Extended Thinking을 활용하면 **Edge case를 최대한 많이 발견**할 수 있습니다. Effort Level이 high인 상태에서 다음과 같이 요청하세요.

```text
JWT 인증 모듈에 대한 테스트를 작성해줘.
가능한 모든 edge case를 포함하고, 각 케이스의 예상 동작을 명시해줘.
```

Extended Thinking이 발견하는 Edge case 예시:
- 만료된 토큰
- 잘못된 서명
- 누락된 필드
- 타임존 차이
- 토큰 갱신 중 만료
- 동시 요청 충돌

## 6-3. 작업과 검증 분리

작업 완료 후 독립적인 관점으로 검증할 때 Extended Thinking을 사용하면 효과적입니다.

```text
Step 1 - 작업 (Effort: medium):
  JWT 인증을 구현해줘

Step 2 - 검증 (Effort: high):
  /clear
  /model → effort를 high로 조절
  src/auth/jwt.ts를 리뷰해줘.
  보안 취약점, 성능 이슈, edge case 처리를 중점적으로 확인해줘
```

작업은 빠르게, 검증은 깊게 진행하는 전략입니다. 새 세션(`/clear`)에서 검증하면, 작업 중 형성된 편향 없이 코드를 분석합니다.

## 6-4. opusplan 모델 활용

`opusplan` 모델 설정은 Plan Mode에서는 Opus를 사용하고 실행 모드에서는 Sonnet으로 전환하는 하이브리드 방식입니다. Extended Thinking의 비용 효율을 자동화한 것과 같습니다.

```text
/model opusplan

동작 방식:
  Plan Mode (분석/계획) → Opus 사용 (깊은 추론)
  실행 모드 (코드 생성)  → Sonnet 사용 (비용 효율)

장점:
  - Opus의 추론 능력으로 고품질 계획 수립
  - Sonnet의 효율로 빠른 실행
  - 사용자가 수동으로 모델/effort를 전환할 필요 없음
```

# 7. 자주 겪는 문제와 해결법

---

| 증상 | 원인 | 해결 |
|------|------|------|
| "think hard"를 써도 응답이 비슷함 | 키워드는 추론 토큰에 영향 없음 | Effort Level 조절 또는 `MAX_THINKING_TOKENS` 설정 |
| 단순 작업인데 응답이 너무 느림 | Effort Level이 high (기본값) | `/model`에서 effort를 low로 조절 |
| Thinking 과정을 보고 싶음 | Verbose 모드가 꺼져 있음 | `Ctrl+O`로 verbose 모드 활성화 |
| Opus 4.6에서 `MAX_THINKING_TOKENS` 설정이 안 먹힘 | Opus 4.6은 Adaptive Reasoning 사용 | `CLAUDE_CODE_EFFORT_LEVEL` 환경 변수 사용 |
| 비용이 예상보다 높음 | Thinking 토큰이 출력 토큰으로 과금 | `/config`에서 Thinking 비활성화 또는 effort 낮춤 |
| Skill에서 ultrathink가 작동하지 않음 | Skill 파일 내용에 키워드가 없음 | SKILL.md 본문에 "ultrathink" 텍스트 포함 |

# 8. 정리

---

## 8-1. Extended Thinking 핵심 요약

| 항목 | 내용 |
|------|------|
| **개념** | Claude가 응답 전에 내부 추론 토큰을 사용하여 단계별로 깊이 분석하는 기능 |
| **기본 상태** | Claude Code에서 기본적으로 활성화 (budget: 최대 31,999 토큰) |
| **제어 방법** | Effort Level (Opus 4.6), `MAX_THINKING_TOKENS` (기타 모델), `/config` 토글 |
| **"think" 등 키워드** | 추론 토큰에 영향 없음 (일반 프롬프트 텍스트로 처리) |
| **예외** | Skill 파일에 "ultrathink" 포함 시 서브에이전트에서 확장 추론 활성화 |
| **Verbose 모드** | `Ctrl+O`로 추론 과정 (요약본) 확인 가능 |
| **과금** | 전체 추론 토큰이 출력 토큰으로 과금 (요약본이 아닌 원본 기준) |

## 8-2. 제어 방법 정리

```text
Opus 4.6:
  /model → Effort 슬라이더 (low / medium / high)
  export CLAUDE_CODE_EFFORT_LEVEL=low|medium|high

Sonnet 등 기타 모델:
  export MAX_THINKING_TOKENS=10000  # budget 제한
  export MAX_THINKING_TOKENS=0      # 완전 비활성화

모든 모델 공통:
  Option+T / Alt+T  → 세션 내 Thinking 토글
  /config           → 전역 Thinking 토글
  Ctrl+O            → Verbose 모드 (추론 과정 확인)
```

## 8-3. 실전 선택 가이드

| 문제 복잡도 | 권장 Effort Level | 예시 |
|-------------|------------------|------|
| 매우 낮음 | low (또는 Thinking 비활성화) | 파일 읽기, 간단한 수정 |
| 낮음 | low | 단순 함수 추가, 변수명 변경 |
| 중간 | medium | 버그 수정, 함수 리팩토링 |
| 높음 | high (기본값) | 다중 파일 리팩토링, 복잡한 버그 |
| 매우 높음 | high + Opus 모델 | 대규모 리팩토링, 성능 최적화 |
| 극도로 높음 | high + Opus (또는 opusplan) | 아키텍처 설계, 마이그레이션 전략 |

# Reference

---

- [Claude Code 공식 문서 - Extended Thinking (Common Workflows)](https://code.claude.com/docs/en/common-workflows)
- [Claude Code 공식 문서 - Effort Level (Model Configuration)](https://code.claude.com/docs/en/model-config)
- [Claude Code 공식 문서 - 환경 변수 설정](https://code.claude.com/docs/en/settings)
- [Claude Platform - Extended Thinking 상세 문서](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Claude Platform - Adaptive Thinking (Opus 4.6)](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Claude Code 공식 문서 - 비용 관리](https://code.claude.com/docs/en/costs)
- 관련 포스트: [Claude Code 필수 60가지 팁](/claudecode/claude-code-60-tips/)
- 관련 포스트: [Claude Code 입문](/claudecode/claude-code-introduction/)
- 관련 포스트: [Hooks & Subagents](/claudecode/claude-code-hooks-subagents/)
