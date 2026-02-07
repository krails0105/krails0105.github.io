---
title: "[Java] Java Time API - LocalDateTime, ZonedDateTime, 타임존 처리"
categories:
  - Java
tags:
  - [Java, DateTime, LocalDateTime, ZonedDateTime, TimeZone]
---

# Introduction

---

Java 8 이전의 `Date`, `Calendar`는 가변(mutable)이고, 스레드 안전하지 않으며, API가 직관적이지 않았습니다. Java 8에서 도입된 **java.time** 패키지는 이 문제들을 해결한 **불변(immutable)**, **스레드 안전**, **명확한 API**를 제공합니다.

이 글은 java.time의 핵심 클래스들과 타임존 처리, 그리고 실무에서 자주 마주치는 변환 패턴을 정리합니다.

# 1. 핵심 클래스 개요

---

```text
┌─────────────────────────────────────────────────────────────┐
│                      java.time 주요 클래스                    │
├─────────────────────────────────────────────────────────────┤
│  LocalDate       │ 날짜만 (2024-01-15)                       │
│  LocalTime       │ 시간만 (14:30:00)                         │
│  LocalDateTime   │ 날짜 + 시간 (2024-01-15T14:30:00)         │
│  ZonedDateTime   │ 날짜 + 시간 + 타임존                      │
│  Instant         │ 타임스탬프 (epoch 기준)                    │
│  Duration        │ 시간 기반 간격 (2시간 30분)                │
│  Period          │ 날짜 기반 간격 (1년 2개월)                 │
│  ZoneId          │ 타임존 ID (Asia/Seoul)                    │
│  ZoneOffset      │ UTC 오프셋 (+09:00)                       │
└─────────────────────────────────────────────────────────────┘
```

## 선택 가이드

```text
타임존이 필요 없다:
  - 날짜만: LocalDate
  - 시간만: LocalTime
  - 날짜+시간: LocalDateTime

타임존이 필요하다:
  - 특정 지역 시각: ZonedDateTime
  - UTC 기준 순간: Instant
  - DB 저장/API 통신: Instant 또는 ZonedDateTime
```

# 2. LocalDate, LocalTime, LocalDateTime

---

## LocalDate - 날짜만

```java
// 생성
LocalDate today = LocalDate.now();                    // 2024-01-15
LocalDate date = LocalDate.of(2024, 1, 15);           // 2024-01-15
LocalDate parsed = LocalDate.parse("2024-01-15");     // 2024-01-15

// 조회
int year = date.getYear();           // 2024
Month month = date.getMonth();       // JANUARY
int day = date.getDayOfMonth();      // 15
DayOfWeek dow = date.getDayOfWeek(); // MONDAY

// 연산 (불변: 새 객체 반환)
LocalDate tomorrow = today.plusDays(1);
LocalDate lastMonth = today.minusMonths(1);
LocalDate nextYear = today.withYear(2025);
```

## LocalTime - 시간만

```java
LocalTime now = LocalTime.now();                  // 14:30:00.123
LocalTime time = LocalTime.of(14, 30, 0);         // 14:30:00
LocalTime parsed = LocalTime.parse("14:30:00");   // 14:30:00

int hour = time.getHour();      // 14
int minute = time.getMinute();  // 30

LocalTime later = time.plusHours(2);  // 16:30:00
```

## LocalDateTime - 날짜 + 시간

```java
LocalDateTime now = LocalDateTime.now();
LocalDateTime dt = LocalDateTime.of(2024, 1, 15, 14, 30, 0);
LocalDateTime dt2 = LocalDateTime.of(date, time);  // 조합

// 분해
LocalDate datePart = dt.toLocalDate();
LocalTime timePart = dt.toLocalTime();

// 연산
LocalDateTime nextWeek = now.plusWeeks(1);
LocalDateTime startOfDay = now.toLocalDate().atStartOfDay();  // 00:00:00
```

## 불변성

```java
LocalDate date = LocalDate.of(2024, 1, 15);
date.plusDays(1);  // 새 객체 반환, date는 변경 안 됨!

LocalDate tomorrow = date.plusDays(1);  // 이렇게 받아야 함
```

# 3. ZonedDateTime과 타임존

---

## ZonedDateTime

**LocalDateTime + ZoneId** = 특정 타임존의 날짜/시간

```java
// 생성
ZonedDateTime seoulNow = ZonedDateTime.now(ZoneId.of("Asia/Seoul"));
ZonedDateTime utcNow = ZonedDateTime.now(ZoneOffset.UTC);

ZonedDateTime zdt = ZonedDateTime.of(
    LocalDateTime.of(2024, 1, 15, 14, 30),
    ZoneId.of("Asia/Seoul")
);
// 2024-01-15T14:30:00+09:00[Asia/Seoul]

// LocalDateTime에 타임존 부여
LocalDateTime ldt = LocalDateTime.now();
ZonedDateTime zdt2 = ldt.atZone(ZoneId.of("Asia/Seoul"));
```

