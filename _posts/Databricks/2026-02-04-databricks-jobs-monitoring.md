---
title: "[Databricks] 잡/파이프라인 모니터링 - 지연, 빈 데이터, 품질 체크"
categories:
  - Databricks
tags:
  - [Databricks, Monitoring, DataQuality, Alerting, Operations]
---

# Introduction

---

배치 파이프라인에서 운영자가 매번 수동으로 확인하면 반드시 사고가 납니다. 대신 **규칙 기반 모니터링**으로 바꿔야 합니다.

이 글은 Databricks 잡에서 자주 보는 문제를 어떻게 자동 감지/알림하는지 정리합니다:
- 지연
- 빈 데이터(구간 누락)
- 품질 악화(null/중복 급증)

# 1. 최소 모니터링 지표

---

| 지표 | 설명 | 임계값 예시 |
|------|------|------------|
| 실행 시간 | Job duration | 평소 대비 2배 초과 |
| Input row count | 읽은 row 수 | 0이면 경고 |
| Output row count | 쓴 row 수 | 전일 대비 50% 미만 |
| Null 비율 | 핵심 컬럼 null % | 5% 초과 |
| 중복 비율 | PK 기준 중복 | 0 초과 |
| 실패 횟수 | Job failure count | 1 이상 |

# 2. 품질 체크 구현

---

## 기본 품질 체크 함수

```python
from pyspark.sql.functions import col, count, sum as spark_sum, when

class DataQualityChecker:
    def __init__(self, spark):
        self.spark = spark
        self.violations = []

    def check_not_null(self, df, columns, threshold=0.0):
        """Null 비율 체크"""
        total = df.count()
        for column in columns:
            null_count = df.filter(col(column).isNull()).count()
            null_ratio = null_count / total if total > 0 else 0

            if null_ratio > threshold:
                self.violations.append({
                    'rule': 'not_null',
                    'column': column,
                    'value': null_ratio,
                    'threshold': threshold
                })

    def check_unique(self, df, columns):
        """중복 체크"""
        total = df.count()
        distinct = df.select(columns).distinct().count()
        dup_count = total - distinct

        if dup_count > 0:
            self.violations.append({
                'rule': 'unique',
                'column': str(columns),
                'value': dup_count,
                'threshold': 0
            })

    def check_row_count(self, df, min_count=1):
        """최소 row 수 체크"""
        actual = df.count()
        if actual < min_count:
            self.violations.append({
                'rule': 'min_row_count',
                'column': None,
                'value': actual,
                'threshold': min_count
            })

    def check_row_count_change(self, current_df, previous_count, max_drop_pct=0.5):
        """전일 대비 급감 체크"""
        current = current_df.count()
        if previous_count > 0:
            drop_pct = (previous_count - current) / previous_count
            if drop_pct > max_drop_pct:
                self.violations.append({
                    'rule': 'row_count_drop',
                    'column': None,
                    'value': drop_pct,
                    'threshold': max_drop_pct
                })

    def get_violations(self):
        return self.violations

    def has_violations(self):
        return len(self.violations) > 0
```

## 사용 예시

```python
# 품질 체크 실행
checker = DataQualityChecker(spark)

df = spark.table("silver.events")
checker.check_not_null(df, ["event_id", "user_id"], threshold=0.01)
checker.check_unique(df, ["event_id"])
checker.check_row_count(df, min_count=1000)
checker.check_row_count_change(df, yesterday_count, max_drop_pct=0.3)

if checker.has_violations():
    print("Quality issues found:")
    for v in checker.get_violations():
        print(f"  - {v['rule']}: {v['column']} = {v['value']} (threshold: {v['threshold']})")
    # 알림 발송
    send_alert(checker.get_violations())
```

# 3. 파티션 연속성 체크

---

```python
from pyspark.sql.functions import min as spark_min, max as spark_max, datediff
from datetime import date, timedelta

def check_partition_continuity(spark, table_name, date_col, expected_dates):
    """날짜 파티션 누락 체크"""
    actual_dates = spark.table(table_name) \
        .select(date_col).distinct() \
        .rdd.flatMap(lambda x: x).collect()

    actual_set = set(actual_dates)
    missing = [d for d in expected_dates if d not in actual_set]

    if missing:
        return {
            'status': 'FAIL',
            'missing_dates': missing,
            'message': f"Missing {len(missing)} date(s)"
        }
    return {'status': 'PASS'}

# 사용
from datetime import date, timedelta

# 최근 7일 확인
expected = [date.today() - timedelta(days=i) for i in range(7)]
result = check_partition_continuity(spark, "silver.events", "event_date", expected)

if result['status'] == 'FAIL':
    print(f"Missing dates: {result['missing_dates']}")
```

# 4. 지연 감지

---

## SLA 기반 모니터링

