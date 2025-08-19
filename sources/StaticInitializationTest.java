public class StaticInitializationTest {
    // Static fields with different initialization orders
    public static final String CONSTANT1 = "First constant";
    public static int counter = 0;
    public static String dynamicValue;
    
    // Static initialization block 1
    static {
        System.out.println("Static block 1 executed");
        counter += 10;
        dynamicValue = "Initialized in static block 1";
    }
    
    // Another static field
    public static final String CONSTANT2 = initializeConstant2();
    
    // Static initialization block 2
    static {
        System.out.println("Static block 2 executed");
        counter += 20;
        dynamicValue += " and modified in static block 2";
    }
    
    // Instance field initialization
    private String instanceField = "Instance field: " + CONSTANT1;
    
    // Instance initialization block
    {
        System.out.println("Instance initialization block executed");
        instanceField += " (modified in instance block)";
    }
    
    // Constructor
    public StaticInitializationTest() {
        System.out.println("Constructor executed");
        instanceField += " (modified in constructor)";
    }
    
    public static void main(String[] args) {
        System.out.println("=== Static Initialization Order Test ===");
        
        // Access static fields to trigger class loading
        System.out.println("CONSTANT1: " + CONSTANT1);
        System.out.println("Counter after static blocks: " + counter);
        System.out.println("Dynamic value: " + dynamicValue);
        System.out.println("CONSTANT2: " + CONSTANT2);
        
        System.out.println("Creating first instance...");
        StaticInitializationTest instance1 = new StaticInitializationTest();
        System.out.println("Instance field: " + instance1.instanceField);
        
        System.out.println("Creating second instance...");
        StaticInitializationTest instance2 = new StaticInitializationTest();
        System.out.println("Instance field: " + instance2.instanceField);
        
        // Test static method access
        System.out.println("Calling static method...");
        staticMethod();
    }
    
    // Static method that initializes CONSTANT2
    private static String initializeConstant2() {
        System.out.println("Initializing CONSTANT2");
        counter += 5;
        return "Second constant (counter was " + counter + ")";
    }
    
    public static void staticMethod() {
        System.out.println("Static method called, counter = " + counter);
    }
}