## 타임존 변환

```java
ZonedDateTime seoul = ZonedDateTime.now(ZoneId.of("Asia/Seoul"));
// 2024-01-15T14:30:00+09:00[Asia/Seoul]

ZonedDateTime newYork = seoul.withZoneSameInstant(ZoneId.of("America/New_York"));
// 2024-01-15T00:30:00-05:00[America/New_York] (같은 순간)

ZonedDateTime sameLocal = seoul.withZoneSameLocal(ZoneId.of("America/New_York"));
// 2024-01-15T14:30:00-05:00[America/New_York] (같은 로컬 시각, 다른 순간)
```

| 메서드 | 설명 |
|--------|------|
| `withZoneSameInstant()` | 같은 순간, 다른 로컬 시각 |
| `withZoneSameLocal()` | 같은 로컬 시각, 다른 순간 |

## ZoneId vs ZoneOffset

```java
ZoneId zoneId = ZoneId.of("Asia/Seoul");       // 지역 기반 (DST 자동 처리)
ZoneOffset offset = ZoneOffset.of("+09:00");   // 고정 오프셋

// 일광 절약 시간(DST)이 있는 지역은 ZoneId 권장
ZoneId la = ZoneId.of("America/Los_Angeles");  // -08:00 또는 -07:00
```

# 4. Instant - 기계 시간

---

## Instant란?

**Unix Epoch(1970-01-01T00:00:00Z)**부터의 초/나노초. 타임존 없이 **절대적인 순간**을 표현합니다.

```java
Instant now = Instant.now();  // 2024-01-15T05:30:00.123Z (UTC)
Instant epoch = Instant.EPOCH;  // 1970-01-01T00:00:00Z

// epoch 밀리초로 변환
long epochMilli = now.toEpochMilli();

// epoch 밀리초에서 생성
Instant fromMilli = Instant.ofEpochMilli(1705300200000L);
```

## Instant ↔ ZonedDateTime 변환

```java
Instant instant = Instant.now();

// Instant → ZonedDateTime (타임존 부여)
ZonedDateTime zdt = instant.atZone(ZoneId.of("Asia/Seoul"));

// ZonedDateTime → Instant (타임존 제거)
Instant back = zdt.toInstant();
```

## DB 저장 권장 패턴

```java
// 저장: Instant 또는 UTC 기준
Instant createdAt = Instant.now();

// 조회 후 표시: 사용자 타임존으로 변환
ZonedDateTime userTime = createdAt.atZone(ZoneId.of("Asia/Seoul"));
```

# 5. Duration과 Period

---

## Duration - 시간 기반 간격

```java
Duration duration = Duration.ofHours(2);  // 2시간
Duration d2 = Duration.between(time1, time2);  // 두 시각 사이

long hours = duration.toHours();
long minutes = duration.toMinutes();

// 시간 더하기
LocalTime later = time.plus(Duration.ofMinutes(30));
```

## Period - 날짜 기반 간격

```java
Period period = Period.ofMonths(3);  // 3개월
Period p2 = Period.between(date1, date2);  // 두 날짜 사이

int years = period.getYears();
int months = period.getMonths();
int days = period.getDays();

// 날짜 더하기
LocalDate future = date.plus(Period.ofWeeks(2));
```

## 차이점

```text
Duration: 초/나노초 기반 (정확한 시간)
  - 2시간 = 7200초

Period: 날짜 단위 (달력 기준)
  - 1개월 = 28~31일 (가변)
```

# 6. 포맷팅과 파싱

---

## DateTimeFormatter

```java
DateTimeFormatter formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

// 포맷팅 (객체 → 문자열)
LocalDateTime dt = LocalDateTime.now();
String str = dt.format(formatter);  // "2024-01-15 14:30:00"

// 파싱 (문자열 → 객체)
LocalDateTime parsed = LocalDateTime.parse("2024-01-15 14:30:00", formatter);
```

## 주요 패턴

| 패턴 | 의미 | 예시 |
|------|------|------|
| `yyyy` | 4자리 연도 | 2024 |
| `MM` | 2자리 월 | 01 |
| `dd` | 2자리 일 | 15 |
| `HH` | 24시간 | 14 |
| `hh` | 12시간 | 02 |
| `mm` | 분 | 30 |
| `ss` | 초 | 00 |
| `SSS` | 밀리초 | 123 |
| `a` | AM/PM | PM |
| `z` | 타임존 이름 | KST |
| `Z` | 오프셋 | +0900 |

