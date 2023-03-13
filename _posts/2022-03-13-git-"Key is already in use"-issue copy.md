# Issue
하나의 pc에서 git 계정을 2개 이상 사용하는 경우 각 계정의 ID/PW 인증을 통해 https 접속이 가능하지만 ssh 접속을 이용할 경우 각 계정별 key가 필요하다.

만약 이미 github의 타 계정에 등록해 놓은 ssh key를 다른 계정에서도 등록을 시도하면 "Key is already in use"를 출력하며 등록이 실패한다.

# Resolution
해결하기 위해서는 ssh 접속을 하고 싶은 계정을 위한 ssh key를 추가로 생성하고 해당 public 키를 계정에 등록하면 된다.
```
$ ssh-keygen
```
ssh-keygen 명령어 수행 후 기존 키와의 중복 방지를 위해 *Enter file in which to save the key* 단계에서 아래와 같이 key파일의 이름을 바꾸거나 경로를 바꿔서 저장한다.

![](../assets/images/22-02-04-git-key-duplicated/git-issue4.png)

key를 생성하면 아래와 같이 private, public 키가 각각 생성되는데 이 중 public key를 사용하고자 하는 계정에 등록해주면 된다.
```
$ ls  ~/.ssh/id_rsa_krails0105*
/Users/shkim/.ssh/id_rsa_krails0105     /Users/shkim/.ssh/id_rsa_krails0105.pub
```

github 페이지에서 Settings -> SSH and GPG keys -> New SSH Key 

![](../assets/images/22-02-04-git-key-duplicated/git-issue5.png)

위 단계에서 New SSH Key를 누르면 아래와 같이 public key를 등록하는 페이지가 나오는데  Key블록에 .pub 확장자를 가진 key의 내용을 그대로 옮겨주고 Add SSH Key를 누르면 등록이 성공한다. 

아래와 같이 cat 명령어를 이용하면 key의 내용을 볼 수 있는데 결과 텍스트를 그대로 전부 복사하여 넣으면 된다.
```
$ cat /Users/shkim/.ssh/id_rsa_krails0105.pub
```

![](../assets/images/22-02-04-git-key-duplicated/git-issue6.png)

----



추가 키 생성과 등록 후에 주의해야할 부분이 몇가지 있는데 추가로 알아보자.

1. git config의 user 설정

가령 이미 git config --global로 다른 계정의 user 설정이 되어있는 상태에서 아무 설정없이 원격 저장소에 git push를 하면 global user 정보로 push가 된다.


```
git config --global user.name krails0522
git config --global user.email shkim@gmail.com
```

![](../assets/images/22-02-04-git-key-duplicated/git-issue1.png)



이 경우에는 --local 인자를 이용하여 사용할 레포에 원하는 git user 설정을 설정을 해주면 된다.

```
git config --local user.name krails0105
git config --local user.email krails.kim@gmail.com
```

2. git URL를 추가 계정에 맞게 설정을 해줘야 함

아래와 같이 git clone에서 URL은 git@github.com:{your_id}/{repo_name}.git 형식으로 설정이 되어있다.

<img src="../assets/images/22-02-04-git-key-duplicated/git-issue3.png" height="180px" width="600px">

이때 위 URL 그대로 clone을 하면 최초로 설정된 ssh key와 연동되는 repo가 생성된다.

우리는 추가 생성한 ssh key와 연동되는 repo를 clone해와야 하기 때문에 아래와 같은 추가 설정이 필요하다.

```
$ vi ~/.ssh/config
```

```shell 
Host github.com-krailskim
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_rsa_krailskim
```

ssh config 파일에서 추가 생성한 ssh key 파일을 IdentityFile로 하는 새로운 host를 생성한다.

이제 git clone시 아래와 같이 host를 수정하면 clone 결과로 생성된 repo는 자동으로 새로운 ssh key와 연동된다

```
git clone git@github.com-krailskim:krails0105/krails0105.github.io.git
```
만약 위와 같은 설정을 해주지 않고 github에서 복사한 URL그대로 clone을 하면 clone은 성공하지만 push시에 아래와 같은 에러가  발생한다.
```
ERROR: Permission to krails0105/krails0105.github.io.git denied to krails0522.
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
```


이때, 아래와 같이 git remote을 이용하여 origin을 삭제 후 수정된 URL로 add하면 해결할 수 있다
```
$ git remote remove origin
$ git remote add origin git@github.com-krailskim:krails0105/krails0105.github.io.git
```




# Conclusion
하나의 PC에서 여러개의 ssh 키를 생성하여 2개 이상의 git 걔정을 관리하는 방법을 알아보았다.

평소에는 git 걔정을 하나만 사용하기 때문에 잘 발생하지 않는 에러였는데 추후에 회사 계정과 개인 계정을 동시에 관리해야 할 때 유용할 듯 하다.


# Reference

https://kibua20.tistory.com/190



