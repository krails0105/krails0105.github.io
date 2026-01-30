---
title: "[StockInfo] 01. 프로젝트 개요 - 초보자를 위한 주식 정보 서비스"
categories:
  - StockInfo
tags:
  - [Java, Spring, React, TypeScript]
---

# Introduction

---

Stock-Info는 **주식 투자 초보자**를 위한 한국 주식 정보 서비스입니다.

주식 투자를 처음 시작하면 PER, PBR, EPS 같은 용어부터 막막합니다. 이 프로젝트는 복잡한 재무 지표를 **10초 안에 이해할 수 있는 요약**으로 제공하고, 섹터(업종)별로 종목을 쉽게 탐색할 수 있게 합니다.

# 기술 스택

---

## Backend (Spring Boot)

| 기술 | 버전 | 역할 |
|------|------|------|
| Java | 17 | 프로그래밍 언어 |
| Spring Boot | 3.x | 웹 프레임워크 |
| Spring Data JPA | - | 데이터베이스 접근 |
| H2 Database | - | 개발용 인메모리 DB |
| Lombok | - | 보일러플레이트 코드 제거 |
| Gradle | - | 빌드 도구 |

## Frontend (React)

| 기술 | 버전 | 역할 |
|------|------|------|
| React | 19 | UI 라이브러리 |
| TypeScript | - | 정적 타입 언어 |
| Vite | - | 빌드 도구 |
| React Router | 7 | 클라이언트 라우팅 |
| Axios | - | HTTP 클라이언트 |
| Recharts | - | 차트 라이브러리 |

# 시스템 아키텍처

---

전체 시스템 구조를 한눈에 보겠습니다.

```
┌─────────────────┐         ┌─────────────────────────────────┐
│   Frontend      │         │           Backend               │
│   (React)       │  HTTP   │         (Spring Boot)           │
│   port 5173     │ ──────> │         port 8080               │
└─────────────────┘         │                                 │
                            │  Controller → Service → Provider│
                            │                    │            │
                            │     ┌─────────────┼────────┐   │
                            │     │             │        │   │
                            │   KRX API    Mock Data   H2 DB │
                            │   (거래소)    (개발용)    (뉴스) │
                            └─────────────────────────────────┘
```

## 데이터 흐름

1. **사용자**가 웹 브라우저에서 React 앱 접속
2. **Frontend**가 Backend API 호출 (`/api/...`)
3. **Backend Controller**가 요청 수신
4. **Service**에서 비즈니스 로직 처리
5. **Provider**가 외부 API(KRX) 또는 Mock 데이터에서 정보 가져옴
6. 응답을 DTO로 변환하여 Frontend에 전달
7. **Frontend**가 받은 데이터를 화면에 렌더링

# 주요 기능

---

## 1. 시장 지수 조회

코스피, 코스닥 같은 시장 지수를 실시간으로 보여줍니다.

```
┌─────────────────────────────────────────────┐
│  코스피 2,850.32  +12.45 (+0.44%)  ▲       │
│  코스닥   892.15   -3.21 (-0.36%)  ▼       │
└─────────────────────────────────────────────┘
```

## 2. 섹터별 종목 탐색

주식을 **업종(섹터)**별로 분류하여 탐색합니다.

- 전기전자 (삼성전자, SK하이닉스, LG전자)
- 자동차 (현대차, 기아)
- 금융 (삼성생명, KB금융)
- 등 10개 이상 섹터

## 3. 종목 상세 및 10초 요약

각 종목의 재무 지표와 함께 **초보자용 10초 요약**을 제공합니다.

```
┌─────────────────────────────────────────────┐
│  삼성전자 (005930)           점수: 72 STRONG│
│                                              │
│  "실적 안정적, 장기 투자 검토해볼 만합니다"  │
│                                              │
│  ✅ PER 업종 평균 이하 (저평가 가능성)       │
│  ✅ 배당 수익률 양호                         │
│  ⚠️ 최근 주가 변동성 다소 높음              │
└─────────────────────────────────────────────┘
```

## 4. 뉴스 수집 및 태깅

Google News RSS에서 주식 관련 뉴스를 자동 수집하고, 7가지 태그로 분류합니다.

| 태그 | 의미 |
|------|------|
| EARNINGS | 실적 발표 |
| CONTRACT | 대형 계약 |
| BUYBACK_DIVIDEND | 자사주/배당 |
| REGULATION_RISK | 규제 리스크 |
| MA | 인수합병 |
| INDUSTRY | 산업 동향 |
| RUMOR | 루머 |

## 5. 검색/즐겨찾기/차트

- **검색**: 종목명 또는 코드로 검색
- **즐겨찾기**: 관심 종목 저장 (최대 50개)
- **차트**: 1일/1주/1개월/3개월/1년 주가 차트

# 프로젝트 구조

---

## Backend 구조

