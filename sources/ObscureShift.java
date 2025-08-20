public class ObscureShift {
    public static void main(String[] args) {
        System.out.println("Demonstrating shift operators.");

        int negativeNumber = -16;

        System.out.println("Original number: " + negativeNumber);
        System.out.println("Binary representation: " + Integer.toBinaryString(negativeNumber));

        // Signed right shift (>>)
        int signedShiftResult = negativeNumber >> 2;
        System.out.println("Signed right shift (>> 2): " + signedShiftResult);
        System.out.println("Binary representation: " + Integer.toBinaryString(signedShiftResult));

        // Unsigned right shift (>>>)
        int unsignedShiftResult = negativeNumber >>> 2;
        System.out.println("Unsigned right shift (>>> 2): " + unsignedShiftResult);
        System.out.println("Binary representation: " + Integer.toBinaryString(unsignedShiftResult));
    }
}
