public class ObscureStrictFp {

    // This method uses strict floating-point arithmetic.
    // Intermediate results will be truncated to 64 bits for portability.
    public static strictfp void strictCalculation() {
        double a = 1e308;
        double b = 1e308;
        double c = 1e-308;
        // This calculation might overflow or underflow differently without strictfp
        // on processors with 80-bit floating point registers.
        System.out.println("StrictFP calculation: " + (a * b * c * c));
    }

    // This method uses the default floating-point arithmetic.
    public static void nonStrictCalculation() {
        double a = 1e308;
        double b = 1e308;
        double c = 1e-308;
        System.out.println("Non-StrictFP calculation: " + (a * b * c * c));
    }

    public static void main(String[] args) {
        System.out.println("Demonstrating strictfp keyword.");
        System.out.println("Note: The difference may not be visible on all platforms.");
        strictCalculation();
        nonStrictCalculation();
    }
}
