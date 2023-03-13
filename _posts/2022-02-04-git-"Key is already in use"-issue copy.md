# Issue
하나의 pc에서 git 계정을 2개 이상 사용하는 경우 각 계정의 ID/PW 인증을 통해 https 접속이 가능하지만 ssh 접속을 이용할 경우 각 계정별 key가 필요하다.
만약 이미 github의 타 계정에 등록해 놓은 ssh key를 다른 계정에서도 등록을 시도하면 "Key is already in use"를 출력하며 등록이 실패한다.

# Resolution
간단하게 ssh 접속을 하고 싶은 계정을 위한 ssh key를 추가로 생성하고 해당 public 키를 계정에 등록하면 된다.
이때 문제가 발생할만한 부분이 몇가지 있는데 추가로 알아보자.

1. git config --global로 생성한 id, email과의 conflict

```
git config --local user.name krails0105
git config --local user.email krails.kim@gmail.com
```

2. git URL를 추가 계정에 맞게 설정을 해줘야 함


GitHub에서 복사한 URL: git@github.com:{your_id}/{repo_name}.git
수정해야 하는 URL:  git@github.com-{your_id}:{your_id}/{repo_name}.git  
수정 예:  git@github.com-kibua20:kibua20/test.git


```
git clone git@github.com-krailskim:krails0105/krails0105.github.io.git

git remote add origin git@github.com-krailskim:krails0105/krails0105.github.io.git
```

```shell 
Host github.com-krailskim
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_rsa_krailskim
```

# Conclusion
이번에는 이전 index.html에 확장하여 jekyll을 이용한 페이지 생성을 하였다. 

여기서부터는 개발자가 아니면 더이상 일반인이 접근하기는 힘든 영역이라고 생각한다. 아직 페이지 구성만하고 있는데도 다른 블로그보다 난이도가 훨씬 어렵다. 익숙해지면 훨씬 수월하겠지..?

다음에는 한번 더 확장하여 jekyll의 오픈소스 테마를 적용하여 보겠다.


# Reference

https://kibua20.tistory.com/190

https://jekyllrb.com/docs/

https://zeddios.tistory.com/1222

https://leop0ld.tistory.com/17

https://ideveloper2.tistory.com/80




