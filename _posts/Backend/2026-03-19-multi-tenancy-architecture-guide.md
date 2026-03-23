---
layout: single
title: "멀티테넌시(Multi-Tenancy) 아키텍처 완전 가이드 — SaaS를 위한 3가지 전략과 실무 선택 기준"
categories:
  - Backend
tags: [Multi-Tenancy, Architecture, SaaS, Spring Boot, Hibernate, PostgreSQL]
---

## Introduction

---

SaaS(Software as a Service) 서비스를 개발하다 보면 반드시 마주치게 되는 질문이 있다. "고객사(테넌트)마다 데이터를 어떻게 분리해서 저장할까?" 이 질문에 대한 답이 바로 **멀티테넌시(Multi-Tenancy) 아키텍처**다.

이 글에서는 멀티테넌시의 개념부터, 실무에서 사용하는 3가지 구현 전략의 장단점, Spring Boot 3.x + Hibernate 6.x에서의 구현 방법, 그리고 어떤 상황에서 어떤 전략을 선택해야 하는지까지 정리한다.

이 글을 읽고 나면 다음을 할 수 있다:
- 멀티테넌시의 3가지 전략(Database per Tenant, Schema per Tenant, Shared DB)의 차이를 설명할 수 있다.
- Spring Boot에서 각 전략을 구현하는 핵심 코드를 작성할 수 있다.
- 프로젝트 상황에 맞는 전략을 선택하는 판단 기준을 갖출 수 있다.

### 사전 지식

이 글은 다음 개념에 대한 기본적인 이해를 전제로 한다:
- Spring Boot 기본 구조 (Controller, Service, Repository)
- JPA/Hibernate 기초 (Entity, Session, Transaction)
- 관계형 DB 기초 (스키마, 테이블, 인덱스)

코드 예제는 **Spring Boot 3.x + Hibernate 6.4+ + PostgreSQL** 기준이다.

## 배경 -- 멀티테넌시란 무엇인가

---

### 테넌트(Tenant)란?

"테넌트"는 SaaS 서비스를 이용하는 **고객사(조직)** 를 의미한다. 예를 들어 Slack을 쓰는 회사 A와 회사 B는 각각 하나의 테넌트다. 두 회사는 같은 Slack 서버에서 서비스를 받지만, 서로의 채팅 내용은 절대 볼 수 없다.

### 싱글테넌시 vs 멀티테넌시

| 구분 | 싱글테넌시 (Single-Tenancy) | 멀티테넌시 (Multi-Tenancy) |
|------|---------------------------|--------------------------|
| 인프라 | 고객마다 별도 서버/DB | 여러 고객이 인프라 공유 |
| 비용 | 높음 | 낮음 (공유 비용) |
| 격리 수준 | 완전 격리 | 논리적 격리 |
| 운영 복잡도 | 고객 수만큼 증가 | 한 곳에서 관리 |
| 대표 사례 | 온프레미스 엔터프라이즈 SW | Slack, Notion, Jira (Cloud) |

싱글테넌시는 각 고객마다 서버를 따로 띄워주는 방식이다. 격리는 완벽하지만, 고객이 100명이면 서버도 100개가 필요하다. 멀티테넌시는 하나의 애플리케이션이 여러 고객을 동시에 서비스하되, 데이터는 논리적으로 분리한다.

### 왜 멀티테넌시가 필요한가

SaaS 서비스를 운영할 때 고객마다 별도 인프라를 운영하면 비용이 폭발적으로 증가한다. 멀티테넌시는 이를 해결하기 위한 표준 아키텍처 패턴이다.

- **비용 절감**: 인프라를 공유하므로 고객당 운영 비용이 낮아진다.
- **운영 효율**: 배포, 모니터링, 유지보수를 한 곳에서 처리한다.
- **확장성**: 새 고객 온보딩 시 서버 증설 없이 테넌트 계정만 추가하면 된다.

## 멀티테넌시 구현 전략 3가지

---

데이터 격리 수준에 따라 크게 3가지 전략으로 나뉜다. 각 전략을 구체적으로 살펴보자.

### 전략 1: Database per Tenant (테넌트별 독립 DB)

```
[App Server]
    |
    |--- tenant_a DB
    |--- tenant_b DB
    |--- tenant_c DB
```

고객마다 완전히 별도의 데이터베이스 인스턴스(또는 논리적 데이터베이스)를 할당하는 방식이다.

