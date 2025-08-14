import java.lang.reflect.Method;

public class ReflectionTest {
    public static void main(String[] args) throws Exception {
        MyClass obj = new MyClass();
        Method method = obj.getClass().getMethod("myMethod", String.class);
        String result = (String) method.invoke(obj, "World");
        System.out.println(result);
    }
}

class MyClass {
    public String myMethod(String name) {
        return "Hello, " + name + "!";
    }
}
