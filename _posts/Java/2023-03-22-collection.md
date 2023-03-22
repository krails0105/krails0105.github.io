---
title: "[Java] Collection Framework"
categories:
  - Java
tags:
  - [Java]

---



# Introduction

---

Java의 Collection Framework에 대해 알아본다.



# Generic programming

---

변수나 메서드의 매개 변수, 리턴 타입 등을 고정된 자료형이 아닌 ***가변적인 자료형으로 프로그래밍***하는 방식

가변적인 자료형을 사용하기 때문에 하나의 코드(클래스, 함수 등)를 여러 자료형을 이용하여 사용할 수 있다.

- 이때, 자료형은 기본 자료형이 아닌 ***참조 자료형으로의 변환만 가능***하다.

컴파일 과정에서 자료형의 변환이 정상적으로 이루어질 수 있는 지 체크하기 때문에 안정적인 프로그래밍이 가능하다.

자료형이 고정적이지 않기 때문에 ***자료형 매개 변수***라는 형태로 자료형을 표현하며 보통 매개 변수는 T를 많이 사용한다.

```java
public class GenericPrinter<T> {  // 자료형 매개 변수 T

	private T material;							// T에 어떤 타입을 넣느냐에 따라 material 변수의 타입이 결정 된다.

	public T getMaterial() {
		return material;
	}

	public void setMaterial(T material) {
		this.material = material;
	}
	
	public String toString() {
		return material.toString();
	}
}

```



제너릭이 적용된 코드에서 자료형을 정하기 위해서 <> 를 사용한다.

- <> 안에 자료형을 명시하면 되는데 이때 ***자료형을 쓰지 않아도 컴파일러가 자동으로 자료형을 유추하여 넣어준다.***

````java
public class GenericPrinterTest {

	public static void main(String[] args) {
		
    // GenericPrinter의 매개 변수 T는 Integer로 변환된다.
		GenericPrinter<Integer> integerPrinter = new GenericPrinter<Integer>(); 
		powderPrinter.setMaterial(1);
    
    GenericPrinter<Float> floatPrinter = new GenericPrinter<>(); // 자동으로 자료형이 Float으로 설정된다.
    // GenericPrinter<int> intPrinter = new GenericPrinter<int>(); // Error, 기본 자료형 사용 불가

		// 인스턴스를 생성할때 자료형 매개 변수를 명시하지 않으면 Object 형으로 인식함
		GenericPrinter printer = new GenericPrinter();

	}
}
````



### 매개 변수 상속

***매개 변수 T는 다른 클래스를 상속 받을 수 있는데 상속받은 클래스의 매개 변수, 메서드도 사용 가능하다.*** 

- 아무 클래스도 상속받지 않은 T는 Object class의 함수만을 사용 가능

```java
class Plastic extends Meterial{

	public String toString() {
		return "Plastic";
	}

	@Override
	public void doPrinting() {
		System.out.println("Plastic");
		
	}
}

class Powder extends Meterial{

	public String toString() {
		return "Powder";
	}

	@Override
	public void doPrinting() {
		System.out.println("Powder");
		
	}
}

class GenericPrinter<T extends Meterial> { // 매개 변수 상속

	private T material;

	public T getMaterial() {
		return material;
	}

	public void setMaterial(T material) {
		this.material = material;
	}
	
	public String toString() {
		return material.toString();
	}
	
	public void printing() {
		material.doPrinting();	// 매개 변수가 상속받은 Meterial의 메서드 사용
	}
}

public class GenericPrinterTest {

	public static void main(String[] args) {
		
		GenericPrinter<Powder> powderPrinter = new GenericPrinter<Powder>();
		Powder powder = new Powder();
		powderPrinter.setMaterial(powder);
		System.out.println(powderPrinter);
		

		GenericPrinter<Plastic> plasticPrinter = new GenericPrinter<Plastic>();
		Plastic plastic = new Plastic();
		plasticPrinter.setMaterial(plastic);
		System.out.println(plasticPrinter);
		
		powderPrinter.printing();
		plasticPrinter.printing();


	}
}

------

Powder
Plastic
Powder
Plastic
```



### 자료형 매개 변수가 두 개 이상인 경우

자료형 매개 변수가 두 개 이상인 경우 <T, V> 형태로 사용 가능하다.

```java
public class GenericPrinter<T extends Meterial, V> { // 자료형 매개 변수 T, V 사용

	private T material;
	private V material2;

	public T getMaterial() {
		return material;
	}

	public V getMaterial2() {
		return material2;
	}
```



### 제너릭 메서드

매개 변수를 자료형 매개 변수로 사용하는 메서드

- 메서드 내에서 정의한 자료형 매개 변수는 해당 메서드 내에서만 사용된다. (지역 변수와 같은 개념)

아래 예시에서 Shape에 사용된 T와 makeRectangle의 T는 다른 매개 변수이다.

```java
class Point<T, V>{
	...
}

class Shape<T>{
	
	public static <T, V> double makeRectangle(Point<T, V> p1, Point<T, V> p2) { // 제너릭 메서드
		...
	}
}
```



#  Conclusion

---

제너릭 프로그래밍에 대해 알아보았다. C++의 템플릿(template)을 공부할 때 처음 접한 개념인데 모든 타입으로 템플릿 변수를 설정할 수 있는 C++과 달리 Java에서는 기본 자료형이 아닌 참조 자료형만 가능하다는 점이 다르다.

제너릭 프로그래밍은 다음에 포스트할 내용인 컬렉션 프레임워크에서 컬렉션 타입을 정의할 때 계속 나오는 개념이기 때문에 확실히 이해하고 넘어가자.

# Reference

---

Fastcampus JAVA기초 강의 - 박은종 강사님
