---
title: "[Brainstorm] FastAPI + LangChain으로 AI 마이크로서비스 구축하기"
categories:
  - Brainstorm
tags: [FastAPI, LangChain, Python, Pydantic, LCEL, Structured Output, AI, 마이크로서비스]
---

## Introduction

---

브레인스토밍 협업 서비스의 백엔드는 Spring Boot(Java)로 구현되어 있다. 여기에 AI 기능(채팅 기반 키워드 도출, 아이디어 확장)을 추가하기 위해 **Python AI 마이크로서비스**를 별도로 분리했다.

```
FE (React) → Spring Boot BE → Python AI Service (FastAPI + LangChain)
                                    ↓
                              LLM API (Claude)
```

이 글에서는 FastAPI + LangChain으로 AI 마이크로서비스를 처음부터 구축하는 과정을 다룬다. FastAPI의 핵심 개념(Pydantic, APIRouter, Depends)과 LangChain의 LCEL 체인, Structured Output까지 실제 코드로 살펴본다.

## FastAPI 프로젝트 구조

---

최종 프로젝트 구조는 다음과 같다:

```
brainstorm-ai/
├── main.py              # FastAPI 앱 + CORS + 에러 핸들러
├── config.py            # 환경변수(BaseSettings) + LLM 인스턴스 팩토리
├── dto/
│   ├── keyword.py       # KeywordRequest, KeywordResponse
│   └── idea.py          # IdeaRequest, IdeaResponse
├── routes/
│   ├── keyword.py       # POST /api/keywords/extract
│   └── idea.py          # POST /api/ideas/expand
├── services/
│   ├── keyword_service.py  # LangChain 체인 + 프롬프트
│   └── idea_service.py
├── common/exceptions/   # AIServiceError
├── pyproject.toml       # uv 의존성 관리
└── .env                 # LLM API 키
```

Spring Boot의 Controller-Service-DTO 패턴과 거의 동일한 구조다. 차이점은 FastAPI는 **APIRouter**로 라우트를 분리하고, **Pydantic BaseModel**이 DTO 역할을 한다는 것이다.

## Pydantic: 유효성 검증의 자동화

---

FastAPI에서 요청/응답 스키마는 Pydantic `BaseModel`로 정의한다. Spring Boot에서 DTO 클래스를 만들고 `@Valid` + `@NotNull`로 검증하던 것을 **타입 힌트 하나로 대체**한다.

```python
# dto/keyword.py
from pydantic import BaseModel

class KeywordRequest(BaseModel):
    chat_history: str          # 필수 (기본값 없음 → 누락 시 422 에러)
    topic: str                 # 필수
    max_keywords: int = 12     # 선택 (기본값 12)

class KeywordResponse(BaseModel):
    keywords: list[str]
```

이 모델을 함수 파라미터에 쓰면 FastAPI가 자동으로:
1. JSON → Python 객체 변환
2. 타입 검증 (잘못된 타입 → 422 에러 + 어떤 필드가 잘못됐는지 상세 메시지)
3. Swagger UI에 스키마 문서 생성

### BaseModel vs BaseSettings

Pydantic에는 두 가지 베이스 클래스가 있다:

| | BaseModel | BaseSettings |
|---|-----------|-------------|
| 용도 | API 요청/응답 스키마 | 앱 설정값 관리 |
| 데이터 출처 | HTTP JSON body | 환경변수, `.env` 파일 |
| Spring 대응 | DTO | `@Value` + application.properties |

```python
# config.py — 환경변수를 읽는 BaseSettings
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    llm_provider: str = "claude"
    llm_model: str = "claude-sonnet-4-5-20250514"
    llm_api_key: str = ""

    model_config = {"env_file": ".env"}  # .env 파일에서 자동 로드
```

## APIRouter: 라우트 모듈화

---

모든 엔드포인트를 `main.py`에 넣으면 파일이 비대해진다. Spring Boot에서 `@RestController` + `@RequestMapping`으로 컨트롤러를 분리하듯, FastAPI에서는 `APIRouter`를 사용한다.

```python
# routes/keyword.py
from fastapi import APIRouter, Depends
from config import Settings, get_settings
from dto.keyword import KeywordRequest, KeywordResponse
from services.keyword_service import handle_extract_keywords

router = APIRouter(prefix="/api/keywords", tags=["keywords"])

@router.post("/extract", response_model=KeywordResponse)
def extract_keywords(request: KeywordRequest, settings: Settings = Depends(get_settings)):
    result = handle_extract_keywords(request.topic, request.chat_history, request.max_keywords)
    return KeywordResponse(keywords=result.keywords)
```

- `prefix` — 이 라우터의 모든 경로 앞에 `/api/keywords`가 붙는다
- `tags` — Swagger UI에서 그룹으로 묶여 표시된다
- `response_model` — 응답 스키마를 Swagger에 표시하고 자동 검증한다

