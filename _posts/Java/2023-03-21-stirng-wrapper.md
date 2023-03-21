---
title: Java String/Wrapper클래스

---



# Introduction

---

Java의 String class와 Wrapper class에 대해 알아본다.



# String class

---

문자열 클래스

- class 파일: 객체의 정보(멤버 변수, 메서드, 생성자 등)가 포함 되어있는 파일

***Class 클래스는 컴파일된 class 파일을 이용하여 클래스의 정보를 가져올 수 있다.***

Class 클래스를 가져오는 방법은 세 가지가 있는데 아래와 같다.

1. ***getClass()***: Object method를 이용
2. ***{class이름}.class***: 이미 컴파일된 상태인 .class 파일이 존재하는 경우, 해당 클래스 이름(파일 이름)으로 가져올 수 있음.
3. ***Class.forName("{class의 fullname}")***: 해당 statement가 수행될 때(런타임 때), 내가 원하는 클래스/라이브러리 파일이 로컬에 있으면 바인딩함 (동적 로딩, 컴파일 타임에 체크할 수 없기 때문에 예외처리 필요 -> ClassNotFoundException)
   - 정적 로딩: 컴파일 시간에 코드가 바인딩 되는 경우
   - 동적 로딩: 런타임때 코드가 바인딩 되는 경우

```java
public class StringClassTest {

	public static void main(String[] args) throws ClassNotFoundException {
		
		Class c1 = String.class;	 // {class이름}.class 방식
		
		String str = new String();	
		Class c2 = str.getClass();	// getClass 방식
		
		Class c3 = Class.forName("java.lang.String"); // Class.forName 방식
	}
}
```



아래 예시 코드는 Class 클래스로 접근할 수 있는 클래스의 범위에 대하여 테스트한 코드이다.

1. 같은 패키지의 클래스는 접근 가능 하다.
2. 다른 패키지의 클래스는 ***1) public 클래스***이거나 ***2) forName 메서드를 이용한 동적 바인딩***의 경우 접근가능하다.
3. 다른 프로젝트의 클래스는 접근 불가하다.

```java
public class ClassTest {

	public static void main(String[] args) throws ClassNotFoundException, InstantiationException, IllegalAccessException, NoSuchMethodException, SecurityException, IllegalArgumentException, InvocationTargetException {
		
		Class c2 = classex.Person.class; 	// 같은 패키지의 클래스, 접근 가능
		Class c3 = Person.class;			    // 같은 패키지의 클래스, 패키지 명을 붙이지 않아도 접근 가능
		
		
		Class c4 = Class.forName("object.Book"); 		// 다른 패키지에 있는 default 클래스, 접근 가능, 패키지 명 포함 필수
		Class c5 = object.Book.class;    		 				// 다른 패키지에 있는 default 클래스, 접근 불가
		Class c6 = object.ToStringTest.class;    		// 다른 패키지에 있는 public 클래스, 접근 가능, 패키지 명 포함 필수
	
		Class c7 = collection.Member.class;		 					// 다른 프로젝트, 패키지에 있는 클래스, 접근 불가
		Class c8 = Class.forName("collection.Member");  // 다른 프로젝트, 패키지에 있는 클래스, 접근 불가
		
	}

}
```

- 위 코드에서 사용한 프로젝트, 패키지 구조는 아래와 같다.

*![1](../assets/images/23-03-21-class-class/1.png)*



### reflection 프로그래밍

- Class 클래스로부터 클래스의 정보를 가져와 프로그래밍하는 방식
- 로컬에서 정의하지 않아 식별하기 어려운 클래스의 정보를 알고 싶을 때 유용하다.
- java.lang.reflect 패키지의 클래스 활용

