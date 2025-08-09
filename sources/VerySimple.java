public class VerySimple {
    public static void main(String[] args) {
        int a = 3;  // iconst_3, istore_1
        int b = 2;  // iconst_2, istore_2  
        int c = a - b;  // iload_1, iload_2, isub, istore_3
        System.out.println(c);
    }
}