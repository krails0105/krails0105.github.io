---
title: "[TypeScript] TypeScript 문법 (2) - 함수와 제네릭"
categories:
  - TypeScript
tags:
  - [TypeScript, 함수, 제네릭, Quiz Generator]
---

# Introduction

---

실제 React 프로젝트 예시를 통해 TypeScript 함수 타입과 제네릭을 알아봅니다.

# 1. 함수 매개변수 타입

---

```typescript
// 기본 함수
function greet(name: string): string {
  return `Hello, ${name}!`;
}

// 화살표 함수
const add = (a: number, b: number): number => {
  return a + b;
};
```

## Quiz Generator 예시

```typescript
// src/lib/generators/theme.ts
export async function generateTheme(topic: string): Promise<Theme> {
  // topic은 string 타입
  // 반환값은 Promise<Theme> 타입
}
```

# 2. 콜백 함수 타입

---

함수를 매개변수로 받을 때의 타입 정의입니다.

```typescript
// 콜백 함수 타입: (매개변수타입) => 반환타입
interface FormProps {
  onSubmit: (topic: string) => void;  // string을 받고 반환 없음
  isLoading: boolean;
}

// 사용
function Form({ onSubmit, isLoading }: FormProps) {
  // onSubmit("테스트"); 형태로 호출
}
```

## 이벤트 핸들러

```typescript
// React 이벤트 타입
const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
};

const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  console.log(e.target.value);
};
```

# 3. 제네릭 (Generic)

---

타입을 **매개변수**처럼 사용합니다.

```typescript
// src/lib/ai/client.ts

// <T>: 타입 매개변수 (호출 시 결정됨)
export async function generateWithClaude<T>(
  systemPrompt: string,
  userPrompt: string,
  parseResponse: (text: string) => T  // T 타입을 반환하는 함수
): Promise<T> {                       // T 타입을 Promise로 반환
  // ...
  return parseResponse(textContent.text);
}
```

## 제네릭 사용

```typescript
// Theme 타입으로 호출
const theme = await generateWithClaude<Theme>(
  systemPrompt,
  userPrompt,
  parseTheme  // (text: string) => Theme
);
// theme의 타입은 Theme

// ResultType[] 타입으로 호출
const results = await generateWithClaude<ResultType[]>(
  systemPrompt,
  userPrompt,
  parseResults  // (text: string) => ResultType[]
);
// results의 타입은 ResultType[]
```

## 제네릭의 장점

```typescript
// 제네릭 없이 (타입 안전성 없음)
function generate(prompt: string): any {
  // any는 모든 타입 허용 → 타입 검사 무력화
}

// 제네릭 사용 (타입 안전)
function generate<T>(prompt: string): Promise<T> {
  // T에 따라 반환 타입이 결정됨
}
```

# 4. useState 제네릭

---

React의 useState도 제네릭입니다.

```typescript
// 타입 명시
const [state, setState] = useState<GenerationState>({
  status: 'idle',
  currentStep: '',
  // ...
});

// 타입 추론 (초기값으로 추론)
const [count, setCount] = useState(0);  // number로 추론

// null 가능 타입
const [result, setResult] = useState<ScoreResult | null>(null);
```

# 5. Promise 타입

---

비동기 함수의 반환 타입입니다.

```typescript
// Promise<반환타입>
async function fetchData(): Promise<string> {
  const response = await fetch('/api/data');
  return response.text();  // string 반환
}

// 사용
const data = await fetchData();  // data는 string 타입
```

## Quiz Generator 예시

```typescript
// src/lib/generators/orchestrator.ts

export async function* generateQuiz(
  topic: string
): AsyncGenerator<GenerationProgress, GeneratedQuiz, unknown> {
  // AsyncGenerator<Yield타입, Return타입, Next타입>
}
```

# 6. 타입 단언 (Type Assertion)

---

TypeScript에게 "이 타입이 맞다"고 알려줍니다.

```typescript
// as 키워드
const scores = Object.fromEntries(
  typeIds.map(id => [id, 0])
) as Record<string, number>;

// Object.entries의 결과를 명시적으로 타입 지정
const sortedTypes = (
  Object.entries(scores) as [string, number][]
).sort((a, b) => b[1] - a[1]);
```

## ! (Non-null Assertion)

```typescript
// document.getElementById는 null 반환 가능
const root = document.getElementById('root');  // HTMLElement | null

// !를 붙이면 "null이 아님"을 단언
const root = document.getElementById('root')!;  // HTMLElement
```

# 7. 함수 오버로드 (참고)

---

같은 함수가 여러 형태의 매개변수를 받을 때:

```typescript
// 오버로드 시그니처
function process(value: string): string;
function process(value: number): number;

// 실제 구현
function process(value: string | number): string | number {
  if (typeof value === 'string') {
    return value.toUpperCase();
  }
  return value * 2;
}
```

# Reference

---

- [TypeScript 제네릭](https://www.typescriptlang.org/docs/handbook/2/generics.html)
- Quiz Generator: `src/lib/ai/client.ts`
