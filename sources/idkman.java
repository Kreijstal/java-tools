import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.reflect.Method;

// 1. Define a custom annotation
@Retention(RetentionPolicy.RUNTIME)
@interface MyAnnotation {
    String value();
}

// 2. Apply the annotation to a class
@MyAnnotation("Hello from annotation!")
class AnnotatedClass {
    public void myMethod() {
        // a simple method
    }
}

// 3. The main class to run the test
public class idkman {
    public static void main(String[] args) {
        System.out.println("=== Reflection Crash Test ===");

        Class<AnnotatedClass> clazz = AnnotatedClass.class;

        // This is the call that should fail in runJvm
        MyAnnotation annotation = clazz.getAnnotation(MyAnnotation.class);

        if (annotation != null) {
            System.out.println("Annotation found!");
            System.out.println("Value: " + annotation.value());
        } else {
            System.out.println("Annotation not found!");
        }

        System.out.println("Test completed successfully.");
    }
}
