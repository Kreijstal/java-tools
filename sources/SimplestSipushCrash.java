public class SimplestSipushCrash {
    public static void main(String[] args) {
        System.out.println("This test demonstrates the 'sipush' instruction.");
        // This used to crash for numbers > 127, but now it should work correctly.
        int number = 128;
        System.out.println("The 'sipush' instruction is working correctly: " + number);
    }
}