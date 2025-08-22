import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;

public class SimpleStdinTest {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        String line = br.readLine();
        if (line != null) {
            System.out.println("You entered: " + line);
        } else {
            System.out.println("No input received");
        }
    }
}
