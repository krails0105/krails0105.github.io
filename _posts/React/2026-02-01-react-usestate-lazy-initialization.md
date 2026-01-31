---
title: "[React] useState Lazy Initialization vs useEffect - 초기값 설정의 올바른 방법"
categories:
  - React
tags:
  - [React, Hooks, useState, useEffect, StrictMode]
---

# Introduction

---

React에서 localStorage나 계산 비용이 큰 초기값을 설정할 때, **useEffect**와 **useState의 Lazy Initialization** 중 어떤 것을 써야 할까요?

이 글에서는 실제 프로젝트에서 겪은 이슈와 해결 과정을 통해 두 방식의 차이를 알아봅니다.

# 문제 상황

---

## 퀴즈 앱에서 발생한 이슈

연애 대화 스타일 테스트 앱에서 퀴즈를 완료하면 결과 페이지로 이동해야 합니다. 그런데 이상한 현상이 발생했습니다.

```
1. 마지막 질문 답변 후 "결과 보기" 클릭
2. completeQuiz() 호출 → isCompleted: true 설정
3. 그런데 콘솔에서 isCompleted가 다시 false로 출력됨!
```

## 원래 코드 (문제가 있던 코드)

```tsx
// useQuizState.ts

export function useQuizState() {
  // 1️⃣ 빈 상태로 시작
  const [state, setState] = useState<QuizState>(initialState);

  // 2️⃣ 마운트 후에 localStorage에서 복원
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      setState({
        currentIndex: parsed.currentIndex,
        answers: parsed.answers,
        result: parsed.result,
        isCompleted: parsed.result !== null,
      });
    }
  }, []);

  // ... 나머지 코드
}
```

# 원인 분석

---

## React StrictMode의 동작

`main.tsx`를 보면 앱이 `StrictMode`로 감싸져 있습니다.

```tsx
// main.tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

React 18의 **StrictMode**는 개발 모드에서 컴포넌트를 **두 번 마운트**합니다:

1. 마운트 → effect 실행 → **언마운트** → 다시 마운트 → effect 실행

이는 버그를 찾기 위한 의도적인 동작입니다.

## useEffect 방식의 실행 순서

```
컴포넌트 마운트
     ↓
┌─────────────────────────────────┐
│ useState(initialState)          │ ← isCompleted: false
└─────────────────────────────────┘
     ↓
┌─────────────────────────────────┐
│ 🖥️ 첫 번째 렌더링 (화면 그림)    │ ← false 상태로 화면 그림!
└─────────────────────────────────┘
     ↓
┌─────────────────────────────────┐
│ useEffect 실행                  │ ← 화면 그린 "후에" 실행
│ → localStorage에서 복원          │
│ → setState({ isCompleted: true })│
└─────────────────────────────────┘
     ↓
┌─────────────────────────────────┐
│ 🖥️ 두 번째 렌더링 (화면 다시 그림)│ ← 이제야 true!
└─────────────────────────────────┘
```

**문제**: 첫 렌더링에서 `isCompleted: false`로 화면이 그려집니다.

## 페이지 이동 시 발생하는 상황

Quiz 페이지에서 Result 페이지로 이동할 때:

```
Quiz 페이지
├── completeQuiz() → isCompleted: true
├── useEffect([state]) → localStorage에 저장
└── useEffect([isCompleted]) → navigate('/result')
     ↓
Result 페이지 마운트
├── useState(initialState) → isCompleted: false ❌
├── 🖥️ 첫 렌더링 (false 상태)
├── useEffect([]) → localStorage에서 복원 → isCompleted: true
└── 🖥️ 두 번째 렌더링 (true 상태)
```

**7번(false)과 8번(true) 사이**에 잘못된 상태로 한 번 렌더링됩니다.

# 해결 방법: Lazy Initialization

---

## Lazy Initialization이란?

`useState`에 값 대신 **함수**를 전달하면, 그 함수는 컴포넌트가 **최초 마운트될 때 딱 1번만** 실행됩니다.

```tsx
// 일반 초기화 - 매 렌더링마다 initialState 평가 (사용은 첫 번째만)
const [state, setState] = useState(initialState);

// Lazy Initialization - 첫 마운트 시 함수 실행, 그 결과가 초기값
const [state, setState] = useState(() => {
  // 이 함수는 딱 1번만 실행됨
  return 계산된_초기값;
});
```

## 수정된 코드

```tsx
// useQuizState.ts

