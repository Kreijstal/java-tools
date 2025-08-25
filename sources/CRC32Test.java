import java.util.zip.CRC32;

public class CRC32Test {
    public static void main(String[] args) {
        // Test reset()
        CRC32 crc = new CRC32();
        System.out.println("CRC32 created");
        crc.reset();
        System.out.println("CRC32 reset");

        // Test update() and getValue()
        String testString = "Hello, World!";
        byte[] bytes = testString.getBytes();
        
        crc.update(bytes, 0, bytes.length);
        System.out.println("CRC32 updated");

        long value = crc.getValue();
        System.out.println("Value: " + value);
        
        // The expected CRC32 value for "Hello, World!" is 3964322768
        if (value == 3964322768L) {
            System.out.println("Test passed");
        } else {
            System.out.println("Test failed: expected 3964322768, got " + value);
        }
    }
}