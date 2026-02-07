---
title: "[Java] 예외 처리 전략 - Checked vs Unchecked, 커스텀 예외 설계"
categories:
  - Java
tags:
  - [Java, Exception, CheckedException, UncheckedException, ErrorHandling]
---

# Introduction

---

Java의 예외 처리는 단순히 try-catch를 쓰는 것이 아니라, **어떤 예외를 어디서 처리할지 설계**하는 것입니다. Checked Exception을 무분별하게 사용하면 코드가 try-catch로 도배되고, Unchecked Exception만 쓰면 어디서 예외가 터질지 예측하기 어렵습니다.

이 글은 Checked와 Unchecked의 차이, 실무에서의 선택 기준, 그리고 커스텀 예외 설계 방법을 정리합니다.

# 1. Java 예외 계층 구조

---

```text
Throwable
├── Error (시스템 레벨, 처리 불가)
│   ├── OutOfMemoryError
│   └── StackOverflowError
│
└── Exception (애플리케이션 레벨)
    ├── Checked Exception (컴파일 타임 강제)
    │   ├── IOException
    │   ├── SQLException
    │   └── ClassNotFoundException
    │
    └── RuntimeException (Unchecked, 런타임)
        ├── NullPointerException
        ├── IllegalArgumentException
        └── IllegalStateException
```

## Error

JVM 레벨의 심각한 문제로, 애플리케이션에서 **처리하면 안 됩니다**.

```java
// ❌ Error를 catch하면 안 됨
try {
    process();
} catch (OutOfMemoryError e) {
    // 메모리가 부족한데 뭘 할 수 있나?
}
```

## Checked vs Unchecked

| 구분 | Checked Exception | Unchecked Exception |
|------|-------------------|---------------------|
| **상속** | Exception | RuntimeException |
| **컴파일 강제** | 반드시 처리/선언 | 선택적 |
| **의도** | 복구 가능한 상황 | 프로그래밍 오류 |
| **예시** | IOException, SQLException | NullPointerException, IllegalArgumentException |

# 2. Checked Exception

---

## 특징

**컴파일러가 예외 처리를 강제**합니다. 처리하거나(`try-catch`) 던지거나(`throws`) 해야 합니다.

```java
public void readFile(String path) throws IOException {  // 선언 필수
    Files.readAllBytes(Paths.get(path));
}

public void caller() {
    try {
        readFile("/tmp/data.txt");
    } catch (IOException e) {
        // 복구 또는 변환
    }
}
```

## 의도

**호출자가 예외 상황을 인지하고 대응해야 할 때** 사용합니다.

```text
- 파일이 없을 수 있다 → FileNotFoundException
- 네트워크가 끊길 수 있다 → IOException
- DB 연결이 실패할 수 있다 → SQLException
```

## 문제점

Checked Exception의 남용은 코드를 오염시킵니다:

```java
// 모든 계층에서 throws 전파
public void controller() throws ServiceException {
    service.process();
}

public void service() throws RepositoryException {
    repository.save();
}

public void repository() throws SQLException {
    // DB 작업
}
```

catch해서 아무것도 안 하거나, 무의미하게 로그만 찍는 경우가 많습니다:

```java
// 안티패턴: 삼키기
try {
    riskyOperation();
} catch (SomeException e) {
    // 무시
}

// 안티패턴: 로그만 찍고 계속 진행
try {
    riskyOperation();
} catch (SomeException e) {
    log.error("에러 발생", e);
    // 상태가 불안정한데 계속 진행?
}
```

# 3. Unchecked Exception (RuntimeException)

---

## 특징

**컴파일러가 처리를 강제하지 않습니다**. 원하면 처리하고, 아니면 상위로 전파됩니다.

```java
public void validateAge(int age) {
    if (age < 0) {
        throw new IllegalArgumentException("나이는 0 이상이어야 합니다: " + age);
    }
}
```

## 의도

**프로그래밍 오류를 나타낼 때** 사용합니다.

```text
- null이 전달됨 → NullPointerException
- 잘못된 인자 → IllegalArgumentException
- 잘못된 상태 → IllegalStateException
- 인덱스 범위 초과 → IndexOutOfBoundsException
```

## 장점

- 코드가 깔끔함 (try-catch 난무 방지)
- 상위 계층에서 일괄 처리 가능 (Spring의 @ExceptionHandler 등)

## 단점

- 어떤 예외가 발생할 수 있는지 API만 봐서는 알기 어려움
- 문서화가 중요

# 4. 선택 기준: Checked vs Unchecked

---

## 현대적 관점

**대부분의 경우 Unchecked Exception을 권장**합니다.

```text
Java 초기 철학:
  "복구 가능한 상황은 Checked로 강제하자"

현실:
  - 대부분의 예외는 복구 불가능
  - Checked는 코드 오염을 유발
  - 상위 계층에서 일괄 처리가 효율적

현대 프레임워크 (Spring, Hibernate):
  - 거의 모든 예외를 Unchecked로 래핑
  - SQLException → DataAccessException (Unchecked)
```

## 선택 가이드

```text
Checked Exception을 쓸 때:
  - 호출자가 반드시 이 예외를 알아야 할 때
  - 복구 가능한 비즈니스 로직이 있을 때
  - API 사용자가 대응 방법을 알 때

Unchecked Exception을 쓸 때:
  - 프로그래밍 오류 (잘못된 인자, 상태)
  - 복구가 불가능하거나 의미 없을 때
  - 상위에서 일괄 처리할 때
```

## Spring 환경에서의 권장

```java
// Service 레이어: Unchecked 사용
public class UserService {
    public User findById(Long id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new UserNotFoundException("사용자 없음: " + id));
    }
}

// Controller에서 일괄 처리
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(UserNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(UserNotFoundException e) {
        return ResponseEntity.status(404).body(new ErrorResponse(e.getMessage()));
    }
}
```

