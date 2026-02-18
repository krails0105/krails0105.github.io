---
title: "[ClaudeCode] 커스텀 스킬이 Skill 도구에서 인식되지 않는 문제 해결 - 슬래시 커맨드 vs 독립 스킬 vs 플러그인 스킬"
categories:
  - ClaudeCode
tags:
  - [Claude Code, Plugin, Skill, Troubleshooting, Slash Command]
---

# Introduction

---

Claude Code에서 커스텀 스킬을 만들었는데, 사용자가 직접 `/post`를 입력하면 동작하지만 Claude가 Skill 도구로 프로그래밍적으로 호출하면 **"Unknown skill: post"** 에러가 발생하는 문제를 해결한 과정을 정리한다.

이 글에서는 Claude Code의 세 가지 스킬 등록 방식(슬래시 커맨드, 독립 스킬, 플러그인 스킬)의 차이를 이해하고, 플러그인 기반 스킬로 변환하여 Skill 도구에서 정상 인식되도록 만드는 방법을 다룬다.

# 사전 지식

---

이 글을 따라가려면 다음 정도의 경험이 있으면 좋다.

- Claude Code CLI 기본 사용 경험
- JSON 파일 편집 경험
- 터미널 기본 명령어 (`mkdir`, `mv` 등)

# 문제 상황

---

블로그 자동화를 위한 `/post` 스킬을 `~/.claude/skills/post/SKILL.md`에 만들었다.

| 호출 방식 | 동작 여부 |
|-----------|-----------|
| 사용자가 `/post` 입력 | 정상 동작 |
| Claude가 Skill 도구로 호출 | "Unknown skill: post" 에러 |

수동 호출은 되는데 자동 호출은 안 되는 상황이었다.

## 스킬 목록에서 누락 확인

세션 시작 시 Claude Code는 "available for use with the Skill tool" 목록을 보여준다. 여기서 `post` 스킬이 빠져 있었다.

```
- keybindings-help (빌트인)
- cryptoquant:crypto (플러그인)
- cryptoquant:crypto-whale (플러그인)
- cryptoquant:crypto-market (플러그인)
- cryptoquant:crypto-signal (플러그인)
```

반면 `cryptoquant:*` 스킬들은 Skill 도구로도 정상 호출되었다. **플러그인으로 등록된 스킬만 Skill 도구에서 인식된다**는 것이 힌트였다.

# 핵심 개념: 세 가지 스킬 등록 방식

---

원인을 파악하기 전에, Claude Code가 스킬을 등록하는 세 가지 방식을 이해해야 한다.

## 1. 슬래시 커맨드 (`~/.claude/commands/`)

```
~/.claude/commands/
├── review.md        # /review 커맨드
├── test.md          # /test 커맨드
└── deploy.md        # /deploy 커맨드
```

- **공식 문서에 명시적으로 지원되는 방식**이다.
- 사용자가 `/커맨드명`으로 직접 호출하는 개인 슬래시 커맨드 용도이다.
- Claude AI가 Skill 도구를 통해 프로그래밍적으로 호출할 수는 **없다**.

## 2. 독립 스킬 (`~/.claude/skills/`)

```
~/.claude/skills/
└── post/
    └── SKILL.md
```

- 사용자가 `/post`로 직접 호출하면 Claude Code가 이 경로를 스캔하여 로드한다.
- 그러나 **공식 문서에 이 경로에 대한 명시적 설명이 없다** (비공식 경로일 가능성이 있다).
- Claude AI가 Skill 도구를 통해 프로그래밍적으로 호출할 수는 **없다**.

## 3. 플러그인 스킬 (`plugin/skills/`)

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json       # "skills": "./skills/" 설정 필수
├── commands/
├── agents/
└── skills/
    └── my-skill/
        └── SKILL.md
