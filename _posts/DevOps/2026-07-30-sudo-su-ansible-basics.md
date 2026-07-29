---
title: "sudo su가 진짜 하는 일, 그리고 Ansible로 서버 설정 자동화 시작하기"
categories:
  - DevOps
tags: [Linux, sudo, Ansible, 자동화]
---

## 개요

서버 작업을 하다 보면 `sudo su`를 습관적으로 쓰게 된다. 그런데 막상 "왜 `sudo`와 `su`를 같이 쓰는가", "`sudo su`와 `sudo su -`는 뭐가 다른가"를 물으면 답이 애매해지는 경우가 많다.

이 글은 두 부분으로 나뉜다. 앞부분에서는 `sudo`와 `su`의 정확한 권한 모델과 `sudo su` / `sudo su -` / `sudo -i`의 차이를 정리한다. 뒷부분에서는 여기서 등장한 "권한 상승" 개념이 어떻게 Ansible의 `become`으로 이어지는지, 그리고 여러 서버를 코드로 관리하는 Ansible의 기초(에이전트리스, 멱등성, inventory, playbook)를 다룬다. 한 대의 서버에서 권한을 다루는 이야기가 수백 대의 서버를 자동화하는 이야기로 자연스럽게 확장되는 흐름이다.

## sudo vs su — 권한을 얻는 두 가지 방법

`sudo`와 `su`는 둘 다 다른 사용자 권한으로 작업하기 위한 명령이지만, **인증 방식**과 **적용 범위**가 다르다.

`sudo <명령>`은 **내 계정의 비밀번호**로 인증한다. `/etc/sudoers`에 등록된 권한 범위 안에서, 뒤에 붙인 명령 하나만 root 권한으로 실행하고 끝난다. 명령이 끝나면 다시 원래 사용자로 돌아온다.

```bash
sudo apt update
```

`su [사용자명]`은 셸 자체를 다른 사용자로 전환한다. 사용자명을 생략하면 기본값은 root다. 문제는 인증 방식인데, `su`는 **전환하려는 대상 사용자의 비밀번호**를 요구한다. 즉 root로 전환하려면 root 계정의 비밀번호를 알아야 한다.

```bash
su        # root 비밀번호 필요
su alice  # alice 비밀번호 필요
```

여기서 `sudo su`가 등장하는 이유가 나온다. AWS EC2 같은 클라우드 인스턴스는 보안상 root 계정에 아예 비밀번호가 설정되어 있지 않은 경우가 대부분이다. `su` 단독으로는 root 비밀번호를 모르니 root 전환이 불가능하다. 이때 `sudo su`를 쓰면, 먼저 `sudo`로 **내 비밀번호만** 인증한 뒤 그 root 권한으로 `su` 명령 자체를 실행하기 때문에, root 비밀번호 없이도 root 셸을 얻을 수 있다.

정리하면 `sudo su`는 "`sudo`(내 비번으로 권한 상승) + `su`(셸 전환)"의 조합이고, 클라우드 서버에서 root 셸이 필요할 때의 관용적인 우회 경로인 셈이다.

## sudo su, sudo su -, sudo -i — 뭐가 다른가

셋 다 결과적으로 root 셸을 준다는 점은 같지만, **환경(environment)을 얼마나 갈아엎는지**가 다르다.

| 명령 | 셸 전환 | 환경변수 / HOME | 비고 |
|------|--------|----------------|------|
| `sudo su` | root 셸 | 원래 사용자 것 유지 | `$HOME`, `$PATH` 등이 뒤섞일 수 있음 |
| `sudo su -` | root 셸 | root로 완전 전환 | `-`는 "로그인 셸"을 의미 |
| `sudo -i` | root 셸 | root로 완전 전환 | `sudo su -`와 사실상 동일, 권장 방식 |

