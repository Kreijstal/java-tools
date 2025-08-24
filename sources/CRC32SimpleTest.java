import java.util.zip.CRC32;

public class CRC32SimpleTest {
    public static void main(String[] args) {
        CRC32 crc = new CRC32();
        System.out.println("CRC32 created");
        crc.reset();
        System.out.println("CRC32 reset");
    }
}