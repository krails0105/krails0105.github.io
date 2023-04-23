---
title: "[SpringBoot] 머스테치(Mustache) (3) - 추가 기능 구성"
categories:
  - Spring
tags:
  - [Java, Spring]
---



# Introduction

---

이전 포스트에서는 화면 구성과 post 기능을 구현했었는데 이에 추가로 다양한 기능을 구현해보자.



# 전체 화면 조회

---

![image-20230423232455486](../../assets/images/04-14-mustache/11.png)

기존에 만들었던 index 화면에서 위와 같이 테이블 형식으로 전체 데이터를 조회하는 화면을 추가하도록 한다.



## index.mustache

기존에 만든 index.mustache에 table 부분을 추가

```html
{{>layout/header}}
    <h1>스프링 부트로 시작하는 웹 서비스 Ver.2</h1>
    <div class="col-md-12">
        <div class="row">
            <div class="col-md-6">
                <a href="/posts/save" role="button" class="btn btn-primary">글 등록</a>
            </div>
        </div>
        <br>
        <!-- 목록 출력 영역 -->
        <table class="table table-horizontal table-bordered">
            <thead class="thead-strong">
            <tr>
                <th>게시글 번호</th>
                <th>제목</th>
                <th>작성자</th>
                <th>최종 수정일</th>
            </tr>
            </thead>
            <tbody id="tbody">
            {{#posts}}
                <tr>
                    <td>{{id}}</td>
                    <td>{{title}}</td>
                    <td>{{author}}</td>
                    <td>{{modifiedDate}}</td>
                </tr>
            {{/posts}}
            </tbody>
        </table>
    </div>
{{>layout/footer}}
```

위 코드에서 사용된 머스테치 문법은 아래와 같다.

`{{#posts}}`: posts라는 List 순회 (for 문과 동일한 역할)

`{{변수}}`: List의 각 원소 객체가 가진 필드에 접근, 가령 `{{id}}`는 posts 리스트가 포함하고 있는 객체 들의 id 필드에 해당한다.

즉, 위 코드는 posts라는 객체 리스트의 각 원소를 순회하며 각 원소의 id, title, author, modifiedDate 필드를 이용하여 테이블을 생성하는 코드로 해석할 수 있다. 



## Repository / Service

다음은 전체 화면 조회에 사용될 쿼리와 서비스 로직을 생성한다.

1) Repository에 전체 데이터를 조회할 findAllDesc 쿼리 메서드를 생성

```java
package com.example.demo.posts;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface PostsRepository extends JpaRepository<Posts, Long> {

    @Query("SELECT p FROM Posts p ORDER BY p.id DESC")
    List<Posts> findAllDesc();
}

```



2. Service 단에 위의 쿼리 메서드를 호출하여 결과를 리스트로 리턴하는 메서드를 추가

```java
...
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.stream.Collectors;

@RequiredArgsConstructor
@Service
public class PostsService {
    private final PostsRepository postsRepository;

    ...

    @Transactional(readOnly = true)
    public List<PostsListResponseDto> findAllDesc(){
        return postsRepository.findAllDesc().stream()
                .map(PostsListResponseDto::new)
                .collect(Collectors.toList());
    }

}

```

`@Transactional(readOnly = true)`: 해당 범위에 트랜잭션을 유지하지만 조회 기능만을 남겨두기 때문에 조회 속도가 개선된다.



## Controller

Index.mustache의 `{{#posts}}`를 위에서 생성한 서비스 로직과 연결하기 위해 `model.addAttribute` 호출

```java
package com.example.demo.web;

import com.example.demo.service.PostsService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model; // 서버 템플릿 엔진과 객체를 연결하기 위한 클래스
import org.springframework.web.bind.annotation.GetMapping;

@@RequiredArgsConstructor
@Controller
public class IndexController {

    private final PostsService postsService;
    
    @GetMapping("/")
    public String index(Model model){
        model.addAttribute("posts", postsService.findAllDesc()); // 서비스와 컨트롤러 연결
        return "index";
    }

    @GetMapping("/posts/save")
    public String postsSave() {
        return "posts-save";
    }
}

```

