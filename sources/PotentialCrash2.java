public class PotentialCrash2 {
    public static void main(String[] args) {
        // Test wide instructions
        testWideInstructions();
        testArrayInstructions();
        testFieldInstructions();
    }
    
    public static void testWideInstructions() {
        // This might use wide instructions for local variable access
        int var0 = 0, var1 = 1, var2 = 2, var3 = 3, var4 = 4;
        int var5 = 5, var6 = 6, var7 = 7, var8 = 8, var9 = 9;
        // ... many more variables to force wide instruction usage
        int result = var0 + var1 + var2 + var3 + var4 + var5 + var6 + var7 + var8 + var9;
        System.out.println("Wide instruction test: " + result);
    }
    
    public static void testArrayInstructions() {
        // Test various array types
        boolean[] boolArray = new boolean[5];
        byte[] byteArray = new byte[5];
        char[] charArray = new char[5];
        short[] shortArray = new short[5];
        float[] floatArray = new float[5];
        double[] doubleArray = new double[5];
        
        boolArray[0] = true;
        byteArray[0] = 127;
        charArray[0] = 'A';
        shortArray[0] = 32767;
        floatArray[0] = 3.14f;
        doubleArray[0] = 2.718;
        
        System.out.println("Array tests completed");
    }
    
    static int staticField = 42;
    int instanceField = 24;
    
    public static void testFieldInstructions() {
        // Test static field access
        staticField = 100;
        System.out.println("Static field: " + staticField);
        
        // Test instance field access
        PotentialCrash2 obj = new PotentialCrash2();
        obj.instanceField = 200;
        System.out.println("Instance field: " + obj.instanceField);
    }
}