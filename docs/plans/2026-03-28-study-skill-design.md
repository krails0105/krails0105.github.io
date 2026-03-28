# /study 스킬 디자인

## 목적

기술명 하나만 입력하면 공식 문서 기반 커리큘럼 자동 생성 → Day별 학습 → 블로그 포스트 생성까지 원스톱으로 처리하는 스킬.

## 트리거

- `/study {기술명}` (예: `/study Kafka Streams`)
- 입력: 기술명만. 참고 자료/목표 수준은 스킬이 자동 판단.

## 전체 흐름

```
/study Kafka Streams
    ↓
[Phase 1] Context7로 공식 문서 구조 파악
    ↓
[Phase 2] 기술 난이도/범위 분석 → 학습 기간 자동 산정 (3일~2주)
    ↓
[Phase 3] 커리큘럼 생성 (Day별 주제, 학습 목표, 난이도)
    ↓
[사용자 승인] 커리큘럼 확인/조정
    ↓
[Phase 4] Day별 학습 실행
    - Context7 + 웹 검색으로 내용 조사
    - 개념 → 코드 예제 → 비교표 → 주의사항
    - Day 끝나면 "포스트 작성할까요?" 확인
    ↓
[Phase 5] 승인 시 /post 스킬 연동으로 블로그 포스트 생성 + QA
    ↓
다음 Day로 이동 (반복)
```

## Phase별 상세

### Phase 1-2: 조사 및 분석

- `resolve-library-id` → `query-docs`로 공식 문서 구조 파악
- 핵심 개념 수, API 표면적, 문서 규모로 학습 기간 산정

| 요소 | 판단 방법 |
|------|----------|
| 학습 기간 | 공식 문서 규모, 핵심 개념 수, API 표면적 |
| Day 분배 | 기초 개념(40%) → 핵심 기능(40%) → 실전 적용(20%) |
| 챕터 묶음 | 연관 개념끼리 묶되 하루 분량 초과 시 분리 |

### Phase 3: 커리큘럼 출력 형식

```markdown
## Kafka Streams 스터디 커리큘럼 (5일)

Day 1: 기본 개념과 토폴로지
  - 학습 목표: KStream/KTable 차이, Topology 구조 이해
  - 난이도: ★★☆

Day 2: Stateless 변환
  - 학습 목표: filter, map, flatMap, branch
  - 난이도: ★★☆

Day 3: Stateful 연산과 Window
  - 학습 목표: groupBy, aggregate, windowed join
  - 난이도: ★★★
```

사용자가 승인하면 Phase 4로 진행. 수정 요청 시 조정 후 재제시.

### Phase 4: Day별 학습 콘텐츠 구성

Flink 스터디 포스트 패턴 기반:

1. **들어가며** — 이 Day에서 뭘 배우는지, 이전 Day와 연결
2. **사전 준비** — 필요한 선행 지식/환경 표
3. **주제별 섹션** — 각 주제마다:
   - 배경 (왜 이 기능이 필요한지)
   - 핵심 코드 예제
   - 비교표 (유사 개념 차이)
   - 주의사항/실무 함정
4. **정리** — 핵심 요약

### Phase 5: 포스트 생성

Day 학습 완료 후:
1. "Day N 포스트 작성할까요?" 확인
2. 승인 시 → /post 스킬의 blog-post-polisher로 퀄리티 개선
3. QA 검증 (layout 생략, 헤딩 h2 시작, 도메인 익명화)
4. 파일 경로 안내

## 파일 규칙

- 경로: `_posts/{기술카테고리}/YYYY-MM-DD-{기술}-day{N}-{주제}.md`
- 예: `_posts/Kafka/2026-04-01-kafka-streams-day1-topology-basics.md`
- front matter: layout/toc 생략 (defaults 자동 적용), categories YAML 리스트 형식

## 스킬 파일 위치

`/Users/test/.claude/skills/study/SKILL.md`
