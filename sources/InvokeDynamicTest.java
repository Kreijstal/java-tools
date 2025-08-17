public class InvokeDynamicTest {
    public static void main(String[] args) {
        // Using string concatenation with + which generates invokedynamic in modern Java
        String message = "Hello " + "World " + "from " + "InvokeDynamic!";
        System.out.println(message);

        // Using lambda expression which also generates invokedynamic
        Runnable r = () -> System.out.println("Lambda executed!");
        r.run();
    }
}
