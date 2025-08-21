import java.math.BigDecimal;

public class BigDecimalTest {
    public static void main(String[] args) {
        BigDecimal a = new BigDecimal("10.5");
        BigDecimal b = new BigDecimal("20.5");
        BigDecimal c = a.add(b);
        System.out.println(c);
    }
}
