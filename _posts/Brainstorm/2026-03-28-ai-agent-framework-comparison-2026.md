---
layout: single
title: "[AI] 2026 AI Agent 프레임워크 비교 - LangChain, LangGraph, Spring AI, CrewAI, LangChain4j"
categories:
  - Backend
tags:
  - [AI, LangChain, LangGraph, Spring AI, CrewAI, LangChain4j, Agent Framework, Python, Java]
toc: true
toc_sticky: true
---

## Introduction

---

AI 기능을 서비스에 붙이려고 할 때 가장 먼저 마주치는 질문이 있다. "어떤 프레임워크를 써야 하지?"

2026년 현재 선택지는 꽤 많다. Spring AI, LangChain4j, LangChain(Python), LangGraph, CrewAI, Claude Agent SDK... 이름만 들어서는 뭐가 다른지 감이 잘 안 잡힌다.

이 글은 브레인스토밍 협업 서비스에 AI 기능(키워드 기반 아이디어 확장, 채팅 기반 키워드 추출)을 추가하기 위해 프레임워크를 조사하면서 정리한 내용이다. **"내 프로젝트에는 어떤 걸 써야 하나"** 를 판단하는 기준을 잡는 데 도움이 되길 바란다.

### 이 글을 읽고 나면

- 주요 AI Agent 프레임워크 6가지의 핵심 차이를 설명할 수 있다.
- LangChain과 LangGraph가 왜 다른 도구인지 이해한다.
- Java 백엔드에서 AI를 붙이는 두 가지 방법(Spring AI / LangChain4j vs Python 마이크로서비스)의 트레이드오프를 판단할 수 있다.

### 사전 지식

- REST API, 마이크로서비스 개념 기초
- LLM(Large Language Model)이 무엇인지 개략적으로 알고 있을 것
- Spring Boot 또는 Python 중 하나는 사용해본 경험이 있으면 좋다

## 배경 -- 어떤 문제를 해결하려 했나

---

브레인스토밍 협업 서비스의 Phase 3에 다음 AI 기능을 추가하려 했다:

1. **키워드 기반 아이디어 확장** - 사용자가 키워드를 입력하면 AI가 관련 아이디어를 생성
2. **채팅 기반 키워드 자동 추출** - 채팅 내용을 분석해서 핵심 키워드를 뽑아냄
3. **키워드 + 채팅 히스토리로 아이디어 구조화** - 추출된 키워드와 채팅 맥락을 결합하여 체계적인 아이디어 문서 생성

백엔드는 Spring Boot(Java)로 이미 구현되어 있다. 선택지는 크게 두 가지였다:

| 접근 방식 | 사용 프레임워크 | 핵심 특징 |
|-----------|---------------|-----------|
| Spring Boot에 직접 AI를 붙인다 | Spring AI, LangChain4j | 단일 언어, 단일 배포 |
| Python AI 마이크로서비스를 별도로 만든다 | LangChain, LangGraph, CrewAI 등 | 풍부한 AI 생태계, 분리 배포 |

어떤 접근이 맞는지 판단하려면 각 프레임워크의 특성을 알아야 했다. 하나씩 살펴보자.

## 프레임워크 비교

---

### 1. Spring AI

Spring Boot에 AI를 통합하기 위한 **공식 스프링 프로젝트**다. Spring 생태계의 설계 원칙(DI, 자동 설정 등)을 그대로 활용하면서 AI 모델을 호출할 수 있다.

**특징:**
- `ChatClient.Builder`를 주입받아 스프링답게 AI 호출 가능
- OpenAI, Anthropic, Ollama, Azure OpenAI 등 주요 모델 프로바이더 지원
- RAG(Retrieval-Augmented Generation)를 위한 Vector Store 추상화 제공
- MCP(Model Context Protocol) 지원으로 외부 도구 연동 가능