```java

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

public class StringClassTest {

	public static void main(String[] args) throws ClassNotFoundException {
		
		Class c3 = Class.forName("java.lang.String");
		
		Constructor[] cons = c3.getConstructors(); // 해당 클래스의 생성자를 가져온다
		
		for(Constructor con: cons) {
			System.out.println(con);		
		}
		
		System.out.println();
		
		Method[] methods = c3.getMethods();		// 해당 클래스의 메서드를 가져온다
		for(Method method : methods) {
			System.out.println(method);
		}
		
 	}
}

-----------------

public java.lang.String(java.lang.StringBuffer)
public java.lang.String(java.lang.StringBuilder)
public java.lang.String(byte[],int,int,java.nio.charset.Charset)
public java.lang.String(byte[],java.lang.String) throws java.io.UnsupportedEncodingException
public java.lang.String(byte[],java.nio.charset.Charset)
public java.lang.String(byte[],int,int)
public java.lang.String(byte[])
public java.lang.String(char[],int,int)
public java.lang.String(char[])
public java.lang.String(java.lang.String)
public java.lang.String()
public java.lang.String(byte[],int,int,java.lang.String) throws java.io.UnsupportedEncodingException
public java.lang.String(byte[],int)
public java.lang.String(byte[],int,int,int)
public java.lang.String(int[],int,int)

public boolean java.lang.String.equals(java.lang.Object)
public int java.lang.String.length()
public java.lang.String java.lang.String.toString()
public int java.lang.String.hashCode()
public void java.lang.String.getChars(int,int,char[],int)
public int java.lang.String.compareTo(java.lang.String)
public int java.lang.String.compareTo(java.lang.Object)
public int java.lang.String.indexOf(int)
public int java.lang.String.indexOf(java.lang.String)
public int java.lang.String.indexOf(java.lang.String,int)
public int java.lang.String.indexOf(int,int)
public static java.lang.String java.lang.String.valueOf(int)
public static java.lang.String java.lang.String.valueOf(char[])
public static java.lang.String java.lang.String.valueOf(java.lang.Object)
public static java.lang.String java.lang.String.valueOf(boolean)
public static java.lang.String java.lang.String.valueOf(char[],int,int)
public static java.lang.String java.lang.String.valueOf(char)
public static java.lang.String java.lang.String.valueOf(double)
public static java.lang.String java.lang.String.valueOf(float)
public static java.lang.String java.lang.String.valueOf(long)
public char java.lang.String.charAt(int)
public int java.lang.String.codePointAt(int)
public int java.lang.String.codePointBefore(int)
public int java.lang.String.codePointCount(int,int)
public int java.lang.String.offsetByCodePoints(int,int)
public byte[] java.lang.String.getBytes(java.nio.charset.Charset)
public byte[] java.lang.String.getBytes(java.lang.String) throws java.io.UnsupportedEncodingException
public void java.lang.String.getBytes(int,int,byte[],int)
public byte[] java.lang.String.getBytes()
public boolean java.lang.String.contentEquals(java.lang.CharSequence)
public boolean java.lang.String.contentEquals(java.lang.StringBuffer)
public boolean java.lang.String.regionMatches(boolean,int,java.lang.String,int,int)
public boolean java.lang.String.regionMatches(int,java.lang.String,int,int)
public boolean java.lang.String.startsWith(java.lang.String,int)
public boolean java.lang.String.startsWith(java.lang.String)
public int java.lang.String.lastIndexOf(java.lang.String)
public int java.lang.String.lastIndexOf(java.lang.String,int)
public int java.lang.String.lastIndexOf(int,int)
public int java.lang.String.lastIndexOf(int)
public java.lang.String java.lang.String.substring(int,int)
public java.lang.String java.lang.String.substring(int)
public boolean java.lang.String.isEmpty()
public java.lang.String java.lang.String.replace(char,char)
public java.lang.String java.lang.String.replace(java.lang.CharSequence,java.lang.CharSequence)
public boolean java.lang.String.matches(java.lang.String)
public java.lang.String java.lang.String.replaceFirst(java.lang.String,java.lang.String)
public java.lang.String java.lang.String.replaceAll(java.lang.String,java.lang.String)
public java.lang.String[] java.lang.String.split(java.lang.String)
public java.lang.String[] java.lang.String.split(java.lang.String,int)
public static java.lang.String java.lang.String.join(java.lang.CharSequence,java.lang.CharSequence[])
public static java.lang.String java.lang.String.join(java.lang.CharSequence,java.lang.Iterable)
public java.lang.String java.lang.String.toLowerCase()
public java.lang.String java.lang.String.toLowerCase(java.util.Locale)
public java.lang.String java.lang.String.toUpperCase()
public java.lang.String java.lang.String.toUpperCase(java.util.Locale)
public java.lang.String java.lang.String.trim()
public java.lang.String java.lang.String.strip()
public java.lang.String java.lang.String.stripLeading()
public java.lang.String java.lang.String.stripTrailing()
public java.util.stream.Stream java.lang.String.lines()
public java.lang.String java.lang.String.repeat(int)
public boolean java.lang.String.isBlank()
public char[] java.lang.String.toCharArray()
public static java.lang.String java.lang.String.format(java.lang.String,java.lang.Object[])
public static java.lang.String java.lang.String.format(java.util.Locale,java.lang.String,java.lang.Object[])
public java.lang.Object java.lang.String.resolveConstantDesc(java.lang.invoke.MethodHandles$Lookup) throws java.lang.ReflectiveOperationException
public java.lang.String java.lang.String.resolveConstantDesc(java.lang.invoke.MethodHandles$Lookup)
public java.util.stream.IntStream java.lang.String.codePoints()
public boolean java.lang.String.equalsIgnoreCase(java.lang.String)
public int java.lang.String.compareToIgnoreCase(java.lang.String)
public boolean java.lang.String.endsWith(java.lang.String)
public java.lang.CharSequence java.lang.String.subSequence(int,int)
public java.lang.String java.lang.String.concat(java.lang.String)
public boolean java.lang.String.contains(java.lang.CharSequence)
public java.lang.String java.lang.String.indent(int)
public java.lang.String java.lang.String.stripIndent()
public java.lang.String java.lang.String.translateEscapes()
public java.util.stream.IntStream java.lang.String.chars()
public java.lang.Object java.lang.String.transform(java.util.function.Function)
public java.lang.String java.lang.String.formatted(java.lang.Object[])
public static java.lang.String java.lang.String.copyValueOf(char[],int,int)
public static java.lang.String java.lang.String.copyValueOf(char[])
public native java.lang.String java.lang.String.intern()
public java.util.Optional java.lang.String.describeConstable()
public final void java.lang.Object.wait(long,int) throws java.lang.InterruptedException
public final void java.lang.Object.wait() throws java.lang.InterruptedException
public final native void java.lang.Object.wait(long) throws java.lang.InterruptedException
public final native java.lang.Class java.lang.Object.getClass()
public final native void java.lang.Object.notify()
public final native void java.lang.Object.notifyAll()
```



