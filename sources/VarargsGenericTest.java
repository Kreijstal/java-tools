public class VarargsGenericTest {
    public static void main(String[] args) {
        System.out.println("=== Varargs with Generics Test ===");
        
        // Test 1: Simple varargs
        System.out.println("Simple varargs:");
        printItems("apple", "banana", "cherry");
        
        // Test 2: Generic varargs  
        System.out.println("Generic varargs:");
        printGenericItems("first", "second", "third");
        printGenericItems(1, 2, 3, 4, 5);
        
        // Test 3: Varargs with arrays
        System.out.println("Varargs with arrays:");
        String[] fruits = {"orange", "grape"};
        printItems(fruits);
        
        // Test 4: Safe varargs with generics
        System.out.println("Safe varargs:");
        safeVarargsMethod("safe1", "safe2", "safe3");
        
        // Test 5: Generic varargs method with different types
        System.out.println("Mixed generic types:");
        processItems("Process", 42, true, 3.14);
    }
    
    // Simple varargs method
    public static void printItems(String... items) {
        System.out.println("Received " + items.length + " items:");
        for (String item : items) {
            System.out.println("  - " + item);
        }
    }
    
    // Generic varargs method
    public static <T> void printGenericItems(T... items) {
        System.out.println("Generic items (type: " + 
            (items.length > 0 ? items[0].getClass().getSimpleName() : "unknown") + "):");
        for (T item : items) {
            System.out.println("  - " + item);
        }
    }
    
    // Safe varargs annotation
    @SafeVarargs
    public static <T> void safeVarargsMethod(T... items) {
        System.out.println("Safe varargs method with " + items.length + " items:");
        for (T item : items) {
            System.out.println("  - " + item);
        }
    }
    
    // Generic varargs with Object
    public static void processItems(Object... items) {
        System.out.println("Processing " + items.length + " mixed items:");
        for (Object item : items) {
            System.out.println("  - " + item + " (type: " + item.getClass().getSimpleName() + ")");
        }
    }
}