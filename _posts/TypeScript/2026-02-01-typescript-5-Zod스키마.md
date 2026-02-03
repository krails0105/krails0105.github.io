---
title: "[TypeScript] TypeScript 문법 (5) - Zod 스키마 검증"
categories:
  - TypeScript
tags:
  - [TypeScript, Zod, 스키마, 검증, Quiz Generator]
---

# Introduction

---

Zod 라이브러리로 런타임 데이터 검증과 TypeScript 타입 추출을 알아봅니다. API 응답 검증에 특히 유용합니다.

# 1. Zod란?

---

TypeScript를 위한 **스키마 검증 라이브러리**입니다.

```
📚 왜 필요한가?
- TypeScript 타입은 컴파일 타임에만 체크
- 런타임(실행 중)에는 타입 체크 없음
- API 응답 같은 외부 데이터는 예측 불가
- Zod로 런타임에도 데이터 형식 검증 가능
```

## 설치

```bash
npm install zod
```

> **참고**: Zod는 TypeScript 4.5+ 필요, 추가 설정 없이 바로 사용 가능

# 2. 기본 스키마

---

```typescript
import { z } from 'zod';

// 문자열 스키마
const nameSchema = z.string();

// 숫자 스키마
const ageSchema = z.number();

// 불리언 스키마
const activeSchema = z.boolean();

// 검증
nameSchema.parse("Hello");  // OK
nameSchema.parse(123);      // 에러! 문자열이 아님
```

# 3. 객체 스키마

---

```typescript
// src/lib/schemas/theme.ts

export const ThemeSchema = z.object({
  theme: z.string().describe('테마 이름'),
  emoji: z.string().describe('대표 이모지'),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
  }),
  keywords: z.array(z.string()),
});
```

## 메서드 체이닝

```typescript
z.string()
  .min(1)              // 최소 1글자
  .max(100)            // 최대 100글자
  .describe('설명')    // 문서화용 설명
```

# 4. 배열 스키마

---

```typescript
// src/lib/schemas/results.ts

// 문자열 배열
z.array(z.string())

// 정확히 3개
z.array(z.string()).length(3)

// 객체 배열
export const ResultTypesSchema = z.array(ResultTypeSchema).length(12);
```

# 5. enum 스키마

---

```typescript
// src/lib/schemas/questions.ts

// 특정 값만 허용
const OptionIdSchema = z.enum(['A', 'B', 'C', 'D']);

// 사용
OptionIdSchema.parse('A');  // OK
OptionIdSchema.parse('E');  // 에러!
```

# 6. 타입 추출

---

스키마에서 TypeScript 타입을 자동 추출합니다.

```typescript
// src/lib/schemas/theme.ts

export const ThemeSchema = z.object({
  theme: z.string(),
  emoji: z.string(),
  colors: z.object({
    primary: z.string(),
    secondary: z.string(),
  }),
  keywords: z.array(z.string()),
});

// 스키마에서 타입 추출
export type Theme = z.infer<typeof ThemeSchema>;

// 추출된 타입:
// {
//   theme: string;
//   emoji: string;
//   colors: { primary: string; secondary: string };
//   keywords: string[];
// }
```

## 장점

- 스키마와 타입을 한 곳에서 관리
- 스키마 수정 시 타입 자동 업데이트
- 중복 정의 방지

# 7. 데이터 검증

---

```typescript
// parse: 실패 시 에러 throw
try {
  const theme = ThemeSchema.parse(data);
  // theme은 Theme 타입으로 확정
} catch (error) {
  console.error('검증 실패');
}

// safeParse: 에러 throw 안 함
const result = ThemeSchema.safeParse(data);
if (result.success) {
  const theme = result.data;  // Theme 타입
} else {
  console.error(result.error);
}
```

# 8. 실전: API 응답 검증

---

## fetch와 함께 사용

```typescript
// API 응답 스키마 정의
const UserResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.string(),  // ISO 날짜 문자열
});

type UserResponse = z.infer<typeof UserResponseSchema>;

// API 호출 함수
async function fetchUser(id: number): Promise<UserResponse> {
  const response = await fetch(`/api/users/${id}`);
  const data = await response.json();

  // Zod로 검증 - 잘못된 응답이면 에러 발생
  return UserResponseSchema.parse(data);
}

// 사용
try {
  const user = await fetchUser(1);
  console.log(user.name);  // 타입 안전하게 접근
} catch (error) {
  console.error('API 응답 형식이 잘못됨');
}
```

## 전체 흐름

```
API 응답 (unknown)
    ↓
JSON 파싱 (response.json()) → any 타입
    ↓
Zod 검증 (Schema.parse) → 정확한 타입 확정
    ↓
타입 안전하게 사용
```

# 9. 복합 스키마 예시

---

```typescript
// src/lib/schemas/questions.ts

export const ScoringRuleSchema = z.object({
  typeId: z.string(),
  points: z.number(),
});

export const OptionSchema = z.object({
  id: z.enum(['A', 'B', 'C', 'D']),
  text: z.string(),
  scoring: z.array(ScoringRuleSchema).length(2),
});

export const QuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(OptionSchema).length(4),
});

export const QuestionsSchema = z.array(QuestionSchema).length(8);

// 타입 추출
export type Question = z.infer<typeof QuestionSchema>;
export type Option = z.infer<typeof OptionSchema>;
export type ScoringRule = z.infer<typeof ScoringRuleSchema>;
```

# 10. Zod vs 수동 검증 비교

---

```typescript
// ❌ 수동 검증 (장황하고 타입 불안전)
function validateUser(data: unknown): User {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid data');
  }
  if (typeof (data as any).name !== 'string') {
    throw new Error('Invalid name');
  }
  // ... 모든 필드 수동 검증
  return data as User;  // 타입 단언 필요
}

// ✅ Zod (간결하고 타입 안전)
const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
});
type User = z.infer<typeof UserSchema>;

const user = UserSchema.parse(data);  // 자동으로 User 타입
```

# Reference

---

- [Zod 공식 문서](https://zod.dev/)
- [Zod GitHub](https://github.com/colinhacks/zod)
