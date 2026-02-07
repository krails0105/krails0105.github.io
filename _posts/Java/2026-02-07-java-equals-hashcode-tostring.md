---
title: "[Java] equals, hashCode, toString - 객체 동등성과 표현"
categories:
  - Java
tags:
  - [Java, Object, Equals, HashCode, ToString, Collection]
---

# Introduction

---

Java의 모든 클래스는 `Object`를 상속하며, `equals()`, `hashCode()`, `toString()` 세 메서드를 기본으로 갖습니다. 이 메서드들을 제대로 오버라이드하지 않으면 **HashMap에서 값을 못 찾거나**, **Set에 중복이 들어가거나**, **디버깅할 때 `@1a2b3c` 같은 무의미한 출력**을 보게 됩니다.

이 글은 세 메서드의 규약과 올바른 구현 방법을 정리합니다.

# 1. 기본 동작 이해

---

## Object의 기본 구현

```java
// Object.equals(): 참조 동일성 (==)
public boolean equals(Object obj) {
    return (this == obj);
}

// Object.hashCode(): 메모리 주소 기반
public native int hashCode();

// Object.toString(): 클래스명@해시코드
public String toString() {
    return getClass().getName() + "@" + Integer.toHexString(hashCode());
}
```

오버라이드하지 않으면 **같은 내용의 객체도 다른 객체로 취급**됩니다:

```java
User user1 = new User(1L, "홍길동");
User user2 = new User(1L, "홍길동");

user1.equals(user2);  // false (기본: 참조 비교)
user1.hashCode() == user2.hashCode();  // false (기본: 주소 기반)
System.out.println(user1);  // User@1a2b3c
```

# 2. equals() 규약과 구현

---

## equals() 규약 (반드시 지켜야 함)

| 규약 | 설명 |
|------|------|
| **반사성** | `x.equals(x)` = true |
| **대칭성** | `x.equals(y)` = true ↔ `y.equals(x)` = true |
| **추이성** | x=y, y=z → x=z |
| **일관성** | 변경 없으면 결과 동일 |
| **null 비교** | `x.equals(null)` = false |

## 올바른 구현

```java
public class User {
    private Long id;
    private String name;

    @Override
    public boolean equals(Object o) {
        // 1. 동일 참조 확인 (성능)
        if (this == o) return true;

        // 2. null 및 타입 확인
        if (o == null || getClass() != o.getClass()) return false;

        // 3. 필드 비교
        User user = (User) o;
        return Objects.equals(id, user.id) &&
               Objects.equals(name, user.name);
    }
}
```

## Objects.equals()를 쓰는 이유

```java
// 직접 비교: null 체크 필요
if (this.name == null) {
    if (other.name != null) return false;
} else if (!this.name.equals(other.name)) {
    return false;
}

// Objects.equals(): null-safe
Objects.equals(this.name, other.name);
```

## instanceof vs getClass()

```java
// instanceof: 하위 클래스도 동등 취급
if (!(o instanceof User)) return false;

// getClass(): 정확히 같은 클래스만
if (o == null || getClass() != o.getClass()) return false;
```

```text
일반적으로 getClass() 권장:
  - 상속 관계에서 대칭성 문제 방지
  - Liskov 치환 원칙 고려

instanceof가 적합한 경우:
  - final 클래스
  - 인터페이스 기반 동등성 (예: List 구현체 비교)
```

# 3. hashCode() 규약과 구현

---

## hashCode() 규약

| 규약 | 설명 |
|------|------|
| **일관성** | 변경 없으면 항상 같은 값 |
| **equals 연계** | `equals()`가 true → `hashCode()`도 같아야 함 |
| **분산** | 다른 객체는 가급적 다른 hashCode (권장) |

## 핵심: equals를 오버라이드하면 hashCode도 반드시 오버라이드

```java
// ❌ hashCode 미구현
User user1 = new User(1L, "홍길동");
User user2 = new User(1L, "홍길동");

user1.equals(user2);  // true (equals 구현함)

Set<User> set = new HashSet<>();
set.add(user1);
set.contains(user2);  // false! hashCode가 다르니까
```

HashMap/HashSet은 **먼저 hashCode로 버킷을 찾고, 그 안에서 equals로 비교**합니다. hashCode가 다르면 equals는 호출조차 되지 않습니다.

## 올바른 구현

```java
@Override
public int hashCode() {
    return Objects.hash(id, name);
}
```

`Objects.hash()`는 내부적으로 `Arrays.hashCode()`를 호출하여 여러 필드의 해시를 조합합니다.

## 성능 고려 수동 구현

```java
@Override
public int hashCode() {
    int result = 17;  // 0이 아닌 초기값
    result = 31 * result + (id != null ? id.hashCode() : 0);
    result = 31 * result + (name != null ? name.hashCode() : 0);
    return result;
}
```

- **31**: 홀수 소수, 곱셈 최적화 가능 (`31 * i = (i << 5) - i`)
- **equals에 사용된 필드만 포함**

# 4. toString() 구현

---

## 기본 원칙

