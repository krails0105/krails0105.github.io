---
title: "Linux 디스크 마운트 관리: lsblk, blkid, /etc/fstab 완전 정리"
categories:
  - DevOps
tags: [Linux, fstab, lsblk, blkid, filesystem, xfs]
---

## 개요

서버에 디스크를 하나 추가했다고 가정하자. `lsblk`로 디스크가 보이는 것까지는 확인했는데, 정작 어디에 마운트해야 하고 재부팅해도 유지되게 하려면 어떤 파일을 건드려야 하는지 헷갈리는 경우가 많다. 특히 데이터 엔지니어링 환경에서는 Kafka, StarRocks, HDFS 같은 시스템이 데이터를 저장할 별도 디스크를 요구하는 일이 흔해서, 이 흐름을 한 번은 제대로 정리해 둘 필요가 있다.

이 글에서는 비어 있는 디스크 하나(`/dev/sdb`, 100GB)를 추가한 상황을 예로 들어, 디스크 인식 확인부터 재부팅 후에도 안전하게 마운트되도록 설정을 끝내기까지의 전체 흐름을 하나의 실습 시나리오로 따라간다. 다 읽고 나면 다음을 스스로 설명할 수 있게 된다.

- 왜 `/etc/fstab`에는 `/dev/sdb1` 같은 장치명 대신 UUID를 쓰는가
- fsck 순서 필드가 왜 xfs에서는 사실상 의미가 없는가
- 데이터 시스템에서 xfs를 선호하고 swap을 끄는 이유는 무엇인가

## 사전 지식

- 리눅스 CLI와 `sudo` 사용에 대한 기본 이해
- 파티션, 파일시스템, 마운트라는 용어를 들어본 정도의 배경지식
- 실습하려면 데이터가 없는 여분의 디스크(또는 클라우드 환경에서 새로 붙인 EBS/디스크)가 하나 필요하다

## 전체 흐름

디스크를 추가하고 영구적으로 마운트하기까지의 과정은 다음과 같다.

1. 서버에 디스크 추가
2. `lsblk`로 새 디스크 인식 여부 확인
3. 파티션 생성 및 `mkfs`로 포맷
4. 마운트포인트 생성 후 `mount`로 임시 마운트
5. `blkid`(또는 `lsblk -f`)로 UUID 확인
6. `/etc/fstab`에 UUID로 등록
7. `mount -a` / `findmnt --verify`로 검증

핵심은 4번(임시 마운트)과 6~7번(영구 설정)이 별개라는 점이다. `mount` 명령으로 마운트한 디스크는 재부팅하면 사라진다. 재부팅 후에도 유지하려면 반드시 `/etc/fstab`에 등록해야 한다. 아래에서 이 순서를 그대로 따라간다.

## lsblk — 디스크 구조 확인

`lsblk`(list block devices)는 시스템에 연결된 디스크와 파티션을 트리 구조로 보여준다. 디스크를 추가한 직후 가장 먼저 실행하는 명령이다.

```bash
$ lsblk
NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
sda       8:0    0   50G  0 disk
├─sda1    8:1    0   49G  0 part /
└─sda2    8:2    0    1G  0 part /boot
sdb       8:16   0  100G  0 disk
```

`TYPE` 컬럼의 `disk`는 물리(또는 가상) 디스크 자체를, `part`는 그 안의 파티션을 의미한다. 위 예시에서 `sdb`는 자식 파티션(`sdb1` 같은)이 없고 `MOUNTPOINTS`도 비어 있는데, 이는 커널이 디스크는 인식했지만 아직 파티션도 없고 마운트도 안 된 순수 raw 상태라는 뜻이다. 서버에 디스크를 추가하고 가장 먼저 확인해야 할 신호가 바로 이것이다.

## 파티션 생성과 포맷, 임시 마운트

디스크가 인식됐으니 사용할 수 있는 형태로 만든다. 파티션을 나누고, 파일시스템을 입히고, 디렉토리에 붙이는 세 단계다.

