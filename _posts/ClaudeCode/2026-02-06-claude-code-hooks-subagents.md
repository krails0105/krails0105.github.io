---
title: "[ClaudeCode] Hooks & Subagents - 자동화 파이프라인과 멀티에이전트"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, Hooks, Subagents, MultiAgent, Automation, TaskTool]
---

# Introduction

---

Claude Code를 사용하다 보면 두 가지 니즈가 생깁니다. 하나는 **"파일 수정 후 항상 린터를 돌려줘"** 같은 **자동화 규칙**이고, 다른 하나는 **"이 5개 파일을 동시에 분석해줘"** 같은 **병렬 처리**입니다. **Hooks**는 전자를, **Subagents**는 후자를 담당합니다.

Hooks는 CI/CD 파이프라인의 pre-commit hook처럼 특정 이벤트에 자동으로 실행되는 명령이고, Subagents는 메인 Claude가 전문 분야별 보조 에이전트에게 작업을 위임하는 구조입니다.

이 글은 Hooks의 이벤트 체계와 설정법, Subagents의 종류와 활용 패턴을 정리합니다.

# 1. Hooks란?

---

## 개념

Hook은 Claude Code의 **라이프사이클 이벤트에 연결된 자동 실행 명령**입니다. Claude가 어떤 선택을 하든 상관없이, 특정 이벤트가 발생하면 **항상** 실행됩니다.

```text
예시:
  Claude가 파일을 수정할 때마다 → 자동으로 ESLint 실행
  Claude가 Bash를 실행하려 할 때 → 위험한 명령인지 검사
  세션이 시작될 때 → 환경 변수 초기화
```

## Hook vs 프롬프트 지시

| 항목 | 프롬프트로 지시 | Hook |
|------|---------------|------|
| **실행 보장** | Claude가 잊을 수 있음 | 항상 실행 |
| **결정 주체** | AI 판단 | 규칙 기반 (결정적) |
| **적용 범위** | 현재 세션 | 모든 세션 |
| **설정 방법** | 대화로 요청 | 설정 파일 |

핵심 차이는 **결정적(deterministic)** 실행입니다. "파일 수정 후 린터를 돌려줘"라고 프롬프트로 지시하면 Claude가 가끔 잊을 수 있지만, Hook으로 설정하면 100% 실행됩니다.

# 2. Hook 이벤트

---

## 이벤트 종류

| 이벤트 | 시점 | 대표 활용 |
|--------|------|----------|
| `SessionStart` | 세션 시작 | 환경 초기화, 상태 확인 |
| `PreToolUse` | 도구 실행 **전** | 위험 명령 차단, 입력 검증 |
| `PostToolUse` | 도구 실행 **후** | 린터 실행, 포매팅 |
| `Stop` | Claude 응답 완료 | 결과 검증, 알림 발송 |
| `PreCompact` | 컨텍스트 압축 전 | 중요 정보 보존 |

## 실행 흐름

```text
사용자: "이 파일을 수정해줘"

  1. Claude가 Edit 도구 사용 결정
  2. [PreToolUse Hook 실행] → matcher가 "Edit"에 매칭
     → 보안 검사 스크립트 실행
     → 결과: allow → 계속 진행
  3. Edit 도구 실행 (파일 수정)
  4. [PostToolUse Hook 실행] → matcher가 "Edit"에 매칭
     → ESLint --fix 실행
     → 결과를 Claude에게 피드백
  5. Claude가 응답 완료
  6. [Stop Hook 실행]
     → 변경 요약 로그 기록
```

# 3. Hook 설정법

---

## 대화형 설정

```text
/hooks
→ 이벤트 선택 (PreToolUse, PostToolUse 등)
→ matcher 입력 (대상 도구 패턴)
→ 실행 명령어 입력
```

## 설정 파일 직접 편집

`~/.claude/settings.json` 또는 `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ./scripts/validate-command.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx eslint --fix $FILE_PATH"
          }
        ]
      }
    ]
  }
}
```

## Hook 정의 구조

```text
matcher:   정규식 패턴 (어떤 도구에 반응할지)
type:      "command" (셸 명령) 또는 "prompt" (LLM 평가)
command:   실행할 셸 명령어
prompt:    LLM이 평가할 프롬프트 (type: prompt일 때)
timeout:   최대 실행 시간 (초)
```