```java
// Spring AI - ChatClient를 사용한 아이디어 확장 서비스
@Service
public class IdeaExpansionService {

    private final ChatClient chatClient;

    // Spring Boot가 자동 설정한 ChatClient.Builder를 주입받는다
    public IdeaExpansionService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    public String expandIdea(String keyword) {
        // prompt() -> user() -> call() -> content() 플루언트 API로 LLM 호출
        return chatClient.prompt()
            .user("다음 키워드로 아이디어를 5개 제안해줘: " + keyword)
            .call()
            .content();  // 응답을 String으로 반환
    }
}
```

**언제 쓰면 좋은가:** 기존 Spring Boot 앱에 간단한 AI 기능을 추가할 때. 팀 전체가 Java 개발자이고 Python 역량이 없을 때.

**한계:** Java 생태계라 Python 기반의 최신 AI 라이브러리들을 바로 활용하기 어렵다. AI 관련 커뮤니티, 예제, 레퍼런스도 Python이 압도적으로 많다.

---

### 2. LangChain4j

Java/Kotlin을 위한 LLM 통합 프레임워크다. Python LangChain에서 영감을 받았지만, Java 생태계에 맞게 독자적으로 설계되었다.

**특징:**
- Spring AI보다 더 많은 모델 프로바이더와 Vector DB를 지원
- 인터페이스 선언 + 어노테이션만으로 LLM 호출을 추상화하는 **AI Service** 패턴
- Tool/Function calling, RAG, 메모리 관리 등 내장
- `@Agent` 어노테이션을 통한 에이전트 정의 지원

```java
// LangChain4j - AI Service 인터페이스로 LLM 연동
// 인터페이스를 선언하면 LangChain4j가 프록시 구현체를 자동 생성한다
interface KeywordExtractor {

    // @SystemMessage로 LLM에게 역할을 지정
    @SystemMessage("채팅 내용에서 핵심 키워드를 추출해서 JSON 배열로 반환해.")
    // @UserMessage가 붙은 파라미터가 사용자 입력으로 전달됨
    String extract(@UserMessage String chatHistory);
}

// 사용 시: AiServices.builder()로 인스턴스를 생성
// KeywordExtractor extractor = AiServices.builder(KeywordExtractor.class)
//     .chatLanguageModel(model)
//     .build();
```

> **참고:** LangChain4j에는 `@AiService`라는 어노테이션이 별도로 존재하지 않는다. 인터페이스를 정의하고 `AiServices.builder()`를 통해 프록시 인스턴스를 생성하거나, Spring Boot 환경에서는 자동 설정을 활용한다.

**언제 쓰면 좋은가:** Java 프로젝트인데 Spring AI보다 더 유연한 AI 통합이 필요할 때. LLM을 깊이 활용해야 하는 경우.

**한계:** Python LangChain/LangGraph에 비해 생태계가 작다. 최신 AI 기법들이 Python에 먼저 구현되는 경향이 있어 Java 포팅에 시간이 걸린다.

---

### 3. LangChain (Python)

Python AI 생태계의 사실상 표준(de facto standard)이다. LLM 호출, RAG, 체이닝, Agent 등 AI 애플리케이션에 필요한 대부분의 기능을 제공한다.

**핵심 개념:** 입력 -> 처리 -> 출력으로 이어지는 **선형 파이프라인(chain)** 방식이다. LCEL(LangChain Expression Language)의 `|` 연산자로 각 단계를 체인처럼 연결한다.

```python
# LangChain - LCEL(LangChain Expression Language) 체인 예시
from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# 사용할 LLM 모델 초기화
llm = ChatAnthropic(model="claude-sonnet-4-20250514")

# | 연산자로 프롬프트 -> LLM -> 출력 파서를 파이프라인으로 연결
chain = (
    ChatPromptTemplate.from_template(
        "키워드 '{keyword}'로 아이디어 5개를 제안해줘."
    )
    | llm                  # 프롬프트를 LLM에 전달
    | StrOutputParser()    # LLM 응답을 문자열로 파싱
)

# invoke()로 실행. 템플릿 변수를 딕셔너리로 전달
result = chain.invoke({"keyword": "원격근무"})
```