먼저 파티션을 생성한다. 2TB를 넘는 디스크나 최신 환경에서는 MBR 대신 GPT 파티션 테이블을 쓰는 것이 표준이므로 `parted`로 GPT 레이블을 만들고 전체 공간을 파티션 하나로 할당한다.

```bash
# GPT 파티션 테이블 생성 후 전체 공간을 파티션 하나로 할당
$ sudo parted /dev/sdb --script mklabel gpt
$ sudo parted /dev/sdb --script mkpart primary 0% 100%
```

> 파티션 없이 디스크 전체(`/dev/sdb`)에 바로 파일시스템을 만드는 것도 가능하며, 단일 대용량 데이터 볼륨에서는 오히려 이 방식을 쓰기도 한다. 다만 파티션 테이블이 있으면 `lsblk`에서 용도가 더 명확히 드러나므로, 여기서는 파티션을 나눠 진행한다.

다음으로 파티션을 포맷한다. 이 글의 예시는 데이터 디스크이므로 xfs로 포맷한다(타입 선택 기준은 뒤에서 다룬다).

```bash
$ sudo mkfs.xfs /dev/sdb1
meta-data=/dev/sdb1  isize=512    agcount=4, agsize=6553600 blks
...
Discarding blocks...Done.
```

이 `mkfs.xfs` 시점에 파일시스템 고유의 UUID가 부여된다. UUID가 "포맷할 때 생긴다"는 사실은 뒤에서 UUID를 쓰는 이유를 이해하는 데 중요하다.

마지막으로 마운트할 디렉토리(마운트포인트)를 만들고 임시로 마운트한다.

```bash
$ sudo mkdir -p /data
$ sudo mount /dev/sdb1 /data
$ df -h /data
Filesystem      Size  Used Avail Use% Mounted on
/dev/sdb1        100G  747M  100G   1% /data
```

`df -h`로 `/data`가 `/dev/sdb1`에 연결된 것이 보이면 임시 마운트는 성공이다. 다만 이 상태는 재부팅하면 사라진다는 점을 기억하자. 영구화는 `/etc/fstab`에서 한다.

## blkid — UUID와 저수준 정보 확인

`/etc/fstab`에 등록하려면 파티션의 UUID가 필요하다. 파일시스템 타입과 UUID를 한눈에 보고 싶다면 `lsblk -f`가 편하다.

```bash
$ lsblk -f
NAME    FSTYPE FSVER LABEL UUID                                 MOUNTPOINTS
sda
├─sda1  ext4   1.0         1234abcd-56ef-78ab-90cd-ef1234567890 /
└─sda2  ext4   1.0         2345bcde-67fa-89bc-01de-f23456789012 /boot
sdb
└─sdb1  xfs                a1b2c3d4-e5f6-7890-abcd-ef1234567890 /data
```

방금 포맷한 `sdb1`이 xfs로, UUID와 함께 `/data`에 마운트된 것이 보인다. 특정 파티션의 UUID·LABEL·PARTUUID 같은 저수준 정보만 콕 집어 보고 싶다면 `blkid`를 쓴다.

```bash
$ sudo blkid /dev/sdb1
/dev/sdb1: UUID="a1b2c3d4-e5f6-7890-abcd-ef1234567890" TYPE="xfs" PARTUUID="3f8b0e2a-01"
```

여기서 UUID를 확인하는 이유를 짚고 넘어가야 한다. `/dev/sdb1` 같은 장치명은 커널이 디스크를 인식하는 순서에 따라 붙는 이름이다. 즉 디스크를 추가하거나 제거한 뒤 재부팅하면 같은 물리 디스크가 `/dev/sdc1`로 바뀔 수 있다. 이런 장치명을 `/etc/fstab`에 그대로 적으면, 다음 재부팅 때 엉뚱한 디스크가 마운트되거나 부팅 자체가 실패할 위험이 있다.

반면 UUID는 앞서 `mkfs` 단계에서 파일시스템에 부여된 고유 식별자라 디스크 순서가 바뀌어도 값이 변하지 않는다. 그래서 `/etc/fstab`에는 장치명이 아니라 UUID를 쓰는 것이 표준 관행이다.

