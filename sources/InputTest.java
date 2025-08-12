import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;

public class InputTest {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        String line;
        while ((line = br.readLine()) != null) {
            System.out.println(line);
        }
    }
}
