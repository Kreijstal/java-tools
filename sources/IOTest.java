import java.io.*;

public class IOTest {
    public static void main(String[] args) {
        System.out.println("=== IO Classes Test ===");
        
        // Test ByteArrayInputStream
        System.out.println("Testing ByteArrayInputStream:");
        byte[] data = {65, 66, 67, 68}; // ABCD
        ByteArrayInputStream bais = new ByteArrayInputStream(data);
        
        int b;
        while ((b = bais.read()) != -1) {
            char c = (char)b;
            System.out.println("Read byte: " + b + " (" + c + ")");
        }
        
        // Test StringWriter - simpler approach
        System.out.println("Testing StringWriter:");
        StringWriter sw = new StringWriter();
        sw.write("Hello");
        System.out.println("StringWriter content: " + sw.toString());
        
        System.out.println("=== Test Complete ===");
    }
}