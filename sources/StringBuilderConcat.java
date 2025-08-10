public class StringBuilderConcat {
    public static void main(String[] args) {
        // Using StringBuilder explicitly
        StringBuilder sb = new StringBuilder();
        sb.append("Hello");
        sb.append(" ");
        sb.append("World");
        String result = sb.toString();
        System.out.println(result);
    }
}