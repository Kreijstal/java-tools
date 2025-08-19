import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

public class MethodHandlesTest {
    public static void main(String[] args) {
        System.out.println("=== Method Handles Test ===");
        
        try {
            // Test 1: Basic method handle lookup and invocation
            MethodHandles.Lookup lookup = MethodHandles.lookup();
            MethodType mt = MethodType.methodType(void.class, String.class);
            MethodHandle mh = lookup.findStatic(MethodHandlesTest.class, "staticMethod", mt);
            
            System.out.println("Invoking static method via MethodHandle:");
            mh.invoke("Hello from MethodHandle!");
            
            // Test 2: Instance method handle
            MethodType instanceMt = MethodType.methodType(String.class, int.class);
            MethodHandle instanceMh = lookup.findVirtual(MethodHandlesTest.class, "instanceMethod", instanceMt);
            
            MethodHandlesTest instance = new MethodHandlesTest();
            System.out.println("Invoking instance method via MethodHandle:");
            String result = (String) instanceMh.invoke(instance, 42);
            System.out.println("Result: " + result);
            
            // Test 3: Field access via MethodHandle
            MethodHandle getterMh = lookup.findGetter(MethodHandlesTest.class, "testField", int.class);
            MethodHandle setterMh = lookup.findSetter(MethodHandlesTest.class, "testField", int.class);
            
            System.out.println("Field access via MethodHandle:");
            setterMh.invoke(instance, 100);
            int fieldValue = (int) getterMh.invoke(instance);
            System.out.println("Field value: " + fieldValue);
            
        } catch (Throwable t) {
            System.out.println("Error: " + t.getMessage());
            t.printStackTrace();
        }
    }
    
    public int testField = 0;
    
    public static void staticMethod(String message) {
        System.out.println("Static method called: " + message);
    }
    
    public String instanceMethod(int value) {
        return "Instance method called with: " + value;
    }
}