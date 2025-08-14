public class SimpleReflectionTest {
    public static void main(String[] args) throws Exception {
        Class<?> targetClass = SimpleTarget.class;
        java.lang.reflect.Method method = targetClass.getMethod("simpleStaticMethod");
        Object result = method.invoke(null);
        System.out.println(result);
    }
}