```

- **공식 문서에 명시적으로 지원되는 방식**이다.
- 플러그인 내부의 `skills/` 디렉토리에 있는 스킬은 **자동 탐색(auto-discovery)** 된다.
- 사용자 호출(`/plugin-name:skill-name`)과 **Skill 도구를 통한 프로그래밍적 호출** 모두 가능하다.
- `settings.json`의 `enabledPlugins`에 등록되어야 한다.

> **주의**: 공식 문서에서 언급하는 "Skills are automatically discovered"는 **플러그인 내부의 `skills/` 디렉토리**에 대한 설명이다. `~/.claude/skills/`에 대한 auto-discovery가 아니다. 공식 문서 원문에도 "This organizational pattern is distinct from standalone skills"라고 명시되어 있다.

## 세 방식 비교

| 구분 | 슬래시 커맨드 | 독립 스킬 | 플러그인 스킬 |
|------|-------------|-----------|--------------|
| **경로** | `~/.claude/commands/` | `~/.claude/skills/` | `plugin/skills/` |
| **공식 문서 지원** | O (명시적) | X (문서에 없음) | O (명시적) |
| **사용자 `/name` 호출** | O | O | O (`/plugin:name`) |
| **Skill 도구 호출** | X | X | O |
| **세션 스킬 목록 표시** | X | X | O |
| **auto-discovery** | X | X | O |

## 두 가지 호출 방식의 차이

이 문제의 핵심은 "누가 호출하느냐"에 따라 인식 범위가 다르다는 점이다.

| 호출 주체 | 동작 | 스캔 범위 |
|-----------|------|-----------|
| **사용자** (`/post` 입력) | 사용자가 직접 슬래시 커맨드 입력 | `~/.claude/commands/`, `~/.claude/skills/`, 프로젝트 `.claude/commands/` 등 넓은 범위 |
| **Claude AI** (Skill 도구) | Claude가 프로그래밍적으로 호출 | `enabledPlugins`에 등록된 **플러그인 기반 스킬만** 인식 |

즉, `~/.claude/skills/post/SKILL.md`에 스킬을 넣으면 사용자가 `/post`로 호출하는 건 되지만, Claude AI가 Skill 도구로 호출할 때는 플러그인 목록에서만 찾기 때문에 **"Unknown skill"** 에러가 발생하는 것이다.

# 조사 과정: 동작하는 플러그인 구조 분석

---

왜 `cryptoquant:*` 스킬들은 정상 동작하는지, 해당 플러그인의 등록 구조를 하나씩 확인했다.

## 1. 마켓플레이스 등록

`~/.claude/plugins/known_marketplaces.json`:

```json
{
  "cryptoquant": {
    "source": {
      "source": "github",
      "owner": "cryptoquant-official",
      "repo": "claude-code-plugins"
    },
    "installLocation": "/Users/test/.claude/plugins/cache/cryptoquant"
  }
}
```

## 2. 플러그인 설치 기록

`~/.claude/plugins/installed_plugins.json`:

```json
{
  "claude-cryptoquant-plugin@cryptoquant": [
    {
      "scope": "user",
      "installPath": "/Users/test/.claude/plugins/cache/cryptoquant/claude-cryptoquant-plugin/0.1.0",
      "version": "0.1.0"
    }
  ]
}
```

## 3. 플러그인 활성화

`~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "claude-cryptoquant-plugin@cryptoquant": true
  }
}
```

## 4. 플러그인 메타데이터 (plugin.json)

`~/.claude/plugins/cache/cryptoquant/claude-cryptoquant-plugin/0.1.0/.claude-plugin/plugin.json`:

```json
{
  "name": "claude-cryptoquant-plugin",
  "version": "0.1.0",
  "description": "CryptoQuant Plugin for Claude Code",
  "skills": "./skills/"
}
```

`"skills": "./skills/"` 필드가 스킬 디렉토리 경로를 지정한다. 이 경로 아래의 스킬들이 **auto-discovery** 대상이 된다.

## 5. 스킬 디렉토리 구조

```
~/.claude/plugins/cache/cryptoquant/claude-cryptoquant-plugin/0.1.0/
└── skills/
    ├── crypto/SKILL.md
    ├── crypto-whale/SKILL.md
    ├── crypto-market/SKILL.md
    └── crypto-signal/SKILL.md
```

## 발견한 패턴

**마켓플레이스 등록 -> 플러그인 설치 -> 활성화 -> plugin.json에서 skills 경로 지정** 이 체인이 완성되어야 Skill 도구에서 인식된다. 독립 스킬(`~/.claude/skills/`)은 이 체인에 포함되지 않기 때문에 Skill 도구에서 찾을 수 없었던 것이다.

# 해결 방법: 플러그인으로 변환

---

## 플러그인 등록 체인 전체 구조

플러그인이 동작하려면 5단계 체인이 모두 설정되어야 한다.

```
1. known_marketplaces.json     <- 마켓플레이스 등록
     |
2. plugins/cache/ 디렉토리     <- 플러그인 파일 배치
     |- .claude-plugin/plugin.json       <- 플러그인 메타데이터
     |- .claude-plugin/marketplace.json  <- 마켓플레이스 정보
     +- skills/post/SKILL.md             <- 스킬 정의
     |
3. installed_plugins.json      <- 플러그인 설치 기록
     |
