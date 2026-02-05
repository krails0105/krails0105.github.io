---
title: "[Java] JVM 메모리 구조와 가비지 컬렉션(GC) - Heap, Stack, GC 알고리즘"
categories:
  - Java
tags:
  - [Java, JVM, GarbageCollection, Memory, Performance]
---

# Introduction

---

Java 프로그램을 실행하면 JVM(Java Virtual Machine)이 OS로부터 메모리를 할당받아 여러 영역으로 나누어 관리합니다. 이 구조를 이해하면 `OutOfMemoryError`, 메모리 누수, GC 튜닝 같은 실무 문제를 진단할 수 있습니다.

이 글은 JVM의 메모리 영역, 객체의 생명주기, 가비지 컬렉션 알고리즘을 정리합니다.

# 1. JVM 메모리 구조 전체 그림

---

```text
┌─────────────────────────────────────────────┐
│  JVM Runtime Data Areas                       │
│                                               │
│  ┌─────────────┐  ┌─────────────────────────┐│
│  │  Method Area │  │       Heap              ││
│  │  (Metaspace) │  │  ┌───────┐ ┌─────────┐ ││
│  │  - 클래스 정보  │  │  │ Young │ │   Old   │ ││
│  │  - 상수 풀     │  │  │  Gen  │ │   Gen   │ ││
│  │  - static 변수│  │  └───────┘ └─────────┘ ││
│  └─────────────┘  └─────────────────────────┘│
│                                               │
│  ┌─────────────┐  ┌─────────────────────────┐│
│  │   Stack      │  │   PC Register           ││
│  │  (스레드별)   │  │   Native Method Stack   ││
│  └─────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────┘
```

# 2. 각 영역의 역할

---

## Method Area (Metaspace)

```text
저장되는 것:
  - 클래스 메타데이터 (클래스 이름, 메서드 정보, 필드 정보)
  - static 변수
  - 상수 풀 (Runtime Constant Pool)

특징:
  - 모든 스레드가 공유
  - Java 8부터 PermGen → Metaspace로 변경
  - Metaspace는 Native Memory 사용 (Heap 밖)
  - -XX:MaxMetaspaceSize로 제한 가능
```

## Heap

```text
저장되는 것:
  - new 키워드로 생성된 모든 객체와 배열
  - String Pool (Java 7+)

특징:
  - 모든 스레드가 공유
  - GC의 주요 대상
  - -Xms (초기 크기), -Xmx (최대 크기)로 설정

구조:
  Young Generation:
    - Eden: 새로 생성된 객체가 할당되는 곳
    - Survivor 0, 1: Minor GC 후 살아남은 객체가 이동
  Old Generation:
    - Young에서 오래 살아남은 객체가 이동 (promotion)
```

## Stack

```text
저장되는 것:
  - 지역 변수 (primitive 타입의 값 자체)
  - 참조 변수 (객체의 Heap 주소)
  - 메서드 호출 정보 (Stack Frame)

특징:
  - 스레드마다 독립적으로 생성
  - LIFO(Last In First Out) 구조
  - 메서드 호출 시 Frame 생성, 반환 시 제거
  - -Xss로 스레드당 스택 크기 설정
  - 초과 시 StackOverflowError
```

## 변수 저장 위치 정리

```java
public class MemoryExample {
    static int classVar = 10;          // Method Area (static)
    int instanceVar = 20;              // Heap (객체의 일부)

    public void method() {
        int localVar = 30;             // Stack (지역 변수)
        String str = new String("hi"); // str → Stack, String 객체 → Heap
        String literal = "hello";      // literal → Stack, "hello" → Heap(String Pool)
    }
}
```

| 변수 종류 | 저장 위치 | 생명주기 |
|-----------|----------|---------|
| static 변수 | Method Area | 클래스 로딩 ~ 언로딩 |
| 인스턴스 변수 | Heap | 객체 생성 ~ GC |
| 지역 변수 (primitive) | Stack | 메서드 호출 ~ 반환 |
| 지역 변수 (참조) | Stack(참조) + Heap(객체) | 참조: 메서드 반환 시, 객체: GC |

# 3. 가비지 컬렉션(GC) 기초

---

## GC란?

Heap에 할당된 객체 중 **더 이상 참조되지 않는 객체**를 자동으로 찾아 메모리를 회수하는 메커니즘입니다.

```java
public void example() {
    Object obj = new Object(); // Heap에 객체 생성
    obj = null;                // 참조 끊김 → GC 대상
}
// 메서드 종료 → 지역 변수 obj가 Stack에서 제거
// Heap의 Object는 참조가 없으므로 GC 대상
```

## Reachability 판단

```text
GC Root에서 참조 체인을 따라갈 수 있는 객체 = "도달 가능" (살림)
GC Root에서 도달할 수 없는 객체 = "도달 불가능" (수거)

비유: 조직도에서 CEO(GC Root)로부터 보고라인이 끊긴 부서는 정리 대상이 됩니다.

GC Root가 되는 것:
  - Stack의 지역 변수
  - static 변수
  - JNI 참조
  - 실행 중인 Thread
```

## Generational GC: Young과 Old를 나누는 이유

```text
약한 세대 가설 (Weak Generational Hypothesis):
  1. 대부분의 객체는 금방 죽는다 (단명 객체)
  2. 오래 살아남은 객체는 계속 살 확률이 높다

→ 단명 객체가 모이는 Young Gen을 자주, 빠르게 수거 (Minor GC)
→ 장수 객체가 모이는 Old Gen은 드물게, 느리게 수거 (Major/Full GC)
```

# 4. GC 동작 과정

---

## Minor GC (Young Generation)