`main.py`에서 `include_router()`로 명시적으로 등록한다. Spring의 `@ComponentScan` 자동 감지와 달리 **수동 등록**이다:

```python
# main.py
from fastapi import FastAPI
from routes import keyword, idea

app = FastAPI()
app.include_router(keyword.router)
app.include_router(idea.router)
```

## Depends: 함수 기반 의존성 주입

---

Spring의 `@Autowired`가 "인터페이스를 선언하면 컨테이너가 구현체를 주입"하는 방식이라면, FastAPI의 `Depends`는 **"이 함수를 먼저 실행하고, 리턴값을 파라미터에 넣어줘"**라는 방식이다.

```python
from functools import lru_cache

@lru_cache  # 매번 새 인스턴스를 만들지 않도록 캐싱
def get_settings() -> Settings:
    return Settings()

# 엔드포인트 호출 시 get_settings()가 자동 실행 → 리턴값이 settings에 들어감
@router.post("/extract")
def extract_keywords(request: KeywordRequest, settings: Settings = Depends(get_settings)):
    # settings.llm_model 등 사용 가능
    ...
```

**Depends의 핵심 장점은 체이닝**이다. 의존성끼리 연결하면 FastAPI가 실행 순서를 자동 관리한다:

```python
def get_settings():
    return Settings()

def get_llm(settings: Settings = Depends(get_settings)):
    return ChatAnthropic(model=settings.llm_model, api_key=settings.llm_api_key)

# 엔드포인트에서는 최종 결과만 받으면 됨
# FastAPI가 설정 로드 → LLM 생성 → 엔드포인트 실행 순서를 자동 처리
@router.post("/extract")
def extract(request: Request, llm = Depends(get_llm)):
    ...
```

## LangChain LCEL: 파이프라인으로 LLM 호출

---

LangChain의 핵심은 **LCEL(LangChain Expression Language)** — `|` 연산자로 처리 단계를 파이프라인처럼 연결한다.

```
프롬프트 → LLM → 출력 파서
```

이걸 코드로 쓰면:

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

prompt = ChatPromptTemplate.from_messages([
    ("system", "너는 브레인스토밍 도우미야."),
    ("user", "'{topic}' 관련 키워드를 최대 {max_keywords}개 추출해줘.\n\n{chat_history}"),
])

llm = ChatAnthropic(model="claude-sonnet-4-5-20250514")
parser = StrOutputParser()

chain = prompt | llm | parser  # LCEL 체인
```

실행할 때는 `invoke()`에 딕셔너리로 변수를 넘긴다:

```python
result = chain.invoke({
    "topic": "스타트업 아이디어",
    "max_keywords": 12,
    "chat_history": "A: 번역 서비스 어때?\nB: AI로 하면 좋겠다"
})
# result = "AI, 번역, 실시간, 서비스, ..."  (문자열)
```

각 단계의 역할:

| 단계 | 클래스 | 역할 |
|------|--------|------|
| 프롬프트 | `ChatPromptTemplate` | `{변수}`를 채워 LLM에 보낼 메시지 생성 |
| LLM | `ChatAnthropic` | 메시지를 LLM API로 전송, 응답 수신 |
| 파서 | `StrOutputParser` | LLM 응답을 문자열로 변환 |

## Structured Output: LLM 응답을 Pydantic으로 강제

---

`StrOutputParser`의 문제는 LLM 응답이 **문자열**이라는 것이다. `"AI, 번역, 실시간"` 같은 문자열을 받으면 직접 파싱해야 한다.

LangChain의 `with_structured_output()`은 LLM에게 **"이 Pydantic 스키마에 맞게 응답해"**라고 강제한다:

```python
from dto.keyword import KeywordResponse  # Pydantic 모델

llm = get_llm()
structured_llm = llm.with_structured_output(KeywordResponse)

# StrOutputParser 대신 structured_llm을 파이프라인에 연결
chain = prompt | structured_llm

result = chain.invoke({...})
# result = KeywordResponse(keywords=["AI", "번역", "실시간"])  (Pydantic 객체)
result.keywords  # ["AI", "번역", "실시간"]  (바로 list[str]로 사용 가능)
```

이 방식의 장점:
1. **파싱 불필요** — LLM 응답이 바로 Pydantic 객체로 변환된다
2. **타입 안전** — `result.keywords`가 `list[str]`임을 보장한다
3. **복합 구조** — ideas + solutions 같이 여러 필드를 한번에 받을 수 있다

```python
# 아이디어 확장에서는 두 필드를 동시에 받는다
class IdeaResponse(BaseModel):
    ideas: list[str]      # AI가 생성한 새 아이디어
    solutions: list[str]  # 각 아이디어의 구현 방법