**언제 쓰면 좋은가:**
- 빠른 프로토타이핑이 필요할 때
- RAG 파이프라인, 간단한 챗봇 구현
- 선형적인 요청-응답 흐름으로 충분한 경우

**한계:** 워크플로우가 복잡해지면(조건 분기, 반복, 상태 관리) 한계에 부딪힌다. 이때 LangGraph가 필요해진다.

---

### 4. LangGraph (Python)

LangChain 위에 구축된 **그래프 기반 워크플로우 오케스트레이션** 프레임워크다. LangChain이 체인(선형)이라면, LangGraph는 **노드(Node)와 엣지(Edge)로 구성된 그래프**다. 상태(State)를 명시적으로 관리하며, 조건 분기와 반복(사이클)이 가능하다.

#### LangChain vs LangGraph 핵심 차이

| 구분 | LangChain | LangGraph |
|------|-----------|-----------|
| 구조 | 체인 (선형 파이프라인) | 그래프 (노드 + 엣지, 사이클 허용) |
| 상태 관리 | 없음 (각 단계 독립) | `TypedDict`로 명시적 상태 관리 |
| 흐름 제어 | 단방향, 순차 실행 | 조건 분기(`add_conditional_edges`), 반복 가능 |
| 적합한 케이스 | 단순 RAG, 챗봇, 선형 파이프라인 | 복잡한 멀티스텝 Agent, 재시도 로직 |
| 관계 | 독립 사용 가능 | LangChain 위에서 동작 (LangChain 컴포넌트 재사용) |

```python
# LangGraph - 상태를 가진 그래프 워크플로우 예시
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

# 워크플로우 전체에서 공유하는 상태를 TypedDict로 정의
class BrainstormState(TypedDict):
    keywords: list[str]
    ideas: list[str]
    is_sufficient: bool

def extract_keywords(state: BrainstormState) -> dict:
    """채팅 히스토리에서 키워드를 추출하는 노드"""
    # 실제로는 여기서 LLM을 호출한다
    return {"keywords": ["원격근무", "생산성", "협업"]}

def expand_ideas(state: BrainstormState) -> dict:
    """키워드로 아이디어를 확장하는 노드"""
    # 실제로는 여기서 LLM을 호출한다
    return {"ideas": ["아이디어1", "아이디어2"], "is_sufficient": True}

def should_retry(state: BrainstormState) -> str:
    """아이디어가 충분한지 판단하는 조건 분기 함수"""
    # 충분하면 종료, 아니면 다시 확장 노드로 돌아감 (사이클)
    return "end" if state["is_sufficient"] else "expand_ideas"

# 그래프 구성
workflow = StateGraph(BrainstormState)
workflow.add_node("extract_keywords", extract_keywords)
workflow.add_node("expand_ideas", expand_ideas)

# 엣지 연결: 시작 -> 키워드 추출 -> 아이디어 확장
workflow.add_edge(START, "extract_keywords")
workflow.add_edge("extract_keywords", "expand_ideas")

# 조건 분기: 아이디어 확장 후 재시도 여부 판단
workflow.add_conditional_edges(
    "expand_ideas",
    should_retry,
    {"end": END, "expand_ideas": "expand_ideas"}  # 라우팅 맵
)

# 그래프를 컴파일해야 실행 가능
app = workflow.compile()
result = app.invoke({"keywords": [], "ideas": [], "is_sufficient": False})
```

**언제 쓰면 좋은가:**
- 결과에 따라 다음 단계가 달라지는 **조건 분기** 로직
- 실패 시 **재시도**(retry loop)가 필요한 작업
- 여러 단계를 거치며 **상태를 누적**해야 하는 경우
- 복잡한 멀티 에이전트 시스템

---

