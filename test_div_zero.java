public class DivisionByZeroTest {
    public static void main(String[] args) {
        int a = 10;
        int b = 0;
        int result = a / b; // This should cause division by zero
        System.out.println(result);
    }
}