`su -`의 `-`는 단순 옵션이 아니라 "로그인했을 때와 동일한 환경으로 시작하라"는 의미다(로그인 셸). 그래서 `sudo su`만 쓰면 root 권한은 얻었지만 `$HOME`이 여전히 원래 사용자 홈 디렉토리를 가리키거나 `$PATH`가 원래 사용자 기준으로 남아, 환경이 뒤섞인 상태가 될 수 있다. 반면 `sudo su -`와 `sudo -i`는 root로 새로 로그인한 것과 동일하게 환경변수, 홈 디렉토리, 셸 초기화 파일(`/root/.bashrc` 등)까지 모두 root 기준으로 다시 설정한다.

이 차이는 실제로 문제를 일으킨다. 예를 들어 특정 도구를 root의 `PATH`에 설치해 두었는데 `sudo su`로 들어가면 원래 사용자의 `PATH`가 유지되어 "command not found"가 나는 식이다. 이럴 때 `sudo -i`로 들어가면 root 환경이 제대로 로드되어 문제가 사라진다.

실무에서는 두 가지 원칙이 자주 쓰인다.

- **단건 작업이라면 `sudo <명령>`으로 끝낸다.** 이렇게 하면 어떤 사용자가 어떤 명령을 실행했는지가 감사 로그(`/var/log/auth.log` 등)에 명확히 남는다.
- **root 셸에서 연속으로 여러 작업을 해야 한다면 `sudo -i`를 쓴다.** `sudo su`류보다 의도가 명확하고, 환경도 깨끗하게 시작된다.

즉 root 셸 자체를 오래 유지하는 습관은 지양하고, 필요한 순간에만 `sudo`로 권한을 좁게 빌리는 것이 기본이다.

## Ansible — 여러 서버를 SSH로 동시에 관리하기

`sudo`가 한 대의 서버에서 권한을 다루는 방법이라면, 서버가 수십, 수백 대로 늘어나면 접근 방식 자체가 달라져야 한다. 매번 SSH로 접속해서 `sudo apt install nginx`를 반복하는 대신, **설정 자체를 코드로 선언**하고 여러 서버에 동시에 적용하는 도구가 필요하다. Ansible이 이 역할을 한다.

Ansible의 핵심 특징은 두 가지다.

**에이전트리스(agentless)**다. Chef나 Puppet처럼 대상 서버에 별도 에이전트를 설치할 필요가 없다. 대상 서버에 SSH 접속이 가능하고 Python이 설치되어 있으면 그것으로 충분하다. 관리 대상이 늘어날 때 에이전트를 배포하고 버전을 맞추는 부담이 없다는 뜻이다.

**멱등성(idempotent)**이다. 같은 플레이북을 몇 번을 실행해도 결과가 항상 같다. 예를 들어 nginx를 설치하는 작업을 두 번 실행해도, 이미 설치되어 있으면 두 번째 실행에서는 아무 일도 하지 않고 건너뛴다(`ok`로 표시되고 `changed`가 아니다). 이 덕분에 플레이북을 "이 서버가 지금 어떤 상태인지"와 무관하게 안전하게 반복 실행할 수 있다.

이 멱등성은 YAML로 **절차(어떻게)가 아니라 상태(무엇이어야 하는지)를 선언**하는 방식에서 나온다. "nginx를 설치해라"가 아니라 "nginx가 설치된 상태여야 한다"고 기술하면, Ansible이 현재 상태를 확인하고 필요한 경우에만 조치를 취한다.

## 핵심 구성 요소 — inventory와 playbook

Ansible은 크게 두 가지 파일로 동작한다. 어떤 서버를 대상으로 할지 정하는 **inventory**와, 그 서버에서 무엇을 할지 정하는 **playbook**이다.

Inventory는 관리 대상 서버 목록을 그룹으로 묶어 정의한다.

```ini
# inventory.ini
[web]
web1.example.com
web2.example.com

[db]
db1.example.com
```

Playbook은 `hosts`로 대상 그룹을 지정하고, `tasks`에 원하는 상태를 나열한다. 모듈 이름은 짧은 이름(`apt`, `mount`) 대신 **FQCN(Fully Qualified Collection Name, `ansible.builtin.apt`처럼 전체 경로를 쓰는 이름)**을 쓰는 것이 공식 권장 방식이다. 컬렉션 간 이름 충돌을 막고, 그 모듈이 어느 컬렉션에서 오는지 명확해지기 때문이다.

