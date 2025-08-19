public class TypeConversionTest {
    public static void main(String[] args) {
        int i = 123456789;

        long l = (long)i;
        float f = (float)i;
        double d = (double)i;

        System.out.println(l);
        System.out.println(f);
        System.out.println(d);
    }
}