### 5. CrewAI

여러 Agent가 팀처럼 협업하는 **멀티 에이전트 오케스트레이션** 프레임워크다. "AI에게 역할과 목표를 부여하고, 팀처럼 일하게 한다"는 직관적인 컨셉이 특징이다.

**특징:**
- Agent에게 역할(role), 목표(goal), 배경(backstory)을 부여
- Task에 설명(description)과 기대 결과(expected_output)를 명시
- Agent들이 태스크를 분담하고 결과를 공유
- 순차(sequential) 또는 계층(hierarchical) 프로세스 지원

```python
# CrewAI - Agent와 Task 정의 예시
from crewai import Agent, Task, Crew, Process

# 각 Agent에게 전문 역할 부여
idea_researcher = Agent(
    role="아이디어 리서처",
    goal="주어진 키워드로 혁신적인 아이디어를 탐색한다",
    backstory="당신은 10년 경력의 창의적 전략 컨설턴트입니다."
)

idea_structurer = Agent(
    role="아이디어 구조화 전문가",
    goal="수집된 아이디어를 체계적으로 정리한다",
    backstory="당신은 정보 아키텍처 전문가입니다."
)

# Task에는 description과 expected_output이 필수
research_task = Task(
    description="키워드 '원격근무'로 혁신적인 아이디어 5개를 탐색하라.",
    expected_output="아이디어 5개가 담긴 리스트 (각각 제목과 설명 포함)",
    agent=idea_researcher
)

structure_task = Task(
    description="수집된 아이디어를 카테고리별로 구조화하라.",
    expected_output="카테고리별로 정리된 아이디어 문서",
    agent=idea_structurer
)

# Crew: 에이전트들을 팀으로 묶고 실행
crew = Crew(
    agents=[idea_researcher, idea_structurer],
    tasks=[research_task, structure_task],
    process=Process.sequential  # 순차 실행 (research -> structure)
)

result = crew.kickoff()
```

**언제 쓰면 좋은가:** 비즈니스 워크플로우 자동화, 여러 전문 에이전트가 협업해야 하는 복잡한 시나리오. "리서처가 조사하고 -> 분석가가 정리하고 -> 작성자가 문서화"처럼 역할을 나눠야 할 때.

**한계:** 단순한 use case에는 오버엔지니어링이 될 수 있다. 에이전트 간 통신 오버헤드로 비용과 지연이 증가한다.

---

### 6. Claude Agent SDK

Anthropic에서 제공하는 공식 Agent SDK다. 파일 읽기/쓰기, 명령어 실행 등 **코딩 에이전트** 작업에 특화되어 있다. Python과 TypeScript를 지원한다.

**주의:** 코딩 자동화, 개발 워크플로우에 최적화되어 있다. 키워드 추출이나 아이디어 확장 같은 도메인 특화 AI 기능에는 적합하지 않다. 따라서 이 글의 비교 대상에서는 제외한다.

## 한눈에 비교하기

---

각 프레임워크의 핵심 특성을 표로 정리했다.

| 프레임워크 | 언어 | 핵심 개념 | 복잡도 | 적합한 사용 사례 |
|-----------|------|----------|--------|----------------|
| **Spring AI** | Java | Spring 통합 ChatClient | 낮음 | Spring Boot에 간단한 AI 기능 추가 |
| **LangChain4j** | Java/Kotlin | AI Service 인터페이스 | 중간 | Java에서 깊은 LLM 활용 |
| **LangChain** | Python | LCEL 체인 (선형 파이프라인) | 낮음 | RAG, 챗봇, 프로토타이핑 |
| **LangGraph** | Python | StateGraph (노드+엣지) | 중간~높음 | 조건 분기, 재시도, 복잡한 Agent |
| **CrewAI** | Python | 역할 기반 멀티 에이전트 | 중간 | 멀티 에이전트 협업 워크플로우 |
| **Claude Agent SDK** | Python/TS | 코딩 에이전트 도구 | 중간 | 코딩 자동화 (범용 AI에는 부적합) |

