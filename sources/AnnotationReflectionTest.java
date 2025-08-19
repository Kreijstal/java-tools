import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@interface CustomAnnotation {
    String value() default "default";
    int number() default 42;
}

public class AnnotationReflectionTest {
    @CustomAnnotation(value = "field", number = 10)
    private String annotatedField = "test";
    
    public static void main(String[] args) {
        System.out.println("=== Annotation Reflection Test ===");
        
        try {
            Class<?> clazz = AnnotationReflectionTest.class;
            
            // Test 1: Class annotations
            System.out.println("Class annotations:");
            if (clazz.isAnnotationPresent(CustomAnnotation.class)) {
                CustomAnnotation annotation = clazz.getAnnotation(CustomAnnotation.class);
                System.out.println("Class annotation: " + annotation.value() + ", " + annotation.number());
            } else {
                System.out.println("No class annotation found");
            }
            
            // Test 2: Field annotations
            System.out.println("Field annotations:");
            Field field = clazz.getDeclaredField("annotatedField");
            if (field.isAnnotationPresent(CustomAnnotation.class)) {
                CustomAnnotation annotation = field.getAnnotation(CustomAnnotation.class);
                System.out.println("Field annotation: " + annotation.value() + ", " + annotation.number());
            }
            
            // Test 3: Method annotations
            System.out.println("Method annotations:");
            Method method = clazz.getDeclaredMethod("annotatedMethod", String.class);
            if (method.isAnnotationPresent(CustomAnnotation.class)) {
                CustomAnnotation annotation = method.getAnnotation(CustomAnnotation.class);
                System.out.println("Method annotation: " + annotation.value() + ", " + annotation.number());
            }
            
            // Test 4: Invoke annotated method
            AnnotationReflectionTest instance = new AnnotationReflectionTest();
            String result = (String) method.invoke(instance, "test");
            System.out.println("Method result: " + result);
            
            // Test 5: Field access with different modifiers
            System.out.println("Field modifiers:");
            int modifiers = field.getModifiers();
            System.out.println("Is private: " + Modifier.isPrivate(modifiers));
            System.out.println("Is static: " + Modifier.isStatic(modifiers));
            
        } catch (Exception e) {
            System.out.println("Error: " + e.getMessage());
            e.printStackTrace();
        }
    }
    
    @CustomAnnotation(value = "method", number = 99)
    private String annotatedMethod(String input) {
        return "Processed: " + input;
    }
}