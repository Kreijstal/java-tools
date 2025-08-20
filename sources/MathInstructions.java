public class MathInstructions {
    public static void main(String[] args) {
        testArithmeticInstructions();
        testBitwiseInstructions();
        testShiftInstructions();
    }
    
    public static void testArithmeticInstructions() {
        // Test various arithmetic with different types
        long l1 = 100L, l2 = 50L;
        float f1 = 3.5f, f2 = 1.5f;
        double d1 = 10.5, d2 = 2.5;
        
        System.out.println("Long arithmetic:");
        System.out.println("100 + 50 = " + (l1 + l2));  // ladd
        System.out.println("100 - 50 = " + (l1 - l2));  // lsub
        System.out.println("100 * 50 = " + (l1 * l2));  // lmul
        System.out.println("100 / 50 = " + (l1 / l2));  // ldiv
        System.out.println("100 % 50 = " + (l1 % l2));  // lrem
        
        System.out.println("Float arithmetic:");
        System.out.println("3.5 + 1.5 = " + (f1 + f2));  // fadd
        System.out.println("3.5 - 1.5 = " + (f1 - f2));  // fsub
        System.out.println("3.5 * 1.5 = " + (f1 * f2));  // fmul
        System.out.println("3.5 / 1.5 = " + (f1 / f2));  // fdiv
        System.out.println("3.5 % 1.5 = " + (f1 % f2));  // frem
        
        System.out.println("Double arithmetic:");
        System.out.println("10.5 + 2.5 = " + (d1 + d2));  // dadd
        System.out.println("10.5 - 2.5 = " + (d1 - d2));  // dsub
        System.out.println("10.5 * 2.5 = " + (d1 * d2));  // dmul
        System.out.println("10.5 / 2.5 = " + (d1 / d2));  // ddiv
        System.out.println("10.5 % 2.5 = " + (d1 % d2));  // drem
    }
    
    public static void testBitwiseInstructions() {
        int i1 = 15, i2 = 7;  // 1111 & 0111
        long l1 = 15L, l2 = 7L;
        
        System.out.println("Integer bitwise:");
        System.out.println("15 & 7 = " + (i1 & i2));   // iand
        System.out.println("15 | 7 = " + (i1 | i2));   // ior
        System.out.println("15 ^ 7 = " + (i1 ^ i2));   // ixor
        
        System.out.println("Long bitwise:");
        System.out.println("15 & 7 = " + (l1 & l2));   // land
        System.out.println("15 | 7 = " + (l1 | l2));   // lor
        System.out.println("15 ^ 7 = " + (l1 ^ l2));   // lxor
    }
    
    public static void testShiftInstructions() {
        int i = 8;
        long l = 8L;
        
        System.out.println("Shift instructions:");
        System.out.println("8 << 2 = " + (i << 2));    // ishl
        System.out.println("8 >> 1 = " + (i >> 1));    // ishr
        System.out.println("-8 >>> 1 = " + (-i >>> 1)); // iushr
        
        System.out.println("8L << 2 = " + (l << 2));    // lshl
        System.out.println("8L >> 1 = " + (l >> 1));    // lshr
        System.out.println("-8L >>> 1 = " + (-l >>> 1)); // lushr
    }
}