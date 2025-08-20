public class ComparisonInstructions {
    public static void main(String[] args) {
        testLongComparisons();
        testFloatComparisons();
        testDoubleComparisons();
    }
    
    public static void testLongComparisons() {
        long a = 100L;
        long b = 200L;
        long c = 100L;
        
        // Test lcmp instruction
        if (a < b) System.out.println("100 < 200");
        if (a > b) System.out.println("This should not print");
        if (a == c) System.out.println("100 == 100");
    }
    
    public static void testFloatComparisons() {
        float f1 = 1.5f;
        float f2 = 2.5f;
        float nan = Float.NaN;
        
        // Test fcmpl and fcmpg instructions
        if (f1 < f2) System.out.println("1.5 < 2.5");
        if (f1 > f2) System.out.println("This should not print");
        if (f1 < nan) System.out.println("This should not print (NaN)");
        if (nan > f1) System.out.println("This should not print (NaN)");
        if (f1 != nan) System.out.println("1.5 != NaN");
    }
    
    public static void testDoubleComparisons() {
        double d1 = 1.5;
        double d2 = 2.5;
        double nan = Double.NaN;
        
        // Test dcmpl and dcmpg instructions
        if (d1 < d2) System.out.println("1.5 < 2.5 (double)");
        if (d1 > d2) System.out.println("This should not print");
        if (d1 < nan) System.out.println("This should not print (NaN)");
        if (nan > d1) System.out.println("This should not print (NaN)");
        if (d1 != nan) System.out.println("1.5 != NaN (double)");
    }
}