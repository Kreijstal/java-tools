public class AdvancedArrayCrash {
    public static void main(String[] args) {
        System.out.println("Testing advanced array operations...");
        
        // Test multi-dimensional array access that might use missing instructions
        int[][] matrix = new int[3][4];
        matrix[0][0] = 10;
        matrix[2][3] = 20;
        System.out.println("Matrix[0][0] = " + matrix[0][0]);
        System.out.println("Matrix[2][3] = " + matrix[2][3]);
        
        // Test array of objects 
        String[] strings = new String[3];
        strings[0] = "Hello";
        strings[1] = "World";
        strings[2] = "!";
        
        // Test enhanced for loop on array (might need special bytecode)
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
        System.out.println("Total length: " + totalLength);
        
        // Test arraycopy (might crash if not implemented)
        try {
            int[] src = {1, 2, 3, 4, 5};
            int[] dst = new int[10];
            System.arraycopy(src, 0, dst, 2, 3);
            System.out.println("Arraycopy result: dst[3] = " + dst[3]);
        } catch (Exception e) {
            System.out.println("Arraycopy failed: " + e.getMessage());
        }
    }
}