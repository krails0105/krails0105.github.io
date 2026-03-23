# Blog Recruiter-Friendly Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 채용담당자가 메인 페이지에서 3초 안에 "DE 전문가" 인상을 받도록 사이트 프레젠테이션 개선

**Architecture:** _config.yml 설정 변경 + sidebar.html 카테고리 순서 로직 변경 + About 페이지 신규 생성 + 중복 포스트 제거. 기존 Minimal Mistakes 테마 구조 내 최소 변경.

**Tech Stack:** Jekyll, Minimal Mistakes theme, Liquid templates, YAML

---

### Task 1: _config.yml — 타이틀, 바이오, SEO 설명 변경

**Files:**
- Modify: `_config.yml:19` (title)
- Modify: `_config.yml:108` (bio)
- Modify: `_config.yml:23` (description)

**Step 1: 타이틀 변경**

`_config.yml` line 19:
```yaml
# Before:
title                    : "Shane's space"
# After:
title                    : "Shane | Data Engineer"
```

**Step 2: 바이오 변경**

`_config.yml` line 108:
```yaml
# Before:
bio              : "Never fall behind"
# After:
bio              : "Building Bitcoin on-chain data pipelines with Spark, Databricks & Delta Lake"
```

**Step 3: SEO description 변경**

`_config.yml` line 23:
```yaml
# Before:
description              : "Hi this is Shane's blog."
# After:
description              : "Data Engineer blog — Spark, Kafka, Airflow, Databricks, Delta Lake, and Bitcoin on-chain data pipeline engineering."
```

**Step 4: 로컬 확인**

Run: `cd /Users/test/Workspace/study/side-project/blog && bundle exec jekyll serve`
Expected: 브라우저 탭 타이틀이 "Shane | Data Engineer", 사이드바 바이오 변경 확인

**Step 5: Commit**

```bash
git add _config.yml
git commit -m "chore: update site title, bio, and SEO description for DE focus"
```

---

### Task 2: 네비게이션에 About 추가

**Files:**
- Modify: `_data/navigation.yml`

**Step 1: About 링크 추가**

`_data/navigation.yml` 전체 내용을 아래로 교체:
```yaml
# main links
main:
  - title: "About"
    url: /about/
  - title: "Categories"
    url: /categories/
  - title: "Tags"
    url: /tags/
```

**Step 2: Commit**

```bash
git add _data/navigation.yml
git commit -m "feat: add About link to main navigation"
```

---

### Task 3: About 페이지 생성

**Files:**
- Create: `about.md` (blog root)

**Step 1: About 페이지 작성**

`about.md`:
```markdown
---
layout: single
title: "About"
permalink: /about/
author_profile: true
---

## Sanghyun Kim

Data Engineer based in Seoul, building **Bitcoin on-chain data pipelines** on Databricks.

### Tech Stack

`Spark` `Databricks` `Delta Lake` `Airflow` `Kafka` `ClickHouse` `BigQuery` `Python` `SQL`

### What I Write About

이 블로그에는 실무에서 마주한 데이터 엔지니어링 문제들과 해결 과정을 기록합니다.

- **Spark & Databricks** — UTXO 증분 처리, 멀티태스크 잡 설계, Serverless 디버깅
- **Delta Lake** — CDF 기반 증분 파이프라인, 스키마 진화, 테이블 재생성
- **Pipeline Architecture** — ETL/ELT 설계, OLAP 서빙 레이어 교체, 비용 최적화
- **Kafka & Streaming** — 실시간 파이프라인, 이벤트 기반 아키텍처

### Links

- [GitHub](https://github.com/krails0105/)
- [Email](mailto:krails.kim@gmail.com)
```

**Step 2: 로컬에서 /about/ 접속 확인**

Run: `bundle exec jekyll serve`
Expected: `/about/` 경로에 About 페이지 정상 렌더링

**Step 3: Commit**

```bash
git add about.md
git commit -m "feat: add minimal About page with DE focus"
```

---

### Task 4: 사이드바 카테고리 순서 — DE 카테고리 상단 고정

**Files:**
- Modify: `_includes/sidebar.html:10-36`

**Step 1: 카테고리 정렬 로직 변경**

`_includes/sidebar.html`의 `<nav class="sidebar-categories">` 내부 전체를 아래로 교체:

