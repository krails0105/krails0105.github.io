---
title: "[DataEngineering] Soda Core로 Delta Lake, PostgreSQL, BigQuery 통합 데이터 품질 모니터링 — Cross-source Sync Lag 검증까지"
categories:
  - DataEngineering
tags:
  - Soda
  - DataQuality
  - PostgreSQL
  - BigQuery
  - DeltaLake
  - SodaCL
date: 2026-03-10
---

### 이 글에서 다루는 것

Delta Lake(Databricks)를 source of truth로 두고, PostgreSQL(RDS)과 BigQuery로 데이터를 sync하는 파이프라인에서 **세 소스의 데이터 정합성을 자동으로 검증**하는 방법을 정리한다.

구체적으로는:

- Soda Core 오픈소스를 사용해 세 데이터 소스에 커넥터를 연결하고
- 각 소스에서 `max(id)` 같은 지표를 뽑아 **cross-source sync lag**을 탐지하며
- 구현 과정에서 부딪힌 **실전 gotcha 4가지**를 공유한다

글을 다 읽고 나면, 다중 소스 환경에서 ingestion 지연이나 누락을 자동 감지하는 모니터링 스크립트를 직접 구성할 수 있다.

---

### 배경: 왜 Cross-source 모니터링이 필요한가

ETL 파이프라인 구조는 다음과 같다.

```
Delta Lake (Databricks)  ──→  PostgreSQL (RDS)   [API 서빙용]
                         ──→  BigQuery           [분석용]
```

Delta Lake가 source of truth이고, PostgreSQL과 BigQuery는 각각의 용도로 데이터를 내려 받는다. 문제는 **어느 한 쪽 ingestion이 조용히 실패하거나 지연될 때 감지할 방법이 없다**는 것이다. 수동으로 쿼리를 날려 확인하는 건 스케일하지 않는다.

원하는 것은 단순하다:

1. 각 소스에서 `max(id)` 같은 최신 행 위치를 뽑고
2. `delta_max - psql_max`가 임계값(N)을 넘으면 경고를 띄우는 것

이를 **Soda Core**로 구현하기로 했다.

---

### 왜 Soda Core인가

