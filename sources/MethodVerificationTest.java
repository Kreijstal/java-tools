import java.io.*;

public class MethodVerificationTest {
    public static void main(String[] args) {
        System.out.println("=== Method Verification Test ===");
        
        // Verify InputStream methods exist
        System.out.println("Testing InputStream methods...");
        byte[] data = {65, 66};
        ByteArrayInputStream bais = new ByteArrayInputStream(data);
        try {
            bais.read(); // read()I
            bais.available(); // available()I 
            bais.close(); // close()V
            System.out.println("InputStream methods: OK");
        } catch (Exception e) {
            System.out.println("InputStream methods: FAILED - " + e);
        }
        
        // Verify DataInputStream methods exist
        System.out.println("Testing DataInputStream methods...");
        try {
            ByteArrayInputStream bis = new ByteArrayInputStream(data);
            DataInputStream dis = new DataInputStream(bis); // <init>(Ljava/io/InputStream;)V
            dis.read(new byte[1], 0, 1); // read([BII)I
            dis.close(); // close()V
            System.out.println("DataInputStream methods: OK");
        } catch (Exception e) {
            System.out.println("DataInputStream methods: FAILED - " + e);
        }
        
        // Verify File methods exist  
        System.out.println("Testing File methods...");
        try {
            File f = new File("test"); // <init>(Ljava/lang/String;)V
            f.exists(); // exists()Z
            f.length(); // length()J
            f.delete(); // delete()Z
            System.out.println("File methods: OK");
        } catch (Exception e) {
            System.out.println("File methods: FAILED - " + e);
        }
        
        // Verify StringWriter methods exist
        System.out.println("Testing StringWriter methods...");
        try {
            StringWriter sw = new StringWriter(); // <init>()V
            sw.toString(); // toString()Ljava/lang/String;
            System.out.println("StringWriter methods: OK");
        } catch (Exception e) {
            System.out.println("StringWriter methods: FAILED - " + e);
        }
        
        // Verify PrintWriter methods exist
        System.out.println("Testing PrintWriter methods...");
        try {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw); // <init>(Ljava/io/Writer;)V
            pw.close(); // close()V
            System.out.println("PrintWriter methods: OK");
        } catch (Exception e) {
            System.out.println("PrintWriter methods: FAILED - " + e);
        }
        
        // Verify StringReader methods exist
        System.out.println("Testing StringReader methods...");
        try {
            StringReader sr = new StringReader("test"); // <init>(Ljava/lang/String;)V
            System.out.println("StringReader methods: OK");
        } catch (Exception e) {
            System.out.println("StringReader methods: FAILED - " + e);
        }
        
        // Verify EOFException methods exist
        System.out.println("Testing EOFException methods...");
        try {
            EOFException eof = new EOFException(); // <init>()V
            System.out.println("EOFException methods: OK");
        } catch (Exception e) {
            System.out.println("EOFException methods: FAILED - " + e);
        }
        
        // Verify IOException methods exist
        System.out.println("Testing IOException methods...");
        try {
            IOException ioe = new IOException("test"); // <init>(Ljava/lang/String;)V
            ioe.toString(); // toString()Ljava/lang/String;
            ioe.printStackTrace(); // printStackTrace()V
            System.out.println("IOException methods: OK");
        } catch (Exception e) {
            System.out.println("IOException methods: FAILED - " + e);
        }
        
        System.out.println("=== Verification Complete ===");
    }
}