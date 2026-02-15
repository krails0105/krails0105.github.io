---
title: "[SpringBlog] Spring Boot 프로젝트 생성과 구조 이해"
categories:
  - SpringBlog
tags:
  - [SpringBoot, Gradle, Thymeleaf, H2Database, MVC, SpringInitializr]
---

# Introduction

---

Spring Boot 프로젝트의 첫 걸음은 프로젝트를 생성하고 실행하는 것입니다. 이 과정에서 Gradle이란 무엇인지, `@SpringBootApplication`이 어떻게 동작하는지, Controller와 Thymeleaf가 어떻게 협력하는지를 이해하게 됩니다.

이 글은 Spring Initializr로 프로젝트를 생성하고, IntelliJ에서 설정을 맞추고, 첫 페이지를 띄우는 과정을 정리하면서, 그 과정에서 만나는 핵심 개념들을 초보자 관점에서 설명합니다.

**이 글에서 다루는 내용:**
- Spring Initializr를 사용한 프로젝트 생성과 디렉토리 구조
- Gradle의 역할과 `build.gradle` 분석
- `@SpringBootApplication`이 내부적으로 하는 일
- Controller + Thymeleaf로 첫 페이지 띄우기
- `@Controller` vs `@RestController`의 차이
- `static/` vs `templates/` 디렉토리의 역할
- 초보자가 자주 만나는 함정과 해결법

# 1. Spring Boot 프로젝트 생성

---

## Spring Initializr 사용

