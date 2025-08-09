public class SimpleArithmetic {
    public static void main(String[] args) {
        int a = 3;  // iconst_3
        int b = 2;  // iconst_2  
        int sum = a + b;    // iadd
        int diff = a - b;   // isub
        int product = a * b; // imul
        
        System.out.println(sum);
        System.out.println(diff);
        System.out.println(product);
    }
}