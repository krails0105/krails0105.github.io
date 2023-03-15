# Issue

---

git merge중에 아래와 같은 에러가 나면서 merge가 실패하는 경우가 있었다.

*fatal: refusing to merge unrelated histories*

![github pages](/assets/images/23-02-04-git-issue/git2.png)

나의 경우에는 main브랜치를 만들어 놓고 실수로 master브랜치를 만들고 main과는 아예 다른 내용으로 작업을 진행하였는데 해당 에러가 발생하였다.

찾아보니 이는 두 브랜치의 작업 내용이 연관된 history를 가지지 않아 merge가 refused된 경우이다. 비슷한 경우로 pull에서도 일어날 수 있다 pull은 fetch + merge의 동작을 하는 명령어이기 때문에..

# Resolution

---

해결 방법은 간단한데 명령어에 --allow-unrelated-histories를 추가하면 된다.
```
git merge master --allow-unrelated-histories
```

![github pages](/assets/images/23-02-04-git-issue/git1.png)

머지 후에 생긴 conflict 코드를 수정하고 성공적으로 push를 하였다.

# Reference

---

https://gdtbgl93.tistory.com/63



