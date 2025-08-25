public class UnresolvedTest {
    public void a() {
        System.out.println("hello");
    }

    public void b() {
        Dummy dummy = new Dummy();
        dummy.c();
        dummy.d = 1;
    }
}
