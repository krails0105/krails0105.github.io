# Introduction
![github pages](/assets/images/images.jpeg)

개발 블로그를 구성해보기 위해 여러 서비스 중 github page를 채택하게 되었다. 

github page는 git에서 운영하는 서비스인 만큼 git에 대해 더 익숙해질 수 있는 기회가 될 수 있겠다 싶었고 단순 텍스트와 이미지를 삽입하는 것 뿐만 아니라 웹페이지를 개발하듯이 개발 블로그를 운영할 수 있겠다 싶어 github page를 사용해보기로 하였다. 

이번 페이지는 아래를 목표로 한다.
> index.html을 이용한 간단한 github page 생성

# github page 구성
### 1. 페이지 구성에 사용될 git repository를 만든다
아래 new 버튼 클릭
![](/assets/images/repo.png)
repo 이름은 반드시 {username}.github.io과 동일하게 설정한다.
아래 예시는 username은 Owner와 같은 krails0105이기 때문에 krails0105.github.io로 설정
![](/assets/images/repo1.png)

## 2. index.html 생성 
레포가 생성되면 아래 상태가 되는데 여기서 index.html만 생성해도 바로 page가 생성된다. 아래 Add file -> Create new file을 클릭
![](/assets/images/repo7.png)

아래 krails0105.github.io/[  ] in main의 공란에 index.html을 채워 넣고 아무 텍스트(Hello world!)를 넣고 Commit new file을 선택
![](/assets/images/repo4.png)

아래처럼 index.html이 생성되는데 이제 페이지의 기본 구성은 완료되었기 때문에 바로 페이지 접근이 가능하다
![](/assets/images/repo8.png)

## 3. page 접근
이제 username.github.io(예시의 경우는 krails0105.github.io)로 해당 페이지를 접근할 수 있다!

![](/assets/images/repo6.png)

하지만 index.html을 commit하자마자 바로 페이지를 접근하면 아래와 같은 에러가 나올 수 있는데 github 내부적으로 아직 해당 내용을 배포하는 중일 수 있다
![](/assets/images/repo5.png)

아래 Environments의 github-pages를 보면 해당 페이지의 배포 상태를 볼 수 있다 (아래 경우는 배포가 한번 실패해서 자동으로 재시도 한 것을 알 수 있다)
![](/assets/images/repo10.png)

![](/assets/images/repo9.png)

# Conclusion
이번에는 간단한 repo 생성과 html파일 생성으로 github page를 구성해보았다.

기존에 github을 사용하던 개발자들에게는 간단하지만 사실 개발자들이 아닌 일반사람들이 사용하기에는 이부분부터가 부담일 수 있다고 생각.. 

다음에는 간단한 페이지를 좀 더 확장하여 jekyll이라는 site generator를 이용한 페이지 구성을 해보겠다.


# Reference

https://docs.github.com/en/pages/quickstart

https://zeddios.tistory.com/1222

https://www.youtube.com/watch?v=ACzFIAOsfpM




