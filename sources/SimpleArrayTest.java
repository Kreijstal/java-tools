public class SimpleArrayTest {
    public static void main(String[] args) {
        System.out.println("Testing basic array creation...");
        // This should trigger 'newarray' instruction
        int[] arr = new int[3];
        System.out.println("Array created successfully!");
        arr[0] = 42;
        System.out.println("Array element set: " + arr[0]);
    }
}