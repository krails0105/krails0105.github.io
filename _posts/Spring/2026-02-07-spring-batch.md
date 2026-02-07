---
title: "[Spring] Batch 기초 - Job, Step, Chunk 처리의 이해"
categories:
  - Spring
tags:
  - [Spring, SpringBatch, Job, Step, Chunk, BatchProcessing]
---

# Introduction

---

정산, 보고서 생성, 대용량 데이터 마이그레이션처럼 **대량의 데이터를 일괄 처리**해야 하는 경우가 있습니다. 이런 작업을 하나씩 처리하면 시간이 오래 걸리고, 중간에 실패하면 처음부터 다시 해야 합니다. **Spring Batch**는 대용량 배치 처리를 위한 프레임워크로, **재시작, 건너뛰기, 청크 단위 트랜잭션** 같은 기능을 제공합니다.

이 글은 Spring Batch의 핵심 개념과 기본 사용법을 정리합니다.

# 1. Spring Batch 구조

---

```text
┌─────────────────────────────────────────────────────────┐
│                         Job                              │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐             │
│  │  Step 1 │ →  │  Step 2 │ →  │  Step 3 │             │
│  └─────────┘    └─────────┘    └─────────┘             │
│       │              │              │                   │
│       ▼              ▼              ▼                   │
│   Tasklet      ┌─────────────┐   Tasklet               │
│                │ Chunk 처리  │                          │
│                │ Reader      │                          │
│                │ Processor   │                          │
│                │ Writer      │                          │
│                └─────────────┘                          │
└─────────────────────────────────────────────────────────┘
```

| 개념 | 설명 |
|------|------|
| **Job** | 하나의 배치 작업 단위 |
| **Step** | Job을 구성하는 단계 |
| **Tasklet** | 단일 작업 (한 번에 전부 처리) |
| **Chunk** | 청크 단위 처리 (읽기 → 처리 → 쓰기) |
| **ItemReader** | 데이터 읽기 |
| **ItemProcessor** | 데이터 가공 |
| **ItemWriter** | 데이터 쓰기 |

# 2. 기본 설정

---

## 의존성

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-batch</artifactId>
</dependency>

<!-- 배치 메타데이터 저장용 DB -->
<dependency>
    <groupId>com.h2database</groupId>
    <artifactId>h2</artifactId>
    <scope>runtime</scope>
</dependency>
```

## 설정

```yaml
# application.yml
spring:
  batch:
    job:
      enabled: true  # 시작 시 Job 자동 실행
    jdbc:
      initialize-schema: always  # 배치 테이블 자동 생성
```

## @EnableBatchProcessing

```java
@SpringBootApplication
@EnableBatchProcessing  // Spring Batch 활성화
public class BatchApplication {
    public static void main(String[] args) {
        SpringApplication.run(BatchApplication.class, args);
    }
}
```

# 3. Tasklet - 단순 작업

---

단일 작업을 수행하는 가장 간단한 형태입니다.

```java
@Configuration
public class SimpleJobConfig {

    @Bean
    public Job simpleJob(JobRepository jobRepository, Step simpleStep) {
        return new JobBuilder("simpleJob", jobRepository)
            .start(simpleStep)
            .build();
    }

    @Bean
    public Step simpleStep(JobRepository jobRepository,
                           PlatformTransactionManager transactionManager) {
        return new StepBuilder("simpleStep", jobRepository)
            .tasklet((contribution, chunkContext) -> {
                System.out.println("Hello, Spring Batch!");
                return RepeatStatus.FINISHED;
            }, transactionManager)
            .build();
    }
}
```

## Tasklet 분리

```java
@Component
public class FileCleanupTasklet implements Tasklet {

    @Override
    public RepeatStatus execute(StepContribution contribution,
                                 ChunkContext chunkContext) throws Exception {
        // 임시 파일 정리 로직
        Path tempDir = Paths.get("/tmp/batch");
        Files.walk(tempDir)
            .filter(p -> p.toString().endsWith(".tmp"))
            .forEach(p -> {
                try { Files.delete(p); }
                catch (IOException e) { /* log */ }
            });

        return RepeatStatus.FINISHED;
    }
}
```

# 4. Chunk 처리 - 대용량 데이터

---

대용량 데이터를 **청크(묶음) 단위**로 처리합니다. 10000건을 처리한다면 1000건씩 10번에 나눠서 처리합니다.

```text
청크 크기 = 100인 경우:

1. ItemReader: 100건 읽기
2. ItemProcessor: 100건 가공
3. ItemWriter: 100건 쓰기 (트랜잭션 커밋)
4. 반복...
```

## 기본 구조

```java
@Configuration
public class ChunkJobConfig {

    @Bean
    public Job chunkJob(JobRepository jobRepository, Step chunkStep) {
        return new JobBuilder("chunkJob", jobRepository)
            .start(chunkStep)
            .build();
    }

    @Bean
    public Step chunkStep(JobRepository jobRepository,
                          PlatformTransactionManager transactionManager,
                          ItemReader<User> reader,
                          ItemProcessor<User, UserDto> processor,
                          ItemWriter<UserDto> writer) {
        return new StepBuilder("chunkStep", jobRepository)
            .<User, UserDto>chunk(100, transactionManager)  // 100건씩 처리
            .reader(reader)
            .processor(processor)
            .writer(writer)
            .build();
    }
}
```

## ItemReader

```java
@Bean
public JdbcCursorItemReader<User> userReader(DataSource dataSource) {
    return new JdbcCursorItemReaderBuilder<User>()
        .name("userReader")
        .dataSource(dataSource)
        .sql("SELECT id, name, email FROM users WHERE status = 'ACTIVE'")
        .rowMapper((rs, rowNum) -> new User(
            rs.getLong("id"),
            rs.getString("name"),
            rs.getString("email")
        ))
        .build();
}
```

## ItemProcessor

```java
@Bean
public ItemProcessor<User, UserDto> userProcessor() {
    return user -> {
        // 변환 로직
        return new UserDto(
            user.getId(),
            user.getName().toUpperCase(),
            user.getEmail()
        );
    };
}
```

## ItemWriter

```java
@Bean
public JdbcBatchItemWriter<UserDto> userWriter(DataSource dataSource) {
    return new JdbcBatchItemWriterBuilder<UserDto>()
        .dataSource(dataSource)
        .sql("INSERT INTO user_backup (id, name, email) VALUES (:id, :name, :email)")
        .beanMapped()
        .build();
}
```

# 5. Job 흐름 제어

---

## 순차 실행

```java
@Bean
public Job multiStepJob(JobRepository jobRepository,
                         Step step1, Step step2, Step step3) {
    return new JobBuilder("multiStepJob", jobRepository)
        .start(step1)
        .next(step2)
        .next(step3)
        .build();
}
```

## 조건부 분기

```java
@Bean
public Job conditionalJob(JobRepository jobRepository,
                          Step validateStep, Step processStep, Step errorStep) {
    return new JobBuilder("conditionalJob", jobRepository)
        .start(validateStep)
            .on("FAILED").to(errorStep)  // 실패 시
            .from(validateStep).on("*").to(processStep)  // 그 외
        .end()
        .build();
}
```

## ExitStatus 커스터마이징

```java
@Bean
public Step validateStep(JobRepository jobRepository,
                          PlatformTransactionManager transactionManager) {
    return new StepBuilder("validateStep", jobRepository)
        .tasklet((contribution, chunkContext) -> {
            boolean isValid = validate();
            if (!isValid) {
                contribution.setExitStatus(ExitStatus.FAILED);
            }
            return RepeatStatus.FINISHED;
        }, transactionManager)
        .build();
}
```

# 6. Job Parameters

---

배치 실행 시 파라미터를 전달할 수 있습니다.

```java
@Bean
@StepScope  // 파라미터를 런타임에 주입받으려면 필수
public JdbcCursorItemReader<User> userReader(
        DataSource dataSource,
        @Value("#{jobParameters['targetDate']}") String targetDate) {

    return new JdbcCursorItemReaderBuilder<User>()
        .name("userReader")
        .dataSource(dataSource)
        .sql("SELECT * FROM users WHERE created_date = ?")
        .preparedStatementSetter(ps -> ps.setString(1, targetDate))
        .rowMapper(...)
        .build();
}
```

## 실행 방법

```bash
# 커맨드 라인
java -jar batch.jar targetDate=2024-01-15

# 프로그래밍 방식
JobParameters params = new JobParametersBuilder()
    .addString("targetDate", "2024-01-15")
    .addLong("timestamp", System.currentTimeMillis())  // 재실행을 위한 유니크 값
    .toJobParameters();

