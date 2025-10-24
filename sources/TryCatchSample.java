public class TryCatchSample {
    public static int safeDivide(int a, int b) {
        try {
            return a / b;
        } catch (ArithmeticException ex) {
            return Integer.MIN_VALUE;
        }
    }
}
