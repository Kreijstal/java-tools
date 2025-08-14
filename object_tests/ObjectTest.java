public class ObjectTest {
    public static void main(String[] args) {
        Object obj1 = new Object();
        Object obj2 = new Object();
        Object obj3 = obj1;

        // Test getClass()
        System.out.println(obj1.getClass().getName());

        // Test hashCode()
        System.out.println(obj1.hashCode() != obj2.hashCode());

        // Test equals()
        System.out.println(obj1.equals(obj2));
        System.out.println(obj1.equals(obj3));

        // Test toString()
        System.out.println(obj1.toString());
    }
}
