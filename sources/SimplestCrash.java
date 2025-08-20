public class SimplestCrash {
    public static void main(String[] args) {
        System.out.println("This test demonstrates the 'newarray' instruction.");
        // This used to crash, but now it should work correctly.
        int[] numbers = new int[1];
        System.out.println("The 'newarray' instruction is working correctly.");
    }
}