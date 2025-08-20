import java.util.Date;

public class ObscureStrings {
    public static void main(String[] args) {
        System.out.println("Demonstrating advanced string features.");

        // String.join()
        String joined = String.join(", ", "a", "b", "c");
        System.out.println("String.join(): " + joined);

        // String.repeat() - available from Java 11
        // This might not be supported by the runJvm environment.
        try {
            String repeated = "A".repeat(3);
            System.out.println("String.repeat(): " + repeated);
        } catch (NoSuchMethodError e) {
            System.out.println("String.repeat() is not available in this Java version.");
        }

        // Advanced Date Formatting
        System.out.println("Advanced date formatting:");
        System.out.printf("%tB %<te, %<tY%n", new Date());
    }
}
