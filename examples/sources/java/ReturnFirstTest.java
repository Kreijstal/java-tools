public class ReturnFirstTest {
    public static void main(String[] args) {
        int result = ReturnFirst.useAndReturnFirst(42, 7, 5);
        if (result != 42) {
            throw new AssertionError("Expected 42 but got " + result);
        }
        System.out.println("ReturnFirst.useAndReturnFirst works! Result: " + result);
    }
}
