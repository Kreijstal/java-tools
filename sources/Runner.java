public class Runner {
    public static void main(String[] args) {
        I a = new A();
        I b = new B();
        System.out.println(a.myMethod());
        System.out.println(b.myMethod());
    }
}
