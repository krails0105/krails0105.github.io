---
title: "Flink 체크포인트를 로컬 파일시스템에서 S3로 마이그레이션하기"
categories:
  - Flink
tags: [Flink, S3, Checkpoint, EKS, RocksDB, Kubernetes, Troubleshooting]
---

## 개요

EKS 위에서 운영 중인 Flink 스트리밍 잡이 **5,574회** 무한 재시작에 빠진 원인을 분석하고, 체크포인트 저장소를 로컬 파일시스템에서 S3로 마이그레이션하여 해결한 과정을 정리한다.

이 글을 읽고 나면 다음을 할 수 있다.

- 로컬 파일시스템 체크포인트가 Kubernetes 환경에서 왜 위험한지 설명할 수 있다
- `flink-s3-fs-hadoop` 플러그인을 활성화하고 S3 체크포인트를 구성할 수 있다
- `upgradeMode`(stateless / last-state / savepoint) 세 가지 모드의 차이를 이해한다

---

## 문제 상황

EKS에서 실행 중인 Flink 스트리밍 잡이 갑자기 무한 재시작 루프에 빠졌다. Flink Operator가 찍어둔 재시작 횟수가 **5,574회**까지 올라가 있었다.

에러 로그를 확인하니 다음과 같은 패턴이 반복되고 있었다.

```
FileNotFoundException: /tmp/flink-checkpoints/d03ab439.../chk-552/... (No such file or directory)
Could not restore keyed state backend for KeyedProcessOperator
Job Pipeline Monitoring switched from state RUNNING to RESTARTING
5 tasks will be restarted to recover the failed task
```

로그를 읽는 순서가 중요하다. Flink는 잡이 실패하면 **마지막으로 완료된 체크포인트에서 상태를 복구**하려 한다. 그런데 `FileNotFoundException`이 먼저 나왔고, 바로 뒤에 `KeyedProcessOperator` 상태 복구 실패, 그리고 `RESTARTING` 전환으로 이어진다. 즉, 파일을 못 찾아서 복구에 실패하고, 실패하니 재시작하고, 재시작하면 또 같은 파일을 못 찾는 루프다.

---

## 근본 원인 파악

체크포인트 경로가 `file:///tmp/flink-checkpoints`로 설정되어 있었다.

`/tmp`는 컨테이너 로컬 파일시스템이다. **파드가 재시작되면 `/tmp`는 사라진다.** 처음 파드가 죽은 이유는 별개의 이슈(OOM, 노드 drain 등)였겠지만, 파드가 뜨고 나서 Flink가 이전 체크포인트를 복구하려는 순간 파일이 없으니 다시 실패하는 구조였다.

이걸 한 줄로 정리하면:

> 파드 재시작 &rarr; `/tmp` 소멸 &rarr; 체크포인트 없음 &rarr; 복구 실패 &rarr; 재시작 &rarr; 무한 반복

로컬 파일시스템 체크포인트는 단일 파드 환경에서도 재시작에 취약하다. EKS처럼 파드가 언제든 교체될 수 있는 환경에서는 **처음부터 외부 영구 스토리지를 써야 한다.**

---

## 사전 준비

이 글의 수정 과정을 따라가려면 다음이 필요하다.

- EKS 클러스터에 Flink Kubernetes Operator가 설치되어 있어야 한다
- AWS CLI가 구성되어 있고, S3 버킷을 생성할 수 있는 IAM 권한이 있어야 한다
- Flink 1.20 기준으로 작성되었으나, 1.15 이상이면 동일한 방식이 적용된다

---

## 수정 방법

총 4가지를 변경했다.

### 1단계: S3 버킷 생성

```bash
aws s3 mb s3://<your-bucket-name> --region <your-region>
```

체크포인트와 세이브포인트를 각각 다른 prefix로 분리해서 저장할 예정이므로 하나의 버킷으로 충분하다.

### 2단계: Dockerfile에서 S3 플러그인 활성화

Flink 공식 이미지는 S3 연동 JAR(`flink-s3-fs-hadoop`)을 `/opt/flink/opt/`에 포함해두지만 기본적으로 비활성 상태다. Flink의 [플러그인 로딩 메커니즘](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/filesystems/plugins/)에 따라 `/opt/flink/plugins/` 하위 디렉토리에 복사해야 자동으로 로드된다.

