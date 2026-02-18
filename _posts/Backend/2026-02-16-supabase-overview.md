---
title: "Supabase란? Firebase 대안으로 떠오른 오픈소스 백엔드 플랫폼"
categories:
  - Backend
tags:
  - [Supabase, PostgreSQL, BaaS, Firebase, Backend]
---

# Introduction

---

Supabase는 "오픈소스 Firebase 대안"이라는 캐치프레이즈로 최근 급성장하고 있는 백엔드 플랫폼입니다. PostgreSQL을 기반으로 데이터베이스부터 인증, API, 실시간 기능까지 한 번에 제공하는 BaaS(Backend as a Service)로, 특히 인디 개발자와 스타트업 사이에서 인기를 끌고 있습니다.

이 글에서는 Supabase가 무엇인지, 왜 주목받는지, 순수 PostgreSQL과 어떻게 다른지, 그리고 실제 사용 시 고려해야 할 점들을 정리합니다.

# 1. Supabase란?

---

**Supabase는 PostgreSQL 기반의 오픈소스 백엔드 플랫폼**입니다. Firebase처럼 백엔드 서버를 직접 구축하지 않고도 데이터베이스, 인증, API, 파일 저장소 등을 바로 사용할 수 있게 해줍니다.

## 핵심 기능

| 기능 | 설명 |
|------|------|
| **Database** | PostgreSQL 데이터베이스 (관계형 DB의 강력함) |
| **Auth** | 이메일, OAuth, 소셜 로그인 등 인증 시스템 |
| **Auto-generated APIs** | 테이블 생성 시 REST API가 자동으로 생성됨. GraphQL은 `pg_graphql` 확장을 통해 지원 |
| **Realtime** | 데이터 변경을 실시간으로 구독 가능 (Postgres CDC 기반) |
| **Storage** | 파일 업로드/다운로드 및 이미지 변환 기능 |
| **Edge Functions** | 서버리스 함수 (Deno 기반) |

## 주요 특징

1. **오픈소스**: 코드가 모두 공개되어 있고, 원하면 자체 호스팅(self-hosting)도 가능
2. **PostgreSQL 기반**: NoSQL이 아닌 검증된 관계형 DB 사용 (JOIN, 트랜잭션, 인덱스 등 SQL의 모든 기능)
3. **빠른 프로토타이핑**: 백엔드 서버 없이 바로 개발 시작 가능
4. **프로덕션 레디**: 실제 서비스에도 사용 가능한 수준의 안정성

# 2. 왜 Supabase가 주목받는가?

---

## Firebase 피로감

Firebase를 써본 개발자라면 다음과 같은 불편함을 경험했을 겁니다.

| 불편한 점 | 상세 |
|-----------|------|
| NoSQL(Firestore)의 제약 | 복잡한 쿼리나 JOIN이 어려움. 데이터 중복 저장이 필수적 |
| 벤더 락인 | Google 생태계에 종속됨. 다른 서비스로 마이그레이션이 어려움 |
| 가격 정책 | 사용량 증가 시 비용 예측이 어려움 (읽기/쓰기 단위 과금) |

Supabase는 PostgreSQL이라는 검증된 관계형 DB를 사용하므로 이런 문제에서 상대적으로 자유롭습니다. 데이터는 표준 PostgreSQL이기 때문에 필요할 경우 `pg_dump`로 내보내서 AWS RDS, Neon 등 다른 서비스로 이전할 수 있습니다.

## 급성장 지표

- **GitHub Stars**: 75,000+ (2026년 2월 기준)
- **투자**: 2024년 Series D에서 $200M 유치
- **커뮤니티**: 활발한 오픈소스 생태계
- **AI 시대 궁합**: `pgvector` 확장으로 벡터 DB 기능도 지원 (AI 임베딩 저장 및 유사도 검색)

## 타겟 사용자

- **인디 개발자**: 빠르게 MVP를 만들고 싶은 경우
- **스타트업**: 초기 백엔드 구축 비용 절감
- **AI 프로젝트**: 벡터 검색이 필요한 LLM 앱 (`pgvector` + SQL의 조합)
- **사이드 프로젝트**: 무료 플랜으로도 충분한 소규모 서비스