[Spring Initializr](https://start.spring.io)는 Spring Boot 프로젝트의 기본 구조를 자동으로 만들어주는 웹 도구입니다. 의존성 선택, 빌드 도구 지정, Java 버전 설정 등을 GUI에서 처리하고, 완성된 프로젝트를 ZIP으로 다운로드합니다.

**선택한 설정:**
- Project: Gradle - Groovy (빌드 도구)
- Language: Java
- Spring Boot: 3.5.10
- Java: 17
- Dependencies:
  - Spring Web (REST API, MVC)
  - Thymeleaf (HTML 템플릿 엔진)
  - Spring Data JPA (데이터베이스 접근)
  - H2 Database (인메모리 개발용 DB)
  - Lombok (보일러플레이트 코드 축약)

Generate 버튼을 누르면 `project-name.zip` 파일이 다운로드됩니다. 압축을 해제하고 원하는 디렉토리에 배치합니다.

## 생성된 프로젝트 구조

```text
spring-blog/
├── build.gradle              # Gradle 빌드 설정
├── settings.gradle           # 프로젝트 이름, 멀티 모듈 설정
├── gradlew                   # Gradle Wrapper 실행 스크립트 (Unix)
├── gradlew.bat               # Gradle Wrapper 실행 스크립트 (Windows)
├── src/
│   ├── main/
│   │   ├── java/com/example/blog/
│   │   │   └── BlogApplication.java    # 메인 클래스
│   │   └── resources/
│   │       ├── application.properties  # 설정 파일
│   │       ├── static/                 # CSS, JS, 이미지 (정적 파일)
│   │       └── templates/              # Thymeleaf HTML (서버 렌더링)
│   └── test/
│       └── java/com/example/blog/
│           └── BlogApplicationTests.java
└── gradle/
    └── wrapper/                        # Gradle Wrapper JAR + 설정
        ├── gradle-wrapper.jar
        └── gradle-wrapper.properties
```

`gradlew`(Gradle Wrapper)는 프로젝트에 Gradle을 내장하여, 시스템에 Gradle이 설치되어 있지 않아도 빌드할 수 있게 합니다. 팀원 간 Gradle 버전 차이로 인한 빌드 실패를 방지합니다.

# 2. Gradle이란?

---

## 개념

Gradle은 **빌드 자동화 도구**입니다. Java 프로젝트를 컴파일하고, 테스트하고, 실행하고, 배포 파일(JAR/WAR)을 만드는 과정을 자동화합니다. 의존성(라이브러리) 관리도 Gradle의 핵심 역할 중 하나입니다.

Java 진영에서는 Maven이 오랫동안 표준이었지만, Gradle은 Groovy/Kotlin 기반의 유연한 빌드 스크립트와 빌드 캐시를 통한 성능 이점으로 현재 Spring Boot의 기본 빌드 도구로 자리 잡았습니다.

다른 언어의 유사 도구와 비교하면 다음과 같습니다.

| 언어 | 빌드 도구 | 패키지 매니저 | Gradle과의 대응 |
|------|-----------|-------------|----------------|
| Java | **Gradle** / Maven | Maven Central | 빌드 + 패키지 관리 통합 |
| JavaScript | Webpack / Vite | npm / yarn | npm은 패키지 관리, Webpack은 번들링 |
| Python | setuptools | pip / poetry | pip은 패키지 관리, setuptools는 빌드 |

Gradle은 빌드와 의존성 관리를 하나의 도구에서 처리한다는 점이 특징입니다.

## 핵심 역할

### 1. 의존성 관리

```groovy
// build.gradle
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-thymeleaf'
}
```

이 두 줄로 Spring Web과 Thymeleaf, 그리고 그들이 의존하는 수십 개의 JAR 파일이 자동으로 다운로드됩니다. Gradle은 Maven Central 등의 원격 저장소(Repository)에서 라이브러리를 가져와 프로젝트에 포함시킵니다. 의존성이 또 다른 의존성을 필요로 하는 경우(전이적 의존성, transitive dependency)도 자동으로 해결합니다.

### 2. 빌드 태스크

```bash
./gradlew clean      # 빌드 결과물(build/ 디렉토리) 삭제
./gradlew build      # 컴파일 + 테스트 + JAR 생성
./gradlew test       # 테스트만 실행
./gradlew bootRun    # Spring Boot 앱 실행 (Spring Boot 플러그인 제공)
./gradlew bootJar    # 실행 가능한 JAR 파일 생성
```

각 명령어는 **태스크(Task)**이며, 태스크는 의존 관계를 가집니다. 예를 들어 `build` 태스크는 내부적으로 `compileJava` → `processResources` → `classes` → `test` → `jar` 태스크를 순서대로 실행합니다. `bootRun`은 Spring Boot 플러그인(`org.springframework.boot`)이 제공하는 태스크로, 내장 Tomcat 서버를 띄워 애플리케이션을 실행합니다.

## build.gradle 분석

```groovy
// spring-blog/build.gradle
plugins {
    id 'java'                                               // Java 컴파일, 테스트, JAR 태스크 제공
    id 'org.springframework.boot' version '3.5.10'          // bootRun, bootJar 태스크 제공
    id 'io.spring.dependency-management' version '1.1.7'    // Spring BOM으로 의존성 버전 자동 관리
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)         // Java 17 사용
    }
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'  // JPA + Hibernate
    implementation 'org.springframework.boot:spring-boot-starter-thymeleaf' // Thymeleaf 템플릿 엔진
    implementation 'org.springframework.boot:spring-boot-starter-web'       // Spring MVC + 내장 Tomcat
    compileOnly 'org.projectlombok:lombok'                                 // 컴파일 시에만 사용
    runtimeOnly 'com.h2database:h2'                                        // 실행 시에만 사용
    annotationProcessor 'org.projectlombok:lombok'                         // 어노테이션 처리기
}
```

## 의존성 구성(Configuration) 비교

Gradle의 Java 플러그인은 의존성을 용도별로 분류하는 **구성(Configuration)**을 제공합니다.

| 구성 | 컴파일 클래스패스 | 런타임 클래스패스 | 설명 | 대표 예시 |
|------|:---:|:---:|------|-----------|
| `implementation` | O | O | 컴파일과 런타임 모두 필요 | Spring Web, Thymeleaf |
| `compileOnly` | O | X | 컴파일 시에만 필요, 런타임에 제외 | Lombok |
| `runtimeOnly` | X | O | 런타임에만 필요, 컴파일 시 불필요 | H2 JDBC 드라이버 |
| `annotationProcessor` | - | - | 컴파일 시 어노테이션 처리기 등록 | Lombok |
| `testImplementation` | O (test) | O (test) | 테스트 컴파일과 실행에 필요 | JUnit, Mockito |

**Lombok이 `compileOnly`와 `annotationProcessor` 둘 다 필요한 이유:**
- `compileOnly`: 소스 코드에서 `@Getter`, `@Setter` 등의 어노테이션을 인식하기 위해 컴파일 클래스패스에 필요
- `annotationProcessor`: 컴파일 시 Lombok이 어노테이션을 읽고 실제 `getter()`, `setter()` 메서드를 바이트코드로 생성하기 위해 필요
- 런타임에는 이미 메서드가 생성된 상태이므로 Lombok JAR가 불필요

## `io.spring.dependency-management` 플러그인의 역할

`build.gradle`에서 Spring 관련 의존성에 **버전 번호를 생략**할 수 있는 이유가 이 플러그인입니다.

```groovy
// 버전 번호 없이 선언 가능
implementation 'org.springframework.boot:spring-boot-starter-web'
```

이 플러그인은 Spring Boot BOM(Bill of Materials)을 적용하여, Spring Boot 버전(3.5.10)과 호환되는 의존성 버전을 자동으로 결정합니다. 개발자가 직접 버전 호환성을 관리하는 부담을 줄여줍니다.

# 3. IntelliJ 설정

---

## Project SDK vs Gradle JVM

IntelliJ에서 Java 프로젝트를 열면 두 가지 Java 버전 설정이 등장합니다. 둘의 역할이 다르므로 혼동하지 않도록 주의합니다.

| 항목 | 역할 | 설정 위치 |
|------|------|-----------|
| **Project SDK** | IntelliJ가 코드 편집 시 사용 (문법 체크, 자동완성) | File → Project Structure → Project |
| **Gradle JVM** | Gradle이 빌드/실행 시 사용 | Settings → Build, Execution, Deployment → Build Tools → Gradle |

**중요**: 두 설정 모두 `build.gradle`에 선언한 Java 버전(17)과 맞춰야 합니다. 안 맞으면 편집기에서는 오류가 없는데 빌드 시 컴파일 에러가 발생하거나, 그 반대 상황이 생깁니다.

**설정 방법:**
1. File → Project Structure → Project → SDK를 `temurin-17`로 설정
2. Settings → Build Tools → Gradle → Gradle JVM을 `Project SDK (temurin-17)`로 설정

이 두 설정이 일치하지 않으면, IntelliJ 편집기에서는 에러가 없지만 `./gradlew build`에서 컴파일이 실패하거나, 반대로 빌드는 되지만 편집기에서 빨간 줄이 나타나는 혼란스러운 상황이 발생합니다.

# 4. application.properties 설정

---

`application.properties`는 Spring Boot가 **앱 시작 시 자동으로 읽는 설정 파일**입니다. `src/main/resources/` 디렉토리에 위치하며, 데이터베이스 연결 정보, 서버 포트, JPA 옵션 등을 정의합니다. Spring Boot는 미리 정의된 키(key)를 인식하여 해당 기능을 설정합니다.

```properties
# src/main/resources/application.properties
spring.application.name=blog

# H2 인메모리 DB
spring.datasource.url=jdbc:h2:mem:blogdb
spring.datasource.driver-class-name=org.h2.Driver
spring.datasource.username=sa
spring.datasource.password=

# H2 웹 콘솔 (localhost:8080/h2-console에서 DB 내용 확인)
spring.h2.console.enabled=true

# JPA
spring.jpa.hibernate.ddl-auto=create
spring.jpa.show-sql=true
```

## 핵심 키 설명

| 키 | 값 | 설명 |
|---|---|------|
| `spring.datasource.url` | `jdbc:h2:mem:blogdb` | JDBC 연결 URL. `mem:`은 인메모리 모드, `blogdb`는 DB 이름 |
| `spring.datasource.driver-class-name` | `org.h2.Driver` | JDBC 드라이버 클래스. Spring Boot가 URL에서 자동 추론하므로 생략 가능 |
| `spring.datasource.username` | `sa` | DB 접속 사용자명. H2 기본값이 `sa` |
| `spring.h2.console.enabled` | `true` | H2 웹 콘솔 활성화. `localhost:8080/h2-console`에서 접근 |
| `spring.jpa.hibernate.ddl-auto` | `create` | 앱 시작 시 엔티티 기반 테이블 자동 생성 |
| `spring.jpa.show-sql` | `true` | 실행되는 SQL 쿼리를 콘솔에 출력 |

## `spring.jpa.hibernate.ddl-auto` 옵션 비교

이 옵션은 앱 시작 시 Hibernate가 데이터베이스 스키마를 어떻게 처리할지 결정합니다. **운영 환경에서 잘못 설정하면 데이터가 삭제될 수 있으므로** 각 옵션의 동작을 정확히 이해해야 합니다.

| 옵션 | 동작 | 사용 환경 |
|------|------|-----------|
| `create` | 기존 테이블 DROP 후 새로 CREATE | 개발 (데이터 매번 초기화) |
| `create-drop` | create와 동일 + 앱 종료 시 DROP | 테스트 |
| `update` | 엔티티 변경 사항만 ALTER (기존 데이터 유지) | 개발 |
| `validate` | 엔티티와 테이블 구조 일치 여부만 검증 (변경 없음) | 운영 |
| `none` | 아무 작업 안 함 | 운영 |

**만약 `server.port` 키를 설정하지 않으면** 기본값 8080이 사용됩니다. Spring Boot는 수백 개의 설정 키를 제공하며, 설정하지 않은 키는 모두 기본값을 사용합니다.

# 5. @SpringBootApplication 분해

---

```java
// src/main/java/com/example/blog/BlogApplication.java
package com.example.blog;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class BlogApplication {
    public static void main(String[] args) {
        SpringApplication.run(BlogApplication.class, args);
    }
}
```

`SpringApplication.run()`은 Spring의 `ApplicationContext`를 생성하고, 자동 설정을 적용하고, 내장 웹 서버를 시작합니다. `args`를 전달하면 커맨드라인 인자를 `application.properties` 설정 덮어쓰기에 사용할 수 있습니다 (예: `--server.port=9090`).

## @SpringBootApplication의 내부 구조

`@SpringBootApplication`은 **메타 어노테이션(meta-annotation)**으로, 세 개의 어노테이션을 묶은 것입니다.

```java
// Spring Boot 소스 코드 (간략화)
@SpringBootConfiguration
@EnableAutoConfiguration
@ComponentScan
public @interface SpringBootApplication { ... }
```

### @SpringBootConfiguration

```java
@Configuration
public @interface SpringBootConfiguration { ... }
```

`@Configuration`의 특화 버전입니다. 이 클래스가 **앱의 최상위 설정 클래스**임을 선언합니다. Spring의 `@Configuration`과 기능적으로 동일하지만, Spring Boot가 **통합 테스트에서 설정 클래스를 자동 탐지**할 때 이 어노테이션을 기준으로 찾습니다. 공식 문서에서는 "Spring의 표준 `@Configuration`의 대안으로, 통합 테스트에서의 설정 탐지를 돕는다"고 설명합니다.

### @EnableAutoConfiguration

클래스패스에 존재하는 JAR 의존성을 기반으로 **자동 설정(Auto-configuration)**을 수행합니다. 공식 문서 표현으로는, Spring Boot가 추가된 jar 의존성을 보고 Spring을 어떻게 설정할지 "추측(guess)"합니다.

| 클래스패스의 의존성 | 자동 설정 내용 |
|--------|----------------|
| `spring-boot-starter-web` | 내장 Tomcat 서버, `DispatcherServlet`, JSON 변환기(`HttpMessageConverter`) |
| `spring-boot-starter-thymeleaf` | `ThymeleafViewResolver` (prefix: `classpath:/templates/`, suffix: `.html`) |
| `spring-boot-starter-data-jpa` | `DataSource`, `EntityManagerFactory`, `TransactionManager` |
| `h2` | H2 인메모리 데이터베이스 드라이버 등록 |

예를 들어 `spring-boot-starter-web`이 클래스패스에 있으면, Spring Boot는 자동으로 Tomcat 서버를 8080 포트에 띄우고, `DispatcherServlet`을 등록합니다. **개발자가 별도로 XML이나 Java 설정을 작성하지 않아도** 이 모든 것이 자동으로 이루어집니다.

### @ComponentScan

`BlogApplication` 클래스가 있는 패키지(`com.example.blog`)를 기준으로 **하위 패키지를 모두 스캔**하여 `@Component`와 그 하위 어노테이션(`@Controller`, `@Service`, `@Repository`)이 붙은 클래스를 찾아 Spring Bean으로 등록합니다.

```text
com.example.blog/           <-- @ComponentScan 시작 지점
├── BlogApplication.java
├── controller/
│   └── HomeController.java   <-- @Controller 발견 → Bean 등록
├── service/
│   └── PostService.java      <-- @Service 발견 → Bean 등록
└── repository/
    └── PostRepository.java   <-- @Repository 발견 → Bean 등록
```

**주의**: `com.example.blog` 패키지 외부에 있는 클래스는 스캔되지 않습니다. 따라서 메인 클래스(`@SpringBootApplication`이 붙은 클래스)는 반드시 **최상위 패키지**에 위치해야 합니다.

## 메타 어노테이션이란?

"어노테이션 위에 붙는 어노테이션"을 **메타 어노테이션**이라 합니다. `@SpringBootConfiguration`의 소스 코드를 보면 여러 메타 어노테이션이 붙어 있습니다.

```java
@Target({ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Indexed
@Configuration
public @interface SpringBootConfiguration { ... }
```

| 메타 어노테이션 | 역할 |
|-----------------|------|
| `@Target(ElementType.TYPE)` | 이 어노테이션을 클래스/인터페이스에만 붙일 수 있음 |
| `@Retention(RetentionPolicy.RUNTIME)` | 런타임까지 어노테이션 정보 유지 (리플렉션으로 읽기 위해) |
| `@Documented` | Javadoc에 이 어노테이션 정보 포함 |
| `@Indexed` | 컴포넌트 스캔 성능 최적화 (인덱스 파일 생성) |

**왜 런타임까지 유지할까?**

Spring은 앱 실행 시 **리플렉션(reflection)**을 사용해 클래스를 스캔하고, 어노테이션 정보를 읽어 Bean을 생성합니다. 만약 `@Retention(RetentionPolicy.SOURCE)`였다면 컴파일 후 어노테이션 정보가 사라져서, Spring이 이 클래스가 설정 클래스인지 알 수 없게 됩니다.

```text
@Retention 정책별 어노테이션 정보 유지 범위:
  SOURCE  → 소스 코드까지만 (컴파일 시 제거) → Lombok의 @Getter 등
  CLASS   → .class 파일까지 (런타임 시 로드 안 됨) → 기본값
  RUNTIME → 런타임까지 유지 (리플렉션으로 접근 가능) → Spring 어노테이션들
```

# 6. 첫 페이지 만들기

---

## HomeController 작성

```java
// src/main/java/com/example/blog/controller/HomeController.java
package com.example.blog.controller;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller  // Spring MVC 컨트롤러 선언 → @ComponentScan에 의해 Bean 등록
public class HomeController {

    @GetMapping("/")  // HTTP GET "/" 요청을 이 메서드에 매핑
    public String home() {
        return "home";  // 논리적 뷰 이름 → ViewResolver가 templates/home.html로 변환
    }
}
```

**코드 분석:**
- `@Controller`: 이 클래스가 Spring MVC 컨트롤러임을 선언합니다. `@Component`의 특화 어노테이션이므로 `@ComponentScan`에 의해 자동으로 Bean 등록됩니다.
- `@GetMapping("/")`: HTTP GET 요청이 `/` 경로로 들어오면 `home()` 메서드를 실행합니다. `@RequestMapping(value = "/", method = RequestMethod.GET)`의 축약형입니다.
- `return "home"`: 논리적 뷰 이름 "home"을 반환합니다. `ThymeleafViewResolver`가 이 이름을 `classpath:/templates/home.html` 파일 경로로 변환합니다.

## Thymeleaf 템플릿 작성

```html
<!-- src/main/resources/templates/home.html -->
<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<head>
  <meta charset="UTF-8">
  <title>Blog</title>
</head>
<body>
  <h1>Spring Blog</h1>
  <p>블로그에 오신 것을 환영합니다!</p>
</body>
</html>
```

**주요 포인트:**
- `xmlns:th="http://www.thymeleaf.org"`: Thymeleaf 네임스페이스 선언. `th:text`, `th:each` 등 Thymeleaf 전용 속성을 사용할 수 있게 됩니다.
- 파일 위치: `src/main/resources/templates/` 디렉토리. Controller의 반환값을 통해서만 접근 가능합니다.

## Controller에서 Thymeleaf로의 요청 처리 흐름

```text
1. 사용자 요청: GET http://localhost:8080/
                          ↓
2. DispatcherServlet: 모든 요청을 받는 프론트 컨트롤러
   → @GetMapping("/")이 매핑된 핸들러 메서드 탐색
                          ↓
3. HomeController.home() 실행 → return "home" (논리적 뷰 이름)
                          ↓
4. ThymeleafViewResolver: "home" → classpath:/templates/home.html
   (prefix: "classpath:/templates/" + viewName: "home" + suffix: ".html")
                          ↓
5. Thymeleaf 엔진: 템플릿 파일을 읽고 HTML 렌더링
                          ↓
6. 사용자에게 완성된 HTML 응답 전송
```

**ViewResolver**는 컨트롤러가 반환한 논리적 뷰 이름("home")을 실제 파일 경로(`classpath:/templates/home.html`)로 변환하는 역할을 합니다. Spring Boot가 클래스패스에서 Thymeleaf 의존성을 감지하면, 자동으로 `ThymeleafViewResolver`를 등록하고 prefix를 `classpath:/templates/`, suffix를 `.html`로 설정합니다. 이 기본값은 `application.properties`에서 `spring.thymeleaf.prefix`와 `spring.thymeleaf.suffix`로 변경할 수 있습니다.

# 7. 앱 실행과 포트 충돌 해결

---

## 실행

```bash
# 터미널에서 실행
./gradlew bootRun
```

IntelliJ에서는 `BlogApplication.java`의 `main()` 메서드 왼쪽 초록색 실행 버튼을 클릭해도 됩니다.

정상 실행 시 다음과 같은 로그가 출력됩니다.

```text
  .   ____          _            __ _ _
 /\\ / ___'_ __ _ _(_)_ __  __ _ \ \ \ \
( ( )\___ | '_ | '_| | '_ \/ _` | \ \ \ \
 \\/  ___)| |_)| | | | | || (_| |  ) ) ) )
  '  |____| .__|_| |_|_| |_\__, | / / / /
 =========|_|==============|___/=/_/_/_/

 :: Spring Boot ::              (v3.5.10)

