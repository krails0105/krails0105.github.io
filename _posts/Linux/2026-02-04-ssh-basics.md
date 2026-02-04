---
title: "[Linux] SSH 기초 - 키 생성, 접속, config 설정"
categories:
  - Linux
tags:
  - [Linux, SSH, Security, RemoteAccess]
---

# Introduction

---

SSH(Secure Shell)는 **원격 서버에 안전하게 접속**하는 프로토콜입니다.

```
SSH = 암호화된 원격 접속
```

# 1. 기본 접속

---

```bash
# 기본 접속
ssh user@hostname

# IP로 접속
ssh user@192.168.1.100

# 포트 지정
ssh -p 2222 user@hostname
```

## 첫 접속 시

```bash
ssh user@server
# The authenticity of host 'server' can't be established.
# Are you sure you want to continue connecting (yes/no)? yes
# → 호스트 키가 ~/.ssh/known_hosts에 저장됨
```

# 2. SSH 키 인증

---

## 키 생성

```bash
# RSA 키 생성 (기본)
ssh-keygen -t rsa -b 4096

# Ed25519 키 생성 (권장)
ssh-keygen -t ed25519 -C "your_email@example.com"
```

```
Generating public/private ed25519 key pair.
Enter file in which to save the key (/home/user/.ssh/id_ed25519):
Enter passphrase (empty for no passphrase):
Enter same passphrase again:
```

## 생성된 파일

```
~/.ssh/
├── id_ed25519      # 개인 키 (절대 공유 금지!)
└── id_ed25519.pub  # 공개 키 (서버에 등록)
```

## 공개 키 서버에 등록

```bash
# 방법 1: ssh-copy-id (권장)
ssh-copy-id user@server

# 방법 2: 수동 복사
cat ~/.ssh/id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

# 방법 3: 직접 편집
ssh user@server
vim ~/.ssh/authorized_keys
# 공개 키 내용 붙여넣기
```

## 권한 설정 (중요!)

```bash
# 서버 측
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys

# 클라이언트 측
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

# 3. SSH config 파일

---

## ~/.ssh/config 생성

```bash
touch ~/.ssh/config
chmod 600 ~/.ssh/config
```

## 기본 설정

```
# 개발 서버
Host dev
    HostName 192.168.1.100
    User ubuntu
    Port 22
    IdentityFile ~/.ssh/id_ed25519

# 프로덕션 서버
Host prod
    HostName prod.example.com
    User admin
    Port 2222
    IdentityFile ~/.ssh/prod_key

# AWS EC2
Host aws-bastion
    HostName ec2-xx-xx-xx-xx.compute-1.amazonaws.com
    User ec2-user
    IdentityFile ~/.ssh/aws-key.pem
```

## 간편 접속

```bash
# 긴 명령어 대신
ssh ubuntu@192.168.1.100

# 짧게
ssh dev
```

## 고급 설정

```
# 모든 호스트에 적용
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
    AddKeysToAgent yes

# 와일드카드
Host *.example.com
    User deploy
    IdentityFile ~/.ssh/deploy_key

# Jump Host (점프 서버 경유)
Host internal
    HostName 10.0.0.100
    User admin
    ProxyJump bastion
```

# 4. 점프 호스트 (Bastion)

---

## 직접 경유

```bash
# 구 방식 (-J 없는 경우)
ssh -o ProxyCommand="ssh -W %h:%p bastion" internal

# 신 방식 (OpenSSH 7.3+)
ssh -J bastion internal
```

## config 설정

```
Host bastion
    HostName bastion.example.com
    User ubuntu

Host internal-*
    ProxyJump bastion
    User admin

Host internal-web
    HostName 10.0.0.10

Host internal-db
    HostName 10.0.0.20
```

```bash
ssh internal-web  # bastion 경유해서 10.0.0.10 접속
```

# 5. 포트 포워딩

---

## 로컬 포워딩 (-L)

```bash
# 로컬 8080 → 원격 서버의 localhost:80
ssh -L 8080:localhost:80 user@server

# 로컬 5432 → 원격 서버를 통해 DB 서버:5432
ssh -L 5432:db.internal:5432 user@bastion
```

## 원격 포워딩 (-R)

```bash
# 원격 서버의 8080 → 로컬 80
ssh -R 8080:localhost:80 user@server
```

## 동적 포워딩 (SOCKS 프록시)

```bash
# 로컬 1080에서 SOCKS 프록시
ssh -D 1080 user@server
# 브라우저에서 SOCKS 프록시 localhost:1080 설정
```

# 6. SSH 에이전트

---

## 에이전트 시작

```bash
# 에이전트 시작
eval $(ssh-agent)

# 키 추가
ssh-add ~/.ssh/id_ed25519

# 추가된 키 확인
ssh-add -l
```

## 에이전트 포워딩

```bash
# 점프 호스트에서 내 키 사용
ssh -A bastion
# bastion에서 다른 서버 접속 시 로컬 키 사용
```

## config에 설정

```
Host bastion
    ForwardAgent yes
```

# 7. 보안 설정 (서버 측)

---

## /etc/ssh/sshd_config

```bash
# 비밀번호 인증 비활성화
PasswordAuthentication no

# 루트 로그인 비활성화
PermitRootLogin no

# 특정 사용자만 허용
AllowUsers admin deploy

# 포트 변경
Port 2222

# 키 인증만 허용
PubkeyAuthentication yes
```

## 설정 적용

```bash
sudo systemctl restart sshd
```

# 8. 트러블슈팅

---

## 상세 출력

```bash
ssh -v user@server   # 기본 상세
ssh -vv user@server  # 더 상세
ssh -vvv user@server # 최대 상세
```

## 흔한 문제

### 권한 문제

```bash
# 에러: Permissions 0644 for 'key' are too open
chmod 600 ~/.ssh/id_ed25519
```

### 호스트 키 변경

```bash
# 에러: REMOTE HOST IDENTIFICATION HAS CHANGED
ssh-keygen -R hostname
```

### 연결 끊김

```
# config에 추가
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

### 에이전트 문제

```bash
# 에이전트 확인
echo $SSH_AUTH_SOCK
ssh-add -l

# 에이전트 재시작
eval $(ssh-agent)
ssh-add
```

# 9. 유용한 명령어

---

```bash
# 원격 명령 실행
ssh user@server "ls -la"

# 파일 전송 (scp)
scp file.txt user@server:/path/

# 파일 동기화 (rsync)
rsync -avz ./folder/ user@server:/path/

# 터널 유지 (백그라운드)
ssh -fN -L 8080:localhost:80 user@server
```

# 10. 체크리스트

---

```
□ SSH 키를 생성하고 서버에 등록했는가?
□ 비밀번호 인증을 비활성화했는가?
□ 키 파일 권한이 올바른가? (600)
□ ~/.ssh/config를 활용하고 있는가?
□ 점프 호스트가 필요한 경우 설정했는가?
□ 서버 측 보안 설정을 검토했는가?
```

# Reference

---

- [OpenSSH Documentation](https://www.openssh.com/manual.html)
- [SSH Config Man Page](https://man7.org/linux/man-pages/man5/ssh_config.5.html)
- [SSH Academy](https://www.ssh.com/academy/ssh)
