public class ArithmeticTest {
    public static void main(String[] args) {
        int a = 10;
        int b = 3;
        
        int sum = a + b;        // iadd
        int diff = a - b;       // isub  
        int product = a * b;    // imul
        int quotient = a / b;   // idiv
        int remainder = a % b;  // irem
        
        System.out.println(sum);
        System.out.println(diff);
        System.out.println(product);
        System.out.println(quotient);
        System.out.println(remainder);
    }
}