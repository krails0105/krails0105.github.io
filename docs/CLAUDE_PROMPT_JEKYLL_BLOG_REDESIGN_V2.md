# Claude 실행 프롬프트 — Jekyll(Minimal Mistakes) 블로그 리디자인 V2

당신은 **Jekyll + GitHub Pages + Minimal Mistakes** 테마 커스터마이징 전문가입니다.  
아래 요구사항을 만족하도록 **실제 적용 가능한 코드 변경안**을 파일 단위로 제시하세요.

---

## 0) 목표
현재 블로그는 V1 카드 UI까지는 적용된 상태로 보이나, 아직 회색 톤/디테일 부족으로 완성도가 낮습니다.  
V2 목표는 **프로덕트급 완성도(타이포/여백/계층/인터랙션/다크모드/검색 UX)**로 끌어올리는 것입니다.

제약:
- GitHub Pages에서 빌드 가능(루비 플러그인 의존 X 가정)
- 정적 CSS/JS 중심

---

## 1) 반드시 구현(P0)

### 1.1 디자인 토큰 + 컴포넌트 통일
- CSS 변수로 컬러/타이포/스페이싱 토큰 정의
- Card/TagChip/Button/Divider 스타일 통일
- 링크: 기본 밑줄 제거, hover에서만 강조

### 1.2 헤더 업그레이드
- 헤더 정렬/여백 정돈
- **검색 모달** 구현:
  - 단축키: `/` 또는 `Cmd/Ctrl+K`
  - 입력 즉시 결과 8개 표시(제목+날짜+카테고리)
  - 키보드 `↑↓` 이동 + Enter 이동
  - 검색 인덱스는 `search.json`(Liquid 생성) + Simple-Jekyll-Search 사용
- **다크모드 토글**:
  - localStorage 저장
  - prefers-color-scheme 반영

### 1.3 사이드바 슬림화 + 모바일 드로어
- 데스크탑: 사이드바 카드화/정보 축약, 카테고리 Top 8 + More
- 모바일: 사이드바를 드로어로(햄버거 버튼 또는 프로필 버튼으로 열기)

### 1.4 글 상세 UX 고도화
- 본문 타이포/폭/코드/표 스타일 개선
- TOC:
  - 현재 섹션 하이라이트(스크롤 스파이)
  - 모바일: “On this page” 버튼으로 토글 형태(간단 구현 OK)
- 푸터 톤다운(큰 컬러 바 제거/축소)

---

## 2) 가능하면 구현(P1)
- Reading progress bar(상단 2px)
- 코드 블록 Copy 버튼(hover 시 표시)
- 헤딩 앵커 링크 아이콘(hover 시 표시)
- 리스트 Compact view 토글(선택)

---

## 3) Minimal Mistakes 환경 고려(중요)
- 어떤 파일을 override할지 **레포 구조를 추정**한 뒤,
  - `_includes/`, `_layouts/`, `_sass/`, `assets/` 관점에서
  - “변경/추가 파일 목록”을 먼저 작성하세요.
- SCSS override 방식:
  - `assets/css/main.scss` 또는 `assets/css/custom.scss`
  - `_sass/minimal-mistakes/custom/*` 사용 가능성 고려
- JS는 `assets/js/*`로 분리하고, 필요한 include를 레이아웃/헤더에 연결

---

## 4) 제출 포맷(반드시 지킬 것)
아래 순서대로 출력:

1) **구현 계획(P0→P1)**  
2) **변경 파일 목록 + 각 파일 역할**  
3) **파일별 코드(전체 코드 또는 핵심 diff)**  
4) **GitHub Pages 호환성 체크리스트**  
5) **DoD 체크리스트**

---

## 5) 디자인 톤 가이드(반영)
- “Notion-like Tech Notes + Vercel-like Minimal” 혼합
- 흰 배경(또는 아주 연한 배경), 얇은 보더, 큰 여백
- hover/focus는 미세하게, 접근성(포커스 링) 유지

이제 시작하세요.
