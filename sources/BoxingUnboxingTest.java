public class BoxingUnboxingTest {
    public static void main(String[] args) {
        System.out.println("=== Boxing/Unboxing Test ===");
        
        // Test autoboxing - primitive to wrapper
        Integer i = 42; // autoboxing int to Integer
        System.out.println("Autoboxed Integer: " + i);
        
        // Test unboxing - wrapper to primitive  
        int j = i; // unboxing Integer to int
        System.out.println("Unboxed int: " + j);
        
        // Test with method calls
        System.out.println("=== Method Call Boxing ===");
        testIntegerMethod(100); // autoboxing
        testIntMethod(new Integer(200)); // unboxing
        
        // Test arithmetic with boxed types
        System.out.println("=== Arithmetic with Boxed Types ===");
        Integer a = 10;
        Integer b = 20;
        Integer c = a + b; // Should unbox, add, then box again
        System.out.println("10 + 20 = " + c);
        
        // Test null unboxing (should throw NullPointerException)
        System.out.println("=== Null Unboxing Test ===");
        try {
            Integer nullInt = null;
            int primitive = nullInt; // Should throw NPE
            System.out.println("This should not print: " + primitive);
        } catch (NullPointerException e) {
            System.out.println("Caught expected NPE during unboxing");
        }
    }
    
    public static void testIntegerMethod(Integer param) {
        System.out.println("Integer method received: " + param);
    }
    
    public static void testIntMethod(int param) {
        System.out.println("int method received: " + param);
    }
}