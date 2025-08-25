public class MethodInvocationValidationTest {
    
    // Static method - should work with invokestatic only
    public static int staticAdd(int a, int b) {
        return a + b;
    }
    
    // Instance method - should work with invokevirtual only
    public int instanceMultiply(int a, int b) {
        return a * b;
    }
    
    public static void main(String[] args) {
        System.out.println("Testing method invocation validation");
        
        // This should work - proper static call
        int result1 = staticAdd(5, 3);
        System.out.println("Static method result: " + result1);
        
        // This should work - proper instance call
        MethodInvocationValidationTest obj = new MethodInvocationValidationTest();
        int result2 = obj.instanceMultiply(5, 3);
        System.out.println("Instance method result: " + result2);
        
        System.out.println("All validations passed");
    }
}