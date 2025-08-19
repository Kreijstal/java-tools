public class TryWithResourcesTest {
    public static void main(String[] args) {
        System.out.println("=== Try-With-Resources Test ===");
        
        // Test 1: Single resource
        System.out.println("Single resource:");
        try (TestResource resource = new TestResource("Resource1")) {
            resource.doWork();
            System.out.println("Work completed successfully");
        } catch (Exception e) {
            System.out.println("Caught exception: " + e.getMessage());
        }
        
        // Test 2: Multiple resources
        System.out.println("Multiple resources:");
        try (TestResource resource1 = new TestResource("Resource1");
             TestResource resource2 = new TestResource("Resource2")) {
            resource1.doWork();
            resource2.doWork();
            System.out.println("Multiple resources work completed");
        } catch (Exception e) {
            System.out.println("Caught exception: " + e.getMessage());
        }
        
        // Test 3: Exception in resource and try block
        System.out.println("Exception handling:");
        try (TestResource resource = new TestResource("FailingResource")) {
            resource.doWork();
            throw new RuntimeException("Exception in try block");
        } catch (Exception e) {
            System.out.println("Caught exception: " + e.getMessage());
            if (e.getSuppressed().length > 0) {
                System.out.println("Suppressed exceptions: " + e.getSuppressed().length);
                for (Throwable suppressed : e.getSuppressed()) {
                    System.out.println("  - " + suppressed.getMessage());
                }
            }
        }
    }
    
    static class TestResource implements AutoCloseable {
        private final String name;
        
        public TestResource(String name) {
            this.name = name;
            System.out.println("Created resource: " + name);
        }
        
        public void doWork() {
            System.out.println("Working with resource: " + name);
            if ("FailingResource".equals(name)) {
                throw new RuntimeException("Work failed for " + name);
            }
        }
        
        @Override
        public void close() {
            System.out.println("Closing resource: " + name);
            if ("FailingResource".equals(name)) {
                throw new RuntimeException("Failed to close " + name);
            }
        }
    }
}