```python
from datetime import datetime, timedelta

def check_job_sla(spark, job_name, expected_completion_time):
    """
    Job이 SLA 시간 내에 완료되었는지 확인
    """
    # Job 실행 이력 조회 (Databricks Jobs API 또는 로그 테이블)
    last_run = get_last_successful_run(job_name)

    if last_run is None:
        return {'status': 'FAIL', 'message': 'No successful run found'}

    if last_run.end_time > expected_completion_time:
        delay = last_run.end_time - expected_completion_time
        return {
            'status': 'LATE',
            'delay_minutes': delay.total_seconds() / 60,
            'message': f"Job completed {delay} late"
        }

    return {'status': 'ON_TIME'}

# 예: 매일 오전 6시까지 완료되어야 함
sla_time = datetime.now().replace(hour=6, minute=0, second=0)
result = check_job_sla(spark, "daily_etl", sla_time)
```

## 데이터 신선도 체크

```python
def check_data_freshness(spark, table_name, timestamp_col, max_age_hours=24):
    """
    테이블의 가장 최신 데이터가 얼마나 오래되었는지 확인
    """
    from pyspark.sql.functions import max as spark_max, current_timestamp

    latest = spark.table(table_name) \
        .agg(spark_max(timestamp_col).alias("latest_ts")) \
        .first().latest_ts

    if latest is None:
        return {'status': 'FAIL', 'message': 'No data found'}

    age_hours = (datetime.now() - latest).total_seconds() / 3600

    if age_hours > max_age_hours:
        return {
            'status': 'STALE',
            'age_hours': age_hours,
            'message': f"Data is {age_hours:.1f} hours old"
        }

    return {'status': 'FRESH', 'age_hours': age_hours}

# 사용
result = check_data_freshness(spark, "silver.events", "event_time", max_age_hours=2)
```

# 5. 알림 발송

---

## Slack 알림

```python
import requests

def send_slack_alert(webhook_url, message, severity="warning"):
    """Slack으로 알림 발송"""
    colors = {
        "error": "#FF0000",
        "warning": "#FFA500",
        "info": "#0000FF"
    }

    payload = {
        "attachments": [{
            "color": colors.get(severity, "#808080"),
            "title": f"Data Pipeline Alert ({severity.upper()})",
            "text": message,
            "footer": "Databricks Monitoring"
        }]
    }

    response = requests.post(webhook_url, json=payload)
    return response.status_code == 200

# 사용
if checker.has_violations():
    message = "\n".join([
        f"• {v['rule']}: {v['column']} = {v['value']}"
        for v in checker.get_violations()
    ])
    send_slack_alert(SLACK_WEBHOOK_URL, message, severity="error")
```

## 이메일 알림

```python
# Databricks의 경우 dbutils 활용
def send_email_alert(subject, body, recipients):
    """이메일 알림 (Databricks Workflows에서 설정)"""
    # Databricks Workflows의 이메일 알림 기능 사용
    # 또는 외부 이메일 서비스 API 호출
    pass
```

# 6. 통합 모니터링 파이프라인

---

```python
def run_monitoring_pipeline(spark, table_configs):
    """
    모든 테이블에 대해 모니터링 실행
    """
    results = []

    for config in table_configs:
        table_name = config['table']
        checker = DataQualityChecker(spark)

        df = spark.table(table_name)

        # 기본 품질 체크
        if config.get('not_null_columns'):
            checker.check_not_null(df, config['not_null_columns'])

        if config.get('unique_columns'):
            checker.check_unique(df, config['unique_columns'])

        if config.get('min_row_count'):
            checker.check_row_count(df, config['min_row_count'])

        # 결과 저장
        results.append({
            'table': table_name,
            'violations': checker.get_violations(),
            'checked_at': datetime.now()
        })

        # 심각한 위반 시 즉시 알림
        if checker.has_violations():
            send_slack_alert(
                SLACK_WEBHOOK_URL,
                f"Quality issues in {table_name}: {checker.get_violations()}",
                severity="error"
            )

    return results

# 설정
table_configs = [
    {
        'table': 'silver.events',
        'not_null_columns': ['event_id', 'user_id'],
        'unique_columns': ['event_id'],
        'min_row_count': 1000
    },
    {
        'table': 'silver.users',
        'not_null_columns': ['user_id'],
        'unique_columns': ['user_id'],
        'min_row_count': 100
    }
]

results = run_monitoring_pipeline(spark, table_configs)
```

# 7. 가장 가성비 좋은 품질 규칙 3개

---

```
1. Row count 급감/급증 감지
   → 데이터 소스 장애, 파이프라인 버그 탐지

2. Key 컬럼 null 비율 감지
   → 스키마 변경, 데이터 품질 저하 탐지

3. 파티션 연속성(날짜 누락) 체크
   → 처리 누락, 스케줄 실패 탐지
```

이 3개만 있어도 운영 사고가 크게 줄어듭니다.

# 8. 체크리스트

---

```
□ 지연을 SLA 기준으로 알림 받을 수 있는가?
□ Row count/연속성/중복/널 비율을 자동 검증하는가?
□ 실패 시 재처리 절차가 문서화되어 있는가?
□ 알림이 너무 많아서 무시되지는 않는가? (알림 피로)
□ 모니터링 결과를 저장/추적하고 있는가?
```

# Reference

---

- [Databricks Jobs Monitoring](https://docs.databricks.com/en/workflows/jobs/monitor-jobs.html)
- [Delta Lake Data Quality](https://docs.databricks.com/en/delta/data-quality.html)
- [Databricks SQL Alerts](https://docs.databricks.com/en/sql/admin/alerts.html)
