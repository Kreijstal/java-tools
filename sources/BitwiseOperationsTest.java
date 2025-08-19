public class BitwiseOperationsTest {
    public static void main(String[] args) {
        int a = -10;
        int b = 3;
        System.out.println(a >> b);   // ishr
        System.out.println(a >>> b);  // iushr

        int c = 12; // 1100
        int d = 10; // 1010
        System.out.println(c & d);    // iand (8, or 1000)
        System.out.println(c | d);    // ior (14, or 1110)
        System.out.println(c ^ d);    // ixor (6, or 0110)
    }
}