## 경쟁 제품과의 비교

| 서비스 | 특징 | Supabase와의 차이 |
|--------|------|-------------------|
| **Firebase** | Google의 NoSQL 기반 BaaS | NoSQL vs PostgreSQL (관계형). Supabase는 SQL의 모든 기능 사용 가능 |
| **Neon** | 서버리스 PostgreSQL | DB만 제공 (Auth, Storage, Realtime 등은 별도 구축 필요) |
| **PocketBase** | Go 기반 경량 BaaS | 단일 바이너리로 매우 가벼움. 소규모 프로젝트에 적합 |
| **Appwrite** | 오픈소스 BaaS | 더 많은 기능을 내장하지만 복잡도 높음. MariaDB 기반 |

# 3. 순수 PostgreSQL vs Supabase

---

"그냥 PostgreSQL 쓰면 되지 않나요?"라는 질문이 자주 나옵니다. 핵심 차이는 **Supabase는 DB 위에 백엔드 전체를 얹어주는 것**입니다. 비유하자면, PostgreSQL은 엔진이고 Supabase는 엔진 + 차체 + 바퀴 + 계기판이 포함된 완성차입니다.

## 기능 비교 표

| 기능 | PostgreSQL 직접 사용 | Supabase |
|------|----------------------|----------|
| DB 서버 관리 | 직접 설치/관리 (AWS RDS 등) | 자동 관리 (클라우드) |
| API 서버 | Express/FastAPI 등으로 직접 구현 | PostgREST 기반 REST API 자동 생성 |
| 인증 | Passport.js, JWT 직접 구현 | GoTrue 기반 내장 Auth (이메일, OAuth 등) |
| 파일 업로드 | S3 + Multer 등 조합 | 내장 Storage (S3 호환) |
| 실시간 기능 | WebSocket 직접 구현 | 내장 Realtime (Postgres CDC 기반) |
| 권한 관리 | 미들웨어로 직접 구현 | Row Level Security (RLS) |
| 대시보드 | pgAdmin 등 별도 도구 | 웹 UI 기본 제공 (테이블 편집, SQL 에디터, 로그 등) |

## 코드 예시 비교

### Express + PostgreSQL (전통적인 방식)

백엔드 서버를 직접 구현해야 합니다. 라우팅, DB 연결, 에러 처리를 모두 직접 작성합니다.

```javascript
// 서버 코드 (백엔드)
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// 데이터 조회 - pool.query()의 반환값은 { rows } 객체
app.get('/api/todos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM todos WHERE user_id = $1',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 데이터 삽입
app.post('/api/todos', async (req, res) => {
  try {
    const { title } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO todos (title, user_id) VALUES ($1, $2) RETURNING *',
      [title, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Supabase (백엔드 서버 불필요)

프론트엔드 코드만으로 DB에 직접 접근할 수 있습니다. Row Level Security(RLS)로 보안이 유지됩니다.

```javascript
import { createClient } from '@supabase/supabase-js'

// Supabase 클라이언트 초기화
// SUPABASE_URL: 프로젝트 대시보드에서 확인 (예: https://xxx.supabase.co)
// SUPABASE_ANON_KEY: 공개 가능한 anon key (RLS로 보안 유지)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// 데이터 조회 - { data, error } 패턴으로 결과와 에러를 함께 반환
const { data: todos, error } = await supabase
  .from('todos')
  .select('*')
  .eq('user_id', userId)

if (error) {
  console.error('조회 실패:', error.message)
}

// 데이터 삽입 - .select()를 체이닝하면 삽입된 데이터를 반환받을 수 있음
const { data, error: insertError } = await supabase
  .from('todos')
  .insert({ title: 'New Todo', user_id: userId })
  .select()

