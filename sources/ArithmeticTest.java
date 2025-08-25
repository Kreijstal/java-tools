public class ArithmeticTest {
    public static void main(String[] args) {
        // Integer arithmetic
        int a = 10;
        int b = 3;
        
        int sum = a + b;
        int diff = a - b;
        int product = a * b;
        int quotient = a / b;
        int remainder = a % b;
        
        System.out.println("Integer Arithmetic:");
        System.out.print("Sum: ");
        System.out.println(sum);
        System.out.print("Difference: ");
        System.out.println(diff);
        System.out.print("Product: ");
        System.out.println(product);
        System.out.print("Quotient: ");
        System.out.println(quotient);
        System.out.print("Remainder: ");
        System.out.println(remainder);
        System.out.println();

        // Double arithmetic
        double da = 12345.6789;
        double db = 9876.5432;

        System.out.println("Double Arithmetic:");
        System.out.print("Sum: ");
        System.out.println(da + db);
        System.out.print("Difference: ");
        System.out.println(da - db);
        System.out.print("Product: ");
        System.out.println(da * db);
        System.out.print("Quotient: ");
        System.out.println(da / db);
        System.out.println();

        // Float arithmetic
        float fa = 12.5f;
        float fb = 3.5f;

        System.out.println("Float Arithmetic:");
        System.out.print("Sum: ");
        System.out.println(fa + fb);
        System.out.print("Difference: ");
        System.out.println(fa - fb);
        System.out.print("Product: ");
        System.out.println(fa * fb);
        System.out.print("Quotient: ");
        System.out.println(fa / fb);
    }
}