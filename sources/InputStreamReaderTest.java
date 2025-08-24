import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.io.IOException;

public class InputStreamReaderTest {
    public static void main(String[] args) throws IOException {
        String testString = "Hello, World!";
        byte[] bytes = testString.getBytes("UTF-8");
        ByteArrayInputStream bais = new ByteArrayInputStream(bytes);
        InputStreamReader isr = new InputStreamReader(bais, "UTF-8");

        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = isr.read()) != -1) {
            sb.append((char) c);
        }

        if (testString.equals(sb.toString())) {
            System.out.println("Test passed");
        } else {
            System.out.println("Test failed");
        }
    }
}