## 최종 결정 -- 어떤 구조를 선택했나

---

### 아키텍처: Python AI 마이크로서비스 분리

```
┌─────────────┐
│  FE (React) │
└──────┬──────┘
       │ REST API
┌──────▼──────────────┐
│  Spring Boot BE     │  ← 비즈니스 로직, 인증/권한
│  (Java)             │
└──────┬──────────────┘
       │ REST API (내부 통신)
┌──────▼──────────────┐
│  Python AI Service  │  ← AI 로직에만 집중
│  (FastAPI+LangChain)│
└──────┬──────────────┘
       │
┌──────▼──────────────┐
│  LLM API            │
│  (Claude / OpenAI)  │
└─────────────────────┘
```

Spring Boot 안에 AI를 넣는 대신, Python AI 서비스를 별도로 분리했다. 이유는 다음과 같다:

1. **Python AI 생태계가 압도적으로 풍부하다.** 최신 AI 기법(RAG, 벡터 DB, fine-tuning, 프롬프트 엔지니어링 도구 등)은 Python에 먼저 구현된다. LangChain의 통합 모듈만 해도 수백 개다.

2. **관심사 분리.** Spring Boot는 비즈니스 로직과 인증/권한 처리에 집중하고, AI 서비스는 AI 로직에만 집중한다. 각 서비스의 코드가 단순해지고 테스트도 쉬워진다.

3. **독립적인 스케일링.** AI 서비스의 부하가 늘어도 Spring Boot와 독립적으로 스케일 아웃이 가능하다. LLM 호출은 CPU/메모리 사용 패턴이 일반 API와 크게 다르기 때문에 분리가 유리하다.

이는 업계에서 많이 사용하는 패턴이다. "Spring Boot가 AI 서비스의 오케스트레이터 역할을 한다"고 이해하면 된다.

### 프레임워크: LangChain으로 시작, 필요하면 LangGraph로 업그레이드

현재 필요한 기능(키워드 추출, 아이디어 확장)은 선형 파이프라인으로 충분히 구현 가능하다. LangGraph의 그래프 구조와 상태 관리는 지금 단계에서 오버엔지니어링이다.

**판단 기준 요약:**

| 상황 | 선택 |
|------|------|
| 단순 프롬프트 호출, RAG, 선형 체인 | **LangChain** |
| 조건 분기, 반복 루프, 복잡한 상태 관리 필요 | **LangGraph** |
| 여러 전문 Agent의 협업 워크플로우 | **CrewAI** |
| 기존 Java 팀, Spring Boot에 빠르게 붙이고 싶음 | **Spring AI** 또는 **LangChain4j** |

**"지금 당장 필요한 복잡도에 맞는 도구를 선택하고, 요구사항이 늘어나면 그때 업그레이드한다"** 는 것이 핵심이다. 기술 선택은 항상 현재 문제에 맞춰야 한다.

## 주의할 점 (Gotchas)

---

### 1. LangGraph는 LangChain의 대체재가 아니다

LangGraph는 LangChain **위에** 올라가는 라이브러리다. "LangGraph를 쓰면 LangChain을 버려야 하나?"가 아니라, LangGraph 내부에서 LangChain 컴포넌트(프롬프트 템플릿, 출력 파서, 모델 클래스 등)를 그대로 사용한다. 둘은 대체 관계가 아니라 **레이어 관계**다.

### 2. Spring AI와 LangChain4j는 목적이 다르다

Spring AI는 Spring Boot 생태계에 자연스럽게 녹아드는 것이 목표다. Spring 자동 설정, `ChatClient.Builder` 주입 등 스프링다운 방식을 제공한다. LangChain4j는 LLM 활용에 더 특화되어 더 많은 모델 프로바이더와 Vector DB를 지원하고, AI Service 패턴으로 선언적인 LLM 호출을 제공한다. Java 프로젝트에서 AI를 깊이 쓸 것이라면 LangChain4j가 더 적합할 수 있다.