structured_llm = llm.with_structured_output(IdeaResponse)
```

## 프롬프트 엔지니어링

---

LLM에게 좋은 결과를 받으려면 **역할, 맥락, 제약조건**을 명확히 줘야 한다. 단순히 "키워드 추출해줘"보다 구체적인 프롬프트가 훨씬 좋은 결과를 낸다.

### 키워드 추출 프롬프트

```python
prompt = ChatPromptTemplate.from_messages([
    ("system",
     "너는 브레인스토밍 세션의 키워드 추출 전문가야. "
     "팀원들의 대화 내역을 분석해서 핵심 키워드를 도출하는 역할이야.\n\n"
     "규칙:\n"
     "- 주제와 직접 관련된 키워드만 추출할 것\n"
     "- 키워드는 한 단어 또는 짧은 구(2~3단어) 형태로\n"
     "- 의미가 겹치는 키워드는 하나로 통합할 것\n"
     "- 일상적인 대화 표현(인사, 감탄사 등)은 제외할 것\n"
     "- 추출된 키워드는 브레인스토밍 화이트보드에 나열되어 "
     "팀원들이 투표하고 아이디어를 확장하는 데 쓰인다"),
    ("user",
     "주제: {topic}\n\n"
     "아래 대화에서 주제와 관련된 핵심 키워드를 최대 {max_keywords}개 추출해줘.\n\n"
     "대화 내역:\n{chat_history}"),
])
```

프롬프트 설계의 핵심 요소:

| 요소 | 설명 | 예시 |
|------|------|------|
| 역할 | AI에게 전문 분야 부여 | "키워드 추출 전문가" |
| 규칙 | 출력 형식과 제약조건 | "한 단어 또는 짧은 구 형태" |
| 맥락 | 결과가 어디에 쓰이는지 | "화이트보드에 나열되어 투표에 사용" |

맥락을 주는 것이 중요하다. LLM이 결과의 용도를 알면 더 적절한 형태로 응답한다.

## 에러 핸들링

---

LLM API 호출은 네트워크 오류, 타임아웃, API 키 만료 등 다양한 이유로 실패할 수 있다. 서비스 레이어에서 `try/except`로 감싸고, 커스텀 예외를 발생시켜 `main.py`의 글로벌 핸들러에서 처리한다.

```python
# common/exceptions/__init__.py
class AIServiceError(Exception):
    def __init__(self, message: str = "AI 서비스 오류가 발생했습니다"):
        self.message = message
        super().__init__(message)
```

```python
# services/keyword_service.py
from common.exceptions import AIServiceError

def handle_extract_keywords(topic, chat_history, max_keywords):
    try:
        llm = get_llm()
        chain = prompt | llm.with_structured_output(KeywordResponse)
        return chain.invoke({...})
    except Exception as e:
        raise AIServiceError(f"키워드 추출 실패: {e}")
```

```python
# main.py — 글로벌 예외 핸들러
@app.exception_handler(AIServiceError)
async def ai_service_error_handler(request: Request, exc: AIServiceError):
    return JSONResponse(
        status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
        content={"detail": exc.message}
    )
```

Spring Boot의 `@ExceptionHandler` + `GlobalExceptionHandler` 패턴과 동일한 구조다.

## LLM 인스턴스 관리

---

`ChatAnthropic(model=...)` 을 서비스마다 직접 생성하면 모델명과 API 키가 곳곳에 흩어진다. `config.py`에 팩토리 함수를 만들어 **한 곳에서 관리**한다:

```python
# config.py
from langchain_anthropic import ChatAnthropic

def get_llm() -> ChatAnthropic:
    settings = get_settings()
    return ChatAnthropic(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
    )
```

서비스에서는 `get_llm()`만 호출하면 된다. 나중에 LLM 프로바이더를 Claude → OpenAI로 변경해도 `config.py` 한 곳만 수정하면 된다.

## 부록: RAG와 Vector DB

---

지금 brainstorm-ai는 LLM에게 프롬프트와 대화 내역을 직접 넘기는 단순한 구조다. 하지만 데이터가 많아지면 **LLM의 컨텍스트 윈도우(한 번에 처리할 수 있는 텍스트 길이)** 에 다 넣을 수 없다. 이때 필요한 것이 RAG다.

### RAG (Retrieval-Augmented Generation)

RAG는 **"검색으로 보강된 생성"**이다. LLM에게 질문을 보내기 전에, 관련 있는 문서를 먼저 검색해서 프롬프트에 같이 넣어주는 패턴이다.

```
[기존 방식]
사용자 질문 → LLM → 답변
(LLM이 학습한 지식만으로 답변)

