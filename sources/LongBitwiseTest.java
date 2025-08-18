public class LongBitwiseTest {
    public static void main(String[] args) {
        long c = 12L; // 1100
        long d = 10L; // 1010
        System.out.println(c & d);    // land (8)
        System.out.println(c | d);    // lor (14)
        System.out.println(c ^ d);    // lxor (6)

        long a = -10L;
        int b = 2;
        System.out.println(a << b);   // lshl (-40)
        System.out.println(a >> b);   // lshr (-3)
        System.out.println(a >>> b);  // lushr (4611686018427387901)
    }
}
