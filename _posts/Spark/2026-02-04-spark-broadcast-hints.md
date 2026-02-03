---
title: "[Spark SQL] Broadcast Hint 정리 - Databricks에서 조인 튜닝하기"
categories:
  - Spark
tags:
  - [Spark, SparkSQL, Databricks, Join, Broadcast, AQE]
---

# Introduction

---

작은 테이블을 브로드캐스트(broadcast)해서 조인 비용(셔플)을 줄이는 패턴을 정리합니다.  
특히 Databricks/Spark SQL에서 힌트가 “안 먹는” 상황과 해결법을 예제로 정리합니다.

# 1. Broadcast란?

---

> ✅ 참고: `/*+ BROADCAST */` 형태의 힌트는 **Databricks 전용 문법이 아니라 Spark SQL의 “힌트 주석(comment hint)” 문법**입니다.  
> Databricks는 Spark SQL을 기반으로 하므로 그대로 동작합니다. (환경/버전에 따라 힌트 인식 방식이 조금씩 다를 수 있으니 `explain`으로 확인하세요.)


**Broadcast Join**은 “작은 테이블”을 각 executor로 복제해서, 큰 테이블을 셔플 없이(혹은 최소한으로) 조인하는 전략입니다.

- 기대 효과
  - `Exchange`(Shuffle) 감소
  - 조인 시간/네트워크 비용 감소
- 언제 유리?
  - 한쪽이 충분히 작을 때(대략 수 MB~수십 MB 수준, 환경에 따라 다름)

# 2. Spark/Databricks 힌트 문법 한눈에 보기

---

Spark SQL 힌트는 크게 두 방식이 있습니다.

## 2.1 JOIN 뒤에 붙이는 방식 (가장 안정적)

```sql
FROM big_table b
JOIN /*+ BROADCAST */ small_table s
  ON b.key = s.key
```

- 장점: alias 스코프 문제를 거의 피함
- 실무에서 “힌트가 안 먹는다”의 대부분은 이 방식으로 해결됩니다.

## 2.2 SELECT 힌트로 relation을 지정하는 방식

```sql
SELECT /*+ BROADCAST(small_table) */
  ...
FROM big_table b
JOIN small_table s
  ON b.key = s.key
```

- `BROADCAST(t)`처럼 alias를 넣으면(특히 CTE/뷰 조합에서) Spark가 relation으로 못 찾는 경우가 있습니다.
- CTE라면 보통 **CTE 이름**(예: `target_info`)을 relation로 넣는 쪽이 안전합니다.

## 2.3 힌트는 “적용 여부 확인”이 필수

AQE(Adaptive Query Execution)가 켜져 있으면, 상황에 따라 계획이 바뀔 수 있습니다.  
그래서 **반드시 explain으로 물리 플랜을 확인**하는 습관이 중요합니다.

# 3. 힌트 문법: 가장 안전한 패턴

---

Spark SQL에서 브로드캐스트 힌트를 가장 안정적으로 먹이는 방법은 **JOIN 바로 뒤에 붙이는 방식**입니다.

```sql
SELECT
  *
FROM big_table b
JOIN /*+ BROADCAST */ small_table s
  ON b.key = s.key
```

- 장점: alias 스코프 문제를 피함
- 주의: `small_table`이 작지 않으면 역효과(메모리 압박) 가능

# 4. 힌트가 안 먹을 때: "relation not found" 에러

---

예를 들어 아래 같은 에러가 자주 납니다.

> Relation name(s) specified with SQL hint not found: Could not find relation(s) 't' specified in hint 'BROADCAST(t)'

원인은 보통:
- `/*+ BROADCAST(t) */`처럼 alias를 적었는데,
- CTE/뷰/서브쿼리 조합 때문에 Spark가 `t`를 “relation”으로 인식 못하는 스코프인 경우입니다.

## 해결 1) JOIN 뒤에 `/*+ BROADCAST */`를 붙이기 (권장)

```sql
FROM utxo_stage u
JOIN /*+ BROADCAST */ target_info t
  ON u.spent_block_height = t.block_height
```

## 해결 2) SELECT 힌트는 “CTE 이름”으로 쓰기

```sql
SELECT /*+ BROADCAST(target_info) */
  ...
FROM utxo_stage u
JOIN target_info t
  ON ...
```

# 5. 힌트 적용 여부 확인 (explain)

---

```python
df.explain("formatted")
```

플랜에서 아래 키워드가 보이면 브로드캐스트가 적용된 것입니다.

- `BroadcastHashJoin`
- `BroadcastNestedLoopJoin`
- `Exchange SinglePartition, EXECUTOR_BROADCAST`

# 6. BroadcastNestedLoopJoin이 뜨는 이유 (짧게)

---

조인 조건이 `=`이 아니라 `<=`, `>` 같은 **비등가(range) 조인**이면 Spark가 해시 조인을 못 쓰고,
작은쪽을 브로드캐스트해서 **Nested Loop**로 풀 때가 많습니다.

(자세한 내용은 "카테시안 곱 / range join" 글에서 다룹니다.)

# 7. AQE(Adaptive Query Execution) 관련 팁

---

Spark 3.0+에서 AQE가 기본 활성화되어 있습니다. AQE는 런타임에 통계를 보고 조인 전략을 **자동 변경**할 수 있습니다.

## AQE 설정 확인

```sql
-- AQE 활성화 여부
SET spark.sql.adaptive.enabled;

-- 브로드캐스트 자동 변환 임계값 (기본 10MB)
SET spark.sql.adaptive.autoBroadcastJoinThreshold;
```

## 힌트가 무시될 수 있는 상황

| 상황 | 설명 |
|------|------|
| 테이블이 너무 클 때 | `spark.sql.autoBroadcastJoinThreshold` 초과 시 Spark가 무시할 수 있음 |
| AQE가 더 나은 계획 발견 | 런타임 통계 기반으로 SortMergeJoin으로 변경될 수 있음 |
| 메모리 부족 | Driver 메모리 초과 시 실패 |

## 강제로 브로드캐스트하려면

```sql
-- 임계값을 크게 설정 (주의: 메모리 압박 가능)
SET spark.sql.autoBroadcastJoinThreshold = 100MB;
```

# 8. 실전 체크리스트

---

브로드캐스트 힌트 적용 전 확인할 것들:

```
✅ 작은 테이블 크기가 적절한가? (10MB~100MB 권장)
✅ explain으로 BroadcastHashJoin 확인했는가?
✅ Driver 메모리가 충분한가?
✅ 조인 키가 등가(=) 조건인가? (아니면 NestedLoop)
✅ CTE/서브쿼리 사용 시 relation 이름이 올바른가?
```

# Reference

---

- [Spark SQL Join Hints - 공식 문서](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html)
- [Databricks AQE 가이드](https://docs.databricks.com/en/optimizations/aqe.html)
- [Spark Performance Tuning - Join Strategy](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