디버깅, 로깅에서 객체 상태를 파악할 수 있도록 **주요 필드를 포함**합니다.

```java
@Override
public String toString() {
    return "User{" +
           "id=" + id +
           ", name='" + name + '\'' +
           ", email='" + email + '\'' +
           '}';
}
```

## 민감 정보 제외

```java
@Override
public String toString() {
    return "User{" +
           "id=" + id +
           ", name='" + name + '\'' +
           // password는 제외!
           '}';
}
```

## StringBuilder 사용 (대량 필드)

```java
@Override
public String toString() {
    return new StringBuilder("Order{")
        .append("id=").append(id)
        .append(", status=").append(status)
        .append(", items=").append(items.size())
        .append('}')
        .toString();
}
```

# 5. Lombok/Record 활용

---

## Lombok

```java
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.ToString;

@Data  // equals, hashCode, toString 자동 생성
public class User {
    private Long id;
    private String name;
}

// 세밀한 제어
@EqualsAndHashCode(of = {"id"})  // id만으로 비교
@ToString(exclude = {"password"})  // password 제외
public class User {
    private Long id;
    private String name;
    private String password;
}
```

## Java 14+ Record

```java
public record User(Long id, String name) {
    // equals, hashCode, toString 자동 생성
}
```

Record는 **불변 데이터 클래스**로, 모든 필드가 final이며 세 메서드가 자동 구현됩니다.

## IDE 생성

IntelliJ: `Alt + Insert` → Generate → `equals() and hashCode()`, `toString()`

# 6. JPA Entity에서의 주의점

---

## 문제: Lazy Loading과 equals

```java
@Entity
public class Order {
    @Id
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    private User user;

    @Override
    public boolean equals(Object o) {
        // user.getId()를 호출하면 Lazy Loading 발생!
        // 세션이 닫혀있으면 LazyInitializationException
    }
}
```

## 권장: 비즈니스 키 또는 ID만 사용

```java
@Entity
public class Order {
    @Id
    @GeneratedValue
    private Long id;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Order)) return false;
        Order order = (Order) o;
        // ID만 사용 (연관 엔티티 제외)
        return id != null && id.equals(order.id);
    }

    @Override
    public int hashCode() {
        // 상수 반환: 새 엔티티(id=null)도 Set에 넣을 수 있음
        return getClass().hashCode();
    }
}
```

## 또 다른 접근: 비즈니스 키

```java
@Entity
public class User {
    @Id
    private Long id;

    @Column(unique = true)
    private String email;  // 비즈니스 키

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof User)) return false;
        User user = (User) o;
        return email != null && email.equals(user.email);  // 비즈니스 키로 비교
    }

    @Override
    public int hashCode() {
        return email != null ? email.hashCode() : 0;
    }
}
```

# 7. 실수하기 쉬운 포인트

---

## ❌ equals만 오버라이드

```java
// hashCode를 안 하면 HashMap/Set에서 오동작
public boolean equals(Object o) { ... }
// hashCode() 누락!
```

## ❌ equals에 없는 필드를 hashCode에 포함

```java
// equals: id, name 비교
// hashCode: id, name, createdAt 포함
// → equals가 true인데 hashCode가 다를 수 있음 (규약 위반)
```

## ❌ 가변 필드를 hashCode에 포함

```java
public class User {
    private String name;  // 변경 가능

    @Override
    public int hashCode() {
        return Objects.hash(name);  // name이 바뀌면 hashCode도 변경
    }
}

// HashMap에 넣은 후 name을 변경하면 찾을 수 없음!
Map<User, String> map = new HashMap<>();
User user = new User("홍길동");
map.put(user, "value");
user.setName("김철수");  // hashCode 변경!
map.get(user);  // null!
```

## ❌ 파라미터 타입을 구체 클래스로

```java
// 오버로딩(X), 오버라이딩(O)
public boolean equals(User other) { ... }  // Object가 아니라 User!

// 올바른 시그니처
@Override
public boolean equals(Object o) { ... }
```

# 8. 정리

---

| 메서드 | 목적 | 핵심 규약 |
|--------|------|----------|
| **equals()** | 논리적 동등성 | 반사성, 대칭성, 추이성, 일관성 |
| **hashCode()** | 해시 기반 컬렉션 | equals가 true → hashCode 동일 |
| **toString()** | 디버깅/로깅 | 주요 필드 포함, 민감 정보 제외 |

```text
핵심:
  equals를 오버라이드하면 반드시 hashCode도 오버라이드.
  hashCode가 다르면 HashMap/Set에서 equals는 호출되지 않음.
  Objects.equals(), Objects.hash() 활용.
  JPA Entity는 ID 또는 비즈니스 키만 사용.
  Lombok @Data 또는 Record로 자동 생성 권장.
```

# Reference

---

- [Effective Java 3rd - Item 10, 11, 12](https://www.oreilly.com/library/view/effective-java-3rd/9780134686097/)
- [Objects.equals() Javadoc](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Objects.html)
- [JPA equals/hashCode Best Practices](https://vladmihalcea.com/how-to-implement-equals-and-hashcode-using-the-jpa-entity-identifier/)
