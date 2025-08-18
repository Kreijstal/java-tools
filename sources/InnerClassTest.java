public class InnerClassTest {
    private int outerField = 42;
    private static int staticOuterField = 100;
    
    public static void main(String[] args) {
        System.out.println("=== Inner Class Test ===");
        
        InnerClassTest outer = new InnerClassTest();
        
        // Test non-static inner class
        InnerClassTest.InnerClass inner = outer.new InnerClass();
        inner.printValues();
        
        // Test static nested class
        StaticNestedClass nested = new StaticNestedClass();
        nested.printValue();
        
        // Test local inner class
        outer.testLocalInnerClass();
        
        // Test anonymous inner class
        outer.testAnonymousInnerClass();
    }
    
    // Non-static inner class
    class InnerClass {
        private int innerField = 10;
        
        public void printValues() {
            System.out.println("Inner field: " + innerField);
            System.out.println("Outer field: " + outerField);
            System.out.println("Static outer field: " + staticOuterField);
        }
    }
    
    // Static nested class
    static class StaticNestedClass {
        private int nestedField = 20;
        
        public void printValue() {
            System.out.println("Nested field: " + nestedField);
            System.out.println("Static outer field: " + staticOuterField);
            // Cannot access non-static outerField from static context
        }
    }
    
    // Method with local inner class
    public void testLocalInnerClass() {
        System.out.println("=== Local Inner Class ===");
        final int localVar = 30;
        
        class LocalInnerClass {
            public void printValue() {
                System.out.println("Local variable: " + localVar);
                System.out.println("Outer field: " + outerField);
            }
        }
        
        LocalInnerClass local = new LocalInnerClass();
        local.printValue();
    }
    
    // Method with anonymous inner class
    public void testAnonymousInnerClass() {
        System.out.println("=== Anonymous Inner Class ===");
        
        Runnable runnable = new Runnable() {
            @Override
            public void run() {
                System.out.println("Anonymous inner class running");
                System.out.println("Outer field: " + outerField);
            }
        };
        
        runnable.run();
    }
}