public class DebugSplit {
    public static void main(String[] args) {
        String input = "5 + 3";
        String separator = "\\s+";

        System.out.println("Input: '" + input + "'");
        System.out.println("Separator: '" + separator + "'");
        System.out.println("Separator length: " + separator.length());

        for (int i = 0; i < separator.length(); i++) {
            char c = separator.charAt(i);
            System.out.println("Char " + i + ": '" + c + "' (code: " + (int)c + ")");
        }

        String[] parts = input.split(separator);
        System.out.println("Number of parts: " + parts.length);
        for (int i = 0; i < parts.length; i++) {
            System.out.println("Part " + i + ": '" + parts[i] + "'");
        }
    }
}