**장점**
- 데이터 격리가 완전하다. 한 테넌트의 쿼리가 다른 테넌트에 영향을 줄 수 없다.
- 테넌트별 백업/복구가 독립적으로 가능하다.
- 컴플라이언스 요구사항(GDPR, 개인정보 처리 등)을 만족시키기 쉽다.
- 테넌트별 DB 설정(인덱스, 파티션 등) 커스터마이징이 가능하다.

**단점**
- 테넌트 수가 늘어날수록 DB 연결 수가 급증한다. DB 커넥션 풀 관리가 복잡해진다.
- 스키마 마이그레이션 시 모든 DB에 순서대로 적용해야 한다.
- 인프라 비용이 상대적으로 높다.

**적합한 상황**
- 의료, 금융 등 규제 산업에서 법적으로 데이터 격리가 요구될 때
- 대형 엔터프라이즈 고객이 계약 조건으로 전용 DB를 요구할 때
- 테넌트 수가 수십 개 이내로 제한적일 때

### 전략 2: Schema per Tenant (테넌트별 스키마 분리)

```
[App Server]
    |
    [단일 DB 인스턴스]
        |--- schema: tenant_a (users, orders, ...)
        |--- schema: tenant_b (users, orders, ...)
        |--- schema: tenant_c (users, orders, ...)
```

PostgreSQL의 스키마(Schema)나 MySQL의 데이터베이스(Database)를 테넌트마다 분리하는 방식이다. 하나의 DB 인스턴스를 공유하되, 논리적 네임스페이스를 분리한다.

**장점**
- 전략 1보다 인프라 비용이 낮다 (하나의 DB 인스턴스 공유).
- 스키마 수준의 데이터 격리가 가능하다.
- SQL에서 `search_path`(PostgreSQL) 또는 `USE`(MySQL)로 테넌트 전환이 간단하다.

**단점**
- 테넌트가 수천 개가 되면 스키마 수도 수천 개가 되어 관리가 어렵다.
- 스키마 마이그레이션 시 모든 스키마에 적용해야 하므로 시간이 오래 걸릴 수 있다.
- DB 인스턴스를 공유하므로 Noisy Neighbor 문제(아래 설명)가 발생할 수 있다.

**적합한 상황**
- 중간 규모 SaaS (테넌트 수 수십~수백 개)
- 테넌트 간 데이터 격리가 중요하지만 전용 DB까지는 불필요한 경우
- PostgreSQL을 사용하는 경우 (스키마 기능이 강력)

### 전략 3: Shared Database with Tenant ID (공유 DB + 테넌트 식별자)

```
[App Server]
    |
    [단일 DB 인스턴스, 단일 스키마]
        users 테이블: | tenant_id | user_id | name | ...
        orders 테이블: | tenant_id | order_id | amount | ...
```

모든 테넌트가 같은 테이블을 공유하고, `tenant_id` 컬럼으로 데이터를 구분하는 방식이다. 가장 단순하지만 가장 주의가 필요하다.

**장점**
- 구현이 가장 단순하다.
- 스키마 마이그레이션이 한 번만 적용하면 된다.
- 인프라 비용이 가장 낮다.
- 테넌트 수에 제한이 없다.

**단점**
- 모든 쿼리에 `WHERE tenant_id = ?` 조건을 반드시 포함해야 한다. 실수로 누락하면 데이터 유출 사고가 발생한다.
- 특정 테넌트의 대용량 쿼리가 전체 성능에 영향을 준다 (Noisy Neighbor).
- 테넌트별 개별 백업/복구가 어렵다.
- 테넌트 데이터 삭제 시 전체 테이블에서 `DELETE WHERE tenant_id = ?`를 실행해야 한다.

**적합한 상황**
- 스타트업 초기 단계, 빠른 출시가 우선일 때
- 테넌트 수가 매우 많고(수천 개 이상) 각 테넌트의 데이터량이 적을 때
- 테넌트 간 데이터 격리 요구사항이 낮을 때

## 실무에서의 고려사항

---

### 데이터 격리와 보안

멀티테넌시의 가장 큰 리스크는 **테넌트 간 데이터 유출**이다. 특히 전략 3(공유 DB)에서는 코드 버그 하나로 다른 고객의 데이터가 노출될 수 있다.