```yaml
# playbook.yml
- name: 웹 서버 설정
  hosts: web
  become: true                    # sudo 권한으로 task 실행
  tasks:
    - name: nginx 설치
      ansible.builtin.apt:
        name: nginx
        state: present            # "설치되어 있어야 한다"는 상태 선언
        update_cache: true        # 설치 전에 apt 패키지 목록 갱신

    - name: 데이터 디스크 마운트 (fstab에도 등록)
      ansible.posix.mount:
        path: /data
        src: UUID=b3e48f45-f933-4c8e-a700-22a159ec9077
        fstype: ext4
        state: mounted
```

실행은 다음 한 줄이면 된다.

```bash
ansible-playbook -i inventory.ini playbook.yml
```

### become: true — sudo가 Ansible 안으로 들어온 지점

여기서 눈여겨볼 부분이 `become: true`다. 이 옵션이 켜지면 Ansible은 대상 서버에서 해당 task를 실행할 때 내부적으로 `sudo`(기본 become 방식)를 사용해 권한을 상승시킨다. 앞서 정리한 `sudo` 개념이 그대로 Ansible 안에 들어와 있는 셈이다. `apt` 모듈로 패키지를 설치하거나 시스템 설정 파일을 건드리는 작업 대부분은 root 권한이 필요하므로, 실무 플레이북에서는 `become: true`가 거의 기본으로 등장한다.

특정 사용자로 전환하고 싶다면 `become_user`를, 다른 상승 방식을 쓰고 싶다면 `become_method`(기본값 `sudo`)를 함께 지정한다. `become`은 위 예시처럼 play 전체에 걸 수도 있고, 개별 task에만 걸 수도 있다.

### mount 모듈 — 마운트와 fstab 등록을 한 번에

`mount` 모듈은 짚어둘 지점이 몇 가지 있다.

첫째, 이 모듈은 ansible-core에 포함된 `apt`와 달리 **`ansible.posix` 컬렉션**에 들어 있다. 그래서 처음 쓸 때는 컬렉션을 한 번 설치해야 한다.

```bash
ansible-galaxy collection install ansible.posix
```

둘째, `state` 값에 따라 "지금 마운트하느냐"와 "`/etc/fstab`에 남기느냐"가 달라진다. 이 조합을 헷갈리면 재부팅 후 디스크가 사라지거나, 반대로 지웠는데 fstab에 남아 부팅이 막히는 사고로 이어진다.

| `state` 값 | 지금 마운트 | `/etc/fstab` 등록 | 용도 |
|-----------|:----------:|:----------------:|------|
| `mounted` | O | O | 지금 마운트하고 재부팅 후에도 유지 (가장 흔함) |
| `present` | X | O | fstab에만 등록, 마운트는 다음 부팅/`mount -a` 때 |
| `unmounted` | 해제 | 유지 | 지금은 내리되 fstab 항목은 남겨둠 |
| `absent` | 해제 | 제거 | 마운트 해제 + fstab 항목까지 삭제 |

`state: mounted`가 특히 유용한 이유는, 단순히 `mount` 명령만 실행하는 것이 아니라 **`/etc/fstab`에도 해당 항목을 등록**해 재부팅 후에도 마운트가 유지되도록 만들어 주기 때문이다. 수동으로 `mount` 명령만 실행하고 fstab 등록을 깜빡해서 재부팅 후 디스크가 사라진 것처럼 보이는 흔한 실수를, Ansible을 쓰면 애초에 방지할 수 있다. (디스크 마운트와 fstab의 관계 자체가 헷갈린다면, `lsblk` → `blkid` → `/etc/fstab` 흐름을 다룬 같은 날 올린 "Linux 디스크 마운트 관리" 글을 먼저 보면 도움이 된다.)

## 실무에서 자주 만나는 함정

