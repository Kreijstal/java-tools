import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.io.IOException;

public class CharsetTest {
    public static void main(String[] args) {
        System.out.println("=== Charset and InputStreamReader Test ===");

        // Test Charset.forName()
        Charset utf8 = Charset.forName("UTF-8");
        System.out.println("Charset.forName(\"UTF-8\"): " + utf8);
        if (utf8 == null) {
            System.out.println("ERROR: Charset.forName() returned null!");
        }

        // Test InputStreamReader constructors
        byte[] data = "Hello".getBytes();
        ByteArrayInputStream bais = new ByteArrayInputStream(data);

        try {
            InputStreamReader reader1 = new InputStreamReader(bais);
            System.out.println("Created InputStreamReader(InputStream)");

            bais.reset();
            InputStreamReader reader2 = new InputStreamReader(bais, "UTF-8");
            System.out.println("Created InputStreamReader(InputStream, String)");

            bais.reset();
            InputStreamReader reader3 = new InputStreamReader(bais, utf8);
            System.out.println("Created InputStreamReader(InputStream, Charset)");

            // Basic read test
            int charRead = reader3.read();
            System.out.println("Read from reader: " + (char)charRead);
            if (charRead != 'H') {
                System.out.println("ERROR: Incorrect character read!");
            }

        } catch (IOException e) {
            System.out.println("ERROR: IOException during test: " + e.getMessage());
        }

        System.out.println("=== Test Complete ===");
    }
}
