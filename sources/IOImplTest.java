import java.io.*;

public class IOImplTest {
    public static void main(String[] args) {
        System.out.println("--- IO Implementation Test ---");

        // Test BufferedReader
        try {
            StringReader sr = new StringReader("Hello\nWorld");
            BufferedReader br = new BufferedReader(sr);
            System.out.println("BufferedReader line 1: " + br.readLine());
            System.out.println("BufferedReader line 2: " + br.readLine());
            br.close();
        } catch (IOException e) {
            System.out.println("BufferedReader test failed: " + e.toString());
        }

        // Test DataInputStream (reading from ByteArrayInputStream)
        try {
            byte[] data = { 0, 1, 2, 3 };
            ByteArrayInputStream bais = new ByteArrayInputStream(data);
            DataInputStream dis = new DataInputStream(bais);
            byte[] buffer = new byte[4];
            dis.read(buffer, 0, 4);
            System.out.println("DataInputStream read: " + buffer[0] + "," + buffer[1] + "," + buffer[2] + "," + buffer[3]);
            dis.close();
        } catch (IOException e) {
            System.out.println("DataInputStream test failed: " + e.toString());
        }

        // Test RandomAccessFile
        try {
            File f = new File("test.tmp");
            RandomAccessFile raf = new RandomAccessFile(f, "rw");
            raf.write(123);
            raf.seek(0);
            System.out.println("RandomAccessFile read: " + raf.read());
            System.out.println("RandomAccessFile length: " + raf.length());
            raf.close();
            f.delete();
        } catch (IOException e) {
            System.out.println("RandomAccessFile test failed: " + e.toString());
        }

        // Test PrintWriter and StringWriter
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        pw.println("Hello from PrintWriter");
        pw.close();
        System.out.println("PrintWriter output: " + sw.toString().trim());

        System.out.println("--- Test Complete ---");
    }
}