...
Tomcat started on port 8080 (http) with context path '/'
Started BlogApplication in 2.345 seconds (process running for 2.789)
```

브라우저에서 `http://localhost:8080`에 접속하면 `home.html`이 렌더링된 페이지를 확인할 수 있습니다.

## 포트 충돌 문제

```text
***************************
APPLICATION FAILED TO START
***************************

Description:

Web server failed to start. Port 8080 was already in use.
```

이미 8080 포트를 사용 중인 프로세스가 있을 때 발생합니다.

**해결 방법 1: 기존 프로세스 종료**

```bash
# macOS/Linux: 8080 포트를 사용 중인 프로세스 찾기
lsof -ti :8080

# 해당 프로세스 강제 종료
kill -9 $(lsof -ti :8080)
```

**해결 방법 2: 포트 변경**

`application.properties`에서 다른 포트를 지정합니다.

```properties
server.port=9090
```

# 8. @Controller vs @RestController

---

Spring MVC에서 HTTP 요청을 처리하는 컨트롤러는 두 종류가 있습니다. 반환값의 처리 방식이 핵심 차이입니다.

| 어노테이션 | 내부 구성 | 반환값 처리 | 사용 목적 |
|-----------|-----------|-------------|-----------|
| `@Controller` | `@Component` | ViewResolver를 통해 템플릿 렌더링 | HTML 페이지 반환 (서버 사이드 렌더링) |
| `@RestController` | `@Controller` + `@ResponseBody` | HTTP 응답 본문에 직접 쓰기 (JSON 변환) | REST API 엔드포인트 |

