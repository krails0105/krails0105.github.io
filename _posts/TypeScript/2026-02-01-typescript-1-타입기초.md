---
title: "[TypeScript] TypeScript 문법 (1) - 타입 기초"
categories:
  - TypeScript
tags:
  - [TypeScript, 타입, 인터페이스, Quiz Generator]
---

# Introduction

---

실제 React 프로젝트 예시를 통해 TypeScript의 기본 타입 문법을 알아봅니다.

> **예시 프로젝트**: 이 시리즈에서는 "Quiz Generator"라는 심리 테스트 생성 앱의 코드를 예시로 사용합니다. AI로 퀴즈를 생성하고, 사용자가 퀴즈를 풀면 결과를 보여주는 React + TypeScript 앱입니다.

# 1. 기본 타입

---

```typescript
// 문자열
const topic: string = "연애 심리 테스트";

// 숫자
const count: number = 12;

// 불리언
const isLoading: boolean = false;

// null 가능 타입
const error: string | null = null;
```

## 타입 추론

타입을 명시하지 않아도 TypeScript가 추론합니다.

```typescript
// 타입 명시
const name: string = "Quiz";

// 타입 추론 (동일하게 동작)
const name = "Quiz";  // string으로 추론됨
```

# 2. 배열 타입

---

```typescript
// 문자열 배열
const keywords: string[] = ["연애", "심리", "테스트"];

// 객체 배열
const questions: Question[] = [];

// Array<타입> 형태 (동일)
const items: Array<string> = ["a", "b", "c"];
```

# 3. 인터페이스 (interface)

---

객체의 **구조(모양)**를 정의합니다.

```typescript
// src/components/preview/types.ts

interface ScoringRule {
  typeId: string;   // 필수 속성
  points: number;
}

interface Option {
  id: 'A' | 'B' | 'C' | 'D';  // 리터럴 타입
  text: string;
  scoring: ScoringRule[];     // 다른 인터페이스 배열
}

interface Question {
  id: string;
  text: string;
  options: Option[];          // 중첩 구조
}
```

## 중첩 객체

```typescript
interface Theme {
  theme: string;
  emoji: string;
  colors: {           // 중첩 객체
    primary: string;
    secondary: string;
  };
  keywords: string[];
}
```

# 4. 선택적 속성 (Optional)

---

`?`를 붙이면 해당 속성이 없어도 됩니다.

```typescript
interface ScoreResult {
  mainType: string;           // 필수
  subType?: string;           // 선택적 (없을 수 있음)
  scores: Record<string, number>;
  isMixed: boolean;
}

// 사용
const result1: ScoreResult = {
  mainType: "type_a",
  scores: {},
  isMixed: false
  // subType 없어도 OK
};

const result2: ScoreResult = {
  mainType: "type_a",
  subType: "type_b",  // 있어도 OK
  scores: {},
  isMixed: true
};
```

# 5. 유니온 타입 (Union Type)

---

여러 타입 중 하나를 가질 수 있습니다.

```typescript
// 문자열 리터럴 유니온
type Status = 'idle' | 'generating' | 'complete' | 'error';

// 사용
let status: Status = 'idle';
status = 'generating';  // OK
status = 'invalid';     // 에러! 허용되지 않는 값

// 타입 유니온
type Result = string | null;
let error: Result = null;
error = "오류 발생";  // OK
```

# 6. 리터럴 타입

---

특정 값만 허용합니다.

```typescript
interface Option {
  // 'A', 'B', 'C', 'D' 중 하나만 가능
  id: 'A' | 'B' | 'C' | 'D';
  text: string;
}

// 사용
const option: Option = {
  id: 'A',      // OK
  text: "선택지"
};

const option2: Option = {
  id: 'E',      // 에러! 'E'는 허용 안 됨
  text: "선택지"
};
```

# 7. Record 타입

---

키와 값의 타입을 지정한 객체입니다.

```typescript
// Record<키타입, 값타입>
type Scores = Record<string, number>;

// 동일한 표현
type Scores = {
  [key: string]: number;
};

// 사용
const scores: Scores = {
  "type_a": 10,
  "type_b": 8,
  "type_c": 5
};
```

# 8. export와 재사용

---

```typescript
// types.ts - 타입 정의
export interface Question { ... }
export interface Theme { ... }
export type Status = 'idle' | 'generating';

// 다른 파일에서 사용
import type { Question, Theme, Status } from './types';
```

`import type`은 타입만 가져옵니다 (런타임에 사용 안 됨).

# 9. 유틸리티 타입 (Utility Types)

---

TypeScript가 기본 제공하는 타입 변환 도구입니다.

## Partial<T> - 모든 속성을 선택적으로

```typescript
interface User {
  name: string;
  age: number;
  email: string;
}

// 모든 속성이 선택적 (업데이트 시 유용)
type PartialUser = Partial<User>;
// { name?: string; age?: number; email?: string; }

function updateUser(id: string, updates: Partial<User>) {
  // name만 업데이트해도 OK
}
updateUser('1', { name: '새이름' });
```

## Pick<T, K> - 특정 속성만 선택

```typescript
// name과 email만 선택
type UserPreview = Pick<User, 'name' | 'email'>;
// { name: string; email: string; }
```

## Omit<T, K> - 특정 속성 제외

```typescript
// age 제외
type UserWithoutAge = Omit<User, 'age'>;
// { name: string; email: string; }
```

## 자주 쓰는 유틸리티 타입

| 타입 | 설명 |
|------|------|
| `Partial<T>` | 모든 속성을 선택적으로 |
| `Required<T>` | 모든 속성을 필수로 |
| `Pick<T, K>` | 특정 속성만 선택 |
| `Omit<T, K>` | 특정 속성 제외 |
| `Record<K, V>` | 키-값 객체 타입 |
| `Readonly<T>` | 모든 속성을 읽기 전용으로 |

# Reference

---

- [TypeScript 공식 문서](https://www.typescriptlang.org/docs/)
- Quiz Generator: `src/components/preview/types.ts`
