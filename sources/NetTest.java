import java.net.InetAddress;
import java.net.Socket;
import java.net.UnknownHostException;
import java.io.IOException;

public class NetTest {
    public static void main(String[] args) {
        String host = "example.com";
        System.out.println("Performing network tests for host: " + host);

        try {
            System.out.println("1. Looking up host using InetAddress.getByName()...");
            InetAddress address = InetAddress.getByName(host);
            System.out.println("   - Success. Hostname: " + address.getHostName());

            byte[] ipAddress = address.getAddress();
            System.out.print("   - IP Address: ");
            for (int i = 0; i < ipAddress.length; i++) {
                System.out.print(ipAddress[i] & 0xFF);
                if (i < ipAddress.length - 1) {
                    System.out.print(".");
                }
            }
            System.out.println();

            System.out.println("2. Creating a socket to port 80...");
            try (Socket socket = new Socket(address, 80)) {
                System.out.println("   - Success. Socket created and connected (or at least, no immediate error).");
            }

        } catch (UnknownHostException e) {
            System.out.println("   - FAILED: Unknown host. " + e.getMessage());
            e.printStackTrace();
        } catch (IOException e) {
            System.out.println("   - FAILED: IO Error. " + e.getMessage());
            e.printStackTrace();
        }

        System.out.println("Network tests complete.");
    }
}