**@Controller 예시 - HTML 페이지 반환:**

```java
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HomeController {
    @GetMapping("/")
    public String home() {
        return "home";  // → ViewResolver → templates/home.html 렌더링
    }
}
```

**@RestController 예시 - JSON/문자열 반환:**

```java
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
public class ApiController {
    @GetMapping("/api/hello")
    public String hello() {
        return "Hello";  // → 문자열 "Hello"가 HTTP 응답 본문에 그대로 전달
    }
}
```

`@RestController`는 `@Controller` + `@ResponseBody`를 합친 것입니다. `@ResponseBody`는 메서드 반환값을 ViewResolver를 거치지 않고 HTTP 응답 본문에 직접 쓰라는 지시입니다.

**@Controller에서 @ResponseBody를 개별 메서드에 붙이는 패턴:**

하나의 컨트롤러에서 HTML 렌더링과 JSON 응답을 모두 처리해야 할 때 유용합니다.

```java
@Controller
public class HomeController {
    @GetMapping("/")
    public String home() {
        return "home";  // HTML 렌더링
    }

    @GetMapping("/api/status")
    @ResponseBody  // 이 메서드만 응답 본문에 직접 쓰기
    public String status() {
        return "OK";  // 문자열 "OK" 반환
    }
}
```

# 9. static/ vs templates/ 디렉토리