- **`become`을 빼먹어 권한 오류가 난다.** `apt`, `mount`, 시스템 서비스 조작 등은 root 권한이 필요하다. `become: true`가 없으면 일반 사용자로 실행되어 `Permission denied`가 난다.
- **`ansible.posix.mount`인데 컬렉션을 설치하지 않았다.** `couldn't resolve module/action 'ansible.posix.mount'` 오류가 나면 `ansible-galaxy collection install ansible.posix`를 먼저 실행했는지 확인한다.
- **대상 서버에 Python이 없다.** Ansible은 에이전트리스지만 대부분의 모듈은 대상에서 Python을 실행한다. 최소 설치 이미지에는 Python이 없을 수 있어 `raw` 모듈로 먼저 설치해야 하는 경우가 있다.
- **UUID 대신 `/dev/sdb1` 같은 장치명을 쓴다.** 장치명은 재부팅이나 디스크 추가 순서에 따라 바뀔 수 있다. fstab/mount에는 `blkid`로 확인한 `UUID=...`를 쓰는 것이 안전하다.
- **`state: latest`를 습관적으로 쓴다.** `state: latest`는 실행할 때마다 최신 버전으로 업그레이드해 멱등하지 않은(매번 `changed`) 결과를 낼 수 있다. 버전을 고정하고 싶다면 `state: present`를 쓴다.

## 데이터 엔지니어링 관점에서의 활용

Kafka, Flink, StarRocks처럼 여러 노드로 구성되는 클러스터를 처음 세팅할 때는 노드마다 반복되는 작업이 많다. 필요한 패키지 설치, 데이터 디스크 마운트, 커널 파라미터 튜닝, 사용자/디렉토리 생성 같은 작업이 노드 수만큼 반복된다.

이런 작업을 Ansible 플레이북으로 정의해두면, 새 노드를 추가할 때 inventory에 호스트 한 줄만 추가하고 같은 플레이북을 다시 실행하는 것만으로 표준화된 세팅을 재현할 수 있다. 멱등성 덕분에 이미 세팅된 노드에 다시 실행해도 안전하고, 바뀐 부분만 반영된다. 수동으로 SSH를 돌아다니며 같은 명령을 반복 입력하는 것과 비교하면, 설정 누락이나 노드 간 불일치를 줄이는 효과가 크다.

## 정리

| 개념 | 핵심 |
|------|------|
| `sudo <명령>` | 내 비밀번호로 인증, 해당 명령만 root 권한 실행, 감사 로그 남김 |
| `su` | 대상 사용자 비밀번호 필요 → root 비밀번호 없는 클라우드 서버에서는 단독 사용 불가 |
| `sudo su` | root 비밀번호 없이 내 비밀번호만으로 root 셸 획득, 단 환경은 원래 사용자 것 유지 |
| `sudo su -` / `sudo -i` | root로 완전히 로그인한 것처럼 환경까지 전환, `sudo -i`가 권장 방식 |
| Ansible | 에이전트리스 + 멱등성 기반 구성 자동화 도구 |
| inventory / playbook | 대상 서버 목록 / 그 서버에서 선언할 상태 |
| `become: true` | 플레이북 task 실행 시 sudo로 권한 상승 |
| `ansible.builtin.apt` | 패키지 상태 선언 (`state: present`), ansible-core 내장 |
| `ansible.posix.mount` | 마운트와 `/etc/fstab` 등록을 함께 처리, `ansible.posix` 컬렉션 필요 |

한 대의 서버에서 `sudo`로 권한을 좁게 빌리던 습관이, 여러 서버 자동화에서는 `become`으로 이어진다. 권한을 "필요한 만큼, 명시적으로" 다룬다는 원칙은 규모와 무관하게 동일하다.

## Reference

- [Ansible `become`(권한 상승) 공식 문서](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_privilege_escalation.html)
- [`ansible.builtin.apt` 모듈 공식 문서](https://docs.ansible.com/ansible/latest/collections/ansible/builtin/apt_module.html)
- [`ansible.posix.mount` 모듈 공식 문서](https://docs.ansible.com/ansible/latest/collections/ansible/posix/mount_module.html)
- [Ansible 컬렉션 사용 가이드](https://docs.ansible.com/ansible/latest/collections_guide/index.html)
