public class InstanceofTest {
    public static void main(String[] args) {
        System.out.println("=== instanceof Test ===");
        
        Object obj1 = "Hello";
        Object obj2 = new Integer(42);
        Object obj3 = new int[]{1, 2, 3};
        
        // Test basic instanceof
        System.out.println("String instanceof String: " + (obj1 instanceof String));
        System.out.println("String instanceof Object: " + (obj1 instanceof Object));
        System.out.println("Integer instanceof Integer: " + (obj2 instanceof Integer));
        System.out.println("Integer instanceof Number: " + (obj2 instanceof Number));
        System.out.println("int[] instanceof Object: " + (obj3 instanceof Object));
        
        // Test with null
        Object nullObj = null;
        System.out.println("null instanceof String: " + (nullObj instanceof String));
        System.out.println("null instanceof Object: " + (nullObj instanceof Object));
        
        // Test class hierarchy
        System.out.println("=== Class Hierarchy Test ===");
        Parent parent = new Parent();
        Child child = new Child();
        Parent parentRef = new Child();
        
        System.out.println("Parent instanceof Parent: " + (parent instanceof Parent));
        System.out.println("Child instanceof Parent: " + (child instanceof Parent));
        System.out.println("Child instanceof Child: " + (child instanceof Child));
        System.out.println("Parent ref to Child instanceof Child: " + (parentRef instanceof Child));
    }
    
    static class Parent {
        public void parentMethod() {
            System.out.println("Parent method");
        }
    }
    
    static class Child extends Parent {
        public void childMethod() {
            System.out.println("Child method");
        }
    }
}