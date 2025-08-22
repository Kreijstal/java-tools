public class ClassLiteralTest {
    public static void main(String[] args) {
        System.out.println("=== Class Literal Test ===");
        
        // Test basic class literals
        Class<?> intClass = int.class;
        Class<?> stringClass = String.class;
        Class<?> arrayClass = int[].class;
        Class<?> multiArrayClass = int[][].class;
        
        System.out.println("int.class: " + intClass.getName());
        System.out.println("String.class: " + stringClass.getName());
        System.out.println("int[].class: " + arrayClass.getName());
        System.out.println("int[][].class: " + multiArrayClass.getName());
        
        // Test primitive vs wrapper
        System.out.println("int.class == Integer.TYPE: " + (intClass == Integer.TYPE));
        System.out.println("Integer.class: " + Integer.class.getName());
        
        // Test void class
        Class<?> voidClass = void.class;
        System.out.println("void.class: " + voidClass.getName());
        System.out.println("Void.TYPE: " + Void.TYPE.getName());
        System.out.println("void.class == Void.TYPE: " + (voidClass == Void.TYPE));
        
        // Test Class.forName
        try {
            Class<?> forNameClass = Class.forName("java.lang.String");
            System.out.println("Class.forName(\"java.lang.String\"): " + forNameClass.getName());
            System.out.println("forName == String.class: " + (forNameClass == String.class));
            
            // Test array class loading
            Class<?> arrayForName = Class.forName("[I");
            System.out.println("Class.forName(\"[I\"): " + arrayForName.getName());
            System.out.println("forName array == int[].class: " + (arrayForName == int[].class));
            
        } catch (ClassNotFoundException e) {
            System.out.println("ClassNotFoundException: " + e.getMessage());
        }
        
        // Test getSuperclass
        Class<?> superClass = String.class.getSuperclass();
        System.out.println("String.class.getSuperclass(): " + superClass.getName());
        
        // Test isArray, isPrimitive
        System.out.println("int.class.isPrimitive(): " + int.class.isPrimitive());
        System.out.println("String.class.isPrimitive(): " + String.class.isPrimitive());
        System.out.println("int[].class.isArray(): " + int[].class.isArray());
        System.out.println("String.class.isArray(): " + String.class.isArray());
    }
}