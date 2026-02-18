---
title: "[SpringBlog] Markdown 렌더링 - flexmark-java로 Markdown → HTML 변환 구현하기"
categories:
  - SpringBlog
tags:
  - [Spring Boot, Markdown, flexmark-java, Thymeleaf, TDD]
---

# Introduction

---

블로그에 글을 작성할 때 일반 텍스트만 사용하면 가독성이 떨어집니다. **굵은 글씨**, *기울임*, 제목, 링크 등 다양한 서식을 적용하려면 Markdown이 필요합니다.

이번 Phase 5에서는 Spring Blog 프로젝트에 **Markdown 지원 기능**을 추가했습니다. 사용자가 Markdown 문법으로 작성한 글을 HTML로 변환하여 브라우저에서 서식이 적용된 상태로 보여주는 기능입니다.

이 글에서 다루는 내용:
- Markdown → HTML 변환 시점 선택 (저장 시 vs 조회 시)
- flexmark-java 라이브러리를 사용한 변환 서비스 구현
- TDD 방식의 단위 테스트 작성
- Controller와 Thymeleaf 템플릿 연동

# 배경 (Problem & Context)

---

## Markdown이 필요한 이유

일반 텍스트로만 글을 작성하면:
- 제목, 본문 구분이 어려움
- 강조 표현 불가능
- 링크나 이미지 추가 어려움
- 코드 블록 표시 불가능

Markdown을 사용하면 간단한 문법으로 서식을 지정할 수 있습니다:
```markdown
# 제목
**굵게** *기울임*
[링크](https://example.com)
`코드`
```

## Jekyll vs Spring Blog 동작 비교

Jekyll도 Markdown → HTML 변환을 수행합니다. 핵심 원리는 같지만 **변환 시점**이 다릅니다.

| | Jekyll | Spring Blog |
|---|---|---|
| 변환 시점 | 빌드 타임 (정적 사이트 생성) | 런타임 (사용자 요청 시) |
| 변환 도구 | Kramdown (Ruby) | flexmark-java (Java) |
| 저장 형태 | .md 파일 → .html 파일 | DB에 원본 Markdown 저장 |
| 변환 방식 | 빌드 시 모든 .md 파일을 HTML로 변환 | 조회 시마다 실시간 변환 |

## 저장 시 변환 vs 조회 시 변환

Markdown → HTML 변환을 **언제** 할 것인지는 설계 단계에서 결정해야 합니다.

### 저장 시 변환 (Write Time)
```
POST /posts/new
→ Markdown 변환 → HTML 생성
→ DB에 원본 Markdown + HTML 둘 다 저장
→ 조회 시 HTML 그대로 출력
```

**장점**: 조회 빠름 (이미 HTML이 준비되어 있음)

**단점**:
- DB 용량 증가 (원본 + HTML 둘 다 저장)
- Markdown 라이브러리 변경 시 전체 글 재변환 필요
- 구현 복잡 (Post 엔티티에 content + contentHtml 필드 둘 다 필요)

### 조회 시 변환 (Read Time)
```
GET /posts/{id}
→ DB에서 Markdown 원본 조회
→ 실시간 Markdown 변환 → HTML
→ HTML을 화면에 출력
```

**장점**:
- 구현 간단 (content 필드만 있으면 됨)
- DB 용량 절약 (원본만 저장)
- 라이브러리 변경 유연 (다음 조회부터 자동 반영)

**단점**: 매 조회마다 변환 비용 발생 (실무에서는 캐싱으로 해결)

| | 저장 시 변환 | 조회 시 변환 |
|---|---|---|
| 조회 성능 | 빠름 (HTML 준비됨) | 느림 (매번 변환) |
| 구현 복잡도 | 높음 (필드 2개 관리) | 낮음 (필드 1개) |
| 유연성 | 낮음 (재변환 필요) | 높음 (즉시 반영) |
| 적합한 상황 | 트래픽 많은 서비스 | 학습 프로젝트, 소규모 서비스 |

**학습 프로젝트이므로 조회 시 변환 방식을 선택했습니다.** 구현이 간단하고 유연하기 때문입니다.

# 접근 방법 (Approach)

---

## 라이브러리 선택: flexmark-java

Java에서 Markdown을 HTML로 변환하는 라이브러리는 크게 두 가지가 있습니다.

| | commonmark-java | flexmark-java |
|---|---|---|
| 기반 스펙 | CommonMark | CommonMark + 확장 |
| 확장 기능 | 별도 추가 필요 | 테이블, 취소선 등 내장 |
| GFM 지원 | 부분적 | GitHub Flavored Markdown 지원 |
| 특징 | 가볍고 빠름 | 풍부한 기능 |

