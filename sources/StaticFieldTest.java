public class StaticFieldTest {
    public static int staticField = 100;
    
    public static void main(String[] args) {
        System.out.println("Testing static field access...");
        // This should trigger 'getstatic' instruction
        System.out.println("Static field value: " + staticField);
        
        // This should trigger 'putstatic' instruction
        staticField = 200;
        System.out.println("Static field updated: " + staticField);
    }
}