실무에서 많이 쓰는 방어 패턴:

**1. Row Level Security (RLS) -- PostgreSQL**

DB 수준에서 `tenant_id` 필터를 강제한다. 애플리케이션 코드에서 실수로 조건을 빠뜨려도 DB가 차단한다.

```sql
-- 1) 테이블에 RLS 활성화
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 2) 현재 세션의 tenant_id와 일치하는 행만 접근 허용하는 정책 생성
CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.current_tenant')::TEXT);

-- 3) 애플리케이션에서 커넥션 획득 후, 세션 변수에 테넌트 ID 설정
SET app.current_tenant = 'tenant_a';

-- 이후 실행되는 모든 쿼리에 tenant_id 조건이 자동 적용된다
SELECT * FROM orders;  -- tenant_a의 주문만 반환
```

RLS는 DB 수준의 안전망이다. `WHERE tenant_id = ?`를 빠뜨려도 다른 테넌트의 데이터가 노출되지 않는다. 다만 RLS만 믿고 애플리케이션 코드에서 필터링을 생략하는 것은 권장하지 않는다. 두 겹의 방어(Application + DB)가 안전하다.

**2. Hibernate @TenantId (Hibernate 6.x 신규)**

Hibernate 6부터 도입된 `@TenantId` 어노테이션을 사용하면 엔티티에 테넌트 식별 컬럼을 선언하여, 세션 내에서 자동으로 해당 테넌트의 데이터만 조회되도록 필터링할 수 있다. 이 방식은 전략 3(Discriminator 기반)에 해당한다.

```java
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import org.hibernate.annotations.TenantId;

@Entity
public class Order {

    @Id
    private Long id;

    // Hibernate가 세션의 테넌트 ID로 자동 필터링한다.
    // INSERT 시에도 현재 테넌트 ID가 자동으로 설정된다.
    @TenantId
    private String tenantId;

    private String productName;
    private int amount;

    // getter/setter 생략
}
```

`@TenantId`를 사용하면 JPQL/HQL 쿼리에 `WHERE tenant_id = ?`를 직접 작성하지 않아도 Hibernate가 자동으로 추가한다. 단, **네이티브 SQL 쿼리에는 자동 필터링이 적용되지 않으므로** 직접 조건을 추가해야 한다.

**3. 인터셉터/AOP**

서비스 레이어에서 현재 테넌트 컨텍스트를 검증하는 AOP를 적용하는 방식이다. 요청 진입 시점에 테넌트 ID를 검증하고, 존재하지 않는 테넌트이면 요청을 차단한다.

### Noisy Neighbor 문제

공유 DB 환경에서 특정 테넌트가 대량의 쿼리를 실행하면 다른 테넌트의 응답 속도가 느려지는 현상이다. 이를 해결하는 방법:

- 테넌트별 쿼리 실행 시간 모니터링
- Rate limiting (테넌트별 API 호출량 제한)
- 대용량 테넌트를 별도 DB로 마이그레이션 (하이브리드 전략)
- DB 커넥션 풀을 테넌트별로 분리하거나 가중치 적용

### 스케일링 전략

멀티테넌시에서 스케일링은 "어떤 테넌트의 어떤 데이터를 어디로 분산할 것인가"의 문제다.

**수평 확장**: 대형 테넌트는 전용 DB로 이전하고, 소형 테넌트는 공유 DB에 유지하는 **하이브리드 전략**이 실용적이다. AWS RDS + Aurora Serverless 조합으로 테넌트별 트래픽에 자동 대응하는 방식도 많이 쓰인다.

**읽기 분산**: 테넌트별 Read Replica를 구성하거나, 읽기 트래픽이 많은 테넌트만 선별적으로 캐싱(Redis)을 강화한다.

### 스키마 마이그레이션 관리

전략 1, 2에서 스키마 변경은 모든 테넌트 DB/스키마에 순차적으로 적용해야 한다. 실무에서는 Flyway나 Liquibase를 사용하되, 테넌트별로 마이그레이션을 추적하는 별도 메타데이터 테이블을 관리한다.

주의할 점:
- 마이그레이션 중 서비스 중단을 피하려면 Backward-compatible 스키마 변경(컬럼 추가 후 데이터 이전 후 기존 컬럼 삭제)을 단계적으로 진행해야 한다.
- 테넌트 수가 많으면 마이그레이션 완료까지 시간이 오래 걸린다. 비동기 마이그레이션 파이프라인을 고려해야 한다.

