---
title: "[SpringBoot] TDD/Test 코드 작성"
categories:
  - Spring
tags:
  - [Java, Spring]
---



# Introduction

---

기본적인 TDD의 개념과 SpringBoot의 Controller Test 코드 작성 방법 살펴 본다.



# TDD(Test Driven Development)

---

테스트 주도 개발을 의미하며 간략하게 테스트를 진행해가며 개발 코드를 작성하고 개선시켜야 한다는 개념이다.

TDD는 보통 아래 `Red, Green, Refactor` cycle을 통해서 설명되곤 하는데 각각의 의미는 아래와 같다.

- `Red`: 테스트가 실패하는 단계, 특정 문제에 대한 해결이 없는 상태
- `Green`: Red 상태의 문제를 해결하는 프로덕션 코드를 작성한 상태
- `Refactoring`: 문제를 해결한 프로덕션 코드를 제너럴하고 효율적으로 리팩토링

![img](../../assets/images/03-27-spring-test/1.png)

즉, 테스트를 통해 발생한 문제를 해결하고 이를 개선시켜가면서 코드를 작성한다는 의미이다.



# 단위 테스트

---

TDD를 위한 첫 단계로 기능 단위의 테스트 코드를 작성하는 것

1. 개발 초기에 문제를 발견
2. 추후 리팩토링이나 라이브러리 업그레이드 등의 상황에서 기존 기능들의 검증 가능
3. 기능의 불확실성 감소
4. 단위 테스트 자체가 문서로써 기능을 제공



테스트 코드 작성을 위한 대표적인 프레임워크에는 아래와 같다. 

`JUnit` - Java (현재 JUnit5까지 나왔으나 현업에서는 아직 JUnit4를 많이 사용)

`DBUnit` - DB

`CppUnit` - C++

`NUnit` - .net



이번 포스트에서는 `JUnit4`를 이용하여 테스트를 진행한다.

> SpringBoot 2.2.* *버전*이 release 되면서 SpringBoot에서 기본으로 제공되던 JUnit이 ***JUnit4 버전에서 JUnit5으로  변경***되었기 때문에 ***SpringBoot 2.2이상의 버전을 쓰고 있다면 아래와 같이 Junit4에 대한 의존성을 추가***해줘야 한다.

```java
// build.gradle
...
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
    testImplementation 'junit:junit:4.13.1' // JUnit4 의존성 추가
		...
}
```





### Controller 테스트 코드 작성

이전 Rest API 관련 포스트에서 작성하였던 GetController 코드이다. response로 String타입의 "Get!" 문자열을 리턴해주고 있다.

```java
package com.example.demo.controller;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(path = "/api") // localhost:8080/api
public class GetController {

    @RequestMapping(method= RequestMethod.GET, path = "/getMethod") // localhost:8080/api/getmethod
    public String getRequest(){
        return "Get!";
    }
}

```



이제 JUnit4를 이용하여 위 코드에 대한 기본적인 테스트 코드를 작성해보자.

테스트 코드는 아래 보이는 src/test/java 패키지에서 생성하는데 이때, 테스트할 코드와 같은 경로(com.example.demo.controller)에 코드를 생성한다.

![3](../../assets/images/03-26-spring-test/3.png)



```java
package com.example.demo.controller;

import org.junit.Test;
import org.junit.After;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.junit4.SpringRunner;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@RunWith(SpringRunner.class)
@WebMvcTest(controllers = GetController.class)
public class UserContollerTest {

    @Autowired
    private MockMvc mvc;
		
   @Before
    public void start() {
        System.out.println("Test Start!");
    }
    @After
    public void cleanup(){
        System.out.println("Test End!");
    }

    @Test
    public void getTest() throws Exception {
        String expected = "Get!";

        mvc.perform(get("/api/getMethod"))
                .andExpect(status().isOk())
                .andExpect(content().string(expected));
    }
}

```

Contoller에 대한 기본적인 테스트 코드를 작성하였다. 코드에 대한 설명은 아래와 같다.

- `@RunWith`: 테스트를 실행할 때 JUnit의 내장 실행자 외에 추가적인 실행자를 실행하기 위한 어노테이션, 위 `코드에서는SpringRunner` 를 추가하여 스프링 부트 테스트를 JUnit에 연결하였다.
- `@WebMvcTest`: Spring test 어노테이션 중 Web에 특화된 어노테이션, @Controller, @ControllerAdvice 등을 사용하여 테스트가 가능하지만 @Service, @Component, @Repository 등은 사용할 수 없기 때문에 컨트롤러 테스트에 유용하다.

- `@Autowired`: Dependency injection(DI, 의존성 주입)을 위한 어노테이션으로 스프링이 관리하는 Bean을 주입

- `@Before`: JUnit 단위 Test가 시작 전에 수행될 동작을 지정

-  `@After`: JUnit 단위 Test가 끝날 때 수행될 동작을 지정

