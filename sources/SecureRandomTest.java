import java.security.SecureRandom;

public class SecureRandomTest {
    public static void main(String[] args) {
        System.out.println("=== SecureRandom Test ===");

        SecureRandom random = new SecureRandom();

        // Test nextInt()
        int randomInt = random.nextInt();
        System.out.println("nextInt(): " + randomInt);

        // Test nextInt(bound)
        int boundedInt = random.nextInt(100);
        System.out.println("nextInt(100): " + boundedInt);
        if (boundedInt < 0 || boundedInt >= 100) {
            System.out.println("ERROR: nextInt(100) out of bounds!");
        }

        // Test nextLong()
        long randomLong = random.nextLong();
        System.out.println("nextLong(): " + randomLong);

        // Test nextDouble()
        double randomDouble = random.nextDouble();
        System.out.println("nextDouble(): " + randomDouble);
        if (randomDouble < 0.0 || randomDouble >= 1.0) {
            System.out.println("ERROR: nextDouble() out of bounds!");
        }

        // Test nextBytes()
        byte[] bytes = new byte[10];
        random.nextBytes(bytes);
        System.out.print("nextBytes(10): [");
        for (int i = 0; i < bytes.length; i++) {
            System.out.print(bytes[i]);
            if (i < bytes.length - 1) {
                System.out.print(", ");
            }
        }
        System.out.println("]");

        // Test setSeed (should be a no-op)
        random.setSeed(12345L);
        System.out.println("setSeed() called (no-op)");

        System.out.println("=== Test Complete ===");
    }
}
