---
title: "[Java] Optional 제대로 쓰기 - null 안전하게 다루기"
categories:
  - Java
tags:
  - [Java, Optional, NullPointerException, FunctionalProgramming]
---

# Introduction

---

Java 개발자라면 `NullPointerException`을 수없이 마주했을 것입니다. Java 8에서 도입된 `Optional`은 **"값이 있을 수도, 없을 수도 있다"**를 타입으로 표현하여 null 체크를 강제합니다. 하지만 Optional을 잘못 사용하면 오히려 코드가 복잡해지거나, Optional 자체가 null이 되는 아이러니한 상황이 발생합니다.

이 글은 Optional의 올바른 사용법과 실무에서 자주 보이는 안티패턴을 정리합니다.

# 1. Optional이란?

---

**값이 존재하거나 존재하지 않을 수 있음**을 명시적으로 표현하는 컨테이너 클래스입니다.

```java
// 기존: null 반환 → 호출자가 null 체크를 잊을 수 있음
public User findUserById(Long id) {
    return userRepository.findById(id);  // null 가능
}

// Optional: 반환 타입에서 "없을 수 있음"이 명시됨
public Optional<User> findUserById(Long id) {
    return Optional.ofNullable(userRepository.findById(id));
}
```

호출자는 `Optional`을 받으면 반드시 값의 존재 여부를 처리해야 합니다.

# 2. Optional 생성

---

## Optional.of() - null이 아님을 확신할 때

```java
String name = "홍길동";
Optional<String> opt = Optional.of(name);  // OK

String nullName = null;
Optional<String> opt2 = Optional.of(nullName);  // NullPointerException!
```

## Optional.ofNullable() - null일 수 있을 때

```java
String name = getName();  // null 가능
Optional<String> opt = Optional.ofNullable(name);  // 안전
```

## Optional.empty() - 빈 Optional

```java
Optional<String> empty = Optional.empty();
```

## 선택 기준

```text
확실히 null이 아님 → Optional.of()
null일 수 있음     → Optional.ofNullable()
명시적으로 비어있음 → Optional.empty()
```

# 3. Optional 값 추출

---

## get() - 사용 금지

```java
Optional<String> opt = Optional.empty();
String value = opt.get();  // NoSuchElementException!
```

`get()`은 값이 없으면 예외가 발생합니다. 사실상 null 체크를 안 하는 것과 같으므로 **사용을 피해야 합니다**.

## orElse() - 기본값 제공

```java
String name = Optional.ofNullable(userName)
    .orElse("익명");
```

⚠️ **orElse는 항상 실행됩니다**:

```java
String name = Optional.ofNullable(userName)
    .orElse(createDefaultUser().getName());  // 값이 있어도 createDefaultUser() 호출!
```

## orElseGet() - 기본값을 지연 생성

```java
String name = Optional.ofNullable(userName)
    .orElseGet(() -> createDefaultUser().getName());  // 값이 없을 때만 호출
```

## orElse vs orElseGet

| 메서드 | 실행 시점 | 사용 상황 |
|--------|----------|----------|
| `orElse(value)` | 항상 | 상수, 이미 계산된 값 |
| `orElseGet(() -> ...)` | 값이 없을 때만 | DB 조회, 객체 생성 등 비용이 큰 연산 |

```java
// ✅ 상수는 orElse
.orElse("default")

// ✅ 비용이 큰 연산은 orElseGet
.orElseGet(() -> userRepository.findDefaultUser())
```

## orElseThrow() - 없으면 예외

```java
User user = findUserById(id)
    .orElseThrow(() -> new UserNotFoundException("사용자를 찾을 수 없습니다: " + id));
```

Java 10+에서는 인자 없이 호출하면 `NoSuchElementException`이 발생합니다:

```java
User user = findUserById(id).orElseThrow();  // NoSuchElementException
```

# 4. Optional 변환 - map, flatMap

---

## map() - 값 변환

```java
Optional<String> name = findUserById(id)
    .map(User::getName);  // Optional<User> → Optional<String>
```

값이 없으면 변환하지 않고 빈 Optional을 반환합니다.

## flatMap() - Optional 중첩 방지

```java
// getAddress()가 Optional<Address>를 반환할 때
Optional<String> city = findUserById(id)
    .map(User::getAddress)       // Optional<Optional<Address>> (중첩!)
    .map(Address::getCity);      // 컴파일 에러

// flatMap으로 해결
Optional<String> city = findUserById(id)
    .flatMap(User::getAddress)   // Optional<Address>
    .map(Address::getCity);      // Optional<String>
```

```text
map:     T → R         → Optional<R>
flatMap: T → Optional<R> → Optional<R> (중첩 제거)
```

# 5. 조건부 동작 - ifPresent, filter

---

## ifPresent() - 값이 있을 때만 실행

