// Test specific features that were fixed
public class FixedFeaturesTest {
    public static void main(String[] args) {
        System.out.println("=== Testing Fixed JVM Features ===");
        
        // Test 1: ifle instruction (if less than or equal)
        testIfleInstruction();
        
        // Test 2: Primitive autoboxing 
        testAutoboxing();
        
        // Test 3: getClass() on wrapper objects
        testGetClass();
        
        // Test 4: Basic exception handling improvements
        testExceptions();
    }
    
    public static void testIfleInstruction() {
        System.out.println("--- ifle instruction test ---");
        int[] numbers = {-1, 0, 1, 2};
        for (int num : numbers) {
            if (num <= 0) {
                System.out.println(num + " is <= 0");
            } else {
                System.out.println(num + " is > 0");
            }
        }
    }
    
    public static void testAutoboxing() {
        System.out.println("--- Autoboxing test ---");
        processObject(42);        // int -> Integer
        processObject(3.14);      // double -> Double  
        processObject(true);      // boolean -> Boolean
        processObject("hello");   // String (already object)
    }
    
    public static void processObject(Object obj) {
        System.out.println("Received: " + obj + " (type: " + obj.getClass().getSimpleName() + ")");
    }
    
    public static void testGetClass() {
        System.out.println("--- getClass() test ---");
        Integer i = 100;
        Double d = 2.5;
        Boolean b = false;
        String s = "test";
        
        System.out.println("Integer class: " + i.getClass().getSimpleName());
        System.out.println("Double class: " + d.getClass().getSimpleName());
        System.out.println("Boolean class: " + b.getClass().getSimpleName());
        System.out.println("String class: " + s.getClass().getSimpleName());
    }
    
    public static void testExceptions() {
        System.out.println("--- Exception handling test ---");
        
        // Test NullPointerException
        try {
            String str = null;
            str.length();
        } catch (NullPointerException e) {
            System.out.println("Caught NPE: " + e.getClass().getSimpleName());
        }
        
        // Test ArithmeticException  
        try {
            int result = 10 / 0;
        } catch (ArithmeticException e) {
            System.out.println("Caught ArithmeticException: " + e.getClass().getSimpleName());
        }
    }
}