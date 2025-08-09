public class ExceptionTest {

    public static void main(String[] args) {
        try {
            throwException();
        } catch (IllegalArgumentException e) {
            System.out.println("Caught exception");
        }
    }

    public static void throwException() {
        throw new IllegalArgumentException();
    }
}