---
title: "[Java] Modern Java 핵심 신기능 - Record, Sealed Class, Pattern Matching (Java 14~21)"
categories:
  - Java
tags:
  - [Java, Record, SealedClass, PatternMatching, ModernJava]
---

# Introduction

---

Java 14부터 21까지 추가된 핵심 기능을 정리합니다. `Record`, `Sealed Class`, `Pattern Matching`, `Text Block`, `Switch Expression` 등은 보일러플레이트를 줄이고 코드의 의도를 명확하게 표현하기 위한 기능입니다.

# 1. Record (Java 16)

---

## 기존 DTO/VO의 문제

```java
// 단순 데이터 운반용 클래스에도 이만큼의 코드가 필요했음
public class UserDto {
    private final String name;
    private final int age;

    public UserDto(String name, int age) {
        this.name = name;
        this.age = age;
    }

    public String getName() { return name; }
    public int getAge() { return age; }

    @Override
    public boolean equals(Object o) { /* 구현 */ }
    @Override
    public int hashCode() { /* 구현 */ }
    @Override
    public String toString() { /* 구현 */ }
}
```

## Record로 변환

```java
public record UserDto(String name, int age) {}
```

```text
Record가 자동 생성하는 것:
  - 모든 필드는 private final
  - 전체 필드를 받는 생성자 (canonical constructor)
  - 필드별 접근자 메서드 (name(), age() — getXxx() 형태가 아님)
  - equals(), hashCode(), toString()
```

## Record의 활용과 제약

```java
// Compact Constructor: 유효성 검사
public record UserDto(String name, int age) {
    public UserDto {  // 파라미터 목록 생략
        if (age < 0) throw new IllegalArgumentException("age must be >= 0");
        name = name.trim(); // 필드 가공 가능
    }
}

// 메서드 추가 가능
public record Point(int x, int y) {
    public double distanceTo(Point other) {
        return Math.sqrt(Math.pow(x - other.x, 2) + Math.pow(y - other.y, 2));
    }
}

// 인터페이스 구현 가능
public record ApiResponse<T>(int status, T data) implements Serializable {}
```

```text
제약:
  - 다른 클래스를 상속할 수 없음 (암묵적으로 java.lang.Record 상속)
  - 필드를 변경할 수 없음 (불변)
  - 인스턴스 필드를 추가할 수 없음 (static 필드는 가능)
```

# 2. Sealed Class (Java 17)

---

## 개념

상속 가능한 클래스를 **특정 클래스만 허용**하도록 제한합니다.

```java
// Shape을 상속할 수 있는 클래스를 명시적으로 제한
public sealed class Shape permits Circle, Rectangle, Triangle {
    // 공통 로직
}

public final class Circle extends Shape {    // final: 더 이상 상속 불가
    private final double radius;
    public Circle(double radius) { this.radius = radius; }
    public double radius() { return radius; }
}

public final class Rectangle extends Shape {
    private final double width, height;
    public Rectangle(double w, double h) { this.width = w; this.height = h; }
    public double width() { return width; }
    public double height() { return height; }
}

public non-sealed class Triangle extends Shape { // non-sealed: 자유롭게 상속 가능
    // ...
}
```

```text
permits는 "이 클래스만 상속할 수 있다"는 허가 명단입니다.
permits 절의 서브클래스는 반드시 다음 중 하나:
  - final: 더 이상 상속 불가
  - sealed: 다시 permits로 제한
  - non-sealed: 제한 해제 (자유 상속)
```

## Pattern Matching과의 시너지

```java
// Sealed Class + Switch Pattern Matching
public double area(Shape shape) {
    return switch (shape) {
        case Circle c    -> Math.PI * c.radius() * c.radius();
        case Rectangle r -> r.width() * r.height();
        case Triangle t  -> t.base() * t.height() / 2;
        // default 불필요: 모든 경우를 다 커버했으므로 (exhaustive)
    };
}
```

```text
Sealed Class의 핵심 가치:
  - 컴파일러가 모든 하위 타입을 알고 있음
  → switch에서 default 없이도 컴파일 가능 (exhaustive check)
  → 새 서브클래스 추가 시 switch에서 컴파일 에러 발생 (누락 방지)
```

# 3. Pattern Matching

---

## instanceof Pattern Matching (Java 16)

```java
// Before
if (obj instanceof String) {
    String s = (String) obj;  // 캐스팅 반복
    System.out.println(s.length());
}

// After
if (obj instanceof String s) {  // 타입 확인 + 변수 바인딩 한 번에
    System.out.println(s.length());
}
```

## Switch Pattern Matching (Java 21)

```java
// 타입별 분기 + null 처리
public String format(Object obj) {
    return switch (obj) {
        case Integer i  -> "정수: " + i;
        case String s   -> "문자열: " + s;
        case int[] arr  -> "배열 크기: " + arr.length;
        case null       -> "null";
        default         -> "기타: " + obj;
    };
}
```

