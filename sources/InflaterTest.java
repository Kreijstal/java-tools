import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

public class InflaterTest {
    public static void main(String[] args) throws IOException, DataFormatException {
        String testString = "Hello, World! This is a test string for inflation.";
        byte[] input = testString.getBytes("UTF-8");

        // Compress the data
        Deflater deflater = new Deflater();
        deflater.setInput(input);
        deflater.finish();
        ByteArrayOutputStream baos = new ByteArrayOutputStream(input.length);
        byte[] buffer = new byte[1024];
        while (!deflater.finished()) {
            int count = deflater.deflate(buffer);
            baos.write(buffer, 0, count);
        }
        baos.close();
        byte[] compressedData = baos.toByteArray();

        // Decompress the data
        Inflater inflater = new Inflater();
        inflater.setInput(compressedData, 0, compressedData.length);
        ByteArrayOutputStream baos2 = new ByteArrayOutputStream(input.length);
        buffer = new byte[1024];
        while (!inflater.finished()) {
            int count = inflater.inflate(buffer);
            baos2.write(buffer, 0, count);
        }
        baos2.close();
        byte[] decompressedData = baos2.toByteArray();

        String resultString = new String(decompressedData, "UTF-8");

        if (testString.equals(resultString)) {
            System.out.println("Test passed");
        } else {
            System.out.println("Test failed");
            System.out.println("Original: " + testString);
            System.out.println("Result:   " + resultString);
        }
    }
}