```
stock-info-api/
├── src/main/java/.../
│   ├── controller/          # REST API 엔드포인트
│   │   ├── StockController.java
│   │   ├── SectorController.java
│   │   └── IndexController.java
│   ├── service/             # 비즈니스 로직
│   │   ├── StockService.java
│   │   ├── SectorService.java
│   │   └── news/            # 뉴스 처리
│   ├── provider/            # 데이터 소스 추상화
│   │   ├── StockDataProvider.java (인터페이스)
│   │   ├── MockStockDataProvider.java
│   │   └── KrxStockDataProviderImpl.java
│   ├── dto/                 # 데이터 전송 객체
│   │   ├── domain/          # 내부용 DTO
│   │   ├── response/        # API 응답용 DTO
│   │   └── external/        # 외부 API 매핑용 DTO
│   ├── entity/              # JPA 엔티티
│   └── repository/          # JPA 레포지토리
└── src/main/resources/
    └── application.yml      # 설정 파일
```

## Frontend 구조

```
stock-info-frontend/
├── src/
│   ├── components/          # 재사용 컴포넌트
│   │   ├── MarketSummaryBar.tsx
│   │   ├── SectorCard.tsx
│   │   ├── StockDetailSummary.tsx
│   │   └── StockPriceChart.tsx
│   ├── pages/               # 페이지 컴포넌트
│   │   ├── HomePage.tsx
│   │   ├── SearchPage.tsx
│   │   ├── SectorDetailPage.tsx
│   │   └── StockDetailPage.tsx
│   ├── hooks/               # 커스텀 훅
│   │   ├── useDebounce.ts
│   │   ├── useLocalStorage.ts
│   │   └── useFavorites.ts
│   ├── services/            # API 호출
│   │   └── api.ts
│   ├── types/               # TypeScript 타입
│   │   └── index.ts
│   └── App.tsx              # 라우팅 설정
└── vite.config.ts           # Vite 설정
```

# API 엔드포인트

---

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/indexes` | 시장 지수 (코스피, 코스닥) |
| GET | `/api/sectors` | 전체 섹터 목록 |
| GET | `/api/sectors/{name}/stocks` | 섹터별 종목 |
| GET | `/api/stocks/{code}` | 종목 상세 |
| GET | `/api/stocks/{code}/chart` | 종목 차트 |
| GET | `/api/stocks/{code}/insight` | 종목 10초 요약 |
| GET | `/api/stocks/search` | 종목 검색 |
| GET | `/api/home/picks` | 오늘의 추천 종목 |

# 실행 방법

---

## Backend

```bash
cd stock-info-api

# Mock 데이터로 실행 (개발용)
./gradlew bootRun

# 실제 KRX 데이터로 실행
SPRING_PROFILES_ACTIVE=prod ./gradlew bootRun
```

## Frontend

```bash
cd stock-info-frontend

# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

브라우저에서 `http://localhost:5173` 접속

# 블로그 시리즈 안내

---

이 시리즈는 Stock-Info 프로젝트를 통해 **웹 개발의 핵심 개념**을 배웁니다.

## Part 2: Backend 기초 (6편)

| 순서 | 제목 | 핵심 개념 |
|------|------|----------|
| 02 | Controller | REST API, HTTP Method, @RequestMapping |
| 03 | Service | 비즈니스 로직, @Service, 의존성 주입 |
| 04 | Provider 패턴 | Strategy 패턴, 인터페이스, @Profile |
| 05 | DTO 설계 | 3-Layer DTO, 변환 패턴 |
| 06 | Configuration | application.yml, Spring Profile |
| 07 | JPA Entity | @Entity, Repository, JPQL |

## Part 3: Backend 심화 (3편)

| 순서 | 제목 | 핵심 개념 |
|------|------|----------|
| 08 | Rule Engine | 비즈니스 규칙, 점수 시스템 |
| 09 | News Pipeline | RSS 수집, 태깅, 클러스터링 |
| 10 | Home Picks API | 다양성 제약, 4-Bucket 선택 |

## Part 4: Frontend 기초 (4편)

| 순서 | 제목 | 핵심 개념 |
|------|------|----------|
| 11 | React 기초 | 컴포넌트, Props, State, useEffect |
| 12 | Custom Hooks | useDebounce, useLocalStorage |
| 13 | API Layer | Axios, 인터셉터, 타입 안전성 |
| 14 | CSS와 스타일링 | 디자인 토큰, 컴포넌트 스타일 |

## Part 5: Frontend 심화 (2편)

| 순서 | 제목 | 핵심 개념 |
|------|------|----------|
| 15 | 인사이트 컴포넌트 | StockDetailSummary, SectorTopPicks |
| 16 | 인터랙티브 기능 | 검색, 즐겨찾기, 차트 |

# Reference

---

- [Spring Boot Documentation](https://docs.spring.io/spring-boot/docs/current/reference/html/)
- [React Documentation](https://react.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [KRX 한국거래소](http://data.krx.co.kr/)
