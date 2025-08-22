public class SimpleStringTest {
    public static void main(String[] args) {
        String s1 = "hello";
        String s3 = new String("hello");
        System.out.println("s1.equals(s3): " + s1.equals(s3));
        System.out.println("s3.equals(s1): " + s3.equals(s1));
        System.out.println("s1: " + s1);
        System.out.println("s3: " + s3);
    }
}