## Hook 타입: Command vs Prompt

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "command",
          "command": "bash ./check-security.sh"
        }
      ]
    },
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "prompt",
          "prompt": "이 Bash 명령이 프로덕션 환경에서 안전한지 평가하세요. 파괴적 명령, 안전장치 누락을 확인하세요."
        }
      ]
    }
  ]
}
```

- **command**: 셸 스크립트를 실행하여 결과로 판단 (빠르고 결정적)
- **prompt**: LLM이 상황을 평가하여 판단 (유연하지만 비용 발생)

# 4. Hook의 제어 흐름

---

## PreToolUse에서 실행 차단

```text
Exit Code 0: 정상 → 도구 실행 허용
Exit Code 2: 차단 → 도구 실행 거부, stderr를 Claude에게 피드백
```

## 예시: 위험 명령 차단 스크립트

```bash
#!/bin/bash
# check-dangerous.sh
# PreToolUse Hook에서 Bash 도구에 연결

INPUT=$(cat)  # stdin으로 도구 입력 수신
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# 위험한 패턴 검사
if echo "$COMMAND" | grep -qE 'rm -rf|DROP TABLE|format'; then
  echo "차단: 위험한 명령이 감지되었습니다" >&2
  exit 2  # 실행 차단
fi

exit 0  # 실행 허용
```

## PreToolUse의 JSON 응답 (고급)

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "updatedInput": {
      "command": "수정된 명령어"
    }
  },
  "systemMessage": "Claude에게 전달할 메시지"
}
```

`permissionDecision`으로 allow/deny/ask를 지정하고, `updatedInput`으로 도구 입력을 수정할 수도 있습니다.

# 5. Subagents란?

---

## 개념

Subagent는 **특정 작업에 특화된 보조 AI 에이전트**입니다. 메인 Claude가 직접 처리하는 대신, 전문 에이전트에게 작업을 위임합니다. 각 서브에이전트는 **독립된 컨텍스트 윈도우**에서 실행됩니다.

```text
메인 Claude:
  "이 5개 모듈의 구조를 분석해야 하는데..."
  → Explore 에이전트에게 모듈 A 분석 위임
  → Explore 에이전트에게 모듈 B 분석 위임
  → 결과를 종합하여 사용자에게 보고
```

## 왜 Subagent를 쓰는가?

```text
1. 컨텍스트 보호:
   대량의 파일 읽기/분석 결과가 메인 컨텍스트를 차지하는 것 방지
   서브에이전트의 결과만 요약되어 돌아옴

2. 병렬 처리:
   독립적인 작업을 동시에 실행
   예: 5개 파일을 병렬로 분석

3. 전문화:
   작업 유형에 맞는 도구와 모델 조합
   예: 탐색은 빠른 모델, 코드 작성은 정밀한 모델
```

# 6. 기본 제공 Subagent 유형

---

| 유형 | 모델 | 도구 | 용도 |
|------|------|------|------|
| **Explore** | Haiku (빠름) | 읽기 전용 (Read, Grep, Glob) | 코드베이스 탐색, 파일 검색 |
| **Plan** | 상속 | 읽기 전용 | 구현 계획 수립, 설계 검토 |
| **Bash** | 상속 | Bash만 | 터미널 명령 실행 |
| **general-purpose** | 상속 | 전체 | 복잡한 멀티스텝 작업 |

## Explore 에이전트

```text
용도: 코드베이스에서 빠르게 정보를 찾을 때
모델: Haiku (빠르고 저렴)
도구: Read, Grep, Glob (읽기만 가능)

예시:
  "src/ 디렉토리에서 인증 관련 파일을 모두 찾아줘"
  → Explore 에이전트가 빠르게 탐색
  → 결과만 메인 컨텍스트에 반환
```

## general-purpose 에이전트

```text
용도: 복잡한 작업을 독립적으로 수행
모델: 메인과 동일
도구: 전체 도구 사용 가능

예시:
  "이 테스트 파일들을 각각 분석하고 커버리지를 계산해줘"
  → general-purpose 에이전트가 전체 작업 수행
  → 결과를 메인에 보고
```

# 7. 병렬 실행

---

## 독립 작업의 병렬화

Subagent의 핵심 장점 중 하나는 **독립적인 작업을 동시에 실행**할 수 있다는 점입니다.

```text
순차 실행 (서브에이전트 미사용):
  파일 A 분석 (30초) → 파일 B 분석 (30초) → 파일 C 분석 (30초)
  총 90초

병렬 실행 (서브에이전트 사용):
  파일 A 분석 (30초) ─┐
  파일 B 분석 (30초) ──┤ 동시 실행
  파일 C 분석 (30초) ─┘
  총 30초
```

## 병렬 실행의 조건

