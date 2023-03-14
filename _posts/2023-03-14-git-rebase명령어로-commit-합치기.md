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
or 
$ git rebase -i HEAD~~~~~
```

rebase를 수행하면 아래와 같은 화면이 나오면서 커밋 내역들이 나온다.

HEAD~ 다음에 오는 숫자에 따라 내역의 수가 달라지는데 위의 예에서는 HEAD~5이므로 HEAD를 포함하여 5개의 커밋 내역들이 출력된다. 또는 포함할 커밋 수 만큼 HEAD뒤에 물결표를 추가해도 동일한 결과가 나온다. 

```shell
pick 3df3e3c7 feature: add 1
pick d4b73b68 feature: add 2
pick a24b8a9c feature: add 4
pick 0f33276d feature: add 3
pick 39f264ae feature: add 5

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

위 커밋 내역을 보면 각 커밋 id앞에 pick이라는 커맨드가 보이는데 병합할 commit id의 pick을 squash(또는 s)로 변경하면 squash로 표시된 커밋은 이전 커밋과 합쳐진다.

```sh
pick 3df3e3c7 feature: add 1
s d4b73b68 feature: add 2
s a24b8a9c feature: add 4
s 0f33276d feature: add 3
s 39f264ae feature: add 5
```

주의할 점은 squash는 이전 커밋과 합쳐진다는 점이다. 만약 아래와 같이 모든 커밋에 squash를 넣는다던가 squash, pick의 순서를 잘못 설정하면 원하지 않는 결과가 나오거나 에러를 발생시킬 수 있다.

```shell
## Error case (1)
s 3df3e3c7 feature: add 1
s d4b73b68 feature: add 2
s a24b8a9c feature: add 4
s 0f33276d feature: add 3
s 39f264ae feature: add 5
```

```shell
## Error case (2)
s 3df3e3c7 feature: add 1
s d4b73b68 feature: add 2
s a24b8a9c feature: add 4
s 0f33276d feature: add 3
pick 39f264ae feature: add 5
```

Rebase 화면에서 squash, pick 설정을 마치고 :wq 커맨드로 vi를 빠져나오면 아래와 같이 커밋 메세지를 설정할 수 있는 창이 나오는데 여기서 원하는 커밋 메세지를 설정하고 git push를 하면 통합된 커밋이 push된다.

```shell
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

필자는 아래와 같이 커밋 메세지를 수정 후 push 하였다

```shell

feature: merge 1~5

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

```shell
$ git rebase -i HEAD~5
[detached HEAD 17f6b343] feature: add 1
 Date: Tue Mar 14 21:15:23 2023 +0900
 5 files changed, 0 insertions(+), 0 deletions(-)
 create mode 100644 1
 create mode 100644 2
 create mode 100644 3
 create mode 100644 4
 create mode 100644 5
Successfully rebased and updated refs/heads/test/test.
$ git push
```

# Conclusion
git rebase로 commit을 통합하는 법에 대해서 알아보았다.

git rebase -i에는 커밋 통합 외에 커밋 수정 등 다른 기능들이 있는 것 같아 보이니 추후 더 알아볼 필요가 있어보인다.


# Reference

https://backlog.com/git-tutorial/kr/stepup/stepup7_5.html

