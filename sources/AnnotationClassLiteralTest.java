import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@interface WithClassAndEnum {
    Class<?> type();
    Level level();
}

enum Level {
    LOW,
    HIGH
}

@WithClassAndEnum(type = String.class, level = Level.HIGH)
public class AnnotationClassLiteralTest {
    public static void main(String[] args) {
        WithClassAndEnum annotation = AnnotationClassLiteralTest.class.getAnnotation(WithClassAndEnum.class);
        if (annotation == null) {
            System.out.println("Annotation not found");
            return;
        }

        System.out.println("=== Annotation Class Literal Test ===");
        System.out.println("Type: " + annotation.type().getName());
        System.out.println("Level: " + annotation.level());
    }
}
