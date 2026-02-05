# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jekyll-based personal blog using the Minimal Mistakes theme (v4.24.0). The site is deployed to GitHub Pages at https://krails0105.github.io.

## Development Commands

```bash
# Install dependencies
bundle install
npm install

# Local development server (with auto-regeneration)
bundle exec jekyll serve

# Build static site
bundle exec jekyll build

# Preview with rake (watches _data, _includes, _layouts, _sass, assets)
bundle exec rake preview

# JavaScript build (minify and add banner)
npm run build:js

# Watch JS files for changes
npm run watch:js
```

## Architecture

**Content Organization:**
- `_posts/` - Blog posts organized by category subdirectories (Git, Java, Leetcode, Spring)
- `_includes/` - Reusable Liquid template partials
- `_layouts/` - Page structure templates (single.html for posts, home.html for homepage)
- `_data/` - YAML data files (navigation.yml, ui-text.yml)
- `_sass/` - SCSS stylesheets for theme customization

**Build Pipeline:**
1. Jekyll processes Markdown posts with Liquid templating and Kramdown
2. SCSS compiles to compressed CSS
3. JavaScript minified via UglifyJS (`npm run build:js`)
4. Output goes to `_site/` directory

**Key Configuration:**
- `_config.yml` - Main site configuration (theme skin: "air", permalink structure, plugins)
- Posts use YAML front matter with layout: single, categories, and tags
- Syntax highlighting via Rouge
- Client-side search with Lunr.js

## Post Format

Posts follow this structure:
```markdown
---
layout: single
title: "Post Title"
categories: CategoryName
tags: [tag1, tag2]
---

Content in Markdown...
```

Permalink structure: `/:categories/:title/`

## 포스트 작성 원칙

이 블로그의 포스트는 **개발자가 기술을 공부하기 위한 학습 자료**입니다. 이를 고려하여 다음 원칙을 따릅니다.

- **대상 독자**: 해당 기술을 처음 또는 다음 단계로 학습하는 개발자
- **목적**: 개념 이해 → 코드로 확인 → 실무 주의사항 파악
- **글 구조**: Introduction(왜 배우는지) → 개념/원리 설명 → 코드 예제 → 비교/정리표 → 실무 함정/주의사항 → 핵심 요약
- **내용 기준**:
  - 공식 문서 수준의 정확한 기술 설명을 제공
  - 코드 예제는 동작 원리를 이해할 수 있도록 충분히 포함
  - 개념 간 차이를 비교표로 명확히 정리
  - 실무에서 자주 만나는 함정이나 주의사항을 반드시 포함
  - 기술적 설명이 중심이되, 이해를 돕는 간결한 일상 비유는 적절히 활용 (1~2문장 수준, 별도 섹션으로 분리하지 않음)

## 포스트 작성/수정 워크플로우 (필수)

블로그 포스트를 작성하거나 수정할 때, 커밋 전에 아래 단계를 반드시 수행합니다.

### 1단계: 기존 포스트 참고 (포맷/구조 통일)

같은 카테고리의 기존 포스트를 읽고, 포맷과 글 구조를 통일합니다.

- `_posts/{카테고리}/` 디렉토리에서 기존 포스트 1~2개를 읽어 다음을 맞춤:
  - front matter 형식 (title, categories, tags 스타일)
  - 섹션 구조 (Introduction → 번호 섹션 → 정리 → Reference)
  - 코드 블록 + 설명 텍스트 블록 배치 방식
  - 표(table) 활용 패턴
  - 글의 톤 (기술 중심, 과도한 일상 비유 지양)

### 2단계: Context7 기술 점검

포스트에서 다루는 기술의 정확성을 Context7으로 검증합니다.

1. `resolve-library-id`로 관련 라이브러리 검색
2. `query-docs`로 공식 문서를 조회하여 확인:
   - API 사용법, 파라미터, 기본값이 정확한지
   - 버전별 차이(기본값 변경, deprecated 등)가 올바르게 반영되었는지
   - 코드 예제가 실제로 컴파일/실행 가능한지
3. 부족한 내용이 있으면 보충 (누락된 옵션, 주의사항, 관련 개념 등)

### 3단계: 자체 점검 2~3회

작성 완료 후 전체 포스트를 다시 읽으며 점검합니다. **기술적 내용 보완에 중점**을 둡니다.

- 기술적 정확성: 설정 기본값, 메서드 시그니처, 반환 타입, 동작 방식
- 내용 보충: 빠진 옵션, 주의사항, 실무에서 자주 만나는 함정 등
- 코드 정합성: 예제 코드가 컴파일/실행 가능한지 (private 필드 접근, import 누락 등)
- 포스트 간 일관성: 같은 개념이 여러 포스트에 등장할 때 설명이 모순되지 않는지