```java
findUserById(id)
    .ifPresent(user -> sendEmail(user.getEmail()));
```

## ifPresentOrElse() - 값 유무에 따라 분기 (Java 9+)

```java
findUserById(id)
    .ifPresentOrElse(
        user -> sendEmail(user.getEmail()),
        () -> log.warn("사용자 없음")
    );
```

## filter() - 조건 필터링

```java
Optional<User> activeUser = findUserById(id)
    .filter(User::isActive);  // 활성 사용자만
```

# 6. 안티패턴

---

## ❌ Optional을 필드로 사용

```java
public class User {
    private Optional<String> nickname;  // 잘못됨!
}
```

Optional은 **직렬화가 안 되고**, 필드로 사용하도록 설계되지 않았습니다. 필드는 그냥 null을 허용하고, getter에서 Optional로 반환하세요.

```java
public class User {
    private String nickname;  // null 허용

    public Optional<String> getNickname() {
        return Optional.ofNullable(nickname);
    }
}
```

## ❌ Optional을 메서드 파라미터로

```java
// 잘못됨
public void processUser(Optional<User> userOpt) { ... }

// 올바름: 메서드 오버로딩 또는 null 파라미터
public void processUser(User user) { ... }
```

Optional 파라미터는 호출자가 `Optional.of()`, `Optional.empty()`를 만들어야 하는 부담을 줍니다.

## ❌ Optional.of(null)

```java
Optional.of(null);  // NullPointerException!
```

null일 가능성이 있으면 반드시 `ofNullable()`을 사용하세요.

## ❌ isPresent() + get()

```java
// 안티패턴
if (opt.isPresent()) {
    User user = opt.get();
    process(user);
}

// 올바른 방법
opt.ifPresent(this::process);

// 또는
User user = opt.orElseThrow();
```

## ❌ Optional == null 체크

```java
Optional<User> opt = findUser();
if (opt != null && opt.isPresent()) {  // Optional이 null?!
    ...
}
```

**Optional 자체가 null이면 안 됩니다**. Optional을 반환하는 메서드는 절대 null을 반환하지 말고 `Optional.empty()`를 반환해야 합니다.

# 7. 실무 패턴

---

## 패턴 1: 체이닝으로 null-safe 접근

```java
// 기존: 중첩 null 체크
String city = null;
if (user != null) {
    Address address = user.getAddress();
    if (address != null) {
        city = address.getCity();
    }
}

// Optional 체이닝
String city = Optional.ofNullable(user)
    .map(User::getAddress)
    .map(Address::getCity)
    .orElse("Unknown");
```

## 패턴 2: 여러 소스에서 값 찾기

```java
String name = Optional.ofNullable(getName1())
    .or(() -> Optional.ofNullable(getName2()))  // Java 9+
    .or(() -> Optional.ofNullable(getName3()))
    .orElse("default");
```

## 패턴 3: Stream과 결합

```java
List<String> names = users.stream()
    .map(User::getNickname)     // Stream<Optional<String>>
    .flatMap(Optional::stream)  // Stream<String> (빈 Optional 제거, Java 9+)
    .collect(Collectors.toList());
```

## 패턴 4: 조건부 처리

```java
findUserById(id)
    .filter(User::isActive)
    .filter(user -> user.getAge() >= 18)
    .ifPresentOrElse(
        this::grantAccess,
        () -> denyAccess("조건 불충족")
    );
```

# 8. 정리

---

| 메서드 | 설명 | 주의사항 |
|--------|------|---------|
| `of(T)` | null이 아닌 값 래핑 | null이면 NPE |
| `ofNullable(T)` | null 가능한 값 래핑 | 안전 |
| `empty()` | 빈 Optional | - |
| `orElse(T)` | 기본값 제공 | 항상 실행됨 |
| `orElseGet(Supplier)` | 지연 기본값 | 비용 큰 연산에 사용 |
| `orElseThrow(Supplier)` | 없으면 예외 | 커스텀 예외 가능 |
| `map(Function)` | 값 변환 | Optional 유지 |
| `flatMap(Function)` | Optional 중첩 방지 | 메서드가 Optional 반환 시 |
| `filter(Predicate)` | 조건 필터링 | 조건 불충족 시 empty |
| `ifPresent(Consumer)` | 값 있을 때 실행 | 부작용 용도 |

```text
핵심:
  Optional = "값이 없을 수 있음"을 타입으로 표현.
  get() 대신 orElse/orElseGet/orElseThrow 사용.
  필드/파라미터에는 Optional 사용 금지.
  Optional 자체가 null이면 안 됨.
```

# Reference

---

- [Java Optional API (Oracle)](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Optional.html)
- [Optional Best Practices](https://www.baeldung.com/java-optional)
- [Effective Java 3rd - Item 55](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)
