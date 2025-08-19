import java.util.concurrent.locks.ReentrantLock;

public class ConcurrencyCrash {
    private static int counter = 0;
    private static final ReentrantLock lock = new ReentrantLock();
    
    public static void main(String[] args) {
        System.out.println("Testing concurrency features that might crash...");
        
        // Test basic thread creation
        Thread t1 = new Thread(() -> {
            for (int i = 0; i < 1000; i++) {
                increment();
            }
        });
        
        Thread t2 = new Thread(() -> {
            for (int i = 0; i < 1000; i++) {
                increment();
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
    
    private static void increment() {
        lock.lock();
        try {
            counter++;
        } finally {
            lock.unlock();
        }
    }
}