```text
✅ 병렬 가능:
  - 작업 간 의존성이 없을 때
  - 각 작업이 독립적인 파일/모듈을 대상으로 할 때

❌ 순차 실행 필요:
  - 이전 작업의 결과가 다음 작업의 입력일 때
  - 같은 파일을 여러 에이전트가 수정해야 할 때
```

# 8. 커스텀 Subagent

---

## 파일 기반 정의

```text
프로젝트 에이전트:
  .claude/agents/<agent-name>/CLAUDE.md

사용자 에이전트:
  ~/.claude/agents/<agent-name>/CLAUDE.md
```

## CLAUDE.md 예시 (코드 리뷰어)

```markdown
---
name: code-reviewer
description: 코드 변경사항을 보안, 성능, 컨벤션 관점에서 리뷰합니다
tools: Read, Grep, Glob
model: sonnet
---

당신은 시니어 코드 리뷰어입니다. 코드를 리뷰할 때:

1. 보안 취약점을 먼저 확인합니다
2. 성능 이슈를 점검합니다
3. 코딩 컨벤션 준수 여부를 확인합니다
4. 발견한 이슈를 심각도별로 분류합니다:
   - Critical: 즉시 수정 필요
   - Warning: 개선 권장
   - Info: 참고 사항
```

## Frontmatter 옵션

```yaml
---
name: agent-name              # 에이전트 이름
description: 설명              # 자동 매칭에 사용
tools: Read, Grep, Bash       # 사용 가능한 도구 제한
model: sonnet                  # 실행 모델 (haiku는 빠르고 저렴)
---
```

## 모델 선택 전략

```text
Haiku:  빠른 탐색, 간단한 분석 (비용 최소화)
Sonnet: 일반적인 코딩 작업
Opus:   복잡한 아키텍처 분석, 정밀한 추론
```

작업 유형에 맞는 모델을 지정하면 **비용과 속도를 최적화**할 수 있습니다.

# 9. Hooks + Subagents 조합 패턴

---

## 패턴: 코드 수정 후 자동 리뷰

```text
1. 사용자: "이 기능을 구현해줘"
2. Claude가 코드 수정 (Edit 도구)
3. [PostToolUse Hook] → code-reviewer 서브에이전트 호출
4. 리뷰 결과를 Claude에게 피드백
5. Claude가 리뷰 피드백 반영하여 수정
```

## 패턴: 세션 시작 시 프로젝트 상태 확인

```text
1. 세션 시작
2. [SessionStart Hook]
   → git status 확인
   → 미완료 TODO 수집
   → 실패한 테스트 목록 수집
3. 결과를 Claude에게 전달
4. Claude가 현재 상태를 파악한 채로 대화 시작
```

# 10. 주의사항

---

```text
Hooks:
  - timeout을 설정하지 않으면 Hook이 무한 대기할 수 있음
  - PreToolUse Hook에서 exit 2로 차단하면 Claude에게 이유를 알려줘야 함
  - prompt 타입 Hook은 매 실행마다 토큰을 소비

Subagents:
  - 서브에이전트는 다른 서브에이전트를 생성할 수 없음 (1단계만 가능)
  - 백그라운드 서브에이전트는 MCP 도구에 접근 불가
  - 일부 에이전트(general-purpose 등)는 현재 대화 컨텍스트에 접근 가능하지만,
    Explore 같은 경량 에이전트는 독립 컨텍스트에서 실행 → 상세한 지시 필요
```

# 11. 정리

---

| 개념 | 설명 |
|------|------|
| **Hook** | 라이프사이클 이벤트에 연결된 자동 실행 명령 |
| **Hook 이벤트** | PreToolUse, PostToolUse, Stop, SessionStart 등 |
| **Hook 타입** | command (셸 실행), prompt (LLM 평가) |
| **Subagent** | 독립 컨텍스트에서 실행되는 전문 보조 에이전트 |
| **기본 유형** | Explore(탐색), Plan(설계), Bash(명령), general-purpose(범용) |
| **병렬 실행** | 독립 작업을 동시에 실행하여 속도 향상 |
| **커스텀 에이전트** | CLAUDE.md로 도구/모델/역할 정의 |

```text
핵심:
  Hooks = "이벤트가 발생하면 항상 이것을 실행해라" (자동화)
  Subagents = "이 작업은 전문가에게 맡겨라" (위임과 병렬화)
  조합하면 = 코드 수정 → 자동 린트 → 자동 리뷰 파이프라인 구축 가능
```

# Reference

---

- [Claude Code Hooks 공식 문서](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code Subagents 가이드](https://docs.anthropic.com/en/docs/claude-code/sub-agents)
- [Claude Code Plugin Hook 개발](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev/skills/hook-development)
