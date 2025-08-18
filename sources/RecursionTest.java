public class RecursionTest {
    public static void main(String[] args) {
        System.out.println("Testing recursion without static fields...");
        int result = factorial(5);
        System.out.println("5! = " + result);
    }
    
    public static int factorial(int n) {
        if (n <= 1) {
            return 1;
        }
        return n * factorial(n - 1);
    }
}