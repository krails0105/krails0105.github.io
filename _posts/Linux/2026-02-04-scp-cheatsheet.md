---
title: "[Linux] SCP 명령어 치트시트 - 파일 전송 기초"
categories:
  - Linux
tags:
  - [Linux, SCP, SSH, FileTransfer]
---

# Introduction

---

SCP(Secure Copy)는 SSH를 통해 **파일을 안전하게 전송**하는 명령어입니다.

```
SCP = SSH + 파일 복사
```

# 1. 기본 문법

---

```bash
scp [옵션] [원본] [대상]
```

## 로컬 → 원격

```bash
# 파일 전송
scp file.txt user@remote:/path/to/destination/

# 디렉토리 전송 (-r)
scp -r folder/ user@remote:/path/to/destination/
```

## 원격 → 로컬

```bash
# 파일 다운로드
scp user@remote:/path/to/file.txt ./

# 디렉토리 다운로드
scp -r user@remote:/path/to/folder/ ./
```

## 원격 → 원격

```bash
scp user1@remote1:/path/file.txt user2@remote2:/path/
```

# 2. 주요 옵션

---

| 옵션 | 설명 |
|------|------|
| `-r` | 디렉토리 재귀 복사 |
| `-P port` | 포트 지정 (대문자 P) |
| `-i key` | SSH 키 파일 지정 |
| `-v` | 상세 출력 (디버깅) |
| `-C` | 압축 전송 |
| `-p` | 수정 시간/권한 유지 |
| `-q` | 조용히 (진행률 숨김) |
| `-l limit` | 대역폭 제한 (Kbit/s) |

# 3. 실전 예제

---

## 포트 지정

```bash
# SSH 포트가 2222인 경우
scp -P 2222 file.txt user@remote:/path/
```

## SSH 키 사용

```bash
scp -i ~/.ssh/my_key.pem file.txt user@remote:/path/
```

## 여러 파일 전송

```bash
# 여러 파일
scp file1.txt file2.txt user@remote:/path/

# 와일드카드
scp *.txt user@remote:/path/
```

## 압축 전송 (느린 네트워크)

```bash
scp -C large_file.txt user@remote:/path/
```

## 대역폭 제한

```bash
# 1000 Kbit/s로 제한
scp -l 1000 large_file.txt user@remote:/path/
```

## 진행률 표시

```bash
# 기본으로 표시됨
scp large_file.txt user@remote:/path/
# file.txt    100%  1GB  50.0MB/s   00:20
```

# 4. SSH config 활용

---

## ~/.ssh/config 설정

```
Host myserver
    HostName 192.168.1.100
    User ubuntu
    Port 2222
    IdentityFile ~/.ssh/my_key.pem
```

## 간편 사용

```bash
# 설정된 별칭 사용
scp file.txt myserver:/path/

# 긴 명령어 대신
# scp -P 2222 -i ~/.ssh/my_key.pem file.txt ubuntu@192.168.1.100:/path/
```

# 5. 자주 쓰는 패턴

---

## 로그 파일 다운로드

```bash
scp user@server:/var/log/app.log ./

# 최근 로그만 (원격에서 tail 후 전송)
ssh user@server "tail -1000 /var/log/app.log" > recent.log
```

## 설정 파일 백업

```bash
scp user@server:/etc/nginx/nginx.conf ./backup/
scp -r user@server:/etc/nginx/ ./backup/nginx/
```

## 배포 (로컬 → 서버)

```bash
# 빌드 결과물 전송
scp -r dist/* user@server:/var/www/html/

# tar로 묶어서 전송 (더 빠름)
tar czf - dist/ | ssh user@server "tar xzf - -C /var/www/html/"
```

## 서버 간 파일 이동

```bash
# 직접 전송
scp user@server1:/data/file.txt user@server2:/data/

# 로컬 경유 (권한 문제 시)
scp user@server1:/data/file.txt ./
scp file.txt user@server2:/data/
```

# 6. SCP vs rsync

---

| 항목 | SCP | rsync |
|------|-----|-------|
| 증분 전송 | X | O |
| 중단 후 재개 | X | O |
| 심볼릭 링크 | 기본 안 따라감 | 옵션으로 제어 |
| 속도 | 빠름 | 대용량 시 더 빠름 |
| 복잡도 | 단순 | 옵션 많음 |

## rsync 권장 상황

```bash
# 큰 디렉토리 동기화
rsync -avz --progress ./data/ user@server:/data/

# 중단 후 재개 필요
rsync -avz --partial --progress large_file.txt user@server:/path/
```

# 7. 트러블슈팅

---

## 권한 거부

```bash
# 권한 확인
ls -la ~/.ssh/
# 키 파일은 600이어야 함
chmod 600 ~/.ssh/my_key.pem
```

## 연결 타임아웃

```bash
# 상세 출력으로 디버깅
scp -v file.txt user@remote:/path/

# SSH 연결 테스트
ssh -v user@remote
```

## 호스트 키 문제

```bash
# known_hosts에서 제거 후 재시도
ssh-keygen -R remote_host
scp file.txt user@remote:/path/
```

## 공간 부족

```bash
# 원격 디스크 확인
ssh user@remote "df -h /path/"
```

# 8. 보안 고려사항

---

```
□ 비밀번호 대신 SSH 키 사용
□ 키 파일 권한 600 유지
□ 루트 계정 직접 접근 피하기
□ 민감한 파일은 암호화 후 전송
```

## 파일 암호화 전송

```bash
# 전송 전 암호화
gpg -c secret.txt
scp secret.txt.gpg user@remote:/path/

# 원격에서 복호화
ssh user@remote "gpg -d /path/secret.txt.gpg > /path/secret.txt"
```

# 9. 체크리스트

---

```
□ SSH 연결이 정상인가?
□ 원격 경로에 쓰기 권한이 있는가?
□ 디렉토리 전송 시 -r 옵션을 사용했는가?
□ 비표준 포트는 -P로 지정했는가?
□ 대용량 전송 시 rsync가 더 적합한가?
```

# Reference

---

- [SCP Man Page](https://man7.org/linux/man-pages/man1/scp.1.html)
- [SSH Config](https://man7.org/linux/man-pages/man5/ssh_config.5.html)
- [rsync Documentation](https://rsync.samba.org/documentation.html)