**선택**: flexmark-java -- 테이블 등 확장 기능이 기본 제공되어 블로그 프로젝트에 더 실용적입니다.

## Gradle 의존성 추가 방법

Maven Central Repository에서 라이브러리를 검색하면 다음 정보를 확인할 수 있습니다:
```
Group ID: com.vladsch.flexmark
Artifact ID: flexmark-all
Version: 0.64.8
```

이 정보를 Gradle 형식으로 변환합니다:
```gradle
implementation 'com.vladsch.flexmark:flexmark-all:0.64.8'
```

**형식**: `'그룹ID:아티팩트ID:버전'`

> `flexmark-all`은 flexmark-java의 모든 확장 모듈을 포함하는 번들입니다. 필요한 확장만 사용하고 싶다면 `flexmark-core` + 개별 확장 모듈(예: `flexmark-ext-tables`)을 각각 추가할 수도 있습니다.

## flexmark-java 동작 흐름

flexmark는 다음 순서로 작동합니다:

```
1. MutableDataSet으로 옵션 설정 (어떤 확장 기능을 쓸 건지)
   ↓
2. Parser 생성 (Markdown → AST 파서)
   ↓
3. HtmlRenderer 생성 (AST → HTML 렌더러)
   ↓
4. parser.parse(markdown) → Node(AST 노드 트리)
   ↓
5. renderer.render(node) → HTML 문자열
```

**AST(Abstract Syntax Tree)란?** Markdown 텍스트를 트리 구조로 변환한 중간 표현입니다. 예를 들어 `**bold**`는 AST에서 `StrongEmphasis` 노드가 됩니다. 이 트리 구조를 거치기 때문에 같은 Markdown을 HTML, PDF 등 다양한 형태로 변환할 수 있습니다.

# 구현 (Key Code & Commands)

---

## 1. build.gradle 의존성 추가

```gradle
// spring-blog/build.gradle
dependencies {
    // ... 기존 의존성들
    implementation 'com.vladsch.flexmark:flexmark-all:0.64.8'
}
```

변경 후 Gradle 새로고침:
```bash
./gradlew build
```

## 2. MarkdownService 구현

```java
// spring-blog/src/main/java/com/example/blog/service/MarkdownService.java
package com.example.blog.service;

import com.vladsch.flexmark.ext.tables.TablesExtension;
import com.vladsch.flexmark.html.HtmlRenderer;
import com.vladsch.flexmark.parser.Parser;
import com.vladsch.flexmark.util.ast.Node;
import com.vladsch.flexmark.util.data.MutableDataSet;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class MarkdownService {

    private final Parser parser;
    private final HtmlRenderer renderer;

    MarkdownService() {
        // 1. 옵션 설정: 테이블 확장 기능 활성화
        MutableDataSet options = new MutableDataSet();
        options.set(Parser.EXTENSIONS, List.of(TablesExtension.create()));

        // 2. Parser와 Renderer 생성 (한 번만 생성하여 재사용)
        parser = Parser.builder(options).build();
        renderer = HtmlRenderer.builder(options).build();
    }

    public String convertToHtml(String markdown) {
        // null 방어 코드
        if (markdown == null) {
            return "";
        }

        // 3. Markdown → Node(AST) → HTML
        Node document = parser.parse(markdown);
        return renderer.render(document);
    }
}
```

**핵심 포인트**:

- **Parser와 HtmlRenderer를 필드로 선언하여 재사용**: flexmark 공식 문서에서 "You can re-use parser and renderer instances"라고 명시합니다. `@Service`는 기본적으로 싱글톤이므로, 생성자에서 한 번 만들면 모든 요청에서 동일한 인스턴스를 사용합니다. 매 요청마다 생성하면 불필요한 객체 생성 비용이 발생합니다.

- **`TablesExtension.create()`**: Markdown 테이블 문법(`| header | header |`)을 HTML `<table>` 태그로 변환합니다. 이 확장을 등록하지 않으면 테이블 문법이 일반 텍스트로 출력됩니다.

- **`Node` 타입**: `parser.parse()`의 반환 타입입니다. 공식 예제에서 `Node`를 사용합니다. `Document`는 `Node`의 하위 타입이므로 둘 다 사용 가능하지만, `renderer.render()`가 `Node`를 파라미터로 받으므로 `Node`로 선언하는 것이 공식 예제와 일치합니다.

- **클래스명 관례**: `MarkDownService` (X) → `MarkdownService` (O). Markdown은 한 단어로 취급합니다. Spring 관례상 약어나 복합어는 카멜케이스로 작성합니다 (HTML → Html, JSON → Json, Markdown → Markdown).

## 3. TDD: 테스트 먼저 작성

