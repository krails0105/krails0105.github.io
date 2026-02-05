---
title: "[Java] 디자인 패턴 실전 - 생성, 구조, 행위 패턴 핵심 정리"
categories:
  - Java
tags:
  - [Java, DesignPattern, OOP, Singleton, Factory, Strategy, Observer]
---

# Introduction

---

디자인 패턴은 반복적으로 등장하는 설계 문제에 대한 검증된 해결 방식입니다. GoF(Gang of Four)가 정리한 23개 패턴 중 Java 실무에서 자주 사용하는 패턴을 **생성(Creational)**, **구조(Structural)**, **행위(Behavioral)** 분류별로 정리합니다.

# 1. 생성 패턴 (Creational Patterns)

---

## Singleton - 인스턴스를 하나만 보장

```java
// 가장 안전한 방식: static inner class (Lazy + Thread-safe)
public class Singleton {
    private Singleton() {}

    private static class Holder {
        private static final Singleton INSTANCE = new Singleton();
    }

    public static Singleton getInstance() {
        return Holder.INSTANCE;
    }
}
```

```text
왜 static inner class인가?
  - Holder 클래스는 getInstance() 호출 시점에 로딩 (lazy)
  - 클래스 로딩은 JVM이 원자적으로 보장 (thread-safe)
  - synchronized 없이도 안전

다른 방식의 문제:
  - DCL(Double-Checked Locking): volatile + synchronized 필요, 복잡
  - enum: 가장 간결하지만 상속 불가
  - 즉시 초기화: 사용하지 않아도 인스턴스 생성
```

## Factory Method - 객체 생성을 서브클래스에 위임

```java
// 인터페이스
public interface Notification {
    void send(String message);
}

// 구현체
public class EmailNotification implements Notification {
    public void send(String message) { /* 이메일 발송 */ }
}
public class SmsNotification implements Notification {
    public void send(String message) { /* SMS 발송 */ }
}

// 팩토리
public class NotificationFactory {
    public static Notification create(String type) {
        return switch (type) {
            case "email" -> new EmailNotification();
            case "sms"   -> new SmsNotification();
            default -> throw new IllegalArgumentException("Unknown: " + type);
        };
    }
}

// 사용
Notification noti = NotificationFactory.create("email");
noti.send("Hello");
```

```text
장점:
  - 객체 생성 로직이 한 곳에 집중 (변경 시 팩토리만 수정)
  - 클라이언트는 구현 클래스를 몰라도 됨 (주문 카운터에 "알림 하나"라고만 하면 됨)
  - Spring의 BeanFactory가 이 패턴의 대표적 구현
```

## Builder - 복잡한 객체를 단계적으로 생성

```java
public class User {
    private final String name;     // 필수
    private final String email;    // 필수
    private final int age;         // 선택
    private final String phone;    // 선택

    private User(Builder builder) {
        this.name = builder.name;
        this.email = builder.email;
        this.age = builder.age;
        this.phone = builder.phone;
    }

    public static class Builder {
        private final String name;   // 필수
        private final String email;  // 필수
        private int age;
        private String phone;

        public Builder(String name, String email) {
            this.name = name;
            this.email = email;
        }

        public Builder age(int age) { this.age = age; return this; }
        public Builder phone(String phone) { this.phone = phone; return this; }
        public User build() { return new User(this); }
    }
}

// 사용: 가독성 높은 객체 생성
User user = new User.Builder("Kim", "kim@email.com")
    .age(30)
    .phone("010-1234-5678")
    .build();
```

```text
Lombok의 @Builder가 이 패턴을 자동 생성해줌
실무에서는 Lombok @Builder를 주로 사용하되, 패턴의 원리를 이해하는 것이 중요
```

# 2. 구조 패턴 (Structural Patterns)

---

## Adapter - 호환되지 않는 인터페이스를 연결

```java
// 기존 시스템: XML 포맷만 처리
public interface XmlParser {
    String parseXml(String xml);
}

// 새 시스템: JSON 포맷
public class JsonProcessor {
    public String processJson(String json) { return "processed: " + json; }
}

// Adapter: JSON을 XML 인터페이스에 맞춤
public class JsonToXmlAdapter implements XmlParser {
    private final JsonProcessor jsonProcessor;

    public JsonToXmlAdapter(JsonProcessor jsonProcessor) {
        this.jsonProcessor = jsonProcessor;
    }

    @Override
    public String parseXml(String xml) {
        String json = convertXmlToJson(xml);
        return jsonProcessor.processJson(json);
    }

    private String convertXmlToJson(String xml) { /* 변환 로직 */ return "{}"; }
}
```

## Decorator - 기존 객체에 동적으로 기능 추가

```java
// 기본 인터페이스
public interface DataSource {
    void writeData(String data);
    String readData();
}

// 기본 구현
public class FileDataSource implements DataSource {
    public void writeData(String data) { /* 파일 쓰기 */ }
    public String readData() { return "raw data"; }
}

// Decorator: 압축 기능 추가
public class CompressionDecorator implements DataSource {
    private final DataSource wrappee;

    public CompressionDecorator(DataSource source) { this.wrappee = source; }

    public void writeData(String data) {
        wrappee.writeData(compress(data));
    }
    public String readData() {
        return decompress(wrappee.readData());
    }
    private String compress(String data) { return "compressed:" + data; }
    private String decompress(String data) { return data.replace("compressed:", ""); }
}

// 사용: 데코레이터 중첩 가능
DataSource source = new CompressionDecorator(
    new EncryptionDecorator(
        new FileDataSource()
    )
);
```

