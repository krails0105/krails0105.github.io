# Blog Recruiter-Friendly Redesign Design

**Date**: 2026-03-09
**Goal**: 토스증권 Data Engineer 지원 시 채용담당자가 3초 안에 "DE 전문가" 인상을 받도록 사이트 프레젠테이션 개선

## Context

- Jekyll blog (Minimal Mistakes theme, "air" skin)
- 244 posts, 33 categories
- 이력서에 메인 페이지 URL(`krails0105.github.io`) 첨부 예정
- 포스트 내용은 수정하지 않음

## Changes

### 1. Site Title

- **Before**: "Shane's space"
- **After**: "Shane | Data Engineer"
- **File**: `_config.yml` → `title`

### 2. Profile Bio

- **Before**: "Never fall behind"
- **After**: DE 전문성이 드러나는 한 줄 (예: "Bitcoin on-chain 데이터 파이프라인을 만드는 Data Engineer")
- **File**: `_config.yml` → `bio`

### 3. Sidebar Category Order

- DE 카테고리 상단 고정: Spark, Databricks, Delta, DataEngineering, Airflow, Kafka, Streaming, Iceberg, BigQuery
- 나머지는 기존대로 글 수 내림차순
- **File**: `_includes/sidebar.html` 또는 `_includes/category-list.html`

### 4. Navigation

- **Before**: Categories, Tags
- **After**: About, Categories, Tags
- **File**: `_data/navigation.yml`

### 5. About Page (New)

- Minimal: 한 줄 DE 소개, 기술 스택 태그 (Spark, Kafka, Airflow, Databricks, Delta, ClickHouse 등), GitHub/LinkedIn 링크
- **File**: `/about.md` (new)

### 6. Duplicate Post Bug Fix

- 메인 페이지에서 동일 포스트가 2번 표시되는 문제 수정
- **File**: TBD (원인 파악 후)

### 7. SEO Meta Description

- **Before**: generic or missing
- **After**: DE 관련 키워드 포함
- **File**: `_config.yml` → `description`

## Non-Goals

- 포스트 본문 내용 수정
- 테마 전면 교체
- 카테고리 카드 그리드 추가 (불필요 판단)
- 비-DE 카테고리 숨김 (전부 노출, DE만 우선 배치)

## Approach

- 기존 Minimal Mistakes 테마 구조 내에서 최소 변경
- URL 구조 변경 없음
- 사이드바/네비게이션 레이아웃 유지
