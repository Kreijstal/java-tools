public class RuntimeTest {
    public static void main(String[] args) {
        Runtime runtime = Runtime.getRuntime();
        System.out.println("Available processors: " + runtime.availableProcessors());
        System.out.println("Free memory: " + runtime.freeMemory());
        System.out.println("Total memory: " + runtime.totalMemory());
        System.out.println("Max memory: " + runtime.maxMemory());

        try {
            Process p = runtime.exec("ls");
            if (p == null) {
                System.out.println("Exec process is null");
            } else {
                System.out.println("Exec process is not null");
            }
        } catch (java.io.IOException e) {
            System.out.println("IOException during exec");
        }
    }
}