```text
Java 표준 라이브러리의 대표적 Decorator:
  new BufferedReader(new InputStreamReader(new FileInputStream("file.txt")))
  → I/O 스트림 체이닝이 Decorator 패턴
```

# 3. 행위 패턴 (Behavioral Patterns)

---

## Strategy - 알고리즘을 교체 가능하게 캡슐화

```java
// 전략 인터페이스
public interface SortStrategy {
    void sort(int[] array);
}

// 구현체
public class QuickSort implements SortStrategy {
    public void sort(int[] array) { /* 퀵소트 구현 */ }
}
public class MergeSort implements SortStrategy {
    public void sort(int[] array) { /* 머지소트 구현 */ }
}

// Context: 전략을 주입받아 사용
public class Sorter {
    private SortStrategy strategy;

    public Sorter(SortStrategy strategy) { this.strategy = strategy; }
    public void setStrategy(SortStrategy strategy) { this.strategy = strategy; }
    public void sort(int[] array) { strategy.sort(array); }
}

// 사용: 런타임에 알고리즘 교체
Sorter sorter = new Sorter(new QuickSort());
sorter.sort(data);
sorter.setStrategy(new MergeSort()); // 전략 변경
sorter.sort(data);
```

```text
Spring에서의 Strategy 패턴 활용:
  - HandlerMapping: 요청 URL에 따라 다른 핸들러 선택
  - TransactionManager: JPA/JDBC 등 다른 트랜잭션 전략
  - Java 함수형 인터페이스(Comparator 등)도 Strategy의 일종
```

## Observer - 상태 변경을 구독자에게 자동 알림

```java
import java.util.ArrayList;
import java.util.List;

// Subject (발행자)
public class EventPublisher {
    private final List<EventListener> listeners = new ArrayList<>();

    public void subscribe(EventListener listener) { listeners.add(listener); }
    public void unsubscribe(EventListener listener) { listeners.remove(listener); }

    public void notify(String event) {
        for (EventListener listener : listeners) {
            listener.onEvent(event);
        }
    }
}

// Observer (구독자)
public interface EventListener {
    void onEvent(String event);
}

// 구현
public class EmailAlert implements EventListener {
    public void onEvent(String event) {
        System.out.println("이메일 알림: " + event);
    }
}

// 사용
EventPublisher publisher = new EventPublisher();
publisher.subscribe(new EmailAlert());
publisher.subscribe(new SlackAlert());
publisher.notify("서버 장애 발생");
```

```text
Spring의 ApplicationEventPublisher가 Observer 패턴의 구현
@EventListener 어노테이션으로 이벤트 구독 가능
```

## Template Method - 알고리즘 골격은 고정, 세부 단계만 변경

```java
public abstract class DataProcessor {
    // Template Method: 전체 흐름은 고정
    public final void process() {
        readData();
        parseData();
        validate();
        saveData();
    }

    protected abstract void readData();   // 서브클래스가 구현
    protected abstract void parseData();  // 서브클래스가 구현
    protected void validate() { /* 기본 검증 (오버라이드 가능) */ }
    protected abstract void saveData();   // 서브클래스가 구현
}

public class CsvProcessor extends DataProcessor {
    protected void readData()  { /* CSV 파일 읽기 */ }
    protected void parseData() { /* CSV 파싱 */ }
    protected void saveData()  { /* DB 저장 */ }
}
```

# 4. 패턴 선택 가이드

---

| 문제 상황 | 패턴 | 핵심 |
|-----------|------|------|
| 인스턴스가 하나만 필요 | Singleton | static inner class |
| 객체 생성을 캡슐화 | Factory | 생성 로직 집중 |
| 선택적 파라미터가 많은 객체 | Builder | 체이닝 생성 |
| 호환 안 되는 인터페이스 연결 | Adapter | 래핑 |
| 기능을 동적으로 추가 | Decorator | 중첩 래핑 |
| 알고리즘을 런타임에 교체 | Strategy | 인터페이스 주입 |
| 상태 변경을 여러 곳에 알림 | Observer | 발행-구독 |
| 알고리즘 골격 고정, 세부만 변경 | Template Method | 추상 클래스 상속 |

# 5. 정리

---

```text
핵심:
  디자인 패턴 = 반복되는 설계 문제의 검증된 해법
  패턴을 억지로 적용하지 말고, 문제가 먼저 → 패턴은 해결 수단
  Spring 프레임워크 자체가 Factory, Strategy, Observer, Template Method를 광범위하게 사용
  Lombok(@Builder), 함수형 인터페이스(Strategy) 등으로 보일러플레이트 감소
```

# Reference

---

- [Refactoring Guru - Design Patterns](https://refactoring.guru/design-patterns)
- [Head First Design Patterns (O'Reilly)](https://www.oreilly.com/library/view/head-first-design/9781492077992/)
- [Baeldung - Design Patterns in Java](https://www.baeldung.com/java-design-patterns-interview)
