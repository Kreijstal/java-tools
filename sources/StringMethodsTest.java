public class StringMethodsTest {
    public static void main(String[] args) {
        String text = "Hello World";
        
        // Test various string methods
        System.out.println(text);
        System.out.println(text.toUpperCase());
        System.out.println(text.toLowerCase());
        
        String name = "Java";
        String greeting = "Hello ".concat(name);
        System.out.println(greeting);
        
        System.out.println("Tests completed");
    }
}