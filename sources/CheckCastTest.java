public class CheckCastTest {
    public static void main(String[] args) {
        System.out.println("Testing checkcast instruction...");
        
        Object obj = "Hello World";
        
        try {
            // This should trigger 'checkcast' instruction
            String str = (String) obj;
            System.out.println("Cast successful: " + str);
            
            // This should throw ClassCastException
            Integer num = (Integer) obj;
            System.out.println("This should not print: " + num);
        } catch (ClassCastException e) {
            System.out.println("Caught expected ClassCastException");
        }
        
        // Test with null
        Object nullObj = null;
        String nullStr = (String) nullObj;
        System.out.println("Null cast: " + nullStr);
    }
}