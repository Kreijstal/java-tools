public class FinallyTest {
    public static void main(String[] args) {
        System.out.println("Test 1: Normal execution");
        testNormalPath();

        System.out.println("\nTest 2: Exceptional execution");
        testExceptionPath();
    }

    public static void testNormalPath() {
        try {
            System.out.println("In try block (normal)");
        } catch (Exception e) {
            System.out.println("In catch block (should not be printed)");
        } finally {
            System.out.println("In finally block (normal)");
        }
    }

    public static void testExceptionPath() {
        try {
            System.out.println("In try block (exception)");
            throw new RuntimeException("Test exception");
        } catch (Exception e) {
            System.out.println("In catch block (exception)");
        } finally {
            System.out.println("In finally block (exception)");
        }
    }
}
