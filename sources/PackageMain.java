import pkg.demo.Greeter;

public class PackageMain {
    public static void main(String[] args) {
        Greeter.greet("world");
        System.out.println(Greeter.twice(21));
    }
}
