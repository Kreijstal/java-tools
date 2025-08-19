public class DoubleComparisonTest {
    public static void main(String[] args) {
        System.out.println("=== Double Comparison Test ===");
        
        double d1 = 3.14159;
        double d2 = 2.71828;
        double d3 = 3.14159; // Equal to d1
        double nan = Double.NaN;
        
        // Test dcmpl instruction (NaN bias towards -1)
        if (d1 > d2) {
            System.out.println("d1 > d2: true");
        } else {
            System.out.println("d1 > d2: false"); 
        }
        
        if (d1 < d2) {
            System.out.println("d1 < d2: true");
        } else {
            System.out.println("d1 < d2: false");
        }
        
        if (d1 == d3) {
            System.out.println("d1 == d3: true");
        } else {
            System.out.println("d1 == d3: false");
        }
        
        // Test NaN comparisons
        if (nan > d1) {
            System.out.println("NaN > d1: true");
        } else {
            System.out.println("NaN > d1: false");
        }
        
        if (nan < d1) {
            System.out.println("NaN < d1: true");
        } else {
            System.out.println("NaN < d1: false");
        }
        
        if (nan == nan) {
            System.out.println("NaN == NaN: true");
        } else {
            System.out.println("NaN == NaN: false");
        }
        
        System.out.println("Test completed successfully!");
    }
}