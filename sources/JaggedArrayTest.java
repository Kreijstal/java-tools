public class JaggedArrayTest {
    public static void main(String[] args) {
        System.out.println("=== Jagged Array Test ===");
        
        // Test 1: Basic jagged array
        System.out.println("Basic jagged array:");
        int[][] jaggedArray = new int[3][];
        jaggedArray[0] = new int[]{1, 2, 3, 4};
        jaggedArray[1] = new int[]{5, 6};
        jaggedArray[2] = new int[]{7, 8, 9};
        
        printJaggedArray(jaggedArray);
        
        // Test 2: Initialize jagged array with different approach
        System.out.println("Jagged array with direct initialization:");
        int[][] jaggedArray2 = {
            {10, 20, 30},
            {40, 50},
            {60, 70, 80, 90, 100}
        };
        
        printJaggedArray(jaggedArray2);
        
        // Test 3: 3D jagged array
        System.out.println("3D jagged array:");
        int[][][] threeDJagged = new int[2][][];
        threeDJagged[0] = new int[][]{{1, 2}, {3, 4, 5}};
        threeDJagged[1] = new int[][]{{6}, {7, 8, 9}, {10, 11}};
        
        print3DJaggedArray(threeDJagged);
        
        // Test 4: Array of arrays with nulls
        System.out.println("Array with null subarrays:");
        String[][] stringJagged = new String[3][];
        stringJagged[0] = new String[]{"hello", "world"};
        stringJagged[1] = null;  // null subarray
        stringJagged[2] = new String[]{"java", "test"};
        
        printStringJaggedArray(stringJagged);
        
        // Test 5: Dynamic jagged array creation
        System.out.println("Dynamic jagged array:");
        int[][] dynamicJagged = createDynamicJaggedArray(4);
        printJaggedArray(dynamicJagged);
    }
    
    public static void printJaggedArray(int[][] array) {
        for (int i = 0; i < array.length; i++) {
            System.out.print("Row " + i + ": ");
            if (array[i] != null) {
                for (int j = 0; j < array[i].length; j++) {
                    System.out.print(array[i][j] + " ");
                }
            } else {
                System.out.print("null");
            }
            System.out.println();
        }
    }
    
    public static void print3DJaggedArray(int[][][] array) {
        for (int i = 0; i < array.length; i++) {
            System.out.println("Level " + i + ":");
            if (array[i] != null) {
                printJaggedArray(array[i]);
            } else {
                System.out.println("  null");
            }
        }
    }
    
    public static void printStringJaggedArray(String[][] array) {
        for (int i = 0; i < array.length; i++) {
            System.out.print("Row " + i + ": ");
            if (array[i] != null) {
                for (int j = 0; j < array[i].length; j++) {
                    System.out.print(array[i][j] + " ");
                }
            } else {
                System.out.print("null");
            }
            System.out.println();
        }
    }
    
    public static int[][] createDynamicJaggedArray(int rows) {
        int[][] array = new int[rows][];
        for (int i = 0; i < rows; i++) {
            array[i] = new int[i + 1]; // Each row has i+1 elements
            for (int j = 0; j < array[i].length; j++) {
                array[i][j] = (i + 1) * 10 + j;
            }
        }
        return array;
    }
}