jobLauncher.run(job, params);
```

# 7. 에러 처리

---

## Skip - 오류 건너뛰기

```java
@Bean
public Step chunkStep(JobRepository jobRepository,
                       PlatformTransactionManager transactionManager) {
    return new StepBuilder("chunkStep", jobRepository)
        .<User, UserDto>chunk(100, transactionManager)
        .reader(reader())
        .processor(processor())
        .writer(writer())
        .faultTolerant()
        .skip(ValidationException.class)  // 이 예외는 건너뛰기
        .skipLimit(10)  // 최대 10건까지 건너뛰기
        .build();
}
```

## Retry - 재시도

```java
@Bean
public Step chunkStep(JobRepository jobRepository,
                       PlatformTransactionManager transactionManager) {
    return new StepBuilder("chunkStep", jobRepository)
        .<User, UserDto>chunk(100, transactionManager)
        .reader(reader())
        .processor(processor())
        .writer(writer())
        .faultTolerant()
        .retry(TransientDataAccessException.class)  // 이 예외는 재시도
        .retryLimit(3)  // 최대 3번 재시도
        .build();
}
```

## Listener - 이벤트 처리

```java
@Component
public class JobCompletionListener implements JobExecutionListener {

    @Override
    public void beforeJob(JobExecution jobExecution) {
        log.info("Job 시작: {}", jobExecution.getJobInstance().getJobName());
    }

    @Override
    public void afterJob(JobExecution jobExecution) {
        if (jobExecution.getStatus() == BatchStatus.COMPLETED) {
            log.info("Job 완료!");
        } else if (jobExecution.getStatus() == BatchStatus.FAILED) {
            log.error("Job 실패: {}", jobExecution.getAllFailureExceptions());
        }
    }
}
```

```java
@Bean
public Job jobWithListener(JobRepository jobRepository, Step step,
                            JobCompletionListener listener) {
    return new JobBuilder("jobWithListener", jobRepository)
        .listener(listener)
        .start(step)
        .build();
}
```

# 8. 실무 패턴

---

## 패턴 1: 날짜 기반 배치

```java
@Bean
@StepScope
public ItemReader<Order> orderReader(
        @Value("#{jobParameters['date']}") String date) {
    // 해당 날짜 주문만 조회
}

// 실행: java -jar batch.jar date=2024-01-15
```

## 패턴 2: 분할 처리 (Partitioning)

```java
@Bean
public Step masterStep(Step slaveStep) {
    return new StepBuilder("masterStep", jobRepository)
        .partitioner("slaveStep", partitioner())  // 데이터 분할
        .step(slaveStep)
        .gridSize(10)  // 10개로 분할
        .taskExecutor(taskExecutor())  // 병렬 실행
        .build();
}

@Bean
public Partitioner partitioner() {
    return gridSize -> {
        Map<String, ExecutionContext> result = new HashMap<>();
        for (int i = 0; i < gridSize; i++) {
            ExecutionContext context = new ExecutionContext();
            context.putInt("partition", i);
            result.put("partition" + i, context);
        }
        return result;
    };
}
```

## 패턴 3: Chunk 크기 튜닝

```text
청크 크기가 작으면:
  - 트랜잭션/커밋 빈번 → 오버헤드
  - 실패 시 손실 적음

청크 크기가 크면:
  - 트랜잭션/커밋 적음 → 효율적
  - 실패 시 롤백 범위 큼
  - 메모리 사용량 증가

일반적으로 100~1000 사이에서 시작, 성능 테스트로 최적화
```

# 9. 정리

---

| 개념 | 설명 |
|------|------|
| **Job** | 배치 작업 단위 |
| **Step** | Job의 개별 단계 |
| **Tasklet** | 단일 작업 처리 |
| **Chunk** | 청크 단위 처리 (Reader → Processor → Writer) |
| **@StepScope** | Job 파라미터 런타임 주입 |
| **Skip/Retry** | 에러 처리 전략 |

```text
핵심:
  Spring Batch = 대용량 데이터의 안정적인 일괄 처리.
  Chunk 단위로 읽기 → 가공 → 쓰기, 트랜잭션 관리.
  Skip/Retry로 에러 복구, Listener로 모니터링.
  Job Parameters로 실행 시 동적 값 전달.
```

# Reference

---

- [Spring Batch Documentation](https://docs.spring.io/spring-batch/docs/current/reference/html/)
- [Spring Boot Batch](https://docs.spring.io/spring-boot/docs/current/reference/html/howto.html#howto.batch)
- [Spring Batch in Action](https://www.manning.com/books/spring-batch-in-action)
