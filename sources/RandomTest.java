import java.util.Random;

public class RandomTest {
    public static void main(String[] args) {
        Random rand = new Random();
        rand.setSeed(0);

        System.out.println(rand.nextInt());
        System.out.println(rand.nextInt(100));
        System.out.println(rand.nextLong());
        System.out.println(rand.nextBoolean());
        System.out.println(rand.nextFloat());
        System.out.println(rand.nextDouble());

        byte[] bytes = new byte[10];
        rand.nextBytes(bytes);
        for (byte b : bytes) {
            System.out.print(b + " ");
        }
        System.out.println();
    }
}