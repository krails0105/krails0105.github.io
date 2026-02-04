---
title: "[Delta Lake] Liquid Clustering - 유연한 데이터 클러스터링"
categories:
  - Delta
tags:
  - [Delta, LiquidClustering, ZOrder, Partition, Optimization]
---

# Introduction

---

Liquid Clustering(LC)은 Delta Lake의 새로운 데이터 레이아웃 최적화 기능입니다. 테이블을 특정 키 기준으로 물리적으로 정렬해서 필터/조인 성능을 높입니다.

기존 Partition이나 Z-ORDER와 비교해서 **운영 부담을 줄이면서** 비슷한 효과를 얻을 수 있습니다.

# 1. LC vs Partition vs Z-ORDER

---

| 방식 | 장점 | 단점 |
|------|------|------|
| **Partition** | 가장 강력한 프루닝 | 파티션 폭발, 스큐, 변경 어려움 |
| **Z-ORDER** | 다차원 정렬 | 재정렬 비용 큼, OPTIMIZE 필수 |
| **Liquid Clustering** | 유연한 클러스터링, 키 변경 가능 | 상대적으로 새로운 기능 |

## Partition의 문제

```sql
-- 문제: 카디널리티가 높으면 파티션 폭발
PARTITIONED BY (user_id)  -- 수백만 파티션!

-- 문제: 파티션 키 변경이 어려움
-- 기존 데이터 전체 재작성 필요
```

## Z-ORDER의 문제

```sql
-- OPTIMIZE 할 때마다 전체 재정렬
OPTIMIZE table_name ZORDER BY (col1, col2)
-- 비용이 크고, 쓰기마다 정렬이 흐트러짐
```

# 2. Liquid Clustering 사용법

---

## 테이블 생성 시 설정

```sql
CREATE TABLE events (
    event_id STRING,
    user_id STRING,
    event_time TIMESTAMP,
    event_type STRING
)
USING delta
CLUSTER BY (user_id, event_time);
```

## 기존 테이블에 적용

```sql
-- 기존 테이블을 LC로 변환
ALTER TABLE events CLUSTER BY (user_id, event_time);
```

## 클러스터링 키 변경

```sql
-- Z-ORDER와 달리 키 변경이 간단
ALTER TABLE events CLUSTER BY (event_type, event_time);
```

## 클러스터링 해제

```sql
ALTER TABLE events CLUSTER BY NONE;
```

# 3. LC 키 선택 기준

---

## 원칙

1. **WHERE/JOIN에 가장 자주 등장하는 컬럼**
2. **카디널리티가 적당한 컬럼** (너무 낮으면 효과 없음, 너무 높으면 비효율)
3. **time + id 조합**이 자주 좋은 결과

## 키 선택 프로세스

```
1) 가장 비싼 쿼리 3개 뽑기
2) WHERE/JOIN에 반복 등장하는 컬럼 수집
3) 그 중 1~2개를 후보로 선정
```

## 예시

```sql
-- 자주 실행되는 쿼리
SELECT * FROM events WHERE user_id = 'xxx' AND event_time >= '2024-01-01';
SELECT * FROM events e JOIN users u ON e.user_id = u.id WHERE e.event_type = 'purchase';

-- 분석: user_id, event_time이 자주 등장
-- LC 키 선정: (user_id, event_time)
```

## 주의사항

```sql
-- 너무 많은 키는 효과가 떨어짐
CLUSTER BY (col1, col2, col3, col4, col5)  -- 비권장

-- 1~3개가 적정
CLUSTER BY (user_id, event_time)  -- 권장
```

# 4. 효과 검증 방법

---

## explain으로 스캔 파일 수 확인

```python
# LC 적용 전
spark.sql("SELECT * FROM events WHERE user_id = 'xxx'").explain()

# LC 적용 후 비교
# → FileScan에서 스캔 파일 수가 줄어들어야 함
```

## 데이터 스킵 통계 확인

```sql
-- 쿼리 실행 후 Spark UI에서 확인
-- "files read" vs "files pruned" 비율
```

## 벤치마크

```python
import time

def benchmark_query(query, iterations=5):
    times = []
    for _ in range(iterations):
        spark.catalog.clearCache()
        start = time.time()
        spark.sql(query).count()
        times.append(time.time() - start)
    return sum(times) / len(times)

# LC 적용 전후 비교
before = benchmark_query("SELECT * FROM events_no_lc WHERE user_id = 'xxx'")
after = benchmark_query("SELECT * FROM events_lc WHERE user_id = 'xxx'")
print(f"Improvement: {(before - after) / before * 100:.1f}%")
```

# 5. LC와 OPTIMIZE

---

LC는 OPTIMIZE와 함께 동작합니다.

```sql
-- OPTIMIZE가 클러스터링을 유지/개선
OPTIMIZE events;

-- 특정 파티션만
OPTIMIZE events WHERE date = '2024-01-01';
```

## 자동 OPTIMIZE 설정

```sql
ALTER TABLE events SET TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
);
```

# 6. 운영 시 주의사항

---

## Write 패턴의 영향

- **Append**: 새 파일이 추가되면서 클러스터링이 점진적으로 약해질 수 있음
- **MERGE/UPDATE**: 파일이 재작성되면서 클러스터링 유지
- **정기 OPTIMIZE 권장**: 클러스터링 품질 유지

## 모니터링

```python
# 클러스터링 상태 확인
from delta.tables import DeltaTable

dt = DeltaTable.forName(spark, "events")
detail = dt.detail().select("clusteringColumns").first()
print(f"Clustering columns: {detail.clusteringColumns}")
```

# 7. 체크리스트

---

```
□ 가장 빈번한 필터/조인 키가 무엇인지 파악했다
□ LC 키를 1~3개로 제한했다
□ LC 적용 후 스캔 파일 수가 실제로 줄었다
□ write 패턴(append/merge)이 LC를 망가뜨리지 않는다
□ 정기 OPTIMIZE 스케줄이 있다
□ 기존 Partition/Z-ORDER와의 조합을 고려했다
```

# Reference

---

- [Delta Lake Liquid Clustering](https://docs.delta.io/latest/delta-clustering.html)
- [Databricks Liquid Clustering](https://docs.databricks.com/en/delta/clustering.html)
- [OPTIMIZE Command](https://docs.delta.io/latest/optimizations-oss.html)
