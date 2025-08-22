import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;

public class SimpleEcho {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        String line;

        System.out.println("Echo program started. Type 'quit' to exit.");

        while (true) {
            line = br.readLine();
            if (line == null) {
                break;
            }

            // Simple string comparison without using equals()
            boolean shouldQuit = false;
            if (line.length() == 4) {
                char c1 = line.charAt(0);
                char c2 = line.charAt(1);
                char c3 = line.charAt(2);
                char c4 = line.charAt(3);
                if (c1 == 'q' && c2 == 'u' && c3 == 'i' && c4 == 't') {
                    shouldQuit = true;
                }
            }

            if (shouldQuit) {
                break;
            }

            System.out.println("Echo: " + line);
        }

        System.out.println("Echo program exited.");
    }
}