### newInstance()

- Class 클래스의 메서드로 new 키워드를 사용하지 않아도 클래스의 생성자를 호출하여 인스턴스를 생성할 수 있다.
- 리턴 타입은 Object
- Java9 이후로 deprecated

![2](../assets/images/23-03-21-class-class/2.png)

```java
package classex;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;

public class ClassTest {

	public static void main(String[] args) throws ClassNotFoundException, InstantiationException, IllegalAccessException, NoSuchMethodException, SecurityException, IllegalArgumentException, InvocationTargetException {
		
		Class c1 = Class.forName("classex.Person");
		Person person1 = (Person)c1.newInstance(); 	// default 생성자 호출
    
		// 파라미터 1개 이상 가지는 생성자 호출 -> Constructor 객체에서 newInstance 호출
		Class[] parameterTypes = {String.class};
		Constructor cons = c1.getConstructor(parameterTypes);
		Object[] initargs = {"kim"};
		Person lee = (Person)cons.newInstance(initargs);
  }
}
		
```







#  Conclusion

---

Java의 Class class는 생소한 개념이었는데 외부 클래스 파일을 사용해야 할 때나 동적으로 클래스를 import해야 할 일이 있을 때 유용하게 사용할 수 있어 보인다.



# Reference

---

Fastcampus JAVA기초 강의 - 박은종 강사님