정리하면 `lsblk -f`는 전체 디스크 구조를 트리로 훑으며 빠르게 확인할 때 쓰고, `blkid`는 특정 파티션의 UUID·LABEL·PARTUUID 같은 상세 정보가 필요할 때 쓴다. 두 명령 모두 UUID를 보여주지만 쓰는 맥락이 다르다.

## /etc/fstab — 부팅 시 자동 마운트 설정

`mount` 명령으로 마운트한 디스크는 재부팅하면 사라진다고 앞서 언급했다. 재부팅 후에도 자동으로 마운트되게 하려면 `/etc/fstab`(file system table)에 등록해야 한다.

`/etc/fstab`의 한 줄은 공백(또는 탭)으로 구분된 6개 필드로 구성된다.

| 필드 | 의미 | 예시 |
|------|------|------|
| 1. 장치 | 마운트할 파티션 (UUID 권장) | `UUID=a1b2c3d4-...` |
| 2. 마운트포인트 | 마운트될 디렉토리 | `/data` |
| 3. 타입 | 파일시스템 종류 | `xfs`, `ext4`, `nfs`, `swap` |
| 4. 옵션 | 마운트 옵션 | `defaults`, `noatime`, `nofail` |
| 5. dump | dump 백업 대상 여부 (거의 항상 0) | `0` |
| 6. fsck 순서 | 부팅 시 파일시스템 검사 순서 | `0`, `1`, `2` |

앞서 만든 `/data` 디스크를 등록하려면 5번 blkid에서 확인한 UUID를 1번 필드에 넣는다. 실제 파일은 이런 모습이다.

```
# /etc/fstab
UUID=1234abcd-...          /          ext4  defaults          0  1
UUID=a1b2c3d4-...          /data      xfs   defaults,noatime  0  0
192.168.1.10:/share        /mnt/nfs   nfs   defaults,_netdev  0  0
UUID=9876fedc-...          none       swap  sw                0  0
```

각 줄이 무엇을 마운트하는지 보자. 첫 줄은 루트, 둘째 줄이 이번에 추가한 데이터 디스크(xfs), 셋째 줄은 원격 NFS 공유, 넷째 줄은 swap 영역이다. swap은 디렉토리에 마운트되는 것이 아니므로 마운트포인트를 `none`으로, 옵션을 `sw`로 적는다.

### 마운트 옵션(4번 필드) 주요 값

4번 옵션 필드는 콤마로 여러 개를 나열한다. 실무에서 자주 쓰는 값은 다음과 같다.

| 옵션 | 의미 |
|------|------|
| `defaults` | `rw,suid,dev,exec,auto,nouser,async`를 한 번에 지정하는 기본 묶음 |
| `noatime` | 파일을 읽을 때마다 갱신되는 access time 기록을 생략 → 읽기가 많은 데이터 디스크의 불필요한 쓰기 I/O 절감 |
| `nofail` | 부팅 시 해당 장치가 없어도 부팅을 멈추지 않음 (데이터/보조 디스크에 권장) |
| `_netdev` | 네트워크가 준비된 뒤 마운트 (NFS 등 네트워크 파일시스템에 필요) |
| `ro` / `rw` | 읽기 전용 / 읽기·쓰기 |

여기서 `nofail`은 특히 중요하다. `/etc/fstab`은 오타 하나로 부팅이 멈출 수 있는 파일이다. 존재하지 않는 UUID를 적거나 마운트할 디스크가 물리적으로 빠진 상태로 부팅하면, 기본 동작상 시스템이 해당 파일시스템을 찾다가 부팅이 응급 모드(emergency mode)로 떨어질 수 있다. 루트가 아닌 데이터 디스크나 NFS처럼 "없어도 일단 부팅은 돼야 하는" 항목에는 `nofail`을 넣어 두면 이런 사고를 예방할 수 있다.

## 부팅 전 검증 — mount -a와 findmnt --verify

`/etc/fstab`은 수정 직후 반드시 재부팅 전에 검증한다. 재부팅했다가 오타로 부팅이 막히면 콘솔 접근 없이는 복구가 번거롭기 때문이다.

