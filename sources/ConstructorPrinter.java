public class ConstructorPrinter {
    static {
        System.out.println("Static block has been executed.");
    }

    public ConstructorPrinter() {
        System.out.println("Hello from the constructor!");
    }

    public static void main(String[] args) {
        new ConstructorPrinter();
    }
}
