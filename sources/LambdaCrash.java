// LambdaCrash.java
import java.util.function.Function;

public class LambdaCrash {
    public static void main(String[] args) {
        Function<String, String> hello = (name) -> "Hello, " + name;
        System.out.println(hello.apply("World"));
    }
}
