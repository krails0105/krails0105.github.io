---
title: "[ClaudeCode] MCP Servers & Plugins - 외부 도구 연결로 능력 확장"
categories:
  - ClaudeCode
tags:
  - [ClaudeCode, MCP, ModelContextProtocol, Plugins, Integration]
---

# Introduction

---

Claude Code는 기본적으로 파일 읽기/쓰기, 셸 명령 실행, 웹 검색 등의 도구를 가지고 있습니다. 하지만 데이터베이스 조회, Jira 티켓 관리, Figma 디자인 접근 같은 **외부 시스템 연동**은 기본 도구만으로는 불가능합니다. **MCP(Model Context Protocol)**는 이런 외부 도구를 Claude Code에 연결하는 표준 프로토콜이며, **Plugin**은 MCP 서버를 포함한 Skills, Hooks, Agents를 묶어 배포하는 패키지입니다.

전원 콘센트(프로토콜)에 다양한 가전제품(외부 도구)을 꽂아 사용하는 것처럼, MCP라는 표준 인터페이스에 다양한 서비스를 연결하는 구조입니다.

이 글은 MCP의 개념, 서버 설정법, Plugin 시스템, 그리고 실전 활용 패턴을 정리합니다.

# 1. MCP (Model Context Protocol)란?

---

## 개념

MCP는 Anthropic이 2024년에 공개한 **오픈소스 표준 프로토콜**로, AI 시스템과 외부 도구/데이터 소스 간의 통신을 표준화합니다.

```text
MCP 이전:
  Claude Code ←(커스텀 코드)→ GitHub API
  Claude Code ←(커스텀 코드)→ PostgreSQL
  Claude Code ←(커스텀 코드)→ Jira API
  → 각각 별도의 연동 코드 필요

MCP 이후:
  Claude Code ←(MCP 프로토콜)→ GitHub MCP Server
  Claude Code ←(MCP 프로토콜)→ PostgreSQL MCP Server
  Claude Code ←(MCP 프로토콜)→ Jira MCP Server
  → 동일한 프로토콜로 모든 서버와 통신
```

## MCP 서버가 제공하는 것

```text
Tools (도구):
  Claude가 호출할 수 있는 함수
  예: query_database(), create_issue(), fetch_design()

Resources (리소스):
  Claude가 참조할 수 있는 데이터
  예: 문서, 설정 파일, 데이터베이스 스키마

Prompts (프롬프트):
  사전 정의된 프롬프트 템플릿
  예: "이 테이블의 ERD를 그려줘" 같은 특화 프롬프트
```

# 2. MCP 서버 연결 방식

---

MCP 서버는 3가지 방식으로 연결할 수 있습니다.

## Stdio (로컬 프로세스)

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["./servers/db-server.js"],
      "env": {
        "DB_URL": "postgresql://localhost:5432/mydb"
      }
    }
  }
}
```

- Claude Code가 **로컬 프로세스를 직접 실행**
- 표준 입출력(stdin/stdout)으로 통신
- 가장 일반적인 방식

## HTTP (원격 서버)

```json
{
  "mcpServers": {
    "github": {
      "url": "https://mcp.github.com/server",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

- **원격 서버에 HTTP 요청**으로 통신
- 서버가 별도로 실행 중이어야 함
- 팀에서 공유 서버로 운영 시 유용

## SSE (Server-Sent Events)

```json
{
  "mcpServers": {
    "monitor": {
      "type": "sse",
      "url": "https://monitor.example.com/mcp/events"
    }
  }
}
```

- HTTP 기반 **실시간 스트리밍** 연결
- 모니터링, 로그 등 실시간 데이터에 적합

## 연결 방식 비교

| 방식 | 실행 위치 | 통신 | 적합한 상황 |
|------|----------|------|------------|
| Stdio | 로컬 | stdin/stdout | 개인 개발, 로컬 DB |
| HTTP | 원격 | HTTP 요청 | 팀 공유 서버, SaaS |
| SSE | 원격 | HTTP 스트리밍 | 실시간 모니터링 |

# 3. 설정 파일 위치와 스코프

---

## 스코프별 설정

```text
사용자 레벨 (모든 프로젝트에 적용):
  ~/.claude/mcp.json

프로젝트 레벨 (현재 프로젝트에만 적용):
  .claude/mcp.json

플러그인 레벨 (플러그인 내장):
  <plugin>/.mcp.json 또는 plugin.json 내 inline
```

## 설정 파일 형식

```json
{
  "mcpServers": {
    "server-name": {
      "command": "실행 명령어",
      "args": ["인자1", "인자2"],
      "env": {
        "ENV_VAR": "값 또는 ${환경변수}"
      }
    }
  }
}
```

`env`에서 `${ENV_VAR}` 문법으로 시스템 환경 변수를 참조할 수 있어, 시크릿을 설정 파일에 직접 넣지 않아도 됩니다.

# 4. 주요 MCP 서버 예시

---

## 문서 검색 (Context7)

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

라이브러리 공식 문서를 실시간으로 검색합니다. Claude Code가 코드를 작성할 때 최신 API 문서를 참조할 수 있습니다.

```text
사용 흐름:
  1. resolve-library-id → 라이브러리 ID 조회
  2. query-docs → 해당 라이브러리 문서 검색
  → Claude가 최신 API 정보를 기반으로 코드 작성
```

## 데이터베이스 (PostgreSQL)

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}"
      }
    }
  }
}
```

데이터베이스 스키마 조회, 쿼리 실행 등을 Claude Code에서 직접 수행합니다.

## GitHub

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

이슈 관리, PR 리뷰, 코드 검색 등 GitHub API를 Claude Code에서 사용합니다.

# 5. Plugin 시스템

---

## Plugin이란?

Plugin은 **Skills + Agents + Hooks + MCP 서버를 하나로 묶은 배포 패키지**입니다.

```text
개별 설정:
  Skills → .claude/skills/에 직접 배치
  Hooks → settings.json에 직접 설정
  MCP → mcp.json에 직접 설정
  → 각각 따로 설치/관리

