import java.security.SecureRandom;

public class SecureRandomTest {
    public static void main(String[] args) {
        SecureRandom sr = new SecureRandom();
        System.out.println("nextInt: " + sr.nextInt());

        byte[] bytes = new byte[10];
        sr.nextBytes(bytes);
        System.out.print("nextBytes: [");
        for (int i = 0; i < bytes.length; i++) {
            System.out.print(bytes[i]);
            if (i < bytes.length - 1) {
                System.out.print(", ");
            }
        }
        System.out.println("]");

        byte[] seed = sr.generateSeed(10);
        System.out.print("generateSeed: [");
        for (int i = 0; i < seed.length; i++) {
            System.out.print(seed[i]);
            if (i < seed.length - 1) {
                System.out.print(", ");
            }
        }
        System.out.println("]");
    }
}