if (insertError) {
  console.error('삽입 실패:', insertError.message)
}
```

> **주의**: `.insert()`만 호출하면 삽입된 데이터가 반환되지 않습니다. 삽입 결과를 받으려면 반드시 `.select()`를 체이닝해야 합니다.

### Supabase Realtime 구독

Supabase v2에서는 `channel()` API를 사용하여 실시간 데이터 변경을 구독합니다.

```javascript
// 실시간 구독 - Supabase v2의 channel API 사용
// 'postgres_changes' 이벤트로 DB 변경사항을 실시간으로 수신
const channel = supabase
  .channel('todos-changes')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',        // INSERT, UPDATE, DELETE, 또는 * (모든 이벤트)
      schema: 'public',
      table: 'todos',
    },
    (payload) => {
      console.log('새 할 일 추가됨:', payload.new)
    }
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('실시간 구독 시작!')
    }
  })

// 구독 해제 시
await supabase.removeChannel(channel)
```

```
주의: Supabase v1에서는 .from('table').on('INSERT', ...).subscribe() 문법을 사용했지만,
v2부터는 channel() 기반 API로 변경되었습니다. 기존 v1 코드를 사용 중이라면 마이그레이션이 필요합니다.
```

## 핵심 차이점 정리

Supabase의 진짜 가치는 **백엔드 서버 없이 프론트엔드에서 바로 DB를 안전하게 쓸 수 있게 해주는 것**입니다. Row Level Security(RLS)를 활용해 클라이언트에서 직접 쿼리를 보내도 보안이 유지됩니다.

| 관점 | PostgreSQL 직접 사용 | Supabase |
|------|----------------------|----------|
| 개발 속도 | 느림 (서버, API, 인증 직접 구현) | 빠름 (대시보드에서 테이블 생성 후 바로 사용) |
| 유연성 | 높음 (모든 것을 직접 제어) | 중간 (Supabase가 제공하는 방식을 따름) |
| 학습 곡선 | 높음 (백엔드 전체 지식 필요) | 낮음 (SQL + Supabase SDK만 알면 됨) |
| 비용 (초기) | 높음 (서버 인프라 비용) | 낮음 (무료 플랜 제공) |

# 4. 가격 정책

---

## 무료 플랜 (Free Tier)

| 항목 | 제한 |
|------|------|
| 프로젝트 수 | 2개 |
| Database | 500MB |
| Storage | 1GB |
| 월간 활성 사용자 | 5만 명 |
| Edge Function 호출 | 50만 회 |
| **비활성 정지** | **7일간 비활성 시 자동 정지 (재시작 가능)** |

사이드 프로젝트나 MVP 개발에는 무료 플랜으로도 충분합니다. 다만 7일간 요청이 없으면 프로젝트가 자동 정지되므로, 지속적으로 사용하지 않는 프로젝트는 주의가 필요합니다.

## 유료 플랜

| 플랜 | 가격 | 주요 내용 |
|------|------|-----------|
| **Pro** | $25/월 | 8GB DB, 100GB Storage, 자동 정지 없음, 일간 백업 |
| **Team** | $599/월 | 팀 협업 기능, SOC2 인증, 우선 지원 |
| **Enterprise** | 커스텀 | 전용 인프라, SLA, 커스텀 계약 |

프로덕션 서비스라면 최소 Pro 플랜을 고려해야 합니다. Pro 플랜부터는 프로젝트 자동 정지가 없고, 일간 백업이 포함됩니다.

# 5. 실무에서 주의할 점

---

Supabase를 실제 프로젝트에 도입할 때 자주 만나는 함정과 고려사항입니다.

## RLS 설정 누락

Supabase에서 가장 흔한 보안 실수입니다. 테이블을 생성한 뒤 RLS를 활성화하지 않으면, `anon` key를 가진 누구나 모든 데이터에 접근할 수 있습니다.

```sql
-- RLS 활성화 (테이블 생성 후 반드시 실행)
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- 정책 예시: 본인의 데이터만 조회 가능
CREATE POLICY "Users can view own todos"
  ON todos FOR SELECT
  USING (auth.uid() = user_id);

-- 정책 예시: 본인만 데이터 삽입 가능
CREATE POLICY "Users can insert own todos"
  ON todos FOR INSERT
  WITH CHECK (auth.uid() = user_id);
