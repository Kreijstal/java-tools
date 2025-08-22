public class HexFloatLiteralsTest {
    public static void main(String[] args) {
        System.out.println("=== Hexadecimal Float Literals Test ===");
        
        // Basic hexadecimal float literals (Java 5+)
        double hex1 = 0x1.0p0;     // 1.0
        double hex2 = 0x1.8p0;     // 1.5
        double hex3 = 0x1.0p1;     // 2.0
        double hex4 = 0x1.0p-1;    // 0.5
        
        System.out.println("0x1.0p0 = " + hex1);
        System.out.println("0x1.8p0 = " + hex2);
        System.out.println("0x1.0p1 = " + hex3);
        System.out.println("0x1.0p-1 = " + hex4);
        
        // More complex examples
        double hexPi = 0x1.921fb54442d18p1;  // Approximation of PI
        double hexE = 0x1.5bf0a8b145769p1;   // Approximation of E
        
        System.out.println("Hex Pi approximation: " + hexPi);
        System.out.println("Hex E approximation: " + hexE);
        System.out.println("Math.PI: " + Math.PI);
        System.out.println("Math.E: " + Math.E);
        
        // Float variants
        float hexFloat = 0x1.0p0f;
        System.out.println("Hex float: " + hexFloat);
        
        // Extreme values
        double maxValue = 0x1.fffffffffffffp1023;  // Close to Double.MAX_VALUE
        double minValue = 0x1.0p-1022;             // Close to Double.MIN_NORMAL
        double minSubnormal = 0x0.0000000000001p-1022; // MIN_VALUE
        
        System.out.println("Max value (hex): " + maxValue);
        System.out.println("Double.MAX_VALUE: " + Double.MAX_VALUE);
        System.out.println("Min normal (hex): " + minValue);
        System.out.println("Double.MIN_NORMAL: " + Double.MIN_NORMAL);
        System.out.println("Min subnormal (hex): " + minSubnormal);
        System.out.println("Double.MIN_VALUE: " + Double.MIN_VALUE);
        
        // Special values  
        double hexInf = Double.POSITIVE_INFINITY;    // Use constant instead
        double hexNegInf = Double.NEGATIVE_INFINITY;
        double hexNaN = Double.NaN; // Use constant instead
        
        System.out.println("Positive infinity: " + hexInf);
        System.out.println("Is positive infinite: " + Double.isInfinite(hexInf));
        System.out.println("Negative infinity: " + hexNegInf);
        System.out.println("Is negative infinite: " + Double.isInfinite(hexNegInf));
        System.out.println("NaN: " + hexNaN);
        System.out.println("Is NaN: " + Double.isNaN(hexNaN));
    }
}