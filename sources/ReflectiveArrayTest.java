import java.lang.reflect.Array;

public class ReflectiveArrayTest {
    public static void main(String[] args) {
        System.out.println("=== Reflective Array Creation Test ===");
        
        try {
            // Create single-dimensional arrays
            Object intArray = Array.newInstance(int.class, 5);
            Array.setInt(intArray, 0, 42);
            Array.setInt(intArray, 1, 99);
            Array.setInt(intArray, 2, -1);
            
            System.out.println("Created int array, length: " + Array.getLength(intArray));
            System.out.println("Element 0: " + Array.getInt(intArray, 0));
            System.out.println("Element 1: " + Array.getInt(intArray, 1));
            System.out.println("Element 2: " + Array.getInt(intArray, 2));
            
            // Create multi-dimensional array
            Object multiArray = Array.newInstance(String.class, 2, 3);
            Object row0 = Array.get(multiArray, 0);
            Object row1 = Array.get(multiArray, 1);
            
            Array.set(row0, 0, "Hello");
            Array.set(row0, 1, "World");
            Array.set(row0, 2, "!");
            
            Array.set(row1, 0, "Java");
            Array.set(row1, 1, "Array");
            Array.set(row1, 2, "Test");
            
            System.out.println("Multi-dimensional array [2][3]:");
            for (int i = 0; i < 2; i++) {
                Object row = Array.get(multiArray, i);
                for (int j = 0; j < 3; j++) {
                    System.out.print(Array.get(row, j) + " ");
                }
                System.out.println();
            }
            
            // Test with primitive wrapper types
            Object doubleArray = Array.newInstance(Double.TYPE, 3);
            Array.setDouble(doubleArray, 0, 3.14);
            Array.setDouble(doubleArray, 1, 2.71);
            Array.setDouble(doubleArray, 2, 1.41);
            
            System.out.println("Double array:");
            for (int i = 0; i < Array.getLength(doubleArray); i++) {
                System.out.println("  [" + i + "] = " + Array.getDouble(doubleArray, i));
            }
            
            // Test array class information
            Class<?> intArrayClass = intArray.getClass();
            System.out.println("Int array class: " + intArrayClass.getName());
            System.out.println("Is array: " + intArrayClass.isArray());
            System.out.println("Component type: " + intArrayClass.getComponentType().getName());
            
            Class<?> multiArrayClass = multiArray.getClass();
            System.out.println("Multi array class: " + multiArrayClass.getName());
            System.out.println("Multi array component type: " + multiArrayClass.getComponentType().getName());
            
            // Test zero-length array
            Object zeroArray = Array.newInstance(int.class, 0);
            System.out.println("Zero-length array length: " + Array.getLength(zeroArray));
            
            // Test jagged array creation
            Object jaggedArray = Array.newInstance(int[].class, 3);
            Array.set(jaggedArray, 0, Array.newInstance(int.class, 2));
            Array.set(jaggedArray, 1, Array.newInstance(int.class, 4));
            Array.set(jaggedArray, 2, Array.newInstance(int.class, 1));
            
            System.out.println("Jagged array created with different row sizes:");
            for (int i = 0; i < Array.getLength(jaggedArray); i++) {
                Object row = Array.get(jaggedArray, i);
                System.out.println("  Row " + i + " length: " + Array.getLength(row));
            }
            
        } catch (Exception e) {
            System.out.println("Exception: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            e.printStackTrace();
        }
    }
}