- `@Test`: 해당 함수가 테스트에 사용될 함수임을 명시하는 어노테이션, ***junit 버전에 따라 @Test를 import하는 경로가 다르다.***
  - `@Test`의 경로 
    - `junit5`: org.junit.jupiter.api

    - `junit4`: org.junit

- `MockMvc`: 모의 request와 response를 만들어서 웹 테스트를 진행하기 위한 객체

- `perform`: 모의로 http request 수행

- `andExpect`: perform의 결과(status, content)를 검증



테스트를 실행하기 위해서는 아래 버튼을 이용한다.

![4](../../assets/images/03-26-spring-test/4.png)



이때, 아래와 같은 에러가 나며 테스트가 실패할 수 있다.

이때, `IntelliJ Preferences -> Build, Execution, Deployment -> Build Tools -> Gradle` 에서 `Run tests using` 설정을 `Gradle -> IntelliJ`로 설정하면 해결할 수 있다.

![1](../../assets/images/03-26-spring-test/1.png)

아래와 같이 설정을 바꾸면 테스트가 성공한다.

![2](../../assets/images/03-26-spring-test/2.png)



### assertThat

JUnit 또는 assertj의 assertThat을 이용하여 리턴 값 등의 변수를 검증 할 수 있다.

JUnit의 assertThat이란 아래 hamcrest 라이브러리의 assertThat함수를 래핑한 함수이다.

```java
package org.hamcrest;


// hamcrest 라이브러리의 assertThat함수, JUnit에서 사용
public class MatcherAssert {
    public static <T> void assertThat(T actual, Matcher<? super T> matcher) {
        assertThat("", actual, matcher);
    }
    
    public static <T> void assertThat(String reason, T actual, Matcher<? super T> matcher) {
        if (!matcher.matches(actual)) {
            Description description = new StringDescription();
            description.appendText(reason)
                       .appendText(System.lineSeparator())
                       .appendText("Expected: ")
                       .appendDescriptionOf(matcher)
                       .appendText(System.lineSeparator())
                       .appendText("     but: ");
            matcher.describeMismatch(actual, description);
            
            throw new AssertionError(description.toString());
        }
    }
    
    public static void assertThat(String reason, boolean assertion) {
        if (!assertion) {
            throw new AssertionError(reason);
        }
    }
}

```



다만 JUnit의 assertThat의 경우 아래와 같이 Deprecated될 예정이며, JUnit보다 assertj의 assertThat이 사용성이 더 좋다고 하니 되도록이면 assertj을 쓰는 것이 좋아보인다. (이것에 대해서는 기회가 있을 때 추가 포스트를 올리도록 하겠다.)

![3](../../assets/images/03-27-spring-test/4.png)



### JUnit대비 assertj의 장점

1. CoreMatchers과 같은 추가 라이브러리가 필요하지 않음: JUnit의 assertThat은 is() 등과 같은 CoreMatchers 라이브러리 메서드가 추가로 필요하다.
2. 자동 완성이 좀 더 확실하게 지원됨: IDE에서 CoreMatchers는 자동 완성 지원이 약하기 때문에 CoreMatchers를 사용하는 JUnit은 자동 완성을 사용하는 데에 어려움이 있다.



아래 코드는 JUnit, assertj를 이용하여 getResquest 함수를 검증한 테스트 코드이며 사용된 함수는 아래와 같다.

`assertThat`: 값 또는 객체에 대한 검증을 위한 메서드로 검증할 대상을 인자로 넣어서 사용한다.

`isEqualTo`: ***assertj assertThat의 값 비교를 위한 메서드***로 메서드 체이닝을 이용하여 assertThat과 이어서 사용할 수 있다. assertThat의 인자와 isEqualTo의 인자가 같을 경우 검증이 성공한다.

`is`: ***JUnit assertThat의 값 비교를 위한 Matcher 메서드***로 hamcrest 라이브러리에서 가져온 메서드이며 assertThat의 인자로 사용된다. assertThat에서 검증을 위해 넘겨준 인자와 is의 인자가 같을 경우 검증이 성공한다.

```java
package com.example.demo.controller;

import org.assertj.core.api.Assertions;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.junit4.SpringRunner;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.is; // junit assertThat의 인자로 사용하기 위한 matcher
import static org.junit.Assert.assertThat;

@RunWith(SpringRunner.class)
@WebMvcTest(controllers = GetController.class)
public class UserContollerTest {

    @Autowired
    private GetController getController;

    @Test
    public void getTest(){
        System.out.println(getController.getRequest());
        Assertions.assertThat(getController.getRequest()).isEqualTo("Get!"); // assertj 방식
        assertThat(getController.getRequest(),is("Get!")); // JUnit 방식
    }
}

```



# Conclusion

---

TDD의 짧은 설명과 Test 코드 작성을 위해 Controller의 간단한 테스트를 진행해 보았다.



# Reference

---

스프링 부트와 AWS로 혼자 구현하는 웹 서비스 - 이동욱님

https://junit.org/junit5/docs/current/user-guide/

https://jongmin92.github.io/2020/03/31/Java/use-assertthat/

https://jwkim96.tistory.com/168