### 3. 내부 REST API 계약을 먼저 정의하라

Spring Boot와 Python AI Service 간의 API 계약(request/response 스펙)을 먼저 정의해야 양쪽 개발이 막히지 않는다. OpenAPI(Swagger) 스펙을 먼저 작성하고 양쪽이 합의하는 방식을 추천한다.

```json
// POST /api/ai/keywords/expand - 요청 예시
{
  "keyword": "원격근무",
  "max_ideas": 5,
  "language": "ko"
}

// 응답 예시
{
  "ideas": [
    {"title": "가상 오피스", "description": "..."},
    {"title": "비동기 협업 도구", "description": "..."}
  ]
}
```

### 4. 비동기 처리를 초기부터 고려하라

LLM 호출은 응답 시간이 길다(수 초~수십 초). 동기 REST API로 설계하면 Spring Boot의 스레드가 오래 블로킹된다. 다음 방법 중 하나를 초기부터 고려하자:

- **Spring WebFlux** (리액티브 논블로킹)로 AI 서비스 호출
- **FastAPI의 async/await**를 활용한 비동기 처리
- **SSE(Server-Sent Events)** 또는 **WebSocket**을 통한 스트리밍 응답
- 긴 작업은 **비동기 작업 큐**(Celery, Redis Queue 등)로 처리하고 폴링 또는 콜백

### 5. LangChain4j에서 @AiService 어노테이션은 없다

인터넷에 돌아다니는 예제 중 `@AiService` 어노테이션을 사용하는 코드가 있는데, 이는 잘못된 정보다. LangChain4j는 인터페이스를 정의한 후 `AiServices.builder(MyInterface.class).chatLanguageModel(model).build()`로 프록시 인스턴스를 생성하는 패턴을 사용한다. Spring Boot 환경에서는 자동 설정을 통해 빈으로 등록할 수도 있다.

## 다음 단계 (Next Steps)

---

- FastAPI + LangChain으로 Python AI 서비스 초기 구현
- `/api/ai/keywords/expand` 엔드포인트 설계 및 Spring Boot 연동
- 아이디어 구조화 기능에서 복잡한 분기 로직이 필요해지면 LangGraph 도입 검토
- LLM 응답 캐싱 전략 수립 (동일 키워드 요청의 중복 호출 방지)

## 정리

---

| 핵심 질문 | 답변 |
|----------|------|
| Java에서 AI를 쓰려면? | Spring AI(간단) 또는 LangChain4j(깊은 활용) |
| Python에서 선형 AI 파이프라인을 만들려면? | LangChain (LCEL) |
| 조건 분기/재시도/상태 관리가 필요하면? | LangGraph |
| 여러 AI가 역할을 나눠 협업하게 하려면? | CrewAI |
| LangChain과 LangGraph 중 뭘 먼저 배워야 하나? | LangChain 먼저. LangGraph는 그 위의 레이어 |
| Java BE + Python AI를 분리하는 게 맞나? | AI 생태계 활용, 관심사 분리, 독립 스케일링 면에서 유리 |

프레임워크 선택에 정답은 없다. **현재 문제의 복잡도**에 맞는 도구를 선택하고, 요구사항이 늘어나면 그때 도구를 업그레이드하면 된다. 단순한 문제에 복잡한 도구를 쓰는 것이 가장 큰 실수다.

## Reference

---

- [Spring AI 공식 문서](https://docs.spring.io/spring-ai/reference/)
- [LangChain4j 공식 문서](https://docs.langchain4j.dev/)
- [LangChain Python 공식 문서](https://python.langchain.com/docs/introduction/)
- [LangGraph 공식 문서](https://langchain-ai.github.io/langgraph/)
- [CrewAI 공식 문서](https://docs.crewai.com/)
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