```java
// spring-blog/src/test/java/com/example/blog/service/MarkdownServiceTest.java
package com.example.blog.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

// @SpringBootTest 없이 순수 단위 테스트
// MarkdownService는 DB나 Spring 기능에 의존하지 않으므로 직접 생성
class MarkdownServiceTest {

    private MarkdownService markdownService;

    @BeforeEach
    void setUp() {
        markdownService = new MarkdownService();
    }

    @Test
    @DisplayName("볼드 변환: **text** → <strong>text</strong>")
    void convertBold() {
        String html = markdownService.convertToHtml("**bold**");
        assertThat(html.trim()).isEqualTo("<p><strong>bold</strong></p>");
    }

    @Test
    @DisplayName("이탤릭 변환: *text* → <em>text</em>")
    void convertItalic() {
        String html = markdownService.convertToHtml("*italic*");
        assertThat(html.trim()).isEqualTo("<p><em>italic</em></p>");
    }

    @Test
    @DisplayName("제목 변환: # title → <h1>title</h1>")
    void convertHeading() {
        String html = markdownService.convertToHtml("# Hello");
        assertThat(html.trim()).isEqualTo("<h1>Hello</h1>");
    }

    @Test
    @DisplayName("null 입력 시 빈 문자열 반환")
    void convertNull() {
        String html = markdownService.convertToHtml(null);
        assertThat(html.trim()).isEmpty();
    }
}
```

**왜 `@SpringBootTest` 없이 테스트하나?**
- MarkdownService는 DB, HTTP, Spring 컨텍스트에 의존하지 않음
- 순수 Java 로직만 있으므로 `new MarkdownService()`로 직접 생성하여 테스트 가능
- Spring 컨텍스트를 로딩하지 않아 테스트가 빠르게 실행됨 (수 밀리초 vs 수 초)

**테스트 실행 명령어**:
```bash
# Gradle로 특정 테스트 클래스만 실행
./gradlew test --tests "com.example.blog.service.MarkdownServiceTest"
```

> **주의**: `--tests` 옵션에는 **클래스 정규화 이름**(패키지.클래스명)을 사용합니다. 파일 경로(`src/test/java/...`)가 아닙니다.
> IntelliJ에서는 클래스/메서드 옆의 실행 버튼 또는 `Ctrl+Shift+R`(Mac)로 실행할 수 있습니다.

## 4. Controller에서 Markdown 변환

```java
// spring-blog/src/main/java/com/example/blog/controller/PostController.java
@Controller
@RequiredArgsConstructor
public class PostController {

    private final PostService postService;
    private final MarkdownService markdownService;

    @GetMapping("/posts/{id}")
    public String postDetail(@PathVariable Long id, Model model){
        Post post = postService.getPost(id).orElseThrow();

        // Markdown 원본을 HTML로 변환
        String contentHtml = markdownService.convertToHtml(post.getContent());

        // 원본 Post와 변환된 HTML을 따로 전달
        model.addAttribute("post", post);
        model.addAttribute("contentHtml", contentHtml);

        return "posts/detail";
    }
}
```

**왜 `post.setContent(html)` 대신 별도 변수로 전달하나?**

```java
// 잘못된 방법: 엔티티 직접 수정
post.setContent(html);  // 위험! JPA dirty checking으로 DB에 HTML이 저장됨!

// 올바른 방법: 별도 변수로 전달
String contentHtml = markdownService.convertToHtml(post.getContent());
model.addAttribute("contentHtml", contentHtml);
```

**JPA Dirty Checking**: 영속성 컨텍스트에서 관리되는 엔티티의 필드를 변경하면, 트랜잭션 커밋 시 자동으로 UPDATE 쿼리가 발생합니다. `post.setContent(html)`을 호출하면 DB에 HTML이 저장되어 **Markdown 원본을 잃게 됩니다.** 반드시 별도 변수를 사용하세요.

## 5. Thymeleaf 템플릿 수정

```html
<!-- spring-blog/src/main/resources/templates/posts/detail.html -->
<div class="post-content" th:utext="${contentHtml}">Content</div>
```

**`th:text` vs `th:utext`**:

| | th:text | th:utext |
|---|---|---|
| HTML 이스케이프 | O (태그를 문자로 표시) | X (태그를 실제 HTML로 렌더링) |
| 출력 예시 | `<strong>bold</strong>` (문자 그대로) | **bold** (굵은 글씨) |
| 사용 용도 | 사용자 입력 텍스트 | 안전한 HTML (Markdown 변환 결과) |

Markdown 변환 결과는 flexmark-java가 생성한 HTML이므로 `th:utext`를 사용하여 태그를 실제로 렌더링합니다.