[Soda Core](https://github.com/sodadata/soda-core)는 오픈소스 데이터 품질 프레임워크다. **SodaCL**(YAML 기반 체크 언어)로 규칙을 정의하고, Python API(`soda.scan.Scan`)로 실행한다. 각 데이터 소스마다 별도 커넥터 패키지를 설치하는 가벼운 구조라서, 필요한 소스만 골라 붙일 수 있다.

커넥터별 설치 패키지:

| 대상 | 패키지 | 비고 |
|---|---|---|
| PostgreSQL / RDS | `soda-core-postgres` | `psycopg2` 기반 |
| BigQuery | `soda-core-bigquery` | 서비스 계정 JSON 또는 ADC 인증 |
| Databricks SQL Warehouse | `soda-core-spark` | `method: databricks` 옵션으로 연결 |

```bash
pip install soda-core-postgres soda-core-bigquery soda-core-spark
```

> **참고**: `soda-core-databricks`라는 별도 패키지는 PyPI에 존재하지 않는다. Databricks 연결은 `soda-core-spark` 안에 내장되어 있다 (뒤의 Gotchas 섹션에서 상세히 다룬다).

#### Cross-source 비교의 한계

Soda에는 `reconciliation` 문법으로 서로 다른 소스 간 데이터를 직접 비교하는 기능이 있지만, 이는 **Soda Cloud(유료 플랜) 전용**이다. 무료 오픈소스 버전에서는 사용할 수 없다.

따라서 이 글에서는 **각 소스에서 개별 scan을 돌려 값을 추출한 뒤, Python에서 diff를 계산**하는 방식으로 우회한다.

---

### 구현

#### Step 1. configuration.yml -- 세 소스 연결 정의

세 소스 모두 `configuration.yml` 하나에 정의한다. credentials는 환경변수(`${VAR}`)로 주입해서 파일에 하드코딩하지 않는다.

```yaml
# soda/configuration.yml

# PostgreSQL (RDS 직접 엔드포인트 — Proxy가 아님, 이유는 Gotchas 참조)
data_source psql:
  type: postgres
  connection:
    host: ${PG_HOST}
    port: "5432"
    username: ${PG_USER}
    password: ${PG_PASSWORD}
    database: mydb
  schema: myschema

# BigQuery (서비스 계정 JSON 파일 인증)
data_source bq:
  type: bigquery
  connection:
    account_info_json_path: ${BQ_SERVICE_ACCOUNT_PATH}
    project_id: ${BQ_PROJECT_ID}
    dataset: mydataset

# Databricks SQL Warehouse (soda-core-spark 내장 커넥터)
data_source delta:
  type: spark
  method: databricks
  catalog: my_catalog
  schema: myschema
  host: ${DATABRICKS_HOST}
  http_path: ${DATABRICKS_HTTP_PATH}
  token: ${DATABRICKS_TOKEN}
```

각 소스별 주의 사항:

- **PostgreSQL**: `connection:` 블록 안에 `host`, `port`, `username`, `password`, `database`를 넣는다. `port`는 문자열로 감싸야 한다.
- **BigQuery**: `account_info_json_path`로 서비스 계정 JSON 파일 경로를 지정하거나, `gcloud auth application-default login`으로 ADC 인증을 사용할 수 있다.
- **Databricks**: `type: spark`에 `method: databricks`를 지정한다. `database`가 아니라 **`catalog`** 키를 사용하는 점에 주의한다. SQL Warehouse의 Connection Details에서 `host`와 `http_path`를 복사해 온다.

#### Step 2. Soda Scan API 기본 패턴

Soda Core의 Python API로 scan을 실행하고, 체크 결과에서 실측값을 추출하는 래퍼 함수를 만든다.

```python
# soda/sync_lag_check.py
from soda.scan import Scan


def run_soda_check(source_name: str, checks_yaml: str) -> dict:
    """단일 소스에 대해 Soda scan을 실행하고 결과를 반환한다."""
    scan = Scan()
    scan.set_scan_definition_name(f"sync_lag_{source_name}")
    scan.set_data_source_name(source_name)  # configuration.yml의 data_source 이름과 일치해야 함
    scan.add_configuration_yaml_file("soda/configuration.yml")
    scan.add_sodacl_yaml_str(checks_yaml)

    exit_code = scan.execute()
    # exit_code: 0=pass, 1=warn, 2=fail, 3=error

    # 체크 결과에서 실측값(check_value) 추출
    values = {}
    for check in scan._checks:
        values[check.name] = check.check_value

    return {
        "exit_code": exit_code,
        "has_fails": scan.has_check_fails(),
        "values": values,
        "logs": scan.get_logs_text(),
    }
```

핵심 포인트 몇 가지:

- `set_data_source_name()`에 전달하는 이름은 `configuration.yml`에 정의한 `data_source` 이름(`psql`, `bq`, `delta`)과 정확히 일치해야 한다.
- `scan._checks`는 Soda Core의 내부 속성(private attribute)이다. 공식 API인 `scan.get_scan_results()`로도 결과를 가져올 수 있지만, 개별 체크의 `check_value`(실측 수치)에 접근하려면 `_checks`를 직접 참조해야 한다. 버전 업데이트 시 인터페이스가 변경될 수 있으므로 주의한다.
- `scan.execute()`는 정수 exit code를 반환한다. `scan.has_check_fails()`, `scan.has_error_logs()` 등의 메서드로도 결과를 판별할 수 있다.

#### Step 3. SodaCL 체크 정의

각 소스에서 돌리는 체크는 단순하다. `max(id)` 값 조회와 함께, 기본적인 freshness와 row count 체크도 걸어 두면 운영 시 유용하다.

```yaml
# 예시: 3개 테이블, 8개 체크 → PSQL 기준 약 4초에 완료
checks for orders:
  - row_count > 0
  - max(id):
      name: max_id_orders
  - freshness(updated_at) < 2h

checks for products:
  - row_count > 0
  - max(id):
      name: max_id_products

checks for users:
  - row_count > 0
  - max(id):
      name: max_id_users
```

- `max(id)`: 테이블의 최대 ID를 조회한다. `name`을 지정하면 Python에서 `check.name`으로 결과를 찾을 수 있다.
- `row_count > 0`: 테이블이 비어 있지 않은지 확인한다. 가장 기본적인 sanity check다.
- `freshness(updated_at) < 2h`: `updated_at` 컬럼의 최신값이 현재 시각 기준 2시간 이내인지 확인한다. 테이블에 타임스탬프 컬럼이 있을 때 사용한다.

#### Step 4. Cross-source Lag 비교 로직

세 소스에서 각각 scan을 실행하고, 결과를 모아서 Python에서 lag을 계산한다.

```python
# soda/sync_lag_check.py (이어서)

TABLES = ["orders", "products", "users"]
LAG_CRITICAL = 100  # 이 이상 차이나면 CRITICAL
LAG_WARNING = 10    # 이 이상 차이나면 WARNING


def build_checks(table: str) -> str:
    """테이블별 SodaCL 체크 YAML을 생성한다."""
    return f"""
checks for {table}:
  - max(id):
      name: max_id_{table}
"""


def check_sync_lag() -> list[dict]:
    """세 소스의 max(id)를 비교하여 sync lag을 계산한다."""
    results = {}

    for source in ["delta", "psql", "bq"]:
        checks = "\n".join(build_checks(t) for t in TABLES)
        results[source] = run_soda_check(source, checks)

    # cross-source 비교
    rows = []
    for table in TABLES:
        key = f"max_id_{table}"
        delta_max = results["delta"]["values"].get(key)
        psql_max = results["psql"]["values"].get(key)
        bq_max = results["bq"]["values"].get(key)

        psql_lag = (delta_max - psql_max) if (delta_max and psql_max) else None
        bq_lag = (delta_max - bq_max) if (delta_max and bq_max) else None

        status = "OK"
        if any(lag and lag > LAG_CRITICAL for lag in [psql_lag, bq_lag]):
            status = "CRITICAL"
        elif any(lag and lag > LAG_WARNING for lag in [psql_lag, bq_lag]):
            status = "WARNING"

        rows.append({
            "table": table,
            "delta": delta_max,
            "psql": psql_max,
            "bq": bq_max,
            "psql_lag": psql_lag,
            "bq_lag": bq_lag,
            "status": status,
        })

    return rows


if __name__ == "__main__":
    for row in check_sync_lag():
        print(row)
```

실행 결과 예시:

```
table       delta    psql      bq  psql_lag  bq_lag  status
orders     940084  940084  940084         0       0      OK
products   940084  940084  940084         0       0      OK
users      940084  940070  940084         0      14  WARNING
```

`users` 테이블의 PostgreSQL sync가 14건 뒤처져 있어 WARNING이 발생한 상황이다. `LAG_WARNING=10`을 넘었지만 `LAG_CRITICAL=100`에는 미달하므로 WARNING 단계다.

---

### 주의할 점 (Gotchas)

실제 구현 과정에서 부딪힌 문제 4가지를 정리한다. 공식 문서에 명확히 나와 있지 않거나, 에러 메시지만으로는 원인을 파악하기 어려운 것들이다.

#### 1. RDS Proxy는 psycopg2의 `options` 파라미터를 거부한다

`soda-core-postgres`는 내부적으로 `psycopg2`를 사용하는데, 연결 시 `options` 파라미터를 함께 전송한다. **RDS Proxy는 이 `options` 파라미터를 지원하지 않아 연결이 즉시 거부**된다.

```
# 실패: RDS Proxy 엔드포인트
host: my-proxy.proxy-xxxx.us-west-2.rds.amazonaws.com
→ SSL connection has been closed unexpectedly

# 성공: RDS 인스턴스/클러스터 직접 엔드포인트
host: my-cluster.cluster-xxxx.us-west-2.rds.amazonaws.com
```

에러 메시지가 SSL 관련이라 SSL 설정을 의심하기 쉽지만, 원인은 `options` 파라미터다. Soda Core + PostgreSQL 조합에서는 **RDS Proxy를 우회하고 클러스터 엔드포인트로 직접 연결**해야 한다.

#### 2. `soda-core-databricks` 패키지는 존재하지 않는다

PyPI에서 검색하면 나올 것 같지만, `soda-core-databricks`라는 패키지는 **존재하지 않는다**. Databricks 연결은 `soda-core-spark` 패키지 안에 `method: databricks` 옵션으로 내장되어 있다.

```bash
# 이런 패키지는 없다
pip install soda-core-databricks  # ← ERROR: No matching distribution

# 올바른 설치
pip install soda-core-spark
```

```yaml
# configuration.yml
data_source delta:
  type: spark
  method: databricks   # 이 옵션이 Databricks SQL Warehouse 연결을 활성화
  catalog: my_catalog
  schema: myschema
  host: ${DATABRICKS_HOST}
  http_path: ${DATABRICKS_HTTP_PATH}
  token: ${DATABRICKS_TOKEN}
```

Soda 공식 문서에서도 Databricks 연결은 [Spark 커넥터 페이지](https://docs.soda.io/soda/connect-spark)에서 다루고 있다.

#### 3. Cross-source 비교는 Soda Cloud(유료) 전용이다

Soda 공식 문서에 `reconciliation` 문법이 나오지만, 이는 **Soda Cloud 유료 플랜에서만 동작**한다. 무료 오픈소스 버전(Soda Core / Soda Library OSS)에서 아래와 같은 문법을 쓰면 에러가 난다.

```yaml
# Soda Cloud(유료)에서만 동작하는 예시
reconciliation Production:
  datasets:
    source:
      dataset: orders
      datasource: delta
    target:
      dataset: orders
      datasource: psql
  checks:
    - row_count diff < 10
```

무료 버전에서는 이 글에서 보여준 것처럼, 각 소스별로 scan을 독립 실행하고 Python에서 결과 값을 직접 비교하면 된다. 코드가 약간 더 길어지지만 동일한 결과를 얻을 수 있다.

#### 4. Databricks 클러스터 내부에서 실행 시 opentelemetry 충돌

Databricks 클러스터 런타임 환경에서 `soda-core-spark`를 import하면, opentelemetry 패키지 버전 충돌로 인해 `_ExtendedAttributes` 관련 import 에러가 발생한다.

```
ImportError: cannot import name '_ExtendedAttributes' from 'opentelemetry.attributes'
```

Databricks 런타임에 이미 설치된 opentelemetry 버전과 Soda Core가 요구하는 버전이 충돌하기 때문이다.

**해결 방법**: Soda scan은 **로컬 머신이나 별도 Python 환경**(CI/CD 서버, Docker 컨테이너 등)에서 실행한다. Databricks SQL Warehouse는 JDBC/HTTP 프로토콜로 연결하므로, 클러스터 내부가 아니어도 원격으로 쿼리를 보낼 수 있다. Airflow task나 GitHub Actions 등에서 실행하는 것이 가장 자연스러운 구성이다.

---

### 프로젝트 디렉토리 구조

최종 파일 구성은 다음과 같다:

```
soda/
├── configuration.yml       # 세 소스 연결 정보
├── checks/
│   ├── orders.yml          # 테이블별 체크 정의 (선택적으로 파일 분리)
│   ├── products.yml
│   └── users.yml
└── sync_lag_check.py       # cross-source lag 비교 스크립트
```

체크를 파일로 분리할 경우 `scan.add_sodacl_yaml_file()` 또는 `scan.add_sodacl_yaml_files()`로 디렉토리째 로드할 수 있다. 테이블 수가 적으면 이 글처럼 `add_sodacl_yaml_str()`로 인라인 생성해도 충분하다.

---

### 다음 단계

- **스케줄링**: Soda scan을 Airflow DAG의 `PythonVirtualenvOperator`나 GitHub Actions cron으로 파이프라인 완료 직후 자동 실행한다.
- **알림 연동**: `status == "CRITICAL"` 시 Slack webhook이나 PagerDuty로 알림을 보낸다.
- **Freshness SLA 강화**: 테이블별로 `freshness(updated_at) < 1h` 같은 SLA를 정의해서, 지연 자체를 감지한다.
- **이력 추적**: 체크 결과를 DB에 쌓아 Databricks SQL Dashboard나 Grafana로 추세를 시각화한다.

---

### 핵심 정리

| 항목 | 내용 |
|---|---|
| 도구 | Soda Core (오픈소스), SodaCL |
| 소스 | Delta Lake + PostgreSQL + BigQuery |
| 패턴 | 소스별 독립 scan → `check_value` 추출 → Python에서 lag 비교 |
| Cross-source 비교 | 무료 버전에서 불가 → Python 우회로 동일 효과 |
| Databricks 연결 | `soda-core-spark` + `method: databricks` (별도 패키지 없음) |
| 주요 gotcha | RDS Proxy `options` 거부, opentelemetry 충돌 |

---

### Reference

- [Soda Core GitHub Repository](https://github.com/sodadata/soda-core)
- [Soda Core Programmatic Scan 가이드](https://github.com/sodadata/soda-core/blob/main/docs/programmatic.md) -- Python Scan API 상세
- [Soda Spark 커넥터 (Databricks 포함)](https://docs.soda.io/soda/connect-spark) -- `method: databricks` 설정 참조
- [SodaCL 체크 레퍼런스](https://docs.soda.io/soda-cl/soda-cl-overview.html)
- [Soda PostgreSQL 커넥터](https://docs.soda.io/reference/data-source-reference-for-soda-core/postgresql)
- [Soda BigQuery 커넥터](https://docs.soda.io/reference/data-source-reference-for-soda-core/bigquery)
- [AWS RDS Proxy 제약 사항](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
