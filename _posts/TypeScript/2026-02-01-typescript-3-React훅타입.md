---
title: "[TypeScript] TypeScript 문법 (3) - React 훅과 타입"
categories:
  - TypeScript
tags:
  - [TypeScript, React, useState, useCallback, Quiz Generator]
---

# Introduction

---

Quiz Generator 프로젝트 코드를 통해 React 훅에서 TypeScript를 사용하는 방법을 알아봅니다.

# 1. useState 타입

---

## 기본 사용

```typescript
// 타입 추론 (초기값으로 추론)
const [count, setCount] = useState(0);        // number
const [name, setName] = useState('');         // string
const [isOpen, setIsOpen] = useState(false);  // boolean
```

## 제네릭으로 명시

복잡한 타입이나 null 가능 타입은 명시합니다.

```typescript
// src/app/page.tsx

interface GenerationState {
  status: Status;
  currentStep: string;
  message: string;
  zipBase64: string | null;
  filename: string | null;
  quizData: GeneratedQuizData | null;
  error: string | null;
}

const [state, setState] = useState<GenerationState>({
  status: 'idle',
  currentStep: '',
  message: '',
  zipBase64: null,
  filename: null,
  quizData: null,
  error: null,
});
```

## null 가능 타입

```typescript
// src/components/preview/QuizPreview.tsx

// ScoreResult 또는 null
const [result, setResult] = useState<ScoreResult | null>(null);

// 사용 시 null 체크 필요
if (result) {
  console.log(result.mainType);  // OK
}
```

# 2. 함수형 업데이트

---

이전 상태를 기반으로 새 상태를 계산합니다.

```typescript
// prev: 이전 상태값 (타입 자동 추론)
setState((prev) => ({
  ...prev,              // 이전 상태 복사
  status: 'generating', // 일부만 변경
}));

// 배열 업데이트
setAnswers(prev => {
  const newAnswers = [...prev];  // 배열 복사
  newAnswers.push({ questionId, optionId });
  return newAnswers;
});
```

# 3. useCallback 타입

---

함수를 메모이제이션(캐싱)합니다.

```typescript
// src/app/page.tsx

// 매개변수 타입 명시
const handleGenerate = useCallback(async (topic: string) => {
  setState({ ... });
  // ...
}, []);  // 의존성 배열

// 반환값 없는 함수
const handleReset = useCallback(() => {
  setState({ status: 'idle', ... });
}, []);
```

## 의존성 배열

```typescript
// 의존성 배열에 있는 값이 변경되면 함수 재생성
const handleComplete = useCallback(() => {
  const computed = computeResult(answers, data.questions);
  setResult(computed);
}, [answers, data.questions]);  // answers나 questions 변경 시 재생성
```

# 4. Props 타입 정의

---

컴포넌트가 받는 속성의 타입입니다.

```typescript
// src/components/GeneratorForm.tsx

interface GeneratorFormProps {
  onSubmit: (topic: string) => void;  // 콜백 함수
  isLoading: boolean;
}

export default function GeneratorForm({
  onSubmit,
  isLoading
}: GeneratorFormProps) {
  // ...
}
```

## 구조 분해와 타입

```typescript
// 구조 분해 할당 + 타입
function Component({ name, count }: { name: string; count: number }) {
  return <div>{name}: {count}</div>;
}

// 또는 인터페이스 분리
interface Props {
  name: string;
  count: number;
}

function Component({ name, count }: Props) {
  return <div>{name}: {count}</div>;
}
```

# 5. children 타입

---

```typescript
interface LayoutProps {
  children: React.ReactNode;  // 모든 React 렌더링 가능 요소
}

function Layout({ children }: LayoutProps) {
  return <div className="container">{children}</div>;
}
```

## React 타입들

| 타입 | 설명 |
|------|------|
| `React.ReactNode` | 모든 렌더링 가능 요소 |
| `React.ReactElement` | JSX 요소만 |
| `React.FC<Props>` | 함수형 컴포넌트 타입 (권장 안 함) |

# 6. 이벤트 핸들러 타입

---

```typescript
// 폼 제출 이벤트
const handleSubmit = (e: React.FormEvent) => {
  e.preventDefault();
};

// Input 변경 이벤트
const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  setTopic(e.target.value);
};

// 버튼 클릭 이벤트
const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
  console.log('clicked');
};
```

## 인라인 이벤트 핸들러

```typescript
// 타입 자동 추론됨
<input
  onChange={(e) => setTopic(e.target.value)}  // e는 자동으로 ChangeEvent
/>

<button
  onClick={() => setCount(count + 1)}  // 매개변수 없으면 타입 불필요
>
```

# 7. 실제 사용 예시

---

```typescript
// src/components/preview/QuizPreview.tsx

interface QuizPreviewProps {
  data: GeneratedQuizData;
  onExit: () => void;
}

export default function QuizPreview({ data, onExit }: QuizPreviewProps) {
  const [page, setPage] = useState<PreviewPage>('landing');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [result, setResult] = useState<ScoreResult | null>(null);

  const handleSelectAnswer = useCallback((
    questionId: string,
    optionId: 'A' | 'B' | 'C' | 'D'
  ) => {
    setAnswers(prev => {
      const newAnswers = [...prev];
      // ...
      return newAnswers;
    });
  }, []);

  // ...
}
```

# Reference

---

- [React TypeScript Cheatsheet](https://react-typescript-cheatsheet.netlify.app/)
- Quiz Generator: `src/components/preview/QuizPreview.tsx`
