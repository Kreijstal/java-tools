import java.lang.reflect.Method;

class Target {
    public static int staticMethod() {
        return 42;
    }

    public int instanceMethod() {
        return 100;
    }

    public void printMethod(String message) {
        System.out.println(message);
    }
}

public class ReflectionTest {
    public static void main(String[] args) throws Exception {
        Class<?> targetClass = Target.class;
        System.out.println(targetClass.getName());

        Method[] methods = targetClass.getMethods();
        System.out.println("Got methods array");
        for (Method method : methods) {
            System.out.println(method.getName());
            if (method.getName().equals("staticMethod")) {
                Object result = method.invoke(null);
                System.out.println(result);
            }

            if (method.getName().equals("instanceMethod")) {
                Target instance = new Target();
                Object result = method.invoke(instance);
                System.out.println(result);
            }

            if (method.getName().equals("printMethod")) {
                Target instance = new Target();
                method.invoke(instance, "Hello Reflection!");
            }
        }
    }
}