# 5. 커스텀 예외 설계

---

## 기본 구조

```java
public class UserNotFoundException extends RuntimeException {

    private final Long userId;

    public UserNotFoundException(Long userId) {
        super("사용자를 찾을 수 없습니다: " + userId);
        this.userId = userId;
    }

    public UserNotFoundException(Long userId, Throwable cause) {
        super("사용자를 찾을 수 없습니다: " + userId, cause);
        this.userId = userId;
    }

    public Long getUserId() {
        return userId;
    }
}
```

## 예외 계층 설계

```java
// 도메인별 베이스 예외
public abstract class DomainException extends RuntimeException {
    private final ErrorCode errorCode;

    protected DomainException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public ErrorCode getErrorCode() {
        return errorCode;
    }
}

// 구체적인 예외
public class UserNotFoundException extends DomainException {
    public UserNotFoundException(Long id) {
        super(ErrorCode.USER_NOT_FOUND, "사용자 없음: " + id);
    }
}

public class InsufficientBalanceException extends DomainException {
    public InsufficientBalanceException(BigDecimal required, BigDecimal actual) {
        super(ErrorCode.INSUFFICIENT_BALANCE,
              String.format("잔액 부족: 필요 %s, 현재 %s", required, actual));
    }
}
```

## 에러 코드 enum

```java
public enum ErrorCode {
    // 사용자 관련
    USER_NOT_FOUND("U001", "사용자를 찾을 수 없습니다"),
    USER_ALREADY_EXISTS("U002", "이미 존재하는 사용자입니다"),

    // 주문 관련
    ORDER_NOT_FOUND("O001", "주문을 찾을 수 없습니다"),
    INSUFFICIENT_BALANCE("O002", "잔액이 부족합니다"),

    // 시스템
    INTERNAL_ERROR("S001", "내부 서버 오류");

    private final String code;
    private final String message;

    ErrorCode(String code, String message) {
        this.code = code;
        this.message = message;
    }

    public String getCode() { return code; }
    public String getMessage() { return message; }
}
```

# 6. 예외 처리 패턴

---

## 패턴 1: 변환 후 재던지기

```java
try {
    externalApi.call();
} catch (ExternalApiException e) {
    throw new ServiceException("외부 API 호출 실패", e);  // cause 보존
}
```

원본 예외를 cause로 보존하면 스택 트레이스가 유지됩니다.

## 패턴 2: 예외를 값으로 변환

```java
public Optional<User> findUserSafely(Long id) {
    try {
        return Optional.of(findUser(id));
    } catch (UserNotFoundException e) {
        return Optional.empty();
    }
}
```

예외 대신 Optional, Either, Result 같은 타입으로 반환하면 흐름 제어에 예외를 사용하지 않습니다.

## 패턴 3: try-with-resources

```java
// 리소스 자동 정리
try (Connection conn = dataSource.getConnection();
     PreparedStatement stmt = conn.prepareStatement(sql)) {

    stmt.executeUpdate();

} catch (SQLException e) {
    throw new DataAccessException("DB 작업 실패", e);
}
```

## 패턴 4: 일괄 처리 (Spring)

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ErrorResponse> handleDomain(DomainException e) {
        ErrorCode code = e.getErrorCode();
        return ResponseEntity
            .status(mapToHttpStatus(code))
            .body(new ErrorResponse(code.getCode(), e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnknown(Exception e) {
        log.error("예상치 못한 오류", e);
        return ResponseEntity
            .status(500)
            .body(new ErrorResponse("S001", "내부 서버 오류"));
    }
}
```

# 7. 안티패턴

---

## ❌ 예외 삼키기

```java
try {
    process();
} catch (Exception e) {
    // 아무것도 안 함
}
```

## ❌ catch (Exception e)

```java
// 모든 예외를 잡음 → 예상치 못한 예외도 삼킴
try {
    process();
} catch (Exception e) {
    log.error("에러", e);
}
```

가능하면 구체적인 예외 타입을 catch하세요.

## ❌ 흐름 제어에 예외 사용

```java
// 예외를 if-else처럼 사용
try {
    findUser(id);
    return true;
} catch (UserNotFoundException e) {
    return false;
}

// 더 나은 방법
return userRepository.existsById(id);
```

## ❌ 스택 트레이스 무시

```java
// 원인 정보 유실
catch (SQLException e) {
    throw new ServiceException("DB 오류");  // cause 없음!
}

// 올바른 방법
catch (SQLException e) {
    throw new ServiceException("DB 오류", e);  // cause 보존
}
```

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Checked** | 컴파일 강제, 복구 가능한 상황 (현대에는 지양) |
| **Unchecked** | 런타임, 프로그래밍 오류 또는 일괄 처리 |
| **커스텀 예외** | 도메인별 의미 있는 예외 + 에러 코드 |
| **예외 변환** | 하위 예외를 상위 예외로 래핑 (cause 보존) |
| **일괄 처리** | @ExceptionHandler로 상위에서 처리 |

```text
핵심:
  현대 Java에서는 Unchecked Exception을 선호.
  예외는 복구가 아니라 "실패 알림"으로 사용.
  커스텀 예외 + 에러 코드 + 일괄 처리가 실무 패턴.
  cause 보존, 구체적 예외 타입 catch가 중요.
```

# Reference

---

- [Effective Java 3rd - Item 70~77](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)
- [Java Exception Handling Best Practices](https://www.baeldung.com/java-exceptions)
- [Spring Exception Handling](https://www.baeldung.com/exception-handling-for-rest-with-spring)
