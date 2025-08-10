public class RuntimeArithmetic {
    public static int add(int a, int b) {
        return a + b;  // Tests iadd at runtime
    }
    
    public static int subtract(int a, int b) {
        return a - b;  // Tests isub at runtime
    }
    
    public static int multiply(int a, int b) {
        return a * b;  // Tests imul at runtime
    }
    
    public static void main(String[] args) {
        System.out.println(add(3, 2));      // 5
        System.out.println(subtract(3, 1)); // 2
        System.out.println(multiply(2, 3)); // 6
    }
}