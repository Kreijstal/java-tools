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
        System.out.println("\n=== Array Initialization ===");
        int[] arr2 = {1, 2, 3, 4, 5};
        for (int i = 0; i < arr2.length; i++) {
            System.out.println("arr2[" + i + "] = " + arr2[i]);
        }
        
        // Test multi-dimensional arrays
        System.out.println("\n=== Multi-dimensional Arrays ===");
        int[][] matrix = new int[2][3];
        matrix[0][0] = 1;
        matrix[0][1] = 2;
        matrix[1][0] = 3;
        System.out.println("matrix[0][0] = " + matrix[0][0]);
        System.out.println("matrix[0][1] = " + matrix[0][1]);
        System.out.println("matrix[1][0] = " + matrix[1][0]);
        
        // Test array bounds
        System.out.println("\n=== Array Bounds Test ===");
        try {
            System.out.println("Accessing arr[10]...");
            System.out.println(arr[10]); // Should throw ArrayIndexOutOfBoundsException
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println("Caught expected exception: " + e.getClass().getSimpleName());
        }

        // From AdvancedArrayCrash.java
        System.out.println("\n=== Advanced Array Operations ===");

        // Test multi-dimensional array access that might use missing instructions
        int[][] matrix2 = new int[3][4];
        matrix2[0][0] = 10;
        matrix2[2][3] = 20;
        System.out.println("Matrix2[0][0] = " + matrix2[0][0]);
        System.out.println("Matrix2[2][3] = " + matrix2[2][3]);

        // Test array of objects
        String[] strings = new String[3];
        strings[0] = "Hello";
        strings[1] = "World";
        strings[2] = "!";

        // Test enhanced for loop on array
        System.out.println("Enhanced for loop:");
        for (String s : strings) {
            if (s != null) {
                System.out.println("String: " + s);
            }
        }

        // Test array length access in complex expression
        int totalLength = 0;
        for (String s : strings) {
            if (s != null) {
                totalLength += s.length();
            }
        }
        System.out.println("Total length of strings: " + totalLength);

        // Test arraycopy
        try {
            int[] src = {1, 2, 3, 4, 5};
            int[] dst = new int[10];
            System.arraycopy(src, 0, dst, 2, 3);
            System.out.println("Arraycopy result: dst[3] = " + dst[3]);
        } catch (Exception e) {
            System.out.println("Arraycopy failed: " + e.getMessage());
        }

        // From ArrayCreator.java
        System.out.println("\n=== Array Creator Test ===");
        String[] stringArray = new String[10];
        for (int i = 0; i < 10; i++) {
            stringArray[i] = "A constant string";
        }
        System.out.println("Array created successfully.");
        System.out.println(stringArray[0]);
    }
}