Plugin:
  plugin.json 하나로 모든 구성 요소 정의
  → 설치 한 번으로 전부 활성화
```

## Plugin 구조

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json          ← 매니페스트 (메타데이터)
├── skills/                   ← 스킬 모음
│   ├── code-review/
│   │   └── SKILL.md
│   └── deploy/
│       └── SKILL.md
├── agents/                   ← 커스텀 에이전트
│   └── reviewer/
│       └── CLAUDE.md
├── hooks/                    ← Hook 설정
│   └── hooks.json
└── servers/                  ← MCP 서버
    └── api-server.js
```

## plugin.json 예시

```json
{
  "name": "devops-toolkit",
  "version": "1.0.0",
  "description": "DevOps 자동화 플러그인",
  "skills": ["./skills"],
  "agents": ["./agents"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": {
    "monitoring": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/servers/api-server.js"]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}`는 플러그인 루트 디렉토리를 가리키는 특수 변수입니다.

## Plugin vs 개별 설정

| 항목 | 개별 설정 | Plugin |
|------|----------|--------|
| **설치** | 파일별 수동 복사 | 한 번에 활성화 |
| **버전 관리** | 없음 | plugin.json에 버전 명시 |
| **배포** | Git으로 공유 | 마켓플레이스 또는 Git |
| **구성 요소** | 단일 (Skill만, Hook만) | Skills + Hooks + MCP + Agents 통합 |
| **적합한 상황** | 간단한 커스텀 | 복잡한 워크플로우 패키징 |

# 6. MCP 사용 시 주의사항

---

## 보안

```text
✅ 환경 변수로 시크릿 관리:
  "env": { "API_KEY": "${MY_API_KEY}" }

❌ 설정 파일에 시크릿 직접 입력:
  "env": { "API_KEY": "sk-1234567890" }
```

MCP 서버는 외부 시스템에 접근하므로, API 키나 토큰을 환경 변수로 관리해야 합니다.

## 성능

```text
MCP Tool Search 최적화:
  많은 MCP 서버를 연결하면 도구 설명만으로 컨텍스트를 차지
  → Claude Code는 필요한 도구만 동적으로 로드하여 토큰 절약
```

## 디버깅

MCP 서버가 동작하지 않을 때:

```text
1. 서버 프로세스가 실행 중인지 확인
2. 환경 변수가 올바르게 설정되었는지 확인
3. MCP 서버의 stdout/stderr 로그 확인
4. Claude Code에서 도구 목록에 MCP 도구가 보이는지 확인
```

# 7. 정리

---

| 개념 | 설명 |
|------|------|
| **MCP** | AI와 외부 도구 간의 표준 통신 프로토콜 |
| **MCP Server** | 외부 시스템을 MCP 프로토콜로 노출하는 서버 |
| **연결 방식** | Stdio(로컬), HTTP(원격), SSE(스트리밍) |
| **설정 스코프** | 사용자(~/.claude), 프로젝트(.claude), 플러그인 |
| **Plugin** | Skills + Hooks + MCP + Agents를 묶은 배포 패키지 |
| **활용** | DB 조회, GitHub 연동, 문서 검색, 모니터링 등 |

```text
핵심:
  기본 Claude Code = 파일 + 터미널 + 웹
  MCP 연결 후 = 파일 + 터미널 + 웹 + DB + GitHub + Jira + Slack + ...
  Plugin = 이 모든 확장을 하나의 패키지로 묶어 공유
```

# Reference

---

- [Model Context Protocol 공식 사이트](https://modelcontextprotocol.io/)
- [Claude Code MCP 설정 가이드](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [MCP 서버 디렉토리](https://github.com/modelcontextprotocol/servers)
- [Claude Code Plugin 개발 가이드](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev)
