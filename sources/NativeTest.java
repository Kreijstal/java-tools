// Simple test class that demonstrates native method calls
public class NativeTest {
    
    // Declare native methods (these will be implemented in JavaScript)
    public static native int nativeAdd(int a, int b);
    public static native String nativeGreeting(String name);
    public static native boolean nativeIsPrime(int n);
    
    public static void main(String[] args) {
        System.out.println("=== Native Method Test ===");
        
        // Test native addition
        int result1 = nativeAdd(5, 3);
        System.out.println("nativeAdd(5, 3) = " + result1);
        
        // Test native string operation
        String greeting = nativeGreeting("World");
        System.out.println("nativeGreeting(\"World\") = " + greeting);
        
        // Test native prime check
        boolean isPrime = nativeIsPrime(17);
        System.out.println("nativeIsPrime(17) = " + isPrime);
        
        System.out.println("=== Test Complete ===");
    }
}