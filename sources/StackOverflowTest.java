public class StackOverflowTest {
    private static int depth = 0;
    
    public static void main(String[] args) {
        System.out.println("=== Stack Overflow Test ===");
        System.out.println("Starting infinite recursion...");
        
        try {
            infiniteRecursion();
        } catch (StackOverflowError e) {
            System.out.println("Caught StackOverflowError at depth: " + depth);
        } catch (Exception e) {
            System.out.println("Caught unexpected exception: " + e.getClass().getSimpleName());
            System.out.println("Message: " + e.getMessage());
        }
        
        System.out.println("Test completed");
    }
    
    public static void infiniteRecursion() {
        depth++;
        if (depth % 1000 == 0) {
            System.out.println("Recursion depth: " + depth);
        }
        infiniteRecursion(); // This should eventually cause StackOverflowError
    }
}