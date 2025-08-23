import java.io.*;

public class IOTest {
    public static void main(String[] args) {
        System.out.println("=== IO Classes Test ===");
        
        // Test ByteArrayInputStream
        testByteArrayInputStream();
        
        // Test StringWriter
        testStringWriter();
        
        // Test StringReader
        testStringReader();
        
        // Test File
        testFile();
        
        // Test IOException
        testIOException();
        
        System.out.println("=== Test Complete ===");
    }
    
    private static void testByteArrayInputStream() {
        System.out.println("Testing ByteArrayInputStream:");
        byte[] data = {65, 66, 67, 68}; // ABCD
        ByteArrayInputStream bais = new ByteArrayInputStream(data);
        
        int b;
        while ((b = bais.read()) != -1) {
            System.out.println("Read byte: " + b);
        }
        System.out.println("Available: " + bais.available());
    }
    
    private static void testStringWriter() {
        System.out.println("Testing StringWriter:");
        StringWriter sw = new StringWriter();
        sw.write(72); // H
        sw.write(101); // e  
        sw.write(108); // l
        sw.write(108); // l
        sw.write(111); // o
        System.out.println("StringWriter content: " + sw.toString());
    }
    
    private static void testStringReader() {
        System.out.println("Testing StringReader:");
        try {
            String testStr = "Test";
            StringReader sr = new StringReader(testStr);
            int ch;
            while ((ch = sr.read()) != -1) {
                System.out.println("Read char: " + ch);
            }
            sr.close();
        } catch (IOException e) {
            System.out.println("Error reading: " + e.getMessage());
        }
    }
    
    private static void testFile() {
        System.out.println("Testing File:");
        String fileName = "test.txt";
        File f = new File(fileName);
        System.out.println("File exists: " + f.exists());
        System.out.println("File path: " + f.getPath());
    }
    
    private static void testIOException() {
        System.out.println("Testing IOException:");
        try {
            String msg = "Test exception";
            throw new IOException(msg);
        } catch (IOException e) {
            System.out.println("Caught: " + e.toString());
        }
    }
}