public class MultiCatchTest {
    public static void main(String[] args) {
        System.out.println("=== Multi-Catch Exception Test ===");
        
        // Test 1: Multi-catch with different exception types
        testMultiCatch(1); // ArithmeticException
        testMultiCatch(2); // ArrayIndexOutOfBoundsException  
        testMultiCatch(3); // NullPointerException
        testMultiCatch(4); // No exception
    }
    
    public static void testMultiCatch(int testCase) {
        System.out.println("Test case " + testCase + ":");
        
        try {
            switch (testCase) {
                case 1:
                    int result = 10 / 0; // ArithmeticException
                    break;
                case 2:
                    int[] arr = {1, 2, 3};
                    int value = arr[10]; // ArrayIndexOutOfBoundsException
                    break;
                case 3:
                    String str = null;
                    int length = str.length(); // NullPointerException
                    break;
                default:
                    System.out.println("Normal execution - no exception");
            }
        } catch (ArithmeticException | ArrayIndexOutOfBoundsException | NullPointerException e) {
            System.out.println("Caught multi-catch exception: " + e.getClass().getSimpleName());
            System.out.println("Message: " + e.getMessage());
        } catch (Exception e) {
            System.out.println("Caught general exception: " + e.getMessage());
        } finally {
            System.out.println("Finally block executed for test case " + testCase);
        }
        
        System.out.println();
    }
    
    // Test rethrow with more precise exception type
    public static void testRethrow() throws ArithmeticException, ArrayIndexOutOfBoundsException {
        try {
            // Some operation that might throw multiple exception types
            throw new ArithmeticException("Division by zero");
        } catch (ArithmeticException | ArrayIndexOutOfBoundsException e) {
            System.out.println("Rethrowing: " + e.getMessage());
            throw e; // Precise rethrow
        }
    }
}