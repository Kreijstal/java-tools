import java.util.zip.CRC32;

public class CRC32Test {
    public static void main(String[] args) {
        String testString = "Hello, World!";
        byte[] bytes = testString.getBytes();

        CRC32 crc = new CRC32();
        crc.update(bytes, 0, bytes.length);
        long value = crc.getValue();

        // The expected CRC32 value for "Hello, World!" is 3964322768
        if (value == 3964322768L) {
            System.out.println("Test passed");
        } else {
            System.out.println("Test failed: expected 3964322768, got " + value);
        }
    }
}