---

Spring Boot는 `src/main/resources/` 아래 두 개의 디렉토리를 용도에 따라 구분합니다.

| 디렉토리 | 용도 | 접근 방식 | 서버 처리 | 예시 |
|----------|------|-----------|-----------|------|
| `static/` | CSS, JS, 이미지 등 정적 파일 | URL로 직접 접근 | 파일을 그대로 전달 (가공 없음) | `localhost:8080/css/style.css` |
| `templates/` | Thymeleaf HTML 템플릿 | Controller를 통해서만 접근 | 서버에서 데이터를 주입 후 HTML 생성 | Controller에서 `return "home"` |

**static/ 예시:**

```text
파일 위치: src/main/resources/static/css/style.css
접근 URL: http://localhost:8080/css/style.css
```

`static/` 이하의 경로가 URL에 그대로 매핑됩니다. 서버에서 어떤 가공도 하지 않고 파일을 그대로 전달합니다.

**templates/ 예시 - 서버에서 데이터 주입:**

```java
// Controller에서 Model에 데이터를 담아 전달
@Controller
public class HomeController {
    @GetMapping("/")
    public String home(Model model) {
        model.addAttribute("message", "안녕하세요");  // "message"라는 이름으로 값 전달
        return "home";
    }
}
```

```html
<!-- templates/home.html -->
<p th:text="${message}">기본 텍스트</p>
<!-- 렌더링 결과: <p>안녕하세요</p> -->
```