## ISO 표준 포맷터

```java
// 미리 정의된 포맷터
DateTimeFormatter.ISO_LOCAL_DATE       // 2024-01-15
DateTimeFormatter.ISO_LOCAL_DATE_TIME  // 2024-01-15T14:30:00
DateTimeFormatter.ISO_ZONED_DATE_TIME  // 2024-01-15T14:30:00+09:00[Asia/Seoul]
DateTimeFormatter.ISO_INSTANT          // 2024-01-15T05:30:00Z
```

# 7. 레거시 변환

---

## Date ↔ Instant

```java
// Date → Instant
Date legacyDate = new Date();
Instant instant = legacyDate.toInstant();

// Instant → Date
Date date = Date.from(instant);
```

## Date ↔ LocalDateTime

```java
// Date → LocalDateTime
Date legacyDate = new Date();
LocalDateTime ldt = legacyDate.toInstant()
    .atZone(ZoneId.systemDefault())
    .toLocalDateTime();

// LocalDateTime → Date
LocalDateTime ldt = LocalDateTime.now();
Date date = Date.from(ldt.atZone(ZoneId.systemDefault()).toInstant());
```

## Calendar ↔ ZonedDateTime

```java
// Calendar → ZonedDateTime
Calendar calendar = Calendar.getInstance();
ZonedDateTime zdt = ZonedDateTime.ofInstant(
    calendar.toInstant(),
    calendar.getTimeZone().toZoneId()
);

// ZonedDateTime → Calendar
ZonedDateTime zdt = ZonedDateTime.now();
Calendar calendar = GregorianCalendar.from(zdt);
```

# 8. 실무 패턴

---

## 패턴 1: 오늘의 시작/끝

```java
LocalDate today = LocalDate.now();
LocalDateTime startOfDay = today.atStartOfDay();       // 00:00:00
LocalDateTime endOfDay = today.atTime(LocalTime.MAX);  // 23:59:59.999999999
```

## 패턴 2: 이번 달 첫날/마지막날

```java
LocalDate today = LocalDate.now();
LocalDate firstDay = today.withDayOfMonth(1);
LocalDate lastDay = today.withDayOfMonth(today.lengthOfMonth());

// 또는
YearMonth yearMonth = YearMonth.now();
LocalDate first = yearMonth.atDay(1);
LocalDate last = yearMonth.atEndOfMonth();
```

## 패턴 3: 두 날짜 사이 기간

```java
LocalDate start = LocalDate.of(2024, 1, 1);
LocalDate end = LocalDate.of(2024, 12, 31);

long days = ChronoUnit.DAYS.between(start, end);   // 365
long months = ChronoUnit.MONTHS.between(start, end); // 11
```

## 패턴 4: 영업일 계산

```java
LocalDate date = LocalDate.now();

// 5 영업일 후
LocalDate result = date;
int addedDays = 0;
while (addedDays < 5) {
    result = result.plusDays(1);
    if (result.getDayOfWeek() != DayOfWeek.SATURDAY &&
        result.getDayOfWeek() != DayOfWeek.SUNDAY) {
        addedDays++;
    }
}
```

## 패턴 5: 타임존 안전한 비교

```java
Instant instant1 = ZonedDateTime.parse("2024-01-15T14:00:00+09:00[Asia/Seoul]").toInstant();
Instant instant2 = ZonedDateTime.parse("2024-01-15T00:00:00-05:00[America/New_York]").toInstant();

// Instant로 비교하면 타임존 무관하게 순간 비교
instant1.isBefore(instant2);  // true
```

# 9. 정리

---

| 클래스 | 용도 | 타임존 |
|--------|------|--------|
| `LocalDate` | 날짜만 | 없음 |
| `LocalTime` | 시간만 | 없음 |
| `LocalDateTime` | 날짜 + 시간 | 없음 |
| `ZonedDateTime` | 날짜 + 시간 + 타임존 | 있음 |
| `Instant` | 타임스탬프 (UTC) | UTC 기준 |
| `Duration` | 시간 간격 | - |
| `Period` | 날짜 간격 | - |

```text
핵심:
  java.time은 불변, 스레드 안전, 명확한 API.
  타임존이 필요하면 ZonedDateTime 또는 Instant.
  DB 저장은 Instant(UTC), 표시는 사용자 타임존으로 변환.
  Date/Calendar는 java.time으로 마이그레이션 권장.
```

# Reference

---

- [Java Time API (Oracle)](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/time/package-summary.html)
- [Java 8 Date/Time Guide](https://www.baeldung.com/java-8-date-time-intro)
- [DateTimeFormatter Patterns](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/time/format/DateTimeFormatter.html)
