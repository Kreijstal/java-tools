// sources/ReflectionCrashTest.java
import java.lang.reflect.Method;

class ReflectionTarget {
    private String privateMethod() {
        return "Hello from private method!";
    }
}

public class ReflectionCrashTest {
    public static void main(String[] args) {
        System.out.println("Testing reflection on private methods...");
        try {
            ReflectionTarget target = new ReflectionTarget();
            Method method = ReflectionTarget.class.getDeclaredMethod("privateMethod");
            method.setAccessible(true); // This is key to accessing private methods
            String result = (String) method.invoke(target);
            System.out.println("Reflection result: " + result);
        } catch (Exception e) {
            System.out.println("Reflection test failed: " + e);
            e.printStackTrace();
        }
    }
}
