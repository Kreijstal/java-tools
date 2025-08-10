public class StringConcatMethod {
    public static void main(String[] args) {
        // Using String.concat method instead of + operator
        String hello = "Hello";
        String space = " ";
        String world = "World";
        String result = hello.concat(space).concat(world);
        System.out.println(result);
    }
}