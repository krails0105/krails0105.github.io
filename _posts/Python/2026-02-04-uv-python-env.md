---
title: "[Python] uv와 Python 환경 관리 - venv, pip, lockfile"
categories:
  - Python
tags:
  - [Python, uv, venv, pip, DependencyManagement]
---

# Introduction

---

Python 의존성 관리는 복잡합니다. `uv`는 Rust로 작성된 **빠른** pip/venv 대체 도구입니다.

```
속도 비교 (대략):
pip install: 30초
uv pip install: 3초 (10배 빠름)
```

# 1. 가상환경 기초

---

## venv (표준 라이브러리)

```bash
# 가상환경 생성
python -m venv .venv

# 활성화
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

# 비활성화
deactivate
```

## 왜 가상환경을 쓰나?

```
프로젝트 A: Django 4.0 필요
프로젝트 B: Django 3.2 필요

글로벌 설치 → 충돌!
가상환경 → 각자 독립적
```

# 2. uv 설치 및 기본 사용

---

## 설치

```bash
# curl (Linux/Mac)
curl -LsSf https://astral.sh/uv/install.sh | sh

# pip
pip install uv

# Homebrew
brew install uv
```

## 기본 명령어

```bash
# 가상환경 생성
uv venv

# 패키지 설치
uv pip install flask

# requirements.txt에서 설치
uv pip install -r requirements.txt

# 패키지 제거
uv pip uninstall flask

# 설치된 패키지 목록
uv pip list

# 의존성 트리
uv pip tree
```

# 3. uv로 프로젝트 관리

---

## 프로젝트 초기화

```bash
# 새 프로젝트 생성
uv init my-project
cd my-project

# 구조
my-project/
├── pyproject.toml
├── .python-version
├── .venv/
└── src/
    └── my_project/
        └── __init__.py
```

## pyproject.toml

```toml
[project]
name = "my-project"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "flask>=3.0",
    "sqlalchemy>=2.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "black>=24.0",
]
```

## 의존성 관리

```bash
# 의존성 추가
uv add flask
uv add sqlalchemy>=2.0

# 개발 의존성 추가
uv add --dev pytest black

# 의존성 제거
uv remove flask

# 동기화 (lockfile 기준)
uv sync

# 개발 의존성 포함 동기화
uv sync --dev
```

# 4. Lockfile (uv.lock)

---

## Lockfile이 필요한 이유

```
requirements.txt:
flask>=2.0  # 어떤 버전이 설치될지 모름

lockfile:
flask==3.0.2
  werkzeug==3.0.1
  jinja2==3.1.3
  ...  # 정확한 버전 고정
```

```bash
# lockfile 생성/업데이트
uv lock

# lockfile 기준으로 설치
uv sync
```

## pip-tools와 비교

```bash
# pip-tools 방식
pip-compile requirements.in -o requirements.txt
pip-sync requirements.txt

# uv 방식 (더 빠름)
uv pip compile requirements.in -o requirements.txt
uv pip sync requirements.txt
```

# 5. Python 버전 관리

---

## uv로 Python 설치

```bash
# 사용 가능한 버전 확인
uv python list

# Python 설치
uv python install 3.12

# 프로젝트에서 사용할 버전 지정
uv python pin 3.12
# → .python-version 파일 생성
```

## .python-version

```
3.12
```

```bash
# 해당 버전으로 실행
uv run python --version
# Python 3.12.x
```

# 6. 스크립트 실행

---

## uv run

```bash
# 가상환경 내에서 실행
uv run python script.py
uv run pytest
uv run flask run

# 일회성 패키지 사용
uv run --with requests python -c "import requests; print(requests.__version__)"
```

## 인라인 의존성

```python
# script.py
# /// script
# dependencies = ["requests", "rich"]
# ///

import requests
from rich import print

print(requests.get("https://api.github.com").json())
```

```bash
uv run script.py  # 자동으로 의존성 설치 후 실행
```

# 7. CI/CD에서 uv

---

## GitHub Actions

```yaml
name: Test

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v4
        with:
          version: "latest"

      - name: Set up Python
        run: uv python install 3.12

      - name: Install dependencies
        run: uv sync --frozen  # lockfile 변경 불가

      - name: Run tests
        run: uv run pytest
```

## Docker

```dockerfile
FROM python:3.12-slim

# uv 설치
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# 의존성 먼저 (캐시 활용)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# 애플리케이션 코드
COPY . .

CMD ["uv", "run", "python", "main.py"]
```

# 8. pip vs uv 비교

---

| 기능 | pip | uv |
|------|-----|-----|
| 속도 | 느림 | 10-100x 빠름 |
| lockfile | 없음 | 내장 |
| Python 버전 관리 | 없음 | 내장 |
| 의존성 해결 | 기본 | 향상됨 |
| 가상환경 | venv 별도 | 통합 |

## 마이그레이션

```bash
# 기존 requirements.txt → uv
uv pip install -r requirements.txt

# 또는 새 프로젝트로
uv init
uv add flask sqlalchemy  # 기존 의존성 추가
```

# 9. 일반적인 워크플로우

---

## 새 프로젝트 시작

```bash
uv init my-project
cd my-project
uv add flask sqlalchemy
uv add --dev pytest black
uv sync
```

## 기존 프로젝트 클론

```bash
git clone repo
cd repo
uv sync  # lockfile 기준 설치
```

## 의존성 업데이트

```bash
# 특정 패키지 업데이트
uv add flask@latest

# 모든 의존성 업데이트
uv lock --upgrade
uv sync
```

# 10. 체크리스트

---

```
□ 가상환경을 사용하고 있는가?
□ lockfile로 버전을 고정하고 있는가?
□ .venv/는 .gitignore에 있는가?
□ CI에서 --frozen 옵션을 사용하는가?
□ 개발/프로덕션 의존성을 분리했는가?
□ Python 버전을 명시했는가?
```

# Reference

---

- [uv Documentation](https://docs.astral.sh/uv/)
- [uv GitHub](https://github.com/astral-sh/uv)
- [Python venv Documentation](https://docs.python.org/3/library/venv.html)
- [PEP 517 - Build System](https://peps.python.org/pep-0517/)
