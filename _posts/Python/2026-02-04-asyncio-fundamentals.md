---
title: "[Python] asyncio 기초 - 비동기 프로그래밍 핵심 개념"
categories:
  - Python
tags:
  - [Python, asyncio, Concurrency, Async, Coroutine]
---

# Introduction

---

Python의 asyncio는 **I/O 바운드 작업**을 효율적으로 처리하기 위한 비동기 프로그래밍 프레임워크입니다.

핵심은: **기다리는 동안 다른 일을 한다**

```
동기: 요청1 → 대기 → 응답1 → 요청2 → 대기 → 응답2
비동기: 요청1 → 요청2 → 응답1 → 응답2 (대기 시간 겹침)
```

# 1. 핵심 개념

---

## Coroutine

`async def`로 정의된 함수입니다.

```python
async def fetch_data():
    print("시작")
    await asyncio.sleep(1)  # I/O 대기 시뮬레이션
    print("완료")
    return "data"
```

## await

코루틴의 실행을 일시 중지하고, 다른 작업에 제어권을 넘깁니다.

```python
result = await fetch_data()  # 여기서 다른 코루틴이 실행될 수 있음
```

## Event Loop

모든 비동기 작업을 스케줄링하고 실행합니다.

```python
# Python 3.7+
asyncio.run(main())  # 이벤트 루프 생성 + 실행 + 정리
```

# 2. 동시 실행 패턴

---

## asyncio.gather - 병렬 실행

```python
import asyncio

async def fetch_user(user_id):
    await asyncio.sleep(1)  # API 호출 시뮬레이션
    return f"User {user_id}"

async def main():
    # 3개 동시 실행 → 총 1초 (3초 아님!)
    results = await asyncio.gather(
        fetch_user(1),
        fetch_user(2),
        fetch_user(3)
    )
    print(results)  # ['User 1', 'User 2', 'User 3']

asyncio.run(main())
```

## asyncio.create_task - 백그라운드 실행

```python
async def main():
    # Task 생성 (즉시 스케줄링)
    task1 = asyncio.create_task(fetch_user(1))
    task2 = asyncio.create_task(fetch_user(2))

    # 다른 작업 수행 가능
    print("Tasks started")

    # 결과 대기
    result1 = await task1
    result2 = await task2
```

## asyncio.wait - 세밀한 제어

```python
async def main():
    tasks = [asyncio.create_task(fetch_user(i)) for i in range(5)]

    # 첫 번째 완료 시 반환
    done, pending = await asyncio.wait(
        tasks,
        return_when=asyncio.FIRST_COMPLETED
    )

    # 또는 타임아웃
    done, pending = await asyncio.wait(
        tasks,
        timeout=2.0
    )
```

# 3. 에러 처리

---

## gather에서 예외

```python
async def risky_task(n):
    if n == 2:
        raise ValueError("에러 발생!")
    return n

async def main():
    # return_exceptions=True: 예외도 결과로 반환
    results = await asyncio.gather(
        risky_task(1),
        risky_task(2),
        risky_task(3),
        return_exceptions=True
    )

    for r in results:
        if isinstance(r, Exception):
            print(f"에러: {r}")
        else:
            print(f"결과: {r}")
```

## 개별 Task 예외 처리

```python
async def main():
    task = asyncio.create_task(risky_task(2))

    try:
        result = await task
    except ValueError as e:
        print(f"Task 실패: {e}")
```

# 4. 타임아웃

---

## asyncio.timeout (Python 3.11+)

```python
async def main():
    async with asyncio.timeout(5.0):
        await long_running_task()
```

## asyncio.wait_for (모든 버전)

```python
async def main():
    try:
        result = await asyncio.wait_for(
            long_running_task(),
            timeout=5.0
        )
    except asyncio.TimeoutError:
        print("타임아웃!")
```

# 5. 동기 코드와 통합

---

## 동기 함수에서 비동기 호출

```python
import asyncio

def sync_function():
    # 이벤트 루프가 없는 동기 컨텍스트
    result = asyncio.run(async_function())
    return result
```

## 비동기에서 동기(블로킹) 함수 호출

```python
import asyncio
from concurrent.futures import ThreadPoolExecutor

def blocking_io():
    import time
    time.sleep(1)  # 블로킹 I/O
    return "done"

async def main():
    loop = asyncio.get_event_loop()

    # ThreadPoolExecutor로 블로킹 코드 실행
    with ThreadPoolExecutor() as pool:
        result = await loop.run_in_executor(pool, blocking_io)
```

# 6. 실전 패턴: HTTP 요청

---

```python
import asyncio
import aiohttp

async def fetch_url(session, url):
    async with session.get(url) as response:
        return await response.text()

async def fetch_all(urls):
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_url(session, url) for url in urls]
        return await asyncio.gather(*tasks)

async def main():
    urls = [
        "https://api.example.com/1",
        "https://api.example.com/2",
        "https://api.example.com/3",
    ]
    results = await fetch_all(urls)
    print(f"Fetched {len(results)} pages")

asyncio.run(main())
```

# 7. 흔한 실수

---

## 실수 1: await 없이 코루틴 호출

```python
# 잘못된 코드
async def main():
    fetch_data()  # 실행 안 됨! 코루틴 객체만 생성

# 올바른 코드
async def main():
    await fetch_data()  # await 필요
```

## 실수 2: 동기 함수에서 await

```python
# 잘못된 코드
def sync_func():
    await fetch_data()  # SyntaxError!

# 올바른 코드
async def async_func():
    await fetch_data()
```

## 실수 3: CPU 바운드 작업에 asyncio 사용

```python
# 비효율적 (GIL 때문에 실제 병렬 아님)
async def cpu_bound():
    result = heavy_computation()  # CPU 작업은 await해도 의미 없음
    return result

# 대안: ProcessPoolExecutor 사용
from concurrent.futures import ProcessPoolExecutor

async def main():
    loop = asyncio.get_event_loop()
    with ProcessPoolExecutor() as pool:
        result = await loop.run_in_executor(pool, heavy_computation)
```

# 8. asyncio vs threading vs multiprocessing

---

| 방식 | 적합한 작업 | 동시성 | 병렬성 |
|------|------------|--------|--------|
| asyncio | I/O 바운드 | O | X |
| threading | I/O 바운드 | O | X (GIL) |
| multiprocessing | CPU 바운드 | O | O |

```
I/O 바운드: 네트워크, 파일, DB → asyncio 권장
CPU 바운드: 계산, 이미지 처리 → multiprocessing 권장
```

# 9. 체크리스트

---

```
□ async def + await 기본 문법을 이해했는가?
□ gather vs create_task 차이를 알고 있는가?
□ 타임아웃 처리를 하고 있는가?
□ 예외 처리 전략이 있는가?
□ 블로킹 코드는 run_in_executor로 처리하는가?
□ CPU 바운드 작업은 multiprocessing을 고려하는가?
```

# Reference

---

- [Python asyncio 공식 문서](https://docs.python.org/3/library/asyncio.html)
- [Real Python - Async IO](https://realpython.com/async-io-python/)
- [aiohttp 문서](https://docs.aiohttp.org/)
