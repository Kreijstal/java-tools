import java.util.zip.CRC32;

public class CRC32GetValueTest {
    public static void main(String[] args) {
        CRC32 crc = new CRC32();
        System.out.println("CRC32 created");
        
        String testString = "Hello";
        byte[] bytes = testString.getBytes();
        
        crc.update(bytes, 0, bytes.length);
        System.out.println("CRC32 updated");
        
        long value = crc.getValue();
        System.out.println("Value: " + value);
    }
}