## Guarded Pattern (when 절)

```java
public String classify(Shape shape) {
    return switch (shape) {
        case Circle c when c.radius() > 100  -> "큰 원";
        case Circle c                         -> "작은 원";
        case Rectangle r when r.width() == r.height() -> "정사각형";
        case Rectangle r                      -> "직사각형";
        default -> "기타";
    };
}
```

## Record Pattern (Java 21)

```java
public record Point(int x, int y) {}

// Record의 구성 요소를 바로 분해
if (obj instanceof Point(int x, int y)) {
    System.out.println("x=" + x + ", y=" + y);
}

// 중첩 Record 분해
public record Line(Point start, Point end) {}

if (obj instanceof Line(Point(int x1, int y1), Point(int x2, int y2))) {
    double distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}
```

# 4. Switch Expression (Java 14)

---

```java
// Before: switch statement
String result;
switch (day) {
    case MONDAY: case FRIDAY:
        result = "출근";
        break;
    case SATURDAY: case SUNDAY:
        result = "휴일";
        break;
    default:
        result = "기타";
}

// After: switch expression (값을 반환)
String result = switch (day) {
    case MONDAY, FRIDAY -> "출근";
    case SATURDAY, SUNDAY -> "휴일";
    default -> "기타";
};
```

```text
변경점:
  - 화살표(->) 문법: break 불필요, fall-through 없음
  - switch가 값을 반환하는 "식(expression)"이 됨
  - 여러 케이스를 콤마로 묶기 가능
  - 블록이 필요하면 yield로 값 반환
```

# 5. Text Block (Java 15)

---

```java
// Before: 문자열 연결과 이스케이프
String json = "{\n" +
    "  \"name\": \"Kim\",\n" +
    "  \"age\": 30\n" +
    "}";

// After: Text Block
String json = """
    {
        "name": "Kim",
        "age": 30
    }
    """;
```

```text
규칙:
  - 여는 """  뒤에는 반드시 줄바꿈
  - 닫는 """ 의 위치가 들여쓰기 기준선 결정
  - 공통 들여쓰기가 자동 제거됨 (incidental whitespace stripping)
```

# 6. 기타 유용한 기능

---

## var (Java 10) - 지역 변수 타입 추론

```java
var list = new ArrayList<String>();    // ArrayList<String>으로 추론
var stream = list.stream();            // Stream<String>으로 추론
var entry = Map.entry("key", "value"); // Map.Entry<String, String>으로 추론

// 사용 가능: 지역 변수, for문, try-with-resources
// 사용 불가: 필드, 메서드 파라미터, 반환 타입
```

## Stream.toList() (Java 16)

```java
// Before
List<String> list = stream.collect(Collectors.toList());

// After (Java 16+)
List<String> list = stream.toList(); // 불변 리스트 반환
```

## String 메서드 추가

```java
"  hello  ".strip();         // "hello" (유니코드 공백도 제거, Java 11)
"hello".repeat(3);           // "hellohellohello" (Java 11)
"hello\nworld".lines();      // Stream<String> (Java 11)
"hello".isBlank();           // false (Java 11)
"  ".isBlank();              // true
```

# 7. 정리

---

| 기능 | Java 버전 | 핵심 |
|------|----------|------|
| **Switch Expression** | 14 | switch가 값을 반환, 화살표 문법 |
| **Text Block** | 15 | 여러 줄 문자열 리터럴 |
| **Record** | 16 | 불변 데이터 클래스 자동 생성 |
| **instanceof Pattern** | 16 | 타입 확인 + 변수 바인딩 동시에 |
| **Sealed Class** | 17 | 상속 허용 클래스를 제한 |
| **Switch Pattern** | 21 | switch에서 타입별 분기 |
| **Record Pattern** | 21 | Record 구성 요소 분해 |

```text
핵심:
  Record = 불변 데이터 운반 객체를 한 줄로 정의
  Sealed Class = 상속 계층을 제한 → 컴파일러가 완전성 검증
  Pattern Matching = 타입 확인 + 캐스팅 + 변수 바인딩을 한 번에
  이 세 가지가 결합되면: 타입 안전한 대수적 데이터 타입(ADT)을 Java에서 구현 가능
```

# Reference

---

- [Oracle - JEP 395: Records](https://openjdk.org/jeps/395)
- [Oracle - JEP 409: Sealed Classes](https://openjdk.org/jeps/409)
- [Oracle - JEP 441: Pattern Matching for switch](https://openjdk.org/jeps/441)
- [Baeldung - Java Records](https://www.baeldung.com/java-record-keyword)
- [Baeldung - Sealed Classes](https://www.baeldung.com/java-sealed-classes-interfaces)