4. settings.json               <- enabledPlugins에서 활성화
     |
5. 세션 재시작                   <- 스킬 목록 갱신
```

## 단계별 구현

### Step 1. 플러그인 디렉토리 생성

```bash
# 플러그인 메타데이터 디렉토리
mkdir -p ~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/.claude-plugin

# 스킬 디렉토리
mkdir -p ~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/skills/post
```

디렉토리 경로의 구조는 `cache/{마켓플레이스명}/{플러그인명}/{버전}/` 패턴을 따른다.

### Step 2. plugin.json 작성

`~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/.claude-plugin/plugin.json`:

```json
{
  "name": "blog-automation",
  "version": "1.0.0",
  "description": "Automated blog post generation from dev/tech sessions",
  "author": {
    "name": "test"
  },
  "license": "MIT",
  "keywords": ["blog", "jekyll", "automation", "dev-to-blog"],
  "skills": "./skills/"
}
```

`"skills": "./skills/"` 필드가 **핵심**이다. 이 경로를 기준으로 Claude Code가 하위 디렉토리의 `SKILL.md` 파일들을 자동 탐색한다.

### Step 3. marketplace.json 작성

`~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/.claude-plugin/marketplace.json`:

```json
{
  "name": "blog-plugins",
  "owner": {
    "name": "test"
  },
  "metadata": {
    "description": "Local blog automation plugin"
  },
  "plugins": [
    {
      "name": "blog-automation",
      "source": "./",
      "description": "Auto-generate blog posts from dev/tech sessions",
      "version": "1.0.0",
      "author": {
        "name": "test"
      },
      "license": "MIT"
    }
  ]
}
```

### Step 4. known_marketplaces.json에 마켓플레이스 추가

`~/.claude/plugins/known_marketplaces.json`에 추가한다.

```json
{
  "blog-plugins": {
    "source": {
      "source": "local",
      "path": "/Users/test/.claude/plugins/cache/blog-plugins"
    },
    "installLocation": "/Users/test/.claude/plugins/cache/blog-plugins"
  }
}
```

로컬 플러그인은 `"source": "local"`로, GitHub에서 배포하는 플러그인은 `"source": "github"`로 설정한다.

### Step 5. installed_plugins.json에 설치 기록 추가

`~/.claude/plugins/installed_plugins.json`에 추가한다.

```json
{
  "blog-automation@blog-plugins": [
    {
      "scope": "user",
      "installPath": "/Users/test/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0",
      "version": "1.0.0"
    }
  ]
}
```

키 형식은 `{플러그인명}@{마켓플레이스명}`이다. 이것이 플러그인의 고유 식별자가 된다.

### Step 6. settings.json에서 플러그인 활성화

`~/.claude/settings.json`의 `enabledPlugins`에 추가한다.

```json
{
  "enabledPlugins": {
    "blog-automation@blog-plugins": true
  }
}
```

### Step 7. 스킬 파일 이동

기존 독립 스킬 파일을 플러그인 디렉토리로 이동한다.

```bash
# 스킬 파일을 플러그인 디렉토리로 이동
mv ~/.claude/skills/post/SKILL.md \
   ~/.claude/plugins/cache/blog-plugins/blog-automation/1.0.0/skills/post/

# 기존 독립 스킬 디렉토리 삭제
rm -rf ~/.claude/skills/post/
```

### Step 8. 세션 재시작

Claude Code 세션을 재시작하면 스킬 목록에 다음이 추가된다.

```
- blog-automation:post (플러그인)
```

이제 사용자 호출(`/blog-automation:post`)과 Skill 도구를 통한 프로그래밍적 호출 모두 정상 동작한다.

# 디렉토리 구조 비교 (Before / After)

---

## Before: 독립 스킬

```
~/.claude/
└── skills/
    └── post/
        └── SKILL.md        <- Skill 도구에서 인식 불가
```

## After: 플러그인 스킬

```
~/.claude/
├── plugins/
│   ├── cache/
│   │   └── blog-plugins/                         <- 마켓플레이스
│   │       └── blog-automation/                   <- 플러그인
│   │           └── 1.0.0/                         <- 버전
│   │               ├── .claude-plugin/
│   │               │   ├── plugin.json            <- 플러그인 메타데이터
│   │               │   └── marketplace.json       <- 마켓플레이스 정보
│   │               └── skills/
│   │                   └── post/
│   │                       └── SKILL.md           <- 스킬 정의
│   ├── installed_plugins.json                     (수정됨)
│   └── known_marketplaces.json                    (수정됨)
└── settings.json                                  (수정됨)
```

Skill 도구에서 `blog-automation:post`로 정상 인식된다.

# 자주 만나는 실수와 주의사항

---

## 1. 세션 재시작을 잊는 경우

스킬 목록은 세션 시작 시 한 번만 로드된다. 플러그인 설정을 변경한 후에는 **반드시 Claude Code 세션을 재시작**해야 한다. 재시작 없이 동작하지 않는다고 당황하지 말자.

## 2. plugin.json의 skills 경로 오타

`plugin.json`의 `"skills"` 값과 실제 디렉토리명이 정확히 일치해야 한다.

```json
// 잘못된 예: 's'가 빠짐
{ "skills": "./skill/" }

