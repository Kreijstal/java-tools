public class ObscureNumbers {
    public static void main(String[] args) {
        System.out.println("Demonstrating underscores in numeric literals.");

        long largeNumber = 1_000_000_000_000L;
        long binaryNumber = 0b1111_1111;
        long hexNumber = 0xFF_FF;

        System.out.println("Large number: " + largeNumber);
        System.out.println("Binary number: " + binaryNumber);
        System.out.println("Hex number: " + hexNumber);
    }
}