[RAG 방식]
사용자 질문 → 관련 문서 검색 → 질문 + 검색 결과를 함께 LLM에 전달 → 답변
(외부 데이터를 근거로 답변)
```

brainstorm-ai에 적용한다면:
- 과거 브레인스토밍 세션의 아이디어/키워드를 DB에 저장
- 새 세션에서 아이디어 확장할 때, 과거 유사 아이디어를 검색해서 프롬프트에 포함
- LLM이 과거 데이터를 참고해 더 풍부한 아이디어를 제안

### Vector DB

RAG에서 "관련 문서 검색"을 어떻게 할까? 키워드 검색(LIKE '%AI%')으로는 **의미적 유사성**을 못 잡는다. "원격근무"와 "재택근무"는 키워드는 다르지만 의미는 같다.

**Vector DB**는 텍스트를 **임베딩(embedding)** — 의미를 나타내는 숫자 벡터 — 로 변환하고, 벡터 간 유사도로 검색한다.

```
"원격근무" → [0.82, 0.15, 0.67, ...]  (1536차원 벡터)
"재택근무" → [0.80, 0.18, 0.65, ...]  (비슷한 벡터 → 유사도 높음)
"요리법"   → [0.12, 0.95, 0.03, ...]  (전혀 다른 벡터 → 유사도 낮음)
```

| 일반 DB 검색 | Vector DB 검색 |
|-------------|---------------|
| 키워드 매칭 (`LIKE`, `CONTAINS`) | 의미적 유사도 (cosine similarity) |
| "원격근무" 검색 → "재택근무" 못 찾음 | "원격근무" 검색 → "재택근무" 찾음 |
| SQL 기반 | 벡터 연산 기반 |

### RAG 파이프라인 흐름

```
1. 저장 단계 (Indexing)
   문서 → 청크 분할 → 임베딩 모델로 벡터 변환 → Vector DB에 저장

2. 검색 단계 (Retrieval)
   사용자 질문 → 임베딩 벡터로 변환 → Vector DB에서 유사 문서 검색

3. 생성 단계 (Generation)
   질문 + 검색된 문서 → 프롬프트에 합쳐서 LLM에 전달 → 답변
```

### LangChain에서의 RAG

LangChain은 RAG 파이프라인을 위한 도구를 기본 제공한다:

```python
from langchain_community.vectorstores import Chroma
from langchain_openai import OpenAIEmbeddings

# 1. 임베딩 모델 — 텍스트를 벡터로 변환
embeddings = OpenAIEmbeddings()

# 2. Vector DB — 벡터를 저장하고 유사도 검색
vectorstore = Chroma.from_texts(
    texts=["원격근무 생산성 향상 방법", "AI 번역 서비스 아이디어", ...],
    embedding=embeddings
)

# 3. Retriever — 질문과 유사한 문서를 검색
retriever = vectorstore.as_retriever()
docs = retriever.invoke("재택근무 관련 아이디어")
# → ["원격근무 생산성 향상 방법", ...] (의미적으로 유사한 문서 반환)
```

주요 Vector DB:

| Vector DB | 특징 |
|-----------|------|
| Chroma | 로컬 개발용, 설치 간편 |
| Pinecone | 클라우드 매니지드, 확장성 좋음 |
| Weaviate | 오픈소스, 하이브리드 검색 지원 |
| pgvector | PostgreSQL 확장, 기존 DB 활용 가능 |

현재 brainstorm-ai에서는 대화 내역을 직접 프롬프트에 넣는 방식으로 충분하지만, 세션 데이터가 누적되면 RAG + Vector DB 도입을 검토할 수 있다.

## 정리

---

| FastAPI 개념 | Spring Boot 대응 | 설명 |
|-------------|-----------------|------|
| Pydantic BaseModel | DTO + @Valid | 요청/응답 스키마, 자동 검증 |
| Pydantic BaseSettings | @Value + properties | 환경변수 관리, .env 자동 로드 |
| APIRouter | @RestController | 라우트 모듈 분리 |
| Depends | @Autowired | 함수 기반 의존성 주입 |
| exception_handler | @ExceptionHandler | 글로벌 예외 처리 |
| CORSMiddleware | CorsConfig | CORS 설정 |

| LangChain 개념 | 설명 |
|---------------|------|
| LCEL (`\|`) | 프롬프트 → LLM → 파서를 파이프라인으로 연결 |
| ChatPromptTemplate | `{변수}` 바인딩이 되는 프롬프트 템플릿 |
| with_structured_output | LLM 응답을 Pydantic 모델로 강제 변환 |
| StrOutputParser | LLM 응답을 단순 문자열로 변환 (간단한 경우) |

## Reference

---

- [FastAPI 공식 문서](https://fastapi.tiangolo.com/)
- [LangChain Python 공식 문서](https://python.langchain.com/docs/introduction/)
- [LangChain Anthropic 통합](https://python.langchain.com/docs/integrations/chat/anthropic/)
- [Pydantic 공식 문서](https://docs.pydantic.dev/)
- [uv 공식 문서](https://docs.astral.sh/uv/)