가장 기본적인 검증은 `mount -a`다.

```bash
$ sudo mount -a
```

`mount -a`는 `/etc/fstab`에 적힌 항목 중 `auto` 대상(대부분의 항목)을 지금 즉시 마운트해 본다. 여기서 에러가 나지 않으면 재부팅해도 안전하다고 볼 수 있다. 다만 두 가지 한계를 알아두자.

- `mount -a`는 **이미 마운트된 항목은 건너뛴다.** 그래서 방금 임시 마운트한 `/data`는 다시 마운트하지 않는다. fstab 줄 자체를 실제로 테스트하려면 `sudo umount /data` 후 `sudo mount -a`로 fstab 정의만으로 다시 붙는지 확인하는 편이 확실하다.
- `mount -a`는 **swap을 켜지 않는다.** swap 항목은 `sudo swapon -a`로 별도 활성화하고 `swapon --show`로 확인한다.

문법·경로·중복 등을 정적으로 점검하고 싶다면 `findmnt --verify`가 유용하다. 실제 마운트를 시도하지 않고 `/etc/fstab`의 각 줄을 검사해 경고와 오류를 보여준다.

```bash
$ findmnt --verify
/          : target exists
/data      : target exists
/mnt/nfs   : target exists

0 parse errors, 0 errors, 0 warnings
```

한 가지 더, systemd 기반 배포판(최신 Ubuntu/RHEL 등)은 `/etc/fstab`을 부팅 시 mount 유닛으로 변환해 사용한다. fstab을 수정한 뒤에는 다음으로 systemd가 변경을 다시 읽게 해 주는 것이 안전하다.

```bash
$ sudo systemctl daemon-reload
```

## fsck 순서 — 6번째 필드의 의미

`fsck`(file system check)는 부팅 시 파일시스템 손상을 검사하고 복구하는 절차다. 6번째 필드는 이 검사를 어떤 순서로 할지 지정한다.

- **1**: 루트(`/`) 파일시스템 전용 값이다. 다른 어떤 파일시스템보다 먼저, 그리고 단독으로 검사된다.
- **2**: 루트 이외의 로컬 디스크에 쓴다. 루트 검사가 끝난 뒤 검사되며, 값이 2인 파일시스템들이 서로 다른 물리 드라이브에 있으면 병렬로 검사될 수 있다.
- **0**: 검사하지 않는다.

값이 0인 경우를 정리하면 이렇다.

- **NFS**: 마운트하는 쪽이 아니라 원격 서버가 파일시스템 무결성을 책임지므로 로컬에서 검사할 필요가 없다.
- **swap**: 파일시스템이 아니라 메모리 보조 공간이므로 fsck 대상 자체가 아니다.
- **xfs**: 값이 0이지만 이유가 조금 특별하다. xfs는 저널링 파일시스템이라 마운트되는 시점에 저널을 재생(replay)하면서 자동으로 정합성을 복구한다. `/etc/fstab`에서 6번 필드가 0인 것도 이 때문인데, 실제로 시스템의 `fsck.xfs` 바이너리 자체가 아무 검사도 하지 않고 바로 성공을 반환하는 껍데기(no-op)로 구현되어 있다. xfs에 정말 심각한 손상이 생겼을 때의 복구는 부팅 시 자동 fsck가 아니라 관리자가 직접 `xfs_repair`를 수동으로 실행해야 한다.

그래서 앞서 만든 xfs 데이터 디스크의 6번 필드를 `0`으로 둔 것이다. 만약 같은 자리에 ext4 데이터 디스크를 등록했다면 `2`가 적절하다.

## 파일시스템 타입 비교

| 타입 | 특징 | 주 사용처 |
|------|------|----------|
| ext4 | 리눅스 전통 기본 파일시스템, 가장 무난하고 축소(shrink)도 가능 | Ubuntu/Debian 기본값 |
| xfs | 대용량·고성능, 큰 파일과 병렬 I/O에 강함, 축소(shrink) 불가 | RHEL/CentOS/Rocky 기본값 |
| nfs | 파일시스템이 아니라 네트워크 프로토콜, 원격 디렉토리를 로컬처럼 마운트 | 파일 서버 공유 |
| swap | 디스크를 메모리 보조 공간으로 사용, 마운트포인트가 없어 `none`으로 표기 | 메모리 부족 대비 |