Thymeleaf가 `${message}`를 Controller에서 전달한 "안녕하세요"로 치환한 후 완성된 HTML을 응답합니다. 사용자가 `http://localhost:8080/home.html`로 직접 접근하면 **404 에러**가 발생합니다. `templates/` 디렉토리의 파일은 반드시 Controller를 경유해야 합니다.

# 10. 주의할 점

---

## 1. 패키지 구조와 @ComponentScan

메인 클래스(`@SpringBootApplication`)보다 상위 패키지나 완전히 다른 패키지에 있는 클래스는 스캔되지 않습니다.

```text
잘못된 구조 (스캔 안 됨):
src/main/java/
├── com/example/blog/
│   └── BlogApplication.java      ← @ComponentScan 시작 (com.example.blog)
└── controller/
    └── HomeController.java        ← com.example.blog 하위가 아님! 스캔 안 됨!

올바른 구조 (스캔됨):
src/main/java/com/example/blog/
├── BlogApplication.java          ← @ComponentScan 시작 (com.example.blog)
└── controller/
    └── HomeController.java        ← com.example.blog.controller → 스캔됨
```

이 실수를 하면 Controller가 Bean으로 등록되지 않아 요청 시 **404 에러**가 발생하지만, 컴파일 에러는 나지 않기 때문에 원인을 찾기 어렵습니다.

