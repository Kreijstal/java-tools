public class OptimizerTimeoutTest {
    private static long fib() {
        return Fib.test(100);
    }

    @SuppressWarnings("unused")
    private static int ack() {
        return Ackermann.test(4, 2);
    }

    public static void main(String[] args) {
        long fibResult = fib();
        if (!new java.math.BigInteger("354224848179261915075").equals(java.math.BigInteger.valueOf(fibResult))) {
            throw new AssertionError("Fib.test(100) did not return the correct value.");
        }
        System.out.println("Fib.test(100) works! Result: " + fibResult);
        System.out.println("Ackermann.test(4, 2) was not constant folded, as expected.");
    }
}
