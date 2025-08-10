public class InvokeVirtualTest {
    public static void main(String[] args) {
        // Test multiple invokevirtual scenarios
        
        // 1. String concatenation with concat method
        String hello = "Hello";
        String space = " ";
        String world = "World";
        String result = hello.concat(space).concat(world);
        
        // 2. PrintStream.println
        System.out.println(result);
        
        // 3. String methods
        String upper = result.toUpperCase();  // This might not be supported yet
        
        // 4. More println calls
        System.out.println("Test completed");
    }
}