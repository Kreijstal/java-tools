import java.util.Random;

public class RandomSeedTest {
    public static void main(String[] args) {
        Random rand = new Random();
        rand.setSeed(0);
        
        // Test first few values with seed 0
        System.out.println("nextInt(): " + rand.nextInt());
        System.out.println("nextInt(100): " + rand.nextInt(100));
        System.out.println("nextBoolean(): " + rand.nextBoolean());
    }
}