```dockerfile
# Dockerfile 예시
FROM flink:1.20-java17

# S3 filesystem plugin 활성화
# opt/ 디렉토리의 JAR을 plugins/ 하위로 복사하면 Flink가 자동 로드한다
RUN mkdir -p /opt/flink/plugins/s3-fs-hadoop && \
    cp /opt/flink/opt/flink-s3-fs-hadoop-*.jar /opt/flink/plugins/s3-fs-hadoop/

COPY target/my-flink-job.jar /opt/flink/usrlib/my-flink-job.jar
```

> **이 단계를 빠뜨리면** S3 경로를 설정해도 `No FileSystem for scheme: s3` 에러가 발생한다.

### 3단계: FlinkDeployment YAML에서 체크포인트 경로 변경

```yaml
# FlinkDeployment 핵심 설정 (예시)
flinkConfiguration:
  # 상태 백엔드: RocksDB (대규모 상태에 적합)
  state.backend: rocksdb

  # 체크포인트/세이브포인트를 S3에 저장
  state.checkpoints.dir: s3://<your-bucket-name>/checkpoints
  state.savepoints.dir: s3://<your-bucket-name>/savepoints

  # 체크포인트 주기: 5분
  execution.checkpointing.interval: "300000"

  # 잡 취소 시에도 체크포인트 보존 (운영 환경 권장)
  execution.checkpointing.externalized-checkpoint-retention: RETAIN_ON_CANCELLATION

  # EKS 노드 IAM Role로 S3 자격증명 획득
  fs.s3a.aws.credentials.provider: com.amazonaws.auth.InstanceProfileCredentialsProvider
```

변경 포인트 세 가지:

- **`state.checkpoints.dir`**: `file:///tmp/...` &rarr; `s3://...`
- **`state.savepoints.dir`**: 세이브포인트도 S3에 저장
- **`fs.s3a.aws.credentials.provider`**: EKS 노드 IAM Role(Instance Profile)로 자격증명 획득

EKS에서 S3에 접근할 때는 `InstanceProfileCredentialsProvider`를 쓰거나 IRSA(IAM Role for Service Accounts)를 쓰는 두 가지 방법이 있다. 노드 레벨 IAM Role을 사용하는 경우라면 `InstanceProfileCredentialsProvider`가 간단하다. 보안 관점에서는 IRSA가 최소 권한 원칙에 더 부합한다.

### 4단계: IAM 정책에 S3 권한 추가

