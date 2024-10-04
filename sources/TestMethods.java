public class TestMethods {

    public void publicMethod1() {
        System.out.println("Public Method 1");
    }

    public void publicMethod2() {
        System.out.println("Public Method 2");
    }

    private void privateMethod1() {
        System.out.println("Private Method 1");
    }

    private void privateMethod2() {
        System.out.println("Private Method 2");
    }

    public static void main(String[] args) {
        TestMethods tm = new TestMethods();
        tm.publicMethod1();
        tm.publicMethod2();
        tm.privateMethod1();
        tm.privateMethod2();
    }
}
