public class ReflectionCrash {
    public static void main(String[] args) {
        System.out.println("Testing reflection operations that might crash...");
        
        try {
            // Get class information - might crash if Class.forName not implemented properly
            Class<?> stringClass = Class.forName("java.lang.String");
            System.out.println("String class: " + stringClass.getName());
            
            // Test method reflection
            java.lang.reflect.Method[] methods = stringClass.getMethods();
            System.out.println("String has " + methods.length + " methods");
            
            // Test field reflection
            java.lang.reflect.Field[] fields = stringClass.getFields();
            System.out.println("String has " + fields.length + " public fields");
            
        } catch (Exception e) {
            System.out.println("Exception: " + e.getClass().getSimpleName() + " - " + e.getMessage());
        }
    }
}