ext4는 파일 크기 최대 16TB, 볼륨 크기 최대 1EB까지 지원해 일반 용도로는 충분하다. xfs는 더 큰 볼륨과 대용량 파일, 다수의 프로세스가 동시에 읽고 쓰는 병렬 I/O 워크로드에서 유리하다. 다만 xfs는 온라인으로 확장(`xfs_growfs`)은 되지만 한 번 만든 볼륨을 줄일 수는 없다는 제약이 있어, 용량을 빠듯하게 잡기보다 여유 있게 잡아 두는 편이 안전하다. 반대로 ext4는 `resize2fs`로 확장과 축소가 모두 가능하다.

데이터 엔지니어링 관점에서 보면, Kafka·StarRocks·HDFS처럼 대용량 파일을 순차 쓰기/읽기하고 여러 프로세스가 동시에 접근하는 데이터 디스크는 xfs를 선택하는 경향이 있다. 이 글의 실습에서 데이터 디스크를 xfs로 포맷한 것도 같은 맥락이다.

반대로 swap은 데이터 시스템에서는 오히려 꺼두는 것이 권장된다. JVM 힙이나 DB 캐시처럼 메모리에 상주해야 할 데이터가 swap으로 밀려나면 디스크 I/O를 거치게 되어 지연시간이 수십 배로 뛸 수 있다. 실제로 Kafka와 Elasticsearch 공식 문서 모두 운영 서버에서 swap을 끄거나(`swapoff -a`) `vm.swappiness`를 낮추도록 권장한다.

## 실무에서 자주 만나는 함정

- **장치명을 fstab에 직접 적음**: `/dev/sdb1`은 재부팅 시 이름이 바뀔 수 있다. 반드시 UUID(또는 LABEL)를 쓴다.
- **데이터 디스크에 `nofail`을 빠뜨림**: 디스크가 빠지거나 UUID 오타가 나면 부팅이 응급 모드로 떨어진다. 루트가 아닌 항목엔 `nofail`을 습관화한다.
- **NFS에 `_netdev` 누락**: 네트워크가 올라오기 전에 마운트를 시도해 부팅이 지연되거나 실패한다.
- **수정 후 검증 생략**: `mount -a`, `findmnt --verify`, systemd라면 `systemctl daemon-reload`까지 마친 뒤에 재부팅한다.
- **xfs를 줄이려다 막힘**: xfs는 shrink가 불가능하므로, 축소가 필요할 여지가 있으면 ext4를 택하거나 LVM으로 유연성을 확보한다.

## 정리

디스크 하나를 추가해서 영구적으로 쓸 수 있게 만드는 과정은 결국 "인식 확인(`lsblk`) → 파티션·포맷(`parted`, `mkfs`) → 임시 마운트(`mount`) → 고유 식별자 확인(`blkid`) → 영구 설정(`/etc/fstab`) → 검증(`mount -a`, `findmnt --verify`)"의 흐름이다. 여기에 장치명 대신 UUID를 쓰는 이유, fsck 순서 필드가 xfs에서는 사실상 의미가 없는 배경, 데이터 시스템에서 xfs를 선호하고 swap을 끄는 이유까지 함께 알아두면, 단순히 명령어를 외우는 것을 넘어 "왜 이렇게 설정하는지"까지 설명할 수 있게 된다.

## Reference

- `man lsblk`, `man blkid`, `man fstab`, `man fsck`, `man findmnt`
- [Kafka Documentation - Operating Systems](https://kafka.apache.org/documentation/#os)
- [Elasticsearch - Disable swapping](https://www.elastic.co/guide/en/elasticsearch/reference/current/setup-configuration-memory.html)
- [XFS - Wikipedia (특성 개요)](https://en.wikipedia.org/wiki/XFS)
