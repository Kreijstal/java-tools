public class NestedClassPrivateAccessTest {
    private static int staticPrivateField = 42;
    private int instancePrivateField = 99;
    
    // Private method
    private static String staticPrivateMethod(String input) {
        return "Private static: " + input;
    }
    
    private String instancePrivateMethod(int value) {
        return "Private instance: " + value;
    }
    
    // Nested static class accessing outer private members
    static class StaticNestedClass {
        public void testAccess() {
            System.out.println("Static nested accessing static private field: " + staticPrivateField);
            System.out.println("Static nested calling static private method: " + staticPrivateMethod("test"));
            
            // Create instance to access instance members
            NestedClassPrivateAccessTest outer = new NestedClassPrivateAccessTest();
            System.out.println("Static nested accessing instance private field: " + outer.instancePrivateField);
            System.out.println("Static nested calling instance private method: " + outer.instancePrivateMethod(123));
        }
    }
    
    // Inner class accessing outer private members
    class InnerClass {
        public void testAccess() {
            System.out.println("Inner class accessing static private field: " + staticPrivateField);
            System.out.println("Inner class accessing instance private field: " + instancePrivateField);
            System.out.println("Inner class calling static private method: " + staticPrivateMethod("inner"));
            System.out.println("Inner class calling instance private method: " + instancePrivateMethod(456));
        }
    }
    
    public static void main(String[] args) {
        System.out.println("=== Nested Class Private Access Test ===");
        
        // Test static nested class
        System.out.println("Testing static nested class:");
        StaticNestedClass nested = new StaticNestedClass();
        nested.testAccess();
        
        System.out.println();
        
        // Test inner class
        System.out.println("Testing inner class:");
        NestedClassPrivateAccessTest outer = new NestedClassPrivateAccessTest();
        InnerClass inner = outer.new InnerClass();
        inner.testAccess();
    }
}