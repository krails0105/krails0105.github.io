---
title: "[Python] Flask 배포 패턴 - Gunicorn, Docker, 프로덕션 설정"
categories:
  - Python
tags:
  - [Python, Flask, Gunicorn, Docker, Deployment]
---

# Introduction

---

Flask의 개발 서버(`flask run`)는 **프로덕션용이 아닙니다**.

```
개발: flask run (단일 스레드, 디버그 모드)
프로덕션: Gunicorn/uWSGI + Nginx (멀티 워커, 프로세스 관리)
```

# 1. 프로덕션 서버 선택

---

## Gunicorn (권장)

```bash
pip install gunicorn

# 기본 실행
gunicorn app:app

# 워커 수 지정
gunicorn -w 4 app:app

# 바인딩 주소
gunicorn -w 4 -b 0.0.0.0:8000 app:app
```

## 워커 수 계산

```python
# CPU 코어 수 기반 공식
workers = (2 * cpu_cores) + 1

# 4코어 → 9 워커
gunicorn -w 9 app:app
```

## Gunicorn 설정 파일

```python
# gunicorn.conf.py
import multiprocessing

bind = "0.0.0.0:8000"
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = "sync"  # 또는 "gevent", "eventlet"
timeout = 120
keepalive = 5
errorlog = "-"
accesslog = "-"
loglevel = "info"
```

```bash
gunicorn -c gunicorn.conf.py app:app
```

# 2. Flask 애플리케이션 구조

---

## Application Factory 패턴

```python
# app/__init__.py
from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

def create_app(config_name="production"):
    app = Flask(__name__)

    # 환경별 설정 로드
    app.config.from_object(f"config.{config_name.capitalize()}Config")

    # 확장 초기화
    db.init_app(app)

    # 블루프린트 등록
    from app.api import api_bp
    app.register_blueprint(api_bp, url_prefix="/api")

    return app
```

## 환경별 설정

```python
# config.py
import os

class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-key")
    SQLALCHEMY_TRACK_MODIFICATIONS = False

class DevelopmentConfig(Config):
    DEBUG = True
    SQLALCHEMY_DATABASE_URI = "sqlite:///dev.db"

class ProductionConfig(Config):
    DEBUG = False
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")

    # 프로덕션 보안 설정
    SESSION_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
```

## WSGI 엔트리포인트

```python
# wsgi.py
from app import create_app

app = create_app("production")

if __name__ == "__main__":
    app.run()
```

```bash
gunicorn wsgi:app
```

# 3. Docker 배포

---

## Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# 의존성 먼저 복사 (캐시 활용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드
COPY . .

# 비루트 사용자
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

CMD ["gunicorn", "-c", "gunicorn.conf.py", "wsgi:app"]
```

## docker-compose.yml

```yaml
version: "3.8"

services:
  web:
    build: .
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/mydb
      - SECRET_KEY=${SECRET_KEY}
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=mydb

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - web

volumes:
  postgres_data:
```

# 4. Nginx 리버스 프록시

---

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream flask {
        server web:8000;
    }

    server {
        listen 80;
        server_name example.com;

        location / {
            proxy_pass http://flask;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /static {
            alias /app/static;
            expires 30d;
        }
    }
}
```

# 5. 헬스체크

---

```python
# app/api/health.py
from flask import Blueprint, jsonify
from app import db

health_bp = Blueprint("health", __name__)

@health_bp.route("/health")
def health():
    return jsonify(status="healthy"), 200

@health_bp.route("/health/ready")
def readiness():
    try:
        # DB 연결 확인
        db.session.execute("SELECT 1")
        return jsonify(status="ready"), 200
    except Exception as e:
        return jsonify(status="not ready", error=str(e)), 503
```

## Docker 헬스체크

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1
```

# 6. 환경 변수 관리

---

## python-dotenv

```python
# .env
SECRET_KEY=your-secret-key
DATABASE_URL=postgresql://...
FLASK_ENV=production
```

```python
# wsgi.py
from dotenv import load_dotenv
load_dotenv()

from app import create_app
app = create_app()
```

## 필수 환경 변수 검증

```python
# config.py
import os

class ProductionConfig(Config):
    SECRET_KEY = os.environ.get("SECRET_KEY")
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")

    def __init__(self):
        if not self.SECRET_KEY:
            raise ValueError("SECRET_KEY must be set")
        if not self.SQLALCHEMY_DATABASE_URI:
            raise ValueError("DATABASE_URL must be set")
```

# 7. 로깅 설정

---

```python
# app/__init__.py
import logging
from logging.handlers import RotatingFileHandler

def create_app(config_name="production"):
    app = Flask(__name__)

    if not app.debug:
        # 파일 로깅
        file_handler = RotatingFileHandler(
            "logs/app.log",
            maxBytes=10240000,  # 10MB
            backupCount=10
        )
        file_handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]"
        ))
        file_handler.setLevel(logging.INFO)
        app.logger.addHandler(file_handler)
        app.logger.setLevel(logging.INFO)
        app.logger.info("Application startup")

    return app
```

# 8. 프로덕션 체크리스트

---

```
□ DEBUG = False 설정했는가?
□ SECRET_KEY를 환경변수로 관리하는가?
□ HTTPS를 사용하는가?
□ 세션 쿠키에 Secure, HttpOnly 플래그가 있는가?
□ Gunicorn/uWSGI + Nginx 구성인가?
□ 헬스체크 엔드포인트가 있는가?
□ 로깅이 설정되어 있는가?
□ 에러 모니터링(Sentry 등)이 연동되어 있는가?
□ DB 연결 풀이 적절히 설정되어 있는가?
```

# 9. AWS/클라우드 배포

---

## Elastic Beanstalk

```yaml
# .ebextensions/python.config
option_settings:
  aws:elasticbeanstalk:container:python:
    WSGIPath: wsgi:app
  aws:elasticbeanstalk:environment:proxy:staticfiles:
    /static: static
```

## ECS/Fargate

```json
{
  "containerDefinitions": [
    {
      "name": "flask-app",
      "image": "your-registry/flask-app:latest",
      "portMappings": [{"containerPort": 8000}],
      "environment": [
        {"name": "FLASK_ENV", "value": "production"}
      ],
      "secrets": [
        {"name": "SECRET_KEY", "valueFrom": "arn:aws:secretsmanager:..."}
      ],
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:8000/health || exit 1"]
      }
    }
  ]
}
```

# Reference

---

- [Flask Deployment Options](https://flask.palletsprojects.com/en/latest/deploying/)
- [Gunicorn Documentation](https://docs.gunicorn.org/)
- [Flask Application Factory](https://flask.palletsprojects.com/en/latest/patterns/appfactories/)
- [Docker Best Practices for Python](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
