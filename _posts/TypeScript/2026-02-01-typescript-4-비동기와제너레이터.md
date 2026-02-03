---
title: "[TypeScript] TypeScript 문법 (4) - 비동기 프로그래밍"
categories:
  - TypeScript
tags:
  - [TypeScript, async, await, Generator, Quiz Generator]
---

# Introduction

---

실제 React 프로젝트 예시를 통해 TypeScript의 비동기 프로그래밍 패턴을 알아봅니다.

# 1. async/await 기초

---

```typescript
// async: 이 함수는 비동기 함수
// await: Promise가 완료될 때까지 대기
async function fetchData(): Promise<string> {
  const response = await fetch('/api/data');
  const text = await response.text();
  return text;  // Promise<string> 반환
}

// 사용
const data = await fetchData();
```

## 반환 타입

```typescript
// async 함수는 항상 Promise를 반환
async function example(): Promise<number> {
  return 42;  // 실제로는 Promise.resolve(42)
}
```

# 2. try-catch 에러 처리

---

```typescript
// src/app/page.tsx

try {
  const response = await fetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ topic }),
  });

  if (!response.ok) {
    throw new Error('API 요청 실패');
  }

  // 성공 처리
} catch (error) {
  // error의 타입은 unknown
  if (error instanceof Error) {
    console.log(error.message);  // Error 인스턴스면 message 접근 가능
  }
}
```

## error 타입 처리

```typescript
// error는 unknown 타입 (무엇이든 될 수 있음)
catch (error) {
  // instanceof로 타입 좁히기
  const message = error instanceof Error
    ? error.message
    : '알 수 없는 오류';
}
```

# 3. 제너레이터 함수

---

`yield`로 값을 하나씩 반환하는 특별한 함수입니다.

```typescript
// function* : 제너레이터 함수 선언
function* countUp(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
}

// 사용
const gen = countUp();
console.log(gen.next());  // { value: 1, done: false }
console.log(gen.next());  // { value: 2, done: false }
console.log(gen.next());  // { value: 3, done: false }
console.log(gen.next());  // { value: undefined, done: true }
```

# 4. 비동기 제너레이터

---

`async function*`으로 비동기와 제너레이터를 결합합니다.

```typescript
// src/lib/generators/orchestrator.ts

// AsyncGenerator<Yield타입, Return타입, Next타입>
export async function* generateQuiz(
  topic: string
): AsyncGenerator<GenerationProgress, GeneratedQuiz, unknown> {

  // yield: 진행 상태 반환 (일시 중지)
  yield { step: 'theme', message: '테마 분석 중...' };
  const theme = await generateTheme(topic);

  yield { step: 'results', message: '결과 유형 생성 중...' };
  const resultTypes = await generateResults(theme);

  // return: 최종 결과 반환 (종료)
  return {
    theme,
    resultTypes,
    // ...
  };
}
```

## 제너레이터 타입 설명

```typescript
AsyncGenerator<
  GenerationProgress,  // yield로 반환하는 타입
  GeneratedQuiz,       // return으로 반환하는 타입
  unknown              // .next()로 전달받는 타입
>
```

# 5. 제너레이터 사용

---

```typescript
// src/app/api/generate/route.ts

const generator = generateQuiz(topic);
let result;

while (true) {
  // .next(): 다음 yield/return까지 실행
  const { value, done } = await generator.next();

  if (done) {
    // done이 true면 return 값
    result = value;  // GeneratedQuiz 타입
    break;
  }

  // done이 false면 yield 값
  const progress = value as GenerationProgress;
  console.log(progress.message);
}
```

# 6. IIFE (즉시 실행 함수)

---

함수를 정의와 동시에 실행합니다.

```typescript
// src/app/api/generate/route.ts

// (async () => { ... })() : 비동기 IIFE
(async () => {
  try {
    const generator = generateQuiz(topic);
    // 백그라운드에서 실행
  } catch (error) {
    console.error(error);
  }
})();  // ← 바로 실행

// 응답은 먼저 반환
return new Response(stream.readable);
```

## IIFE의 용도

- 백그라운드 작업 시작
- 응답을 먼저 반환하고 작업 계속
- 스코프 분리

# 7. Stream 처리

---

```typescript
// 브라우저에서 스트림 읽기
const reader = response.body?.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  // chunk 처리
}
```

## 서버에서 스트림 쓰기

```typescript
const encoder = new TextEncoder();
const stream = new TransformStream();
const writer = stream.writable.getWriter();

// 데이터 쓰기
await writer.write(
  encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
);

// 스트림 종료
await writer.close();
```

# Reference

---

- [MDN - async function](https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/Statements/async_function)
- [MDN - Generator](https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/Global_Objects/Generator)
- Quiz Generator: `src/lib/generators/orchestrator.ts`