## Spring Boot 3.x + Hibernate 6.x 멀티테넌시 구현

---

Hibernate 6.x에서는 멀티테넌시 API가 크게 변경되었다. **Hibernate 5.x에서 사용하던 `MultiTenancyStrategy` 열거형과 `hibernate.multiTenancy` 설정 프로퍼티는 Hibernate 6.0에서 제거되었다.** 전략은 더 이상 명시적으로 선언하지 않고, 어떤 빈(Bean)을 등록하느냐에 따라 자동으로 결정된다.

Hibernate 6.x 멀티테넌시의 핵심 인터페이스:

| 인터페이스 | 역할 | 대상 전략 |
|-----------|------|----------|
| `MultiTenantConnectionProvider` | 테넌트별 DB 연결 제공 | 전략 1 (Database per Tenant) |
| `CurrentTenantIdentifierResolver` | 현재 요청의 테넌트 ID 결정 | 모든 전략 공통 |
| `TenantSchemaMapper` | 테넌트 ID를 스키마 이름으로 매핑 | 전략 2 (Schema per Tenant) |
| `@TenantId` 어노테이션 | 엔티티에 테넌트 식별 컬럼 선언 | 전략 3 (Discriminator) |

> **Spring Boot 3.x 참고**: Spring Boot는 Hibernate의 `BeanContainer`를 자동 구성한다. 따라서 위 인터페이스의 구현체를 `@Component`로 등록하면 Hibernate가 자동으로 감지한다. `application.yml`에 프로퍼티를 직접 설정하지 않아도 되는 경우가 많다.

아래는 **Schema per Tenant** 전략을 기준으로 한 구현 예시다.

### 1단계: 테넌트 컨텍스트 홀더

```java
// TenantContext.java
// ThreadLocal을 사용해 HTTP 요청 스레드마다 독립적인 테넌트 ID를 보관한다.
public class TenantContext {

    private static final ThreadLocal<String> CURRENT_TENANT = new ThreadLocal<>();

    public static void setTenant(String tenantId) {
        CURRENT_TENANT.set(tenantId);
    }

    public static String getTenant() {
        return CURRENT_TENANT.get();
    }

    // 반드시 요청 완료 시 호출해야 한다. 누락하면 스레드 풀에서 테넌트 오염이 발생한다.
    public static void clear() {
        CURRENT_TENANT.remove();
    }
}
```

### 2단계: 테넌트 ID 결정자 (CurrentTenantIdentifierResolver)

```java
import org.hibernate.context.spi.CurrentTenantIdentifierResolver;
import org.springframework.stereotype.Component;

// Spring Bean으로 등록하면 Hibernate가 BeanContainer를 통해 자동 감지한다.
@Component
public class TenantIdentifierResolver
        implements CurrentTenantIdentifierResolver<String> {

    private static final String DEFAULT_TENANT = "public";

    @Override
    public String resolveCurrentTenantIdentifier() {
        // TenantContext에서 현재 스레드의 테넌트 ID를 가져온다.
        String tenantId = TenantContext.getTenant();
        return (tenantId != null) ? tenantId : DEFAULT_TENANT;
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        // true로 설정하면 기존 세션이 현재 테넌트와 일치하는지 검증한다.
        return true;
    }
}
```

### 3단계: 테넌트별 커넥션 제공자 (MultiTenantConnectionProvider)

Schema per Tenant에서는 `MultiTenantConnectionProvider` 대신 `TenantSchemaMapper`를 사용하는 방법도 있지만, 커넥션 단위로 `search_path`를 전환하는 전통적 방식이 여전히 널리 쓰인다.

