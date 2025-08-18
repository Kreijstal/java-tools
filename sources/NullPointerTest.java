public class NullPointerTest {
    public static void main(String[] args) {
        System.out.println("Testing null pointer operations...");
        
        String str = null;
        
        try {
            // This should throw NullPointerException
            int length = str.length();
            System.out.println("Length: " + length);
        } catch (NullPointerException e) {
            System.out.println("Caught NullPointerException as expected");
        }
        
        try {
            // Another null operation
            String upper = str.toUpperCase();
            System.out.println("Upper: " + upper);
        } catch (NullPointerException e) {
            System.out.println("Caught second NullPointerException");
        }
        
        // Test array null access
        int[] arr = null;
        try {
            int len = arr.length;
            System.out.println("Array length: " + len);
        } catch (NullPointerException e) {
            System.out.println("Caught NPE on array.length");
        }
        
        System.out.println("Test completed");
    }
}