public class SimplestCrash {
    public static void main(String[] args) {
        System.out.println("This will crash on the very next line...");
        // The simplest possible crash: creating a single integer array
        int[] numbers = new int[1];
        System.out.println("If you see this, newarray is fixed!");
    }
}