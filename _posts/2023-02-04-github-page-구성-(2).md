# Introduction
![github pages](/assets/images/23-02-04-github-page/images.jpeg)

이전 페이지에 이어서 github page 구성을 진행한다.

기존 index.html로만 이루어졌던 페이지를 jekyll site generator를 이용하여 테마를 적용해본다.
> github page에 jekyll 적용

# Jekyll 이란?
*Jekyll is a static site generator with built-in support for GitHub Pages.*

직역하면 github pages에서 지원하는 정적 사이트 생성기이며 markdown, liquid, html 등을 사용하여 사이트를 구성할 수 있게해준다. 

yml 파일을 이용하여 config 설정을 구성할 수 있으며 오픈소스로 제공되는 여러 테마들이 있기 때문에 다양한 구성을 적용해 볼 수 있다.

# Jekyll 설치

기본 설치는 https://jekyllrb.com/docs/ 의 Quickstart 내용대로 진행할 수 있다.

![](/assets/images/23-02-04-github-page(2)/github1.png)

jekyll은 gem이기 때문에 Ruby와 RubyGems이 선행으로 설치되어야 한다. 물론 설치방법도 위 공식 홈페이지에 자세히 명시되어있다. 간단히 소개만 해보자면 아래의 순서로 설치가 이루어진다. (macOS 기준)

*참고 : gem은 ruby에서 쓰이는 라이브러리의 단위이며 gem 명령어를 이용하여 패키지를 설치할 수 있다*

1. ruby 설치
```
brew install chruby ruby-install xz
```
```
ruby-install ruby 3.1.3
```

2. ruby가 설치되면 zshrc, bash_profile에 ruby 설정 추가
```
echo "source $(brew --prefix)/opt/chruby/share/chruby/chruby.sh" >> ~/.zshrc
echo "source $(brew --prefix)/opt/chruby/share/chruby/auto.sh" >> ~/.zshrc
echo "chruby ruby-3.1.3" >> ~/.zshrc # run 'chruby' to see actual version
```

3. zshrc를 재시작하여 ruby설정 적용 또는 source 명령어를 이용하여 설정 즉시 적용
```
source ./zshrc
```
4. gem을 이용하여 jekyll, bundler 설치 
```
gem install jekyll bundler
```

*참고 : Bundler는 Gemfile에 정의된 gem들의 의존성을 파악해서 올바른 gem을 사용할 수 있게끔 해주는 명령어이며 bundle install, bundle update 명령어를 통해 일괄적으로 처리가 가능*

# Jekyll을 이용한 페이지 구성

위 과정을 거쳐 jekyll을 설치하면 아래와 같이 페이지 구성이 가능하다.


블로그 레포 경로로 이동
```
cd {my-blog-path}
```
jekyll 명령어로 블로그 레포의 최상위 폴더에 jekyll 생성
```
jekyll new ./
```
의존성 설치
```
bundle install
```
로컬 서버에 jekyll 페이지 띄우기
```
bundle exec jekyll serve
```
아래와 같이 localhost:4000 주소로 사이트가 띄워졌다.

![](/assets/images/23-02-04-github-page(2)/github3.png)


![](/assets/images/23-02-04-github-page(2)/github4.png)

# Conclusion
이번에는 이전 index.html에 확장하여 jekyll을 이용한 페이지 생성을 하였다. 

여기서부터는 개발자가 아니면 더이상 일반인이 접근하기는 힘든 영역이라고 생각한다. 아직 페이지 구성만하고 있는데도 다른 블로그보다 난이도가 훨씬 어렵다. 익숙해지면 훨씬 수월하겠지..?

다음에는 한번 더 확장하여 jekyll의 오픈소스 테마를 적용하여 보겠다.


# Reference

https://docs.github.com/en/pages/quickstart

https://jekyllrb.com/docs/

https://zeddios.tistory.com/1222

https://leop0ld.tistory.com/17

https://ideveloper2.tistory.com/80




