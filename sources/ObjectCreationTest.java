public class ObjectCreationTest {
    private int value;
    
    public ObjectCreationTest(int value) {
        this.value = value;
    }
    
    public int getValue() {
        return value;
    }
    
    public void setValue(int value) {
        this.value = value;
    }
    
    public static void main(String[] args) {
        System.out.println("Testing object creation...");
        
        // Test object creation with constructor
        ObjectCreationTest obj = new ObjectCreationTest(42);
        System.out.println("Created object with value: " + obj.getValue());
        
        // Test method calls
        obj.setValue(100);
        System.out.println("Updated value: " + obj.getValue());
        
        // Test multiple objects
        ObjectCreationTest obj2 = new ObjectCreationTest(200);
        System.out.println("Second object value: " + obj2.getValue());
    }
}