```

> **주의**: RLS를 활성화만 하고 정책(Policy)을 추가하지 않으면, 모든 접근이 차단됩니다. 반드시 적절한 정책을 함께 설정해야 합니다.

## 벤더 의존성 관리

Supabase 고유 기능(Auth, Realtime, Storage)을 사용하면 해당 부분은 Supabase에 종속됩니다. 다만 데이터 자체는 표준 PostgreSQL이므로, DB 마이그레이션은 비교적 수월합니다.

```
마이그레이션이 쉬운 부분:
- 데이터베이스 (pg_dump / pg_restore로 이전 가능)
- SQL 스키마, 함수, 트리거

마이그레이션에 추가 작업이 필요한 부분:
- Auth (인증 시스템을 직접 구현하거나 다른 서비스로 교체)
- Realtime (WebSocket 기반 구독을 직접 구현)
- Storage (S3 등으로 파일 이전)
- Edge Functions (다른 서버리스 플랫폼으로 포팅)
```

## 비용 증가에 대한 대비

무료 플랜에서 시작하더라도, 서비스가 성장하면 비용이 빠르게 증가할 수 있습니다. 특히 다음 항목들의 사용량을 모니터링해야 합니다.

- **Database 용량**: 500MB(무료) -> 8GB(Pro) 초과 시 추가 비용
- **Realtime 동시 접속**: 동시 접속 사용자가 많으면 비용 증가
- **Edge Function 호출 수**: API 호출 빈도에 비례

# 6. 언제 Supabase를 써야 하나?

---

## 추천하는 경우

- 빠른 프로토타이핑이 필요한 경우 (아이디어 검증, 해커톤 등)
- 백엔드 개발 리소스가 부족한 팀 (프론트엔드 위주의 팀)
- PostgreSQL의 강력한 쿼리가 필요한 경우 (JOIN, 서브쿼리, Window 함수 등)
- AI 프로젝트 (`pgvector`로 벡터 검색)
- 실시간 기능이 필요한 경우 (채팅, 협업 도구, 대시보드 등)

## 신중해야 하는 경우

- 복잡한 비즈니스 로직이 많은 경우 (별도 백엔드 서버가 더 적합)
- 벤더 락인을 극도로 꺼리는 경우 (Auth, Realtime 등이 Supabase에 종속)
- 대규모 트래픽 서비스 (비용 예측과 성능 테스트가 선행되어야 함)
- 레거시 시스템과의 통합이 많은 경우 (기존 백엔드와의 통합에 제약)

# 정리

---

Supabase는 "백엔드 서버 없이 PostgreSQL을 안전하게 쓸 수 있게 해주는 플랫폼"입니다. Firebase의 편리함에 PostgreSQL의 강력함을 더한 것이 핵심 가치입니다.

| 핵심 포인트 | 설명 |
|-------------|------|
| 본질 | PostgreSQL + Auth + Realtime + Storage + Edge Functions를 한 번에 제공하는 BaaS |
| 장점 | 빠른 개발 속도, 무료 플랜, 오픈소스, SQL의 모든 기능 |
| 주의점 | RLS 설정 필수, 벤더 종속 부분 존재, 비용 증가 가능성 |
| 추천 대상 | 사이드 프로젝트, MVP, 프론트엔드 위주 팀, AI 프로젝트 |

다음과 같은 경우라면 Supabase를 적극 고려해볼 만합니다.

- 사이드 프로젝트를 빠르게 시작하고 싶을 때
- 관계형 DB가 필요한 Firebase 대안을 찾을 때
- AI 프로젝트에서 벡터 검색이 필요할 때

다만 모든 도구가 그렇듯, 프로젝트의 요구사항에 맞는지 검토 후 선택해야 합니다. 무료 플랜으로 직접 써보고 판단하는 것을 권장합니다.

# Reference

---

- [Supabase 공식 사이트](https://supabase.com)
- [Supabase 공식 문서](https://supabase.com/docs)
- [Supabase GitHub](https://github.com/supabase/supabase)
- [Supabase JS 클라이언트 (npm)](https://www.npmjs.com/package/@supabase/supabase-js)
- [Supabase 가격 정책](https://supabase.com/pricing)
- [PostgreSQL Row Level Security 문서](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Supabase Realtime - channel API 마이그레이션 가이드](https://supabase.com/docs/guides/realtime)
