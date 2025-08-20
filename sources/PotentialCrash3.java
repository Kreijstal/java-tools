public class PotentialCrash3 {
    public static void main(String[] args) {
        testTypeConversions();
        testComparisonInstructions();
        testExceptionHandling();
    }
    
    public static void testTypeConversions() {
        // Test various type conversions
        int i = 42;
        long l = i;  // i2l
        float f = i; // i2f
        double d = i; // i2d
        
        l = 12345678901L;
        i = (int)l;  // l2i
        f = l;       // l2f
        d = l;       // l2d
        
        f = 3.14f;
        i = (int)f;  // f2i
        l = (long)f; // f2l
        d = f;       // f2d
        
        d = 2.718;
        i = (int)d;  // d2i
        l = (long)d; // d2l
        f = (float)d; // d2f
        
        System.out.println("Type conversion test completed");
    }
    
    public static void testComparisonInstructions() {
        // Test comparison instructions that might be missing
        long l1 = 100L, l2 = 200L;
        if (l1 < l2) System.out.println("lcmp works");
        
        float f1 = 1.0f, f2 = Float.NaN;
        if (f1 < f2) System.out.println("fcmpl case 1");
        if (f2 > f1) System.out.println("fcmpg case 1");
        
        double d1 = 1.0, d2 = Double.NaN;
        if (d1 < d2) System.out.println("dcmpl case 1");
        if (d2 > d1) System.out.println("dcmpg case 1");
    }
    
    public static void testExceptionHandling() {
        try {
            // Test athrow instruction
            throw new RuntimeException("Test exception");
        } catch (RuntimeException e) {
            System.out.println("Caught: " + e.getMessage());
        }
        
        // Test checkcast
        Object obj = "Hello";
        String str = (String) obj;
        System.out.println("Checkcast works: " + str);
        
        // Test instanceof
        if (obj instanceof String) {
            System.out.println("instanceof works");
        }
    }
}