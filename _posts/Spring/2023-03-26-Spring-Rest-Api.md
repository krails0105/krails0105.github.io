---
title: "[SpringBoot] Controller 설정"
categories:
  - Spring
tags:
  - [Java, Spring]
---



# Introduction

---

SpringBoot의 Controller 설정 방법과 Rest API 구현 과정을 살펴 본다.



# Rest API

---

HTTP 프로토콜에 있는 Method를 활용한 아키텍쳐 스타일

HTTP method를 통해서 Resource에 대한 CRUD 작업을 처리한다.

> CRUD: Create / Read / Update / Delete

여기서 Resource란 Collection, Member로 나뉠 수 있다.

- Collection: 리스트 등의 형태로 여러 개로 이루어진 리소스

- Member: 단일로 이루어진 개별적인 리소스



| HTTP Method | CRUD 동작     | URL 형태 (예시)   |
| ----------- | ------------- | ----------------- |
| GET         | 조회 (Read)   | /user, /user/{id} |
| POST        | 생성 (Create) | /user             |
| PUT / PATCH | 수정 (Update) | /user/{id}        |
| DELETE      | 삭제 (Delete) | user/{id}         |



예를 들어 Rest방식으로 단일 리소스(Member)를 조회를 하고 싶을 때는 아래와 같은 작업이 이루어진다.

1. /user/{id} 형태의 url을 사용하여 서버에 HTTP get method를 보낸다
2. 서버에서는 user의 데이터 중 특정 id에 해당하는 정보를 read하여 리턴해준다.



# Controller 설정

---

웹에서 사용자의 접속을 위해서는 주소가 필요한데 웹 개발에서 ***주소의 모음을 Controller***라고 함

Rest API의 형태로 웹 개발을 하기 위해서는 크게 Get, Post, Put/Patch, Delete를 수행하는 주소를 만들고 주소에 매핑되는 메서드들을 만들어 해당 기능을 수행하도록 개발해야 한다.

프로젝트에서 controller라는 패키지를 별도로 생성하고 controller 패키지 안에서 각 메소드들을 정의하도록 한다.



## Get method

컨트롤러의 첫 번째로 GetController를 생성

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

- @RestController : annotation을 사용하여 spring에게 여기는 컨트롤러로 사용할거라는 것을 명시 
- @RequestMapping : api 주소 매핑을 위한 annotation (어떤 주소로 받을건지 설정) 
- 위 예시에서는 get method가 파라미터를 받는 부분이 없기 때문에 /getMethod 뒤에 어떤 파라미터를 붙여도 동일한 동작을 함 → ex) [localhost:8080/api/getMethod?id=1234](http://localhost:8080/api/getMethod?id=1234) 
- 위 예시 코드를 작성하고 서버를 다시 실행하면 http://localhost:8080/api/getmethod 주소로 getRequest를 호출할 수 있고 아래와 같이 브라우저를 이용하여 테스트가 가능하다.

![2](../../assets/images/03-26-spring-api/2.png)

- 웹 브라우저는 캐싱을 하기 때문에 검증을 위한 주소로 접속을 하면 메서드가 호출되는 것이 아니라 캐시 데이터가 리턴될 수 있다.
  - 웹 브라우저의 캐시 끄기: 만든 페이지에서 개발자 모드 -> Network → Disable cache 체크 → refresh 
- 웹 개발에서 개발 코드 검증 : Junit이나 웹브라우저, rest client(Postman 등..) 등을 통해서 가능 

- 만약 Mapping으로 설정한 method 단위의 주소가 똑같은 것이 두개이상있으면 스프링 부트 실행 불가

![1](../../assets/images/03-26-spring-api/1.png)

- 위 예시를 보면 getParameter 주소에 매핑되는 함수를 두 개 만들어서 빌드 에러가 나는 것을 확인 가능



# Conclusion

---

Spring 프로젝트를 시작하기 전에 초기 프로젝트 세팅 방법에 대하여 알아보았다.



# Reference

---

Fastcampus 스프링 부트 프로젝트(어드민 페이지 만들기) 강의 - 예상국 강사님

Fastcampus 스프링 부트 프로젝트 강의(지인 정보 관리 시스템 만들기) - 강현호 강사님