`Model`: 서버 템플릿 엔진에서 사용할 객체를 저장



위까지 구현하고 애플리케이션 실행하면 아래와 같은 화면이 구성 완료된다.

![image-20230423232455486](../../assets/images/04-14-mustache/11.png)



# 게시글 수정, 삭제 화면 생성

---



`Resource/templates` 경로에 아래와 같이 posts-update.mustache 생성 

```html
{{>layout/header}}

<h1>게시글 수정</h1>

<div class="col-md-12">
    <div class="col-md-4">
        <form>
            <div class="form-group">
                <label for="id">글 번호</label>
                <input type="text" class="form-control" id="id" value="{{post.id}}" readonly>
            </div>
            <div class="form-group">
                <label for="title">제목</label>
                <input type="text" class="form-control" id="title" value="{{post.title}}">
            </div>
            <div class="form-group">
                <label for="author"> 작성자 </label>
                <input type="text" class="form-control" id="author" value="{{post.author}}" readonly>
            </div>
            <div class="form-group">
                <label for="content"> 내용 </label>
                <textarea class="form-control" id="content">{{post.content}}</textarea>
            </div>
        </form>
        <a href="/" role="button" class="btn btn-secondary">취소</a>
        <button type="button" class="btn btn-primary" id="btn-update">수정 완료</button>
    </div>
</div>

{{>layout/footer}}
```

새롭게 사용된 머스테치 문법은 아래와 같다.

`{{post.id}}`: post라는 객체의 id 필드 접근

`readonly`: input 태그에 `읽기` 기능만을 허용하는 속성



위 코드의 의도는 `btn-update`버튼을 누르면 input 태그에 있는 데이터로 기존 데이터가 update되는 것이다.

index.js에 아래와 같이 update function을 추가

```js
var main = {
    init : function () {
        var _this = this;
        ...
        // btn-update`의 id를 가진 HTML 원소에 click 이벤트가 발생했을 때, update 함수 호출
        $('#btn-update').on('click', function () { 
            _this.update();
        });
    },
    ...
    update : function () {
        var data = {
            title: $('#title').val(),
            content: $('#content').val()
        };

        var id = $('#id').val();

        $.ajax({
            type: 'PUT', // http 메서드 중 PUT 호출
            url: '/api/v1/posts/'+id, // 호출할 URL path 설정
            dataType: 'json',
            contentType:'application/json; charset=utf-8',
            data: JSON.stringify(data)
        }).done(function() {
            alert('글이 수정되었습니다.');
            window.location.href = '/';
        }).fail(function (error) {
            alert(JSON.stringify(error));
        });
    },
    ...

};

main.init();
```

` $('#btn-update').on('click')`: 

여기까지 구성한 상태로 애플리케이션을 실행해보자.

이제 게시글 등록 화면에서 아래와 같이 데이터를 입력 후에 `등록` 버튼을 누르면 팝업 창이 뜨면서 데이터가 db에 저장된다. 

![image-20230419225835437](../../assets/images/04-14-mustache/9.png)



이번 포스트는 h2 db를 이용하였기 때문에 h2-console에서 방금 넣은 데이터를 확인할 수 있다.

![image-20230419225934679](../../assets/images/04-14-mustache/10.png)

# Conclusion

---

머스테치에 부트스트랩과 제이쿼리를 적용하여 보다 복잡한 화면 구성과 기능(post)을 진행하였다.

다음 포스트는 post 동작에 이어서 update, delete, 전체 조회 화면 등의 동작을 구현해본다.

# Reference

---

스프링 부트와 AWS로 혼자 구현하는 웹 서비스 - 이동욱님

https://hanamon.kr/%EB%B6%80%ED%8A%B8%EC%8A%A4%ED%8A%B8%EB%9E%A9-bootstrap-%EC%9D%B4%EB%9E%80/

https://namu.wiki/w/jQuery

https://aws.amazon.com/ko/what-is/cdn/