// 올바른 예
{ "skills": "./skills/" }
```

실제 디렉토리가 `skills/post/SKILL.md`라면, `"skills": "./skills/"`여야 한다.

## 3. 네임스페이스 호출 형태 변경

플러그인 스킬은 `{플러그인명}:{스킬명}` 형태로 호출한다. 기존 독립 스킬의 호출 방식과 다르므로 주의한다.

```
독립 스킬:    /post
플러그인 스킬: /blog-automation:post
```

Skill 도구에서의 호출도 동일한 네임스페이스를 사용한다.

## 4. 등록 체인 중 하나라도 빠지면 실패

5단계 체인(마켓플레이스 -> 디렉토리 -> 설치 기록 -> 활성화 -> 재시작) 중 **어느 하나라도 누락되면** 스킬이 인식되지 않는다. "설정은 다 했는데 안 된다"면 체인을 처음부터 하나씩 확인하자.

## 5. 로컬 vs GitHub 플러그인의 source 설정

| 타입 | source 설정 | 추가 필드 |
|------|-------------|-----------|
| 로컬 | `"source": "local"` | `"path": "/absolute/path"` |
| GitHub | `"source": "github"` | `"owner": "...", "repo": "..."` |

로컬 플러그인에서 GitHub 플러그인으로 전환할 때 이 부분을 함께 변경해야 한다.

## 6. 버전 디렉토리 관리

플러그인 디렉토리에 버전 번호가 포함된다.

```
.../blog-automation/1.0.0/     <- 현재 버전
.../blog-automation/1.1.0/     <- 업데이트 시 새 디렉토리 생성
```

`installed_plugins.json`의 `version` 필드와 디렉토리 경로의 버전이 일치해야 한다.

# 정리

---

| 핵심 포인트 | 설명 |
|------------|------|
| 문제 원인 | `~/.claude/skills/`의 독립 스킬은 Skill 도구에서 인식되지 않음 |
| 근본 이유 | Skill 도구는 `enabledPlugins`에 등록된 플러그인 기반 스킬만 스캔함 |
| 해결 방법 | 5단계 플러그인 등록 체인을 완성하여 플러그인 스킬로 변환 |
| 호출 형태 변경 | `/post` -> `/blog-automation:post` |

Claude Code에서 **사용자가 직접 호출하는 용도**라면 `~/.claude/commands/`의 슬래시 커맨드로 충분하다. 하지만 **Claude AI가 Skill 도구를 통해 프로그래밍적으로 호출**해야 하는 경우라면 반드시 플러그인으로 등록해야 한다.

# 다음 단계

---

## 1. 플러그인 GitHub 공유

로컬 플러그인을 GitHub에 올려 다른 사용자와 공유할 수 있다.

1. GitHub 리포지토리 생성
2. 플러그인 디렉토리 구조를 push
3. `known_marketplaces.json`에서 `"source": "github"` 설정으로 변경

## 2. 하나의 플러그인에 다중 스킬 추가

```
skills/
├── post/SKILL.md
├── review/SKILL.md
└── summary/SKILL.md
```

`blog-automation:post`, `blog-automation:review`, `blog-automation:summary` 형태로 호출할 수 있다.

# Reference

---

- [Claude Code 공식 GitHub - 플러그인 구조](https://github.com/anthropics/claude-code/tree/main/plugins)
- [Claude Code Plugin Dev - 스킬 개발 가이드](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md)
- [Claude Code Plugin Dev - 플러그인 구조 스킬](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/plugin-structure/SKILL.md)

## 관련 설정 파일

- `~/.claude/plugins/known_marketplaces.json` - 마켓플레이스 등록
- `~/.claude/plugins/installed_plugins.json` - 플러그인 설치 기록
- `~/.claude/settings.json` - 플러그인 활성화 설정 (`enabledPlugins`)
- `.claude-plugin/plugin.json` - 플러그인 메타데이터 (skills 경로 지정)
