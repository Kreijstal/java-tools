// This file tests lambda expressions, which use the 'invokedynamic' instruction.
// This used to crash the JVM, but it is now fixed.
import java.util.function.Function;

public class LambdaCrash {
    public static void main(String[] args) {
        System.out.println("This test demonstrates lambda expressions ('invokedynamic').");
        Function<String, String> hello = (name) -> "Hello, " + name;
        System.out.println(hello.apply("World"));
        System.out.println("Lambda expressions are working correctly.");
    }
}