export function useQuizState() {
  // Lazy Initialization: 렌더링 "전에" localStorage에서 읽어서 시작
  const [state, setState] = useState<QuizState>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: StoredState = JSON.parse(stored);
        return {
          currentIndex: parsed.currentIndex,
          answers: parsed.answers,
          result: parsed.result,
          isCompleted: parsed.result !== null,
        };
      }
    } catch (e) {
      console.error('Failed to restore quiz state:', e);
    }
    return initialState;
  });

  // localStorage 저장은 여전히 useEffect 사용
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // ... 나머지 코드
}
```

## Lazy Initialization의 실행 순서

```
컴포넌트 마운트
     ↓
┌─────────────────────────────────┐
│ useState(() => {                │
│   localStorage에서 읽기          │ ← 렌더링 "전에" 실행!
│   return { isCompleted: true }  │
│ })                              │
└─────────────────────────────────┘
     ↓
┌─────────────────────────────────┐
│ 🖥️ 첫 번째 렌더링 (화면 그림)    │ ← 처음부터 true!
└─────────────────────────────────┘
```

# 비교 정리

---

## 실행 타이밍 비교

| 방식 | 실행 시점 | 첫 렌더링 상태 |
|------|----------|---------------|
| useEffect | 렌더링 **후** | 초기값 (잘못된 상태) |
| Lazy Init | 렌더링 **전** | 복원된 값 (올바른 상태) |

## 비유로 이해하기

| 상황 | useEffect (변경 전) | Lazy Init (변경 후) |
|------|---------------------|---------------------|
| 비유 | 빈 방으로 이사 → 나중에 가구 배치 | 가구 배치 끝난 방으로 이사 |
| 결과 | 빈 방이 잠깐 보임 (깜빡임) | 처음부터 완성된 방 |

## 코드 비교

**useEffect 방식 (Before)**
```tsx
const [state, setState] = useState(initialState);

useEffect(() => {
  const stored = localStorage.getItem(key);
  if (stored) setState(JSON.parse(stored));
}, []);
```

**Lazy Initialization (After)**
```tsx
const [state, setState] = useState(() => {
  const stored = localStorage.getItem(key);
  return stored ? JSON.parse(stored) : initialState;
});
```

# 언제 어떤 것을 사용할까?

---

## Lazy Initialization을 사용해야 할 때

1. **localStorage/sessionStorage에서 초기값 읽기**
2. **계산 비용이 큰 초기값** (정렬, 필터링 등)
3. **첫 렌더링부터 올바른 값이 필요할 때**

```tsx
// ✅ 좋은 예: localStorage 초기값
const [user, setUser] = useState(() => {
  const saved = localStorage.getItem('user');
  return saved ? JSON.parse(saved) : null;
});

// ✅ 좋은 예: 비싼 계산
const [sortedItems, setSortedItems] = useState(() => {
  return items.slice().sort((a, b) => b.score - a.score);
});
```

## useEffect를 사용해야 할 때

1. **비동기 작업** (API 호출, fetch)
2. **DOM 조작**
3. **구독/이벤트 리스너 설정**
4. **상태 변경 시 부수 효과 실행**

```tsx
// ✅ 좋은 예: API 호출 (비동기)
useEffect(() => {
  fetchUser(userId).then(setUser);
}, [userId]);

// ✅ 좋은 예: 상태 변경 시 localStorage 저장
useEffect(() => {
  localStorage.setItem('user', JSON.stringify(user));
}, [user]);

// ✅ 좋은 예: 이벤트 리스너
useEffect(() => {
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);
```

## 핵심 차이 요약

```
useState(초기값)           → 렌더링 전에 초기값 설정
useEffect(() => {}, [])   → 렌더링 후에 실행

useState(() => 계산)       → 렌더링 전에 함수 실행 (동기)
useEffect(() => fetch())  → 렌더링 후에 함수 실행 (비동기 가능)
```

# 정리

---

| 항목 | Lazy Initialization | useEffect |
|------|---------------------|-----------|
| 실행 시점 | 렌더링 전 | 렌더링 후 |
| 비동기 지원 | ❌ | ✅ |
| 첫 렌더링 값 | 올바른 값 | 초기값 → 복원값 |
| 사용 사례 | localStorage, 계산 | API, 구독, DOM |

**요약**:
- **동기적으로 읽을 수 있는 초기값** → `useState(() => ...)`
- **비동기 작업이나 부수 효과** → `useEffect(() => ...)`

# Reference

---

- [useState - React 공식 문서](https://react.dev/reference/react/useState#avoiding-recreating-the-initial-state)
- [useEffect - React 공식 문서](https://react.dev/reference/react/useEffect)
- [StrictMode - React 공식 문서](https://react.dev/reference/react/StrictMode)
