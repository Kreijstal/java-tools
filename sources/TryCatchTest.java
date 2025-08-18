public class TryCatchTest {
    public static void main(String[] args) {
        System.out.println("Testing try-catch with division by zero...");
        
        try {
            int result = 10 / 0;
            System.out.println("Result: " + result);
        } catch (ArithmeticException e) {
            System.out.println("Caught arithmetic exception: " + e.getMessage());
        } catch (Exception e) {
            System.out.println("Caught general exception: " + e.getMessage());
        } finally {
            System.out.println("Finally block executed");
        }
        
        System.out.println("After try-catch");
    }
}