EKS 노드 IAM Role에 다음 권한을 추가했다.

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket"
  ],
  "Resource": [
    "arn:aws:s3:::<your-bucket-name>",
    "arn:aws:s3:::<your-bucket-name>/*"
  ]
}
```

**`ListBucket`은 버킷 자체에, `GetObject`/`PutObject`/`DeleteObject`는 버킷 하위 객체(`/*`)에 각각 부여해야 한다.** 두 Resource를 분리하지 않으면 `ListBucket`이 동작하지 않아 Flink가 체크포인트 목록을 탐색하지 못한다.

---

## upgradeMode 이해하기

이번 작업을 하면서 `upgradeMode` 설정의 차이도 짚고 넘어갈 필요가 있었다. Flink Kubernetes Operator는 세 가지 업그레이드 모드를 제공한다.

```yaml
job:
  upgradeMode: last-state  # stateless | last-state | savepoint
```

| 모드 | 동작 | 권장 상황 |
|---|---|---|
| `stateless` | 상태를 버리고 새로 시작한다 | 개발/테스트 단계에서 빠른 반복 배포 |
| `last-state` | 최신 체크포인트 또는 세이브포인트에서 복구한다 | 운영 환경 일반 업그레이드 |
| `savepoint` | 명시적으로 세이브포인트를 찍고, 그 세이브포인트에서 복구한다 | Flink 마이너 버전 업그레이드 등 |

**S3 체크포인트**와 **`upgradeMode`**는 역할이 다르다.

- S3 체크포인트는 **파드 비정상 종료**(크래시, 강제 종료)로부터 자동 복구하는 메커니즘이다.
- `upgradeMode`는 **의도적인 재배포**(새 이미지 배포, 설정 변경) 시에도 이전 상태를 이어받을지 결정한다.

`last-state` 모드를 사용하려면 **체크포인팅이 활성화되어 있고, HA 메타데이터에 접근할 수 있어야** 한다. HA 메타데이터 형식은 Flink 마이너 버전 간에 호환되지 않을 수 있으므로, 버전 업그레이드 시에는 `savepoint` 모드를 사용해야 한다.

개발 초기에는 `stateless`로 두고 빠르게 반복 배포하다가, 서비스가 안정되면 `last-state`로 전환하는 게 일반적인 접근이다.

---

## 참고: 오퍼레이터 이름 지정으로 디버깅 개선하기

Flink Web UI에서 토폴로지를 볼 때 `KeyedProcessOperator -> KeyedProcessOperator -> ...` 처럼 나오면 어떤 오퍼레이터가 문제인지 파악이 어렵다. `.name()`을 붙여두면 에러 로그에서도 이름이 그대로 나와서 디버깅이 훨씬 쉽다.

```java
// 오퍼레이터에 의미 있는 이름을 부여하는 예시
events
    .keyBy(PipelineEvent::getStateKey)
    .process(new FreshnessChecker())
    .name("Freshness Checker");   // Web UI와 에러 로그에 이 이름이 표시됨

events
    .filter(e -> "ERROR".equals(e.getEventType()))
    .name("Error Filter")
    .keyBy(PipelineEvent::getStateKey)
    .process(new ErrorRateChecker())
    .name("Error Rate Checker");
```

이번 장애에서도 `KeyedProcessOperator`라고만 표시되어 어떤 오퍼레이터가 복구에 실패했는지 즉시 파악하기 어려웠다. `.name()`을 지정했더라면 로그에서 바로 특정 오퍼레이터를 식별할 수 있었을 것이다.

---

## 주의할 점

### S3 플러그인은 반드시 plugins/ 디렉토리에 배치해야 한다

Flink의 플러그인 로딩 메커니즘은 `/opt/flink/plugins/{plugin-name}/` 하위에 JAR이 있어야 한다. `opt/`에 있는 JAR을 직접 클래스패스에 추가하는 방식은 공식적으로 권장하지 않는다.

### 체크포인트 경로를 바꾸면 기존 체크포인트에서 복구할 수 없다

로컬 체크포인트가 소멸된 상황이라 사실상 깨끗하게 재시작하는 것과 같았다. 하지만 **정상 운영 중인 잡의 체크포인트 경로를 변경**하려면, 먼저 세이브포인트를 찍고 그 경로를 새 잡의 초기 복구 포인트로 지정해야 한다.

```bash
# 세이브포인트 트리거 (FlinkDeployment 기준)
kubectl patch flinkdeployment <name> --type merge \
  -p '{"spec":{"job":{"state":"suspended","upgradeMode":"savepoint"}}}'
```

### IAM 정책에서 버킷 ARN과 객체 ARN을 분리해야 한다

`s3:::<bucket>/*`만 넣으면 `ListBucket` 작업이 버킷 레벨에서 동작하지 않아 Flink가 체크포인트를 탐색하지 못한다. 반드시 버킷 ARN(`s3:::<bucket>`)과 객체 ARN(`s3:::<bucket>/*`)을 별도 리소스로 지정해야 한다.

---

## 정리

| 항목 | 변경 전 | 변경 후 |
|---|---|---|
| 체크포인트 저장소 | `file:///tmp/flink-checkpoints` | `s3://<bucket>/checkpoints` |
| 세이브포인트 저장소 | 미설정 | `s3://<bucket>/savepoints` |
| S3 플러그인 | 비활성 | `plugins/s3-fs-hadoop/`에 JAR 복사 |
| IAM 권한 | 없음 | S3 Get/Put/Delete/List 추가 |

핵심 교훈은 단순하다. **Kubernetes 환경에서 Flink 체크포인트는 파드 수명보다 긴 수명을 가진 스토리지에 저장해야 한다.** 로컬 파일시스템은 개발 환경에서조차 파드 재시작 시 상태를 잃을 수 있으므로, S3 같은 외부 스토리지를 처음부터 구성하는 것이 안전하다.

---

## 다음 단계

- **체크포인트 보존 정책**: S3 수명 주기 규칙으로 오래된 체크포인트 자동 삭제 설정
- **IRSA 전환**: 노드 Role 대신 서비스 어카운트 단위 IAM 권한 부여로 최소 권한 원칙 강화
- **체크포인트 모니터링**: Flink 메트릭에서 `numberOfCompletedCheckpoints`, `lastCheckpointDuration`을 Prometheus로 수집하여 체크포인트 누락 감지 알람 추가

---

## Reference

- [Flink File Systems -- S3](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/filesystems/s3/)
- [Flink Plugins](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/filesystems/plugins/)
- [Flink Checkpointing](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/checkpointing/)
- [Flink Configuration -- State Backends](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/#checkpoints-and-state-backends)
- [Flink Kubernetes Operator -- Job Management (upgradeMode)](https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-stable/docs/custom-resource/job-management/)
