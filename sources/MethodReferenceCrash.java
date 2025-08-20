import java.util.function.Function;

public class MethodReferenceCrash {
    public static String reverse(String s) {
        return new StringBuilder(s).reverse().toString();
    }

    public static void main(String[] args) {
        Function<String, String> reverser = MethodReferenceCrash::reverse;
        String reversed = reverser.apply("Hello");
        System.out.println(reversed);
    }
}