```java
import org.hibernate.engine.jdbc.connections.spi.MultiTenantConnectionProvider;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.regex.Pattern;

@Component
public class SchemaBasedConnectionProvider
        implements MultiTenantConnectionProvider<String> {

    // 테넌트 ID 화이트리스트 패턴: 영소문자, 숫자, 언더스코어만 허용
    private static final Pattern TENANT_ID_PATTERN =
            Pattern.compile("^[a-z0-9_]+$");

    private final DataSource dataSource;

    public SchemaBasedConnectionProvider(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    @Override
    public Connection getAnyConnection() throws SQLException {
        // Hibernate 초기화 시 메타데이터 조회용으로 사용된다.
        // 테넌트와 무관한 기본 커넥션을 반환한다.
        return dataSource.getConnection();
    }

    @Override
    public void releaseAnyConnection(Connection connection) throws SQLException {
        connection.close();
    }

    @Override
    public Connection getConnection(String tenantId) throws SQLException {
        // SQL Injection 방어: 테넌트 ID 형식을 검증한다.
        validateTenantId(tenantId);

        Connection connection = getAnyConnection();
        // PostgreSQL: search_path를 테넌트 스키마로 전환한다.
        connection.createStatement()
                .execute("SET search_path TO " + tenantId + ", public");
        return connection;
    }

    @Override
    public void releaseConnection(String tenantId, Connection connection)
            throws SQLException {
        // 커넥션을 풀에 반환하기 전에 search_path를 기본값으로 복원한다.
        connection.createStatement()
                .execute("SET search_path TO public");
        connection.close();
    }

    @Override
    public boolean supportsAggressiveRelease() {
        return false;
    }

    @Override
    public boolean isUnwrappableAs(Class<?> unwrapType) {
        return false;
    }

    @Override
    public <T> T unwrap(Class<T> unwrapType) {
        throw new UnsupportedOperationException("Cannot unwrap to " + unwrapType);
    }

    private void validateTenantId(String tenantId) {
        if (tenantId == null || !TENANT_ID_PATTERN.matcher(tenantId).matches()) {
            throw new IllegalArgumentException(
                    "Invalid tenant ID: " + tenantId
                    + ". Only lowercase letters, numbers, and underscores are allowed.");
        }
    }
}
```

> **SQL Injection 주의**: `SET search_path TO {tenantId}` 구문에 사용자 입력이 직접 들어간다. 반드시 정규식 검증이나 화이트리스트 방식으로 테넌트 ID 형식을 강제해야 한다. 위 코드에서는 `^[a-z0-9_]+$` 패턴으로 제한하고 있다.

### 4단계: Hibernate 설정 (application.yml)

Spring Boot 3.x에서는 `MultiTenantConnectionProvider`와 `CurrentTenantIdentifierResolver` 구현체를 `@Component`로 등록하면 Spring Boot의 Hibernate 자동 구성이 이를 감지한다. 별도의 Java Config 없이 `application.yml`로 설정할 수 있다.

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/myapp
    username: myapp_user
    password: ${DB_PASSWORD}
    driver-class-name: org.postgresql.Driver
  jpa:
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        # CurrentTenantIdentifierResolver 구현체를 직접 지정할 수도 있다.
        # @Component로 등록한 경우 BeanContainer가 자동 감지하므로 생략 가능하다.
        # tenant_identifier_resolver: com.example.TenantIdentifierResolver
        # multi_tenant_connection_provider: com.example.SchemaBasedConnectionProvider
        show_sql: true
        format_sql: true
```

만약 자동 감지가 동작하지 않는 환경이거나 세밀한 제어가 필요하다면, `HibernatePropertiesCustomizer`를 사용한다:

```java
import org.hibernate.cfg.AvailableSettings;
import org.springframework.boot.autoconfigure.orm.jpa.HibernatePropertiesCustomizer;
import org.springframework.stereotype.Component;

import java.util.Map;

@Component
public class HibernateMultiTenancyConfig implements HibernatePropertiesCustomizer {

    private final SchemaBasedConnectionProvider connectionProvider;
    private final TenantIdentifierResolver tenantResolver;

    public HibernateMultiTenancyConfig(
            SchemaBasedConnectionProvider connectionProvider,
            TenantIdentifierResolver tenantResolver) {
        this.connectionProvider = connectionProvider;
        this.tenantResolver = tenantResolver;
    }

