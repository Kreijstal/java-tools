import java.io.*;
import java.net.URL;
public class UrlRead {
  public static void main(String[] a) throws Exception {
    DataInputStream in = new DataInputStream(new URL(a[0]).openStream());
    int first = in.read();
    int count = first < 0 ? 0 : 1;
    while (in.read() >= 0) count++;
    in.close();
    System.out.println("first=" + first + " bytes=" + count);
  }
}
