public class SmallDivisionTest {
    public static int divide(int a, int b) {
        return a / b;  // Tests idiv at runtime
    }
    
    public static int remainder(int a, int b) {
        return a % b;  // Tests irem at runtime
    }
    
    public static void main(String[] args) {
        System.out.println(divide(5, 2));    // 2 (integer division)
        System.out.println(remainder(5, 2)); // 1 (remainder)
        System.out.println(divide(4, 2));    // 2
        System.out.println(remainder(4, 2)); // 0
    }
}