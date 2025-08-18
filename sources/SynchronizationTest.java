public class SynchronizationTest {
    private static int counter = 0;
    private static final Object lock = new Object();
    
    public static void main(String[] args) {
        System.out.println("=== Synchronization Test ===");
        
        // Test synchronized method
        SynchronizationTest test = new SynchronizationTest();
        test.synchronizedMethodTest();
        
        // Test synchronized block
        test.synchronizedBlockTest();
        
        // Test with multiple threads (might be complex for the JVM)
        System.out.println("=== Multi-threaded Test ===");
        Thread t1 = new Thread(() -> {
            for (int i = 0; i < 100; i++) {
                test.incrementCounter();
            }
        });
        
        Thread t2 = new Thread(() -> {
            for (int i = 0; i < 100; i++) {
                test.incrementCounter();
            }
        });
        
        t1.start();
        t2.start();
        
        try {
            t1.join();
            t2.join();
        } catch (InterruptedException e) {
            System.out.println("Interrupted: " + e.getMessage());
        }
        
        System.out.println("Final counter value: " + counter);
    }
    
    public synchronized void synchronizedMethodTest() {
        System.out.println("In synchronized method");
        counter += 10;
        System.out.println("Counter after synchronized method: " + counter);
    }
    
    public void synchronizedBlockTest() {
        System.out.println("Before synchronized block");
        synchronized (lock) {
            System.out.println("In synchronized block");
            counter += 5;
        }
        System.out.println("Counter after synchronized block: " + counter);
    }
    
    public synchronized void incrementCounter() {
        counter++;
    }
}