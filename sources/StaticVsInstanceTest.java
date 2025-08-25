public class StaticVsInstanceTest {
    
    // Static method - should work with invokestatic
    public static int staticMethod(int a, int b) {
        return a + b;
    }
    
    // Instance method - should NOT work with invokestatic
    public int instanceMethod(int a, int b) {
        return a * b;
    }
    
    public static void main(String[] args) {
        System.out.println("Testing static vs instance methods");
        
        // This should work - calling static method normally
        int result1 = staticMethod(5, 3);
        System.out.println("Static method result: " + result1);
        
        // This should work - calling instance method normally
        StaticVsInstanceTest obj = new StaticVsInstanceTest();
        int result2 = obj.instanceMethod(5, 3);
        System.out.println("Instance method result: " + result2);
    }
}