**보안 주의**: 사용자가 직접 HTML을 입력하는 경우 `th:utext`를 사용하면 XSS(Cross-Site Scripting) 공격에 취약합니다. flexmark-java가 변환한 HTML만 `th:utext`로 출력하세요. 사용자의 원본 입력을 그대로 출력할 때는 반드시 `th:text`를 사용합니다.

# 주의할 점 (Gotchas)

---

## 1. Parser/Renderer를 매번 생성하지 않기

가장 흔한 실수는 `convertToHtml()` 메서드 안에서 매번 Parser와 Renderer를 새로 생성하는 것입니다.

```java
// 비효율적: 매번 생성
public String convertToHtml(String markdown) {
    Parser parser = Parser.builder().build();       // 매번 새로 생성
    HtmlRenderer renderer = HtmlRenderer.builder().build();  // 매번 새로 생성
    return renderer.render(parser.parse(markdown));
}
```

flexmark 공식 문서에서 "You can re-use parser and renderer instances"라고 명시한 대로, 위 코드의 MarkdownService처럼 생성자에서 한 번만 생성하고 필드로 재사용해야 합니다.

## 2. IntelliJ에서 테스트 클래스 이름 복사하기

Gradle `--tests` 옵션에는 파일 경로가 아니라 클래스 정규화 이름이 필요합니다. IntelliJ에서 쉽게 복사할 수 있습니다.

| 복사 대상 | 단축키 (Mac) | 결과 예시 |
|---|---|---|
| 파일 경로 | `Cmd+Shift+C` | `src/test/java/.../MarkdownServiceTest.java` |
| 클래스 정규화 이름 | `Cmd+Shift+Alt+C` → Reference | `com.example.blog.service.MarkdownServiceTest` |

## 3. List.of() vs Arrays.asList()

flexmark 공식 예제에서는 `Arrays.asList()`를 사용하지만, Java 9 이상에서는 `List.of()`를 사용할 수 있습니다.

| | Arrays.asList() | List.of() |
|---|---|---|
| Java 버전 | 1.2+ | 9+ |
| null 허용 | O | X |
| 요소 교체 | O (set()) | X (완전 불변) |
| 요소 추가/삭제 | X | X |

확장 목록처럼 한번 설정하고 변경할 일 없는 경우 둘 다 동작하지만, Java 17 프로젝트이므로 `List.of()`가 더 명확합니다.

## 4. th:utext 사용 시 XSS 주의

`th:utext`는 HTML을 이스케이프하지 않고 그대로 렌더링합니다. 만약 사용자가 입력한 텍스트를 `th:utext`로 직접 출력하면, `<script>alert('hack')</script>` 같은 악성 코드가 실행될 수 있습니다. 반드시 **flexmark-java가 변환한 HTML만** `th:utext`로 출력하세요.

# 다음 단계 (Next Steps)

---

## 기능 확장

1. **코드 블록 하이라이팅**:
   - 현재는 `<code>` 태그만 생성
   - highlight.js나 Prism.js로 문법 강조 추가

2. **이미지 업로드 지원**:
   - `![alt](image.png)` 문법 지원
   - 이미지 파일 저장 경로 설정

3. **Markdown 미리보기**:
   - 작성 폼에 실시간 미리보기 추가
   - JavaScript로 클라이언트 측 렌더링

## 성능 최적화

1. **변환 결과 캐싱**:
   - Spring Cache (`@Cacheable`) 적용
   - 같은 글을 반복 조회 시 변환 생략

2. **저장 시 변환 방식으로 변경**:
   - content와 contentHtml 둘 다 저장
   - 조회 성능 향상 vs DB 용량 트레이드오프

# Reference

---

- **구현 코드**:
  - [MarkdownService.java](https://github.com/krails0105/spring-blog/blob/main/src/main/java/com/example/blog/service/MarkdownService.java)
  - [MarkdownServiceTest.java](https://github.com/krails0105/spring-blog/blob/main/src/test/java/com/example/blog/service/MarkdownServiceTest.java)
  - [PostController.java](https://github.com/krails0105/spring-blog/blob/main/src/main/java/com/example/blog/controller/PostController.java)
  - [detail.html](https://github.com/krails0105/spring-blog/blob/main/src/main/resources/templates/posts/detail.html)
  - [build.gradle](https://github.com/krails0105/spring-blog/blob/main/build.gradle)

- **외부 자료**:
  - [flexmark-java GitHub](https://github.com/vsch/flexmark-java)
  - [CommonMark Spec](https://commonmark.org/)
  - [Thymeleaf th:utext 문서](https://www.thymeleaf.org/doc/tutorials/3.0/usingthymeleaf.html#unescaped-text)
