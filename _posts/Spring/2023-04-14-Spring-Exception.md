---
title: "[SpringBoot] Exception"
categories:
  - Spring
tags:
  - [Java, Spring]
---



# Introduction

---

SpringBoot 개발에서 Exception처리에 대한 부분을 다룬다.



# Exception

---

Exception은 보통 아래 2가지로 나뉘게 된다.

1. Checked Exception (컴파일 에러)
2. Unchecked Exception (런타임 에러, Runtime Exception)

![image](../../assets/images/04-14-spring-exception/1.png)

`RuntimeException`의 하위 클래스들을 `Unchecked Exception` 이라 하고 그 외 Exception 클래스의 하위 클래스들은 `Checked Exception`



```java
@Transactional
    public void modify(Long id, String name) {
        // Person person = personRepository.findById(id).orElseThrow(() -> new RuntimeException("ID not found"));
        Person person = personRepository.findById(id).get(); // 의도적 에러

        person.setName(name);

        personRepository.save(person);
    }
```



# Conclusion

---

머스테치가 무엇이고 어떻게 구성하는 지에 대해서 다루었다.

다음 포스트에서는 이어서 머스테치에 자바스크립트, 부트스트랩 등을 적용하여 좀 더 복잡한 화면 구성을 진행해보겠다.

# Reference

---

Fastcampus 스프링 부트 프로젝트 강의(지인 정보 관리 시스템 만들기) - 강현호 강사님

https://devlog-wjdrbs96.tistory.com/351
