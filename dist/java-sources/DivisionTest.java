public class DivisionTest {
    public static int divide(int a, int b) {
        return a / b;  // Tests idiv at runtime
    }
    
    public static int remainder(int a, int b) {
        return a % b;  // Tests irem at runtime
    }
    
    public static void main(String[] args) {
        System.out.println(divide(10, 3));    // 3 (integer division)
        System.out.println(remainder(10, 3)); // 1 (remainder)
        System.out.println(divide(15, 5));    // 3
        System.out.println(remainder(15, 5)); // 0
    }
}