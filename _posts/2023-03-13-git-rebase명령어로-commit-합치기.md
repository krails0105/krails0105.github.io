# Issue
git PR을 요청받을 때, 너무 많은 commit으로 인해 변경점을 추적하기 어려울 때가 많았다.
여러 commit을 하나로 합쳐 브랜치의 변경점을 보다 쉽게 추적하고 싶다.

# Resolution

## git rebase -i 

과거 커밋내역들을 통합하는 명령어이다.

```
git rebase -i HEAD~~
```

테스트를 위해 작업 중인 브랜치에 아래와 같이 5개의 file을 만든다

```shell
$ touch 1
$ touch 2
$ touch 3
$ touch 4
$ touch 5
$ git status
...
Untracked files:
  (use "git add <file>..." to include in what will be committed)
        1
        2
        3
        4
        5
```

5개의 commit을 만들기 위해 각 파일을 add할 때마다 commit을 만든다

```shell
$ git add 1
$ git commit -m "feature: add 1"
$ git add 2
$ git commit -m "feature: add 2"
$ git add 3
$ git commit -m "feature: add 3"
$ git add 4
$ git commit -m "feature: add 4"
$ git add 5
$ git commit -m "feature: add 5"
```

아래와 같이 5개의 커밋이 만들어 짐을 확인할 수 있다

```shell
$ git log --oneline
39f264ae (HEAD -> test/test) feature: add 5
a24b8a9c feature: add 4
0f33276d feature: add 3
d4b73b68 feature: add 2
3df3e3c7 feature: add 1
```

이제 이 커밋들을 하나로 합치기 위해 git 명령어를 사용하자

```shell
$ git rebase -i HEAD~5
```

````shell
```
pick 3df3e3c7 feature: merge 1~5 commit
s d4b73b68 feature: add 2
s a24b8a9c feature: add 4
s 0f33276d feature: add 3
s 39f264ae feature: add 5

# Rebase 18337c13..39f264ae onto 18337c13 (5 commands)
#
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup [-C | -c] <commit> = like “squash” but keep only the previous
#                    commit’s log message, unless -C is used, in which case
#                    keep only this commit’s message; -c is same as -C but
#                    opens the editor
# x, exec <command> = run command (the rest of the line) using shell
# b, break = stop here (continue rebase later with ‘git rebase --continue’)
# d, drop <commit> = remove commit
# l, label <label> = label current HEAD with a name
# t, reset <label> = reset HEAD to a label
# m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]
# .       create a merge commit using the original merge commit’s
# .       message (or the oneline, if no original merge commit was
# .       specified); use -c <commit> to reword the commit message
#
# These lines can be re-ordered; they are executed from top to bottom.
#
# If you remove a line here THAT COMMIT WILL BE LOST.
#
# However, if you remove everything, the rebase will be aborted.
#
~                                                                  
```

```
# This is a combination of 5 commits.
# This is the 1st commit message:

feature: add 1

# This is the commit message #2:

feature: add 2

# This is the commit message #3:

feature: add 4

# This is the commit message #4:

feature: add 3

# This is the commit message #5:

feature: add 5

# Please enter the commit message for your changes. Lines starting
# with ‘#’ will be ignored, and an empty message aborts the commit.
#
# Date:      Tue Mar 14 20:37:46 2023 +0900
#
# interactive rebase in progress; onto 18337c13
# Last commands done (5 commands done):
#    squash 0f33276d feature: add 3
#    squash 39f264ae feature: add 5
# No commands remaining.
# You are currently rebasing.
#
# Changes to be committed:
#       new file:   1
#       new file:   2
#       new file:   3
#       new file:   4
#       new file:   5
#
~                             
```
````





이 경우에는 --local 인자를 이용하여 사용할 레포에 원하는 git user 설정을 설정을 해주면 된다.

```
git config --local user.name krails0105
git config --local user.email krails.kim@gmail.com
```

2. git URL를 추가 계정에 맞게 설정을 해줘야 함

아래와 같이 git clone에서 URL은 git@github.com:{your_id}/{repo_name}.git 형식으로 설정이 되어있다.

<img src="../assets/images/23-03-13-git-key-duplicated/git-issue3.png" height="180px" width="600px">

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



