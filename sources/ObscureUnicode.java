public class ObscureUnicode {
    public static void main(String\u005B\u005D args) {
        // \u005B is [ and \u005D is ]
        System.out.println("Hello from ObscureUnicode!");

        // Unicode characters in variable names
        double Π = 3.14159;
        boolean Javaは最高 = true;

        System.out.println("Value of Π: " + Π);
        System.out.println("Value of Javaは最高: " + Javaは最高);

        // A syntax error would occur with a malformed unicode escape sequence.
        // For example, in a file path string like "C:\\users\\default", the "\\u" is invalid if not a proper escape.
        // To fix it, you would escape the backslash:
        String path = "C:\\users\\default";
        System.out.println("Path: " + path);
    }
}
