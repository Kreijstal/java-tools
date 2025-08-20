import java.math.BigDecimal;

public class ObscureBigDecimal {
    public static void main(String[] args) {
        System.out.println("Demonstrating BigDecimal precision quirk.");

        BigDecimal a = new BigDecimal("1.0");
        BigDecimal b = new BigDecimal("1.00");

        System.out.println("a = new BigDecimal(\"1.0\")");
        System.out.println("b = new BigDecimal(\"1.00\")");

        System.out.println("a.equals(b): " + a.equals(b));
        System.out.println("a.compareTo(b): " + a.compareTo(b));
    }
}
