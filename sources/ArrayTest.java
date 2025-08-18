public class ArrayTest {
    public static void main(String[] args) {
        // Test basic array creation and access
        System.out.println("=== Basic Array Test ===");
        int[] arr = new int[5];
        arr[0] = 10;
        arr[1] = 20;
        System.out.println("arr[0] = " + arr[0]);
        System.out.println("arr[1] = " + arr[1]);
        
        // Test array initialization
        System.out.println("=== Array Initialization ===");
        int[] arr2 = {1, 2, 3, 4, 5};
        for (int i = 0; i < arr2.length; i++) {
            System.out.println("arr2[" + i + "] = " + arr2[i]);
        }
        
        // Test multi-dimensional arrays
        System.out.println("=== Multi-dimensional Arrays ===");
        int[][] matrix = new int[2][3];
        matrix[0][0] = 1;
        matrix[0][1] = 2;
        matrix[1][0] = 3;
        System.out.println("matrix[0][0] = " + matrix[0][0]);
        System.out.println("matrix[0][1] = " + matrix[0][1]);
        System.out.println("matrix[1][0] = " + matrix[1][0]);
        
        // Test array bounds (this might cause an exception)
        System.out.println("=== Array Bounds Test ===");
        try {
            System.out.println("Accessing arr[10]...");
            System.out.println(arr[10]); // Should throw ArrayIndexOutOfBoundsException
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("Caught expected exception: " + e.getClass().getSimpleName());
        }
    }
}