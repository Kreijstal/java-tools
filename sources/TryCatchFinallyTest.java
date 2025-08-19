public class TryCatchFinallyTest {

    public static void main(String[] args) {
        System.out.println("--- Test: Exception in finally ---");
        testExceptionInFinally();

        System.out.println("\n--- Test: Exception in catch ---");
        testExceptionInCatch();

        System.out.println("\n--- Test: Return in finally ---");
        System.out.println("Returned value: " + testReturnInFinally());

        System.out.println("\n--- Test: Nested try-catch-finally ---");
        testNestedTryCatchFinally();

        System.out.println("\n--- Test: Try-finally without catch ---");
        testTryFinallyWithoutCatch();
    }

    public static void testExceptionInFinally() {
        try {
            try {
                System.out.println("Outer try");
                throw new RuntimeException("Original exception");
            } finally {
                System.out.println("Inner finally, throwing new exception");
                throw new IllegalStateException("Exception from finally");
            }
        } catch (Exception e) {
            System.out.println("Caught: " + e.getMessage());
        }
    }

    public static void testExceptionInCatch() {
        try {
            try {
                System.out.println("Outer try");
                throw new RuntimeException("Original exception");
            } catch (RuntimeException e) {
                System.out.println("Outer catch, throwing new exception");
                throw new IllegalStateException("Exception from catch");
            }
        } catch (Exception e) {
            System.out.println("Caught: " + e.getMessage());
        }
    }

    public static int testReturnInFinally() {
        try {
            System.out.println("In try");
            throw new RuntimeException("Exception in try");
           // return 0;
        } catch (Exception e) {
            System.out.println("In catch");
            return 1; // This return is superseded by the finally block's return
        } finally {
            System.out.println("In finally");
            return 2; // This return will be the one that is executed
        }
    }

    public static void testNestedTryCatchFinally() {
        try {
            System.out.println("Outer try");
            try {
                System.out.println("Inner try");
                throw new RuntimeException("Inner exception");
            } catch (Exception e) {
                System.out.println("Inner catch: " + e.getMessage());
            } finally {
                System.out.println("Inner finally");
            }
            System.out.println("Outer try after inner");
        } catch (Exception e) {
            System.out.println("Outer catch: " + e.getMessage());
        } finally {
            System.out.println("Outer finally");
        }
    }

    public static void testTryFinallyWithoutCatch() {
        try {
            try {
                System.out.println("Inner try");
                throw new RuntimeException("Exception from try-finally");
            } finally {
                System.out.println("Inner finally");
            }
        } catch (Exception e) {
            System.out.println("Caught: " + e.getMessage());
        }
    }

}

