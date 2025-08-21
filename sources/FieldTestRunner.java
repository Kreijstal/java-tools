public class FieldTestRunner {
    public static void main(String[] args) {
        FieldTest obj = new FieldTest();
        System.out.println(obj.myField);
        obj.myField = 20;
        System.out.println(obj.myField);
    }
}