## 2. application.properties 키 오타

```properties
# 잘못된 키 (Spring이 인식하지 못함 - 에러도 나지 않음)
spring.datasource.urll=jdbc:h2:mem:blogdb

# 올바른 키
spring.datasource.url=jdbc:h2:mem:blogdb
```

Spring Boot는 인식하지 못하는 키를 **무시**합니다. 에러 메시지 없이 기본값을 사용하기 때문에, 설정이 적용되지 않는 원인을 찾기 어렵습니다. IntelliJ의 자동완성(Ctrl+Space)을 활용하면 오타를 방지할 수 있습니다. 또한 IntelliJ는 인식할 수 없는 키에 노란색 경고를 표시합니다.

## 3. `spring.jpa.hibernate.ddl-auto=create`의 위험성

개발 환경에서는 `create`가 편리하지만, **운영 환경에서 이 옵션을 사용하면 앱 재시작 시 모든 테이블이 삭제(DROP)된 후 다시 생성**됩니다. 기존 데이터가 전부 사라집니다.

```properties
# 개발 환경
spring.jpa.hibernate.ddl-auto=create

# 운영 환경 (반드시 validate 또는 none 사용)
spring.jpa.hibernate.ddl-auto=validate
```

운영 환경에서는 Flyway나 Liquibase 같은 DB 마이그레이션 도구로 스키마를 관리하는 것이 안전합니다.