```liquid
<nav class="sidebar-categories">
    <h4 class="sidebar-categories__title">Categories</h4>
    <ul class="sidebar-categories__list">
      {% assign de_categories = "Spark,Databricks,Delta,DataEngineering,Airflow,Kafka,Streaming,Iceberg,BigQuery" | split: "," %}
      {% assign cat_count = 0 %}

      {% comment %} DE categories first, in defined order {% endcomment %}
      {% for de_cat in de_categories %}
        {% for category in site.categories %}
          {% if category[0] == de_cat %}
            {% assign cat_count = cat_count | plus: 1 %}
            <li>
              <a href="/categories/#{{ category[0] | slugify }}">{{ category[0] }} <span>({{ category[1].size }})</span></a>
            </li>
          {% endif %}
        {% endfor %}
      {% endfor %}

      {% comment %} Remaining categories by post count descending {% endcomment %}
      {% assign categories_max = 0 %}
      {% for category in site.categories %}
        {% if category[1].size > categories_max %}
          {% assign categories_max = category[1].size %}
        {% endif %}
      {% endfor %}
      {% for i in (1..categories_max) reversed %}
        {% for category in site.categories %}
          {% if category[1].size == i %}
            {% assign is_de = false %}
            {% for de_cat in de_categories %}
              {% if category[0] == de_cat %}
                {% assign is_de = true %}
              {% endif %}
            {% endfor %}
            {% unless is_de %}
              {% assign cat_count = cat_count | plus: 1 %}
              <li {% if cat_count > 8 %}class="sidebar-categories__hidden" style="display:none"{% endif %}>
                <a href="/categories/#{{ category[0] | slugify }}">{{ category[0] }} <span>({{ category[1].size }})</span></a>
              </li>
            {% endunless %}
          {% endif %}
        {% endfor %}
      {% endfor %}
    </ul>
    {% assign total_cats = site.categories | size %}
    {% if total_cats > 8 %}
      <button class="sidebar-categories__toggle" onclick="(function(btn){var items=document.querySelectorAll('.sidebar-categories__hidden');var shown=items[0]&&items[0].style.display!=='none';items.forEach(function(el){el.style.display=shown?'none':''});btn.textContent=shown?'Show all ({{ total_cats }})':'Show less'})(this)">
        Show all ({{ total_cats }})
      </button>
    {% endif %}
  </nav>
```

**Step 2: 로컬 확인**

Run: `bundle exec jekyll serve`
Expected: 사이드바 카테고리가 Spark, Databricks, Delta, DataEngineering, Airflow, Kafka, Streaming, Iceberg, BigQuery 순으로 표시되고, 나머지(Java, Spring 등)는 그 아래에 글 수 순.

**Step 3: Commit**

```bash
git add _includes/sidebar.html
git commit -m "feat: pin DE categories at top of sidebar category list"
```

---

### Task 5: 중복 포스트 제거

**Files:**
- Delete: `_posts/DataEngineering/2026-03-04-olap-architecture-review-21-solutions.md` (원본, v2로 대체)

**Step 1: v2가 최신인지 확인**

두 파일 비교:
- `2026-03-04-olap-architecture-review-21-solutions.md` (원본)
- `2026-03-04-olap-architecture-review-21-solutions-v2.md` (v2)

v2가 보강된 버전이라면 원본 삭제. 동일하다면 v2 삭제.

**Step 2: 원본 삭제 (v2가 최신인 경우)**

```bash
git rm _posts/DataEngineering/2026-03-04-olap-architecture-review-21-solutions.md
```

**Step 3: 로컬 확인**

Run: `bundle exec jekyll serve`
Expected: 메인 페이지에서 해당 글이 1번만 표시됨

**Step 4: Commit**

```bash
git commit -m "fix: remove duplicate OLAP review post (keep v2)"
```

---

### Task 6: 최종 확인

**Step 1: 전체 빌드 확인**

Run: `cd /Users/test/Workspace/study/side-project/blog && bundle exec jekyll build`
Expected: 빌드 에러 없음

**Step 2: 채용담당자 관점 체크리스트**

- [ ] 브라우저 탭: "Shane | Data Engineer"
- [ ] 사이드바 바이오: DE 관련
- [ ] 사이드바 카테고리: DE 카테고리가 상단
- [ ] 네비게이션: About 링크 존재
- [ ] /about/ 페이지 정상 렌더링
- [ ] 메인 페이지 중복 포스트 없음
- [ ] 페이지 소스의 meta description: DE 키워드 포함