    @Override
    public void customize(Map<String, Object> hibernateProperties) {
        hibernateProperties.put(
                AvailableSettings.MULTI_TENANT_CONNECTION_PROVIDER,
                connectionProvider);
        hibernateProperties.put(
                AvailableSettings.MULTI_TENANT_IDENTIFIER_RESOLVER,
                tenantResolver);
    }
}
```

### 5단계: HTTP 요청에서 테넌트 식별

```java
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class TenantInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request,
            HttpServletResponse response, Object handler) {

        // 1순위: HTTP 헤더에서 테넌트 ID 추출
        String tenantId = request.getHeader("X-Tenant-ID");

        // 2순위: 서브도메인에서 추출 (예: company-a.myapp.com -> company_a)
        if (tenantId == null || tenantId.isBlank()) {
            tenantId = extractTenantFromSubdomain(request.getServerName());
        }

        // 테넌트 ID가 없으면 요청을 거부한다.
        if (tenantId == null || tenantId.isBlank()) {
            response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            return false;
        }

        TenantContext.setTenant(tenantId);
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request,
            HttpServletResponse response, Object handler, Exception ex) {
        // 반드시 정리해야 메모리 누수와 테넌트 오염을 방지한다.
        TenantContext.clear();
    }

    private String extractTenantFromSubdomain(String serverName) {
        // company-a.myapp.com -> company_a (하이픈을 언더스코어로 변환)
        String subdomain = serverName.split("\\.")[0];
        return subdomain.replace("-", "_");
    }
}
```

인터셉터를 `WebMvcConfigurer`에 등록하는 것을 잊지 말자:

```java
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final TenantInterceptor tenantInterceptor;

    public WebConfig(TenantInterceptor tenantInterceptor) {
        this.tenantInterceptor = tenantInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(tenantInterceptor)
                .addPathPatterns("/api/**")        // API 경로만 적용
                .excludePathPatterns("/api/health"); // 헬스체크는 제외
    }
}
```

## 자주 만나는 함정과 트러블슈팅

---

### ThreadLocal 누수 (가장 흔한 실수)

`TenantContext.clear()`를 빠뜨리면 톰캣 스레드 풀에서 테넌트 ID가 재사용된다. 테넌트 A의 스레드가 풀에 반환된 후 테넌트 B의 요청을 처리할 때 A의 ID가 남아 있으면 **데이터 유출 사고**가 발생한다.

**증상**: 간헐적으로 다른 테넌트의 데이터가 조회된다. 로컬에서는 재현되지 않고 운영 환경(스레드 풀 사용)에서만 나타나는 경우가 많다.

**해결**: 반드시 `afterCompletion`에서 `TenantContext.clear()`를 호출한다. 추가로 `@TenantId` + RLS 조합으로 다중 안전망을 구축하면 더 안전하다.

### SET search_path SQL Injection

`SET search_path TO {tenantId}` 구문에서 테넌트 ID를 검증 없이 삽입하면, 악의적인 테넌트 ID(`'; DROP TABLE users; --`)로 SQL Injection이 가능하다.

**해결**: 테넌트 ID를 `^[a-z0-9_]+$` 정규식으로 검증하거나, DB에 등록된 테넌트 목록과 대조하는 화이트리스트 방식을 사용한다.

### Noisy Neighbor 탐지 지연

공유 DB에서 특정 테넌트가 성능 문제를 일으켜도 즉시 탐지하기 어렵다.

**해결**: APM(Application Performance Monitoring) 도구에서 테넌트 ID를 태그로 붙여 모니터링한다. MDC(Mapped Diagnostic Context)에 테넌트 ID를 넣으면 로그에서도 테넌트별 분석이 가능하다.

```java
// MDC에 테넌트 ID를 설정하는 예시 (TenantInterceptor.preHandle에 추가)
import org.slf4j.MDC;

MDC.put("tenantId", tenantId);
// afterCompletion에서
MDC.remove("tenantId");
```

### 마이그레이션 롤백 계획

전략 전환(예: Shared DB -> Schema per Tenant)은 대규모 데이터 이전 작업이 필요하다. 초기에 전략을 잘못 선택하면 나중에 변경 비용이 매우 크다. 아래의 의사결정 가이드를 참고하여 신중하게 선택하자.

### 네이티브 SQL 쿼리에서 @TenantId 미적용

Hibernate의 `@TenantId`는 JPQL/HQL 쿼리에만 자동 필터링을 적용한다. **네이티브 SQL 쿼리(`@Query(nativeQuery = true)`)에서는 `WHERE tenant_id = ?` 조건을 직접 추가해야 한다.** 이를 놓치면 전체 테넌트의 데이터가 조회된다.

## 어떤 전략을 선택해야 하는가

---

아래 의사결정 흐름을 참고하자.

