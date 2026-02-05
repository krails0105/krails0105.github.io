---
title: "[Java] 동시성 프로그래밍 심화 - ExecutorService, CompletableFuture, 동기화"
categories:
  - Java
tags:
  - [Java, Concurrency, ExecutorService, CompletableFuture, Thread]
---

# Introduction

---

기존 Thread 포스트에서 `Thread` 클래스 상속과 `Runnable` 인터페이스를 다뤘습니다. 하지만 실무에서는 직접 Thread를 생성하는 것보다 **스레드 풀(ExecutorService)**을 사용하고, 비동기 결과를 조합할 때는 **CompletableFuture**를 사용합니다.

이 글은 Java 동시성의 다음 단계인 ExecutorService, Future, CompletableFuture, 동기화 메커니즘을 정리합니다.

# 1. 왜 직접 Thread를 만들면 안 되는가?

---

```java
// 매 요청마다 Thread 생성 → 위험!
for (int i = 0; i < 10000; i++) {
    new Thread(() -> processRequest()).start();
}
```

```text
문제점:
  1. Thread 생성/소멸 비용이 큼 (OS 레벨 리소스)
  2. Thread 수가 제한 없이 증가 → OutOfMemoryError
  3. Thread 간 작업 스케줄링을 직접 관리해야 함
  4. 예외 처리가 어려움

→ 해결: 스레드 풀(Thread Pool)로 스레드를 재사용
```

# 2. ExecutorService - 스레드 풀

---

## 생성

```java
import java.util.concurrent.*;

// 고정 크기 풀 (가장 많이 사용)
ExecutorService fixed = Executors.newFixedThreadPool(10);

// 캐시 풀 (유휴 스레드 재사용, 필요 시 생성)
ExecutorService cached = Executors.newCachedThreadPool();

// 단일 스레드 (순서 보장)
ExecutorService single = Executors.newSingleThreadExecutor();

// 스케줄링 풀 (지연/반복 실행)
ScheduledExecutorService scheduled = Executors.newScheduledThreadPool(5);
```

## 작업 제출과 결과 받기

```java
// 1. execute: 반환값 없음, 예외 처리 어려움
executor.execute(() -> System.out.println("작업 실행"));

// 2. submit: Future 반환, 결과/예외 처리 가능
Future<String> future = executor.submit(() -> {
    Thread.sleep(1000);
    return "완료";
});

// 블로킹 호출: 결과가 올 때까지 대기
String result = future.get();               // 무한 대기
String result2 = future.get(5, TimeUnit.SECONDS); // 타임아웃
```

## 종료

```java
executor.shutdown();     // 진행 중 작업 완료 후 종료
executor.shutdownNow();  // 즉시 종료 시도 (인터럽트)

// 권장 패턴
executor.shutdown();
if (!executor.awaitTermination(60, TimeUnit.SECONDS)) {
    executor.shutdownNow();
}
```

## 실무에서 권장하는 ThreadPoolExecutor 직접 설정

```java
// Executors 팩토리 대신 직접 설정 (제어 가능)
ThreadPoolExecutor executor = new ThreadPoolExecutor(
    10,                              // corePoolSize: 기본 스레드 수
    50,                              // maximumPoolSize: 최대 스레드 수
    60L, TimeUnit.SECONDS,           // keepAliveTime: 유휴 스레드 유지 시간
    new LinkedBlockingQueue<>(1000), // workQueue: 대기 큐 (크기 제한!)
    new ThreadPoolExecutor.CallerRunsPolicy() // 큐 가득 찰 때 정책
);
```

```text
RejectionPolicy 종류:
  AbortPolicy (기본):    RejectedExecutionException 던짐
  CallerRunsPolicy:     호출 스레드에서 직접 실행
  DiscardPolicy:        조용히 버림
  DiscardOldestPolicy:  큐의 가장 오래된 작업을 버림
```

# 3. CompletableFuture - 비동기 조합

---

`Future`는 결과를 `get()`으로 블로킹 호출해야 합니다. `CompletableFuture`는 **콜백 체이닝**으로 논블로킹 비동기 프로그래밍이 가능합니다.

## 기본 사용

```java
import java.util.concurrent.CompletableFuture;

// 비동기 실행 (반환값 있음)
CompletableFuture<String> cf = CompletableFuture.supplyAsync(() -> {
    return fetchFromDB(); // ForkJoinPool.commonPool에서 실행
});

// 비동기 실행 (반환값 없음)
CompletableFuture<Void> cf2 = CompletableFuture.runAsync(() -> {
    sendNotification();
});
```

## 체이닝 (변환/소비)

```java
CompletableFuture.supplyAsync(() -> getUserId())
    .thenApply(id -> fetchUser(id))          // 변환: User → User (동기)
    .thenApplyAsync(user -> enrichUser(user)) // 변환: 다른 스레드에서 실행
    .thenAccept(user -> saveToCache(user))    // 소비: 반환값 없음
    .thenRun(() -> log("완료"));              // 실행: 입력/출력 없음
```