```text
1. 새 객체가 Eden에 할당
2. Eden이 가득 차면 Minor GC 발생
3. Eden에서 살아남은 객체 → Survivor 영역으로 이동 (age + 1)
4. 이전 Survivor의 생존 객체도 다른 Survivor로 이동 (age + 1)
5. age가 임계값(-XX:MaxTenuringThreshold, 기본 15) 초과 → Old Gen으로 promotion

특징:
  - Stop-the-World 발생하지만 매우 짧음 (ms 단위)
  - Eden은 대부분 죽은 객체 → 수거 효율 높음
```

## Major GC / Full GC (Old Generation)

```text
1. Old Gen이 가득 차면 발생
2. 전체 Heap을 대상으로 수거
3. Stop-the-World 시간이 상대적으로 김 (수백 ms ~ 수 초)
4. 애플리케이션 응답 지연의 주원인
```

# 5. GC 알고리즘 종류

---

| GC | 특징 | STW 특성 | 적합한 환경 |
|----|------|---------|-----------|
| Serial GC | 단일 스레드 | 긴 STW | 소규모 앱, 테스트 |
| Parallel GC | 멀티 스레드로 수거 | 처리량 우선 | 배치 처리 |
| G1 GC | Region 기반, 예측 가능한 STW | 목표 STW 시간 설정 가능 | **Java 9+ 기본** |
| ZGC | 초저지연 (ms 이하 STW) | 거의 무중단 | 대규모, 저지연 |
| Shenandoah | ZGC 유사, RedHat 개발 | 초저지연 | 대규모 |

## G1 GC (Garbage First)

```text
Java 9부터 기본 GC. Heap을 고정 크기 Region으로 분할하여 관리.

동작:
  1. Heap을 수백~수천 개 Region으로 분할
  2. 각 Region이 Eden, Survivor, Old, Humongous 역할을 동적으로 맡음
  3. "가비지가 가장 많은 Region"부터 우선 수거 (Garbage First)
  4. -XX:MaxGCPauseMillis=200 으로 목표 STW 시간 설정

장점:
  - 예측 가능한 STW 시간
  - 대용량 Heap에서도 효율적
```

# 6. 메모리 누수(Memory Leak)와 진단

---

Java는 GC가 있지만 **메모리 누수**가 발생할 수 있습니다. 객체가 GC Root에서 여전히 도달 가능하지만 실제로는 사용하지 않는 경우입니다.

## 대표적인 메모리 누수 패턴

```java
// 1. static 컬렉션에 계속 추가
public class Cache {
    private static List<Object> cache = new ArrayList<>();

    public void add(Object obj) {
        cache.add(obj); // 제거하지 않으면 계속 증가
    }
}

// 2. 리스너/콜백을 등록만 하고 해제하지 않음
eventBus.register(listener); // unregister를 안 하면 누수

// 3. 내부 클래스가 외부 클래스를 참조
public class Outer {
    private byte[] largeData = new byte[10_000_000];

    class Inner { // Inner가 살아있으면 Outer도 GC 안 됨
    }
}
```

## 진단 도구

```text
jmap -histo <pid>        : 객체 히스토그램 (어떤 클래스가 메모리를 많이 차지하는지)
jmap -dump:format=b,file=heap.hprof <pid> : Heap 덤프 생성
jstat -gc <pid> 1000     : GC 통계 실시간 모니터링 (1초 간격)
VisualVM, Eclipse MAT    : Heap 덤프 분석 GUI 도구
```

# 7. JVM 옵션 정리

---

| 옵션 | 설명 | 예시 |
|------|------|------|
| `-Xms` | 초기 Heap 크기 | `-Xms512m` |
| `-Xmx` | 최대 Heap 크기 | `-Xmx2g` |
| `-Xss` | 스레드당 Stack 크기 | `-Xss512k` |
| `-XX:MaxMetaspaceSize` | Metaspace 최대 크기 | `-XX:MaxMetaspaceSize=256m` |
| `-XX:+UseG1GC` | G1 GC 사용 | |
| `-XX:MaxGCPauseMillis` | 목표 STW 시간 | `-XX:MaxGCPauseMillis=200` |
| `-XX:+HeapDumpOnOutOfMemoryError` | OOM 시 덤프 자동 생성 | |
| `-verbose:gc` | GC 로그 출력 | |

# 8. 정리

---

| 개념 | 설명 |
|------|------|
| **Heap** | 객체가 저장되는 공유 메모리, GC 대상 |
| **Stack** | 스레드별 지역 변수/메서드 호출 정보 |
| **Metaspace** | 클래스 메타데이터, Native Memory 사용 |
| **Young Gen** | 단명 객체 영역, Minor GC로 빠르게 수거 |
| **Old Gen** | 장수 객체 영역, Major GC로 수거 (STW 김) |
| **G1 GC** | Java 9+ 기본, Region 기반, 예측 가능한 STW |
| **메모리 누수** | 참조가 남아있어 GC 못하는 미사용 객체 |

```text
핵심:
  JVM 메모리 = Method Area + Heap + Stack + PC Register + Native Stack
  GC = 도달 불가능 객체를 자동 수거
  Generational GC = 대부분 객체가 단명한다는 가설 기반
  G1 GC = Region 기반, 가비지가 많은 곳부터 우선 수거
```

# Reference

---

- [Oracle - JVM Specification](https://docs.oracle.com/javase/specs/jvms/se17/html/)
- [Oracle - Garbage Collection Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/)
- [Baeldung - JVM Garbage Collectors](https://www.baeldung.com/jvm-garbage-collectors)
- [G1 GC Documentation](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-g1-garbage-collector1.html)