```
테넌트 수가 수천 개 이상이고 데이터량이 적은가?
  -> YES: 전략 3 (Shared DB + Tenant ID)

법적/계약상 완전한 데이터 격리가 필요한가?
  -> YES: 전략 1 (Database per Tenant)

그 외 (중간 규모, 적당한 격리 필요):
  -> 전략 2 (Schema per Tenant)
```

실무에서는 단일 전략을 고집하기보다 **하이브리드 접근**이 많다. 예를 들어:
- 대부분의 중소 테넌트: 전략 3 (공유 DB)
- 대형 엔터프라이즈 테넌트 또는 금융/의료 고객: 전략 1 (전용 DB)

Notion, Slack, Atlassian 같은 대형 SaaS도 처음에는 단순한 공유 DB로 시작했다가, 엔터프라이즈 수요가 생기면서 하이브리드 모델로 전환한 사례가 많다. 따라서 **초기에는 전략 3으로 빠르게 출시하고, 요구사항이 생기면 선별적으로 격리 수준을 높이는 방향**이 현실적이다.

### 전략 비교 요약표

| 선택 기준 | 전략 1: DB per Tenant | 전략 2: Schema per Tenant | 전략 3: Shared DB |
|----------|----------------------|--------------------------|-------------------|
| 테넌트 수 | ~수십 | ~수백 | 수천 이상 |
| 격리 수준 | 최강 (물리적 분리) | 중간 (논리적 분리) | 약함 (행 수준) |
| 구현 복잡도 | 높음 | 중간 | 낮음 |
| 인프라 비용 | 높음 | 중간 | 낮음 |
| 마이그레이션 | 복잡 (N개 DB 적용) | 복잡 (N개 스키마 적용) | 단순 (1회 적용) |
| 규제 대응 | 용이 | 보통 | 어려움 |
| Hibernate 구현 | `MultiTenantConnectionProvider` | `TenantSchemaMapper` 또는 `MultiTenantConnectionProvider` | `@TenantId` |

## 정리

---

- 멀티테넌시는 SaaS 서비스에서 여러 고객의 데이터를 논리적으로 분리하는 아키텍처 패턴이다.
- 3가지 전략(DB 분리 / 스키마 분리 / 공유 DB + Tenant ID)은 격리 수준과 운영 비용의 트레이드오프 관계다.
- Hibernate 6.x에서는 `MultiTenancyStrategy` 열거형이 제거되었다. 대신 `MultiTenantConnectionProvider`, `TenantSchemaMapper`, `@TenantId` 등 구현체를 등록하면 전략이 자동으로 결정된다.
- Spring Boot 3.x에서는 `@Component`로 등록한 구현체를 `BeanContainer`가 자동 감지하므로 설정이 간결해졌다.
- 전략 3을 사용할 때는 반드시 다중 안전망(Application 레이어 필터 + `@TenantId` + PostgreSQL RLS)을 구축해야 한다.
- 초기에는 전략 3으로 시작하고, 필요에 따라 하이브리드로 전환하는 것이 실용적이다.

## 다음 단계

---

멀티테넌시 아키텍처를 실제로 도입할 때 이어서 학습하면 좋은 주제들:

- **Flyway + 멀티테넌시**: 테넌트별 스키마 마이그레이션 자동화
- **Row Level Security (PostgreSQL)**: DB 레벨에서 테넌트 격리 강제
- **Spring Security + 테넌트 컨텍스트**: 인증/인가와 멀티테넌시 통합
- **관찰 가능성(Observability)**: 테넌트 ID를 MDC에 넣어 로그/트레이스 추적
- **@TenantId 심화**: Discriminator 기반 멀티테넌시의 제약사항과 네이티브 쿼리 처리

## Reference

---

- [Hibernate ORM User Guide - Multi-tenancy](https://docs.jboss.org/hibernate/orm/6.4/userguide/html_single/Hibernate_User_Guide.html#multitenacy)
- [Hibernate 6 Introduction - Multi-tenancy (Advanced)](https://docs.jboss.org/hibernate/orm/6.4/introduction/html_single/Hibernate_Introduction.html#multitenancy)
- [Hibernate 6.0 Migration Guide - MultiTenancyStrategy 제거](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html)
- [Spring Boot - Configure JPA Properties](https://docs.spring.io/spring-boot/how-to/data-access.html#howto.data-access.configure-jpa-properties)
- [PostgreSQL Row Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Martin Fowler - Multi-tenancy](https://martinfowler.com/bliki/SaasMultiTenancy.html)