```text
thenApply  vs  thenApplyAsync:
  thenApply:      이전 단계와 같은 스레드에서 실행
  thenApplyAsync: 다른 스레드에서 실행 (비동기)
```

## 조합 (여러 비동기 작업)

```java
CompletableFuture<String> userCf = CompletableFuture.supplyAsync(() -> fetchUser());
CompletableFuture<String> orderCf = CompletableFuture.supplyAsync(() -> fetchOrder());

// 둘 다 완료되면 결합
CompletableFuture<String> combined = userCf.thenCombine(orderCf,
    (user, order) -> user + " - " + order);

// 여러 개 중 모두 완료 대기
CompletableFuture<Void> all = CompletableFuture.allOf(userCf, orderCf);

// 여러 개 중 하나만 완료되면 반환
CompletableFuture<Object> any = CompletableFuture.anyOf(userCf, orderCf);
```

## 예외 처리

```java
CompletableFuture.supplyAsync(() -> riskyOperation())
    .exceptionally(ex -> {
        log.error("실패: " + ex.getMessage());
        return "기본값";  // 실패 시 대체값
    })
    .thenAccept(result -> process(result));

// handle: 성공/실패 모두 처리
CompletableFuture.supplyAsync(() -> riskyOperation())
    .handle((result, ex) -> {
        if (ex != null) return "기본값";
        return result;
    });
```

# 4. 동기화 메커니즘

---

## synchronized

```java
// 1. 메서드 레벨
public synchronized void increment() {
    count++; // this 객체를 락으로 사용
}

// 2. 블록 레벨 (더 세밀한 제어)
public void increment() {
    synchronized (lock) { // 특정 객체를 락으로 사용
        count++;
    }
}
```

## volatile

```java
private volatile boolean running = true; // 메인 메모리에서 직접 읽기/쓰기

// 사용 시나리오: 단순 플래그
public void stop() { running = false; }
public void run() {
    while (running) { /* 작업 */ }
}
```

```text
volatile vs synchronized:
  volatile:     가시성(visibility) 보장. 원자성(atomicity) 미보장.
  synchronized: 가시성 + 원자성 모두 보장. 성능 비용 더 큼.

  count++는 읽기→증가→쓰기 3단계 → volatile로는 안전하지 않음
  → synchronized 또는 AtomicInteger 사용
```

## Atomic 클래스

```java
import java.util.concurrent.atomic.AtomicInteger;

AtomicInteger count = new AtomicInteger(0);
count.incrementAndGet(); // 원자적 증가 (lock-free, CAS 기반)
count.compareAndSet(5, 10); // 현재 5이면 10으로 변경
```

## ConcurrentHashMap

```java
import java.util.concurrent.ConcurrentHashMap;

// HashMap은 스레드 안전하지 않음
// Collections.synchronizedMap은 전체 락 → 성능 저하
// ConcurrentHashMap은 CAS + 노드별 synchronized → 높은 동시성 (Java 8+)

ConcurrentHashMap<String, Integer> map = new ConcurrentHashMap<>();
map.put("key", 1);
map.compute("key", (k, v) -> v == null ? 1 : v + 1); // 원자적 업데이트
```

# 5. 동시성 유틸리티

---

## CountDownLatch

```java
CountDownLatch latch = new CountDownLatch(3); // 카운터 3

// 3개 작업이 각각 완료되면 countDown
executor.submit(() -> { doWork(); latch.countDown(); });
executor.submit(() -> { doWork(); latch.countDown(); });
executor.submit(() -> { doWork(); latch.countDown(); });

latch.await(); // 카운터가 0이 될 때까지 대기
System.out.println("모든 작업 완료");
```

## Semaphore

```java
Semaphore semaphore = new Semaphore(3); // 동시 접근 3개로 제한

semaphore.acquire(); // 허가 획득 (가용 없으면 대기)
try {
    accessSharedResource();
} finally {
    semaphore.release(); // 허가 반환
}
```

# 6. 정리

---

| 개념 | 설명 |
|------|------|
| **ExecutorService** | 스레드 풀 관리, submit/execute로 작업 제출 |
| **CompletableFuture** | 논블로킹 비동기 체이닝, thenApply/thenCombine/exceptionally |
| **synchronized** | 가시성 + 원자성 보장, 성능 비용 있음 |
| **volatile** | 가시성만 보장, 단순 플래그에 적합 |
| **AtomicInteger** | CAS 기반 lock-free 원자적 연산 |
| **ConcurrentHashMap** | 세그먼트별 락으로 높은 동시성 |

```text
핵심:
  Thread 직접 생성 → ExecutorService (스레드 풀)
  Future.get() 블로킹 → CompletableFuture 체이닝 (논블로킹)
  synchronized는 무겁다 → Atomic/ConcurrentHashMap으로 대체 가능한지 먼저 검토
```

# Reference

---

- [Oracle - Java Concurrency Utilities](https://docs.oracle.com/javase/tutorial/essential/concurrency/)
- [Baeldung - Guide to CompletableFuture](https://www.baeldung.com/java-completablefuture)
- [Java ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- [Baeldung - ConcurrentHashMap](https://www.baeldung.com/java-concurrent-map)