## 4. H2 콘솔 접속 시 JDBC URL 불일치

H2 웹 콘솔(`http://localhost:8080/h2-console`)에 접속할 때, JDBC URL을 `application.properties`에 설정한 값과 **정확히** 맞춰야 합니다.

```properties
spring.datasource.url=jdbc:h2:mem:blogdb
```

H2 콘솔의 JDBC URL 입력란에 기본값인 `jdbc:h2:~/test`가 아니라, `jdbc:h2:mem:blogdb`를 입력해야 연결됩니다. URL이 다르면 별도의 데이터베이스에 연결되어 테이블이 보이지 않습니다.

## 5. Java 버전 불일치

```bash
./gradlew bootRun

> Task :compileJava FAILED
error: invalid source release: 17
```

시스템의 기본 Java 버전이 17보다 낮을 때 발생합니다.

**확인 방법:**

```bash
java -version          # 시스템 기본 Java 버전 확인
echo $JAVA_HOME        # JAVA_HOME 환경 변수 확인
```

**해결 방법:**
- IntelliJ: Settings → Build Tools → Gradle → Gradle JVM을 Java 17로 설정
- 터미널: `JAVA_HOME` 환경 변수를 Java 17 경로로 설정

```bash
# macOS (Homebrew로 설치한 경우)
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

# 11. 정리

---

| 개념 | 설명 |
|------|------|
| **Spring Initializr** | Spring Boot 프로젝트 구조 자동 생성 도구 |
| **Gradle** | 빌드 자동화 도구. 의존성 관리, 컴파일, 테스트, 배포 |
| **build.gradle** | 플러그인, 의존성, Java 버전 등 프로젝트 빌드 설정 |
| **`@SpringBootApplication`** | `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan` |
| **`@EnableAutoConfiguration`** | 클래스패스의 의존성을 보고 Tomcat, Thymeleaf, JPA 등 자동 설정 |
| **`@ComponentScan`** | 메인 클래스 패키지 기준 하위 패키지에서 `@Controller`, `@Service` 등을 찾아 Bean 등록 |
| **`@Controller`** | ViewResolver를 통해 템플릿 렌더링 (HTML 반환) |
| **`@RestController`** | `@Controller` + `@ResponseBody` (JSON/문자열 직접 반환) |
| **ThymeleafViewResolver** | 뷰 이름 "home" → `classpath:/templates/home.html`로 변환 |
| **application.properties** | Spring Boot가 자동으로 읽는 설정 파일 (DB, 포트, JPA 등) |
| **`static/`** | 정적 파일 (CSS, JS). URL로 직접 접근 가능 |
| **`templates/`** | Thymeleaf 템플릿. Controller를 통해서만 접근 |

```text
핵심:
  Spring Boot = Spring + 자동 설정(Auto-configuration) + 내장 서버
  Gradle = 빌드 + 의존성 관리 도구 (Maven의 대안)
  @SpringBootApplication = 설정(@SpringBootConfiguration)
                         + 자동 설정(@EnableAutoConfiguration)
                         + 컴포넌트 스캔(@ComponentScan)
```

# Reference

---

- [Spring Initializr](https://start.spring.io)
- [Spring Boot 공식 문서 - @SpringBootApplication](https://docs.spring.io/spring-boot/reference/using/using-the-springbootapplication-annotation.html)
- [Spring Boot 공식 문서 - Auto-configuration](https://docs.spring.io/spring-boot/reference/using/auto-configuration.html)
- [Spring Boot 공식 문서 - Web Servlet](https://docs.spring.io/spring-boot/reference/web/servlet.html)
- [Gradle 공식 문서 - Dependency Configurations](https://docs.gradle.org/current/userguide/dependency_configurations.html)
- [Thymeleaf 공식 문서](https://www.thymeleaf.org/documentation.html)
