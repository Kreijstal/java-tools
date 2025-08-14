public class ArrayCreator {
    public static void main(String[] args) {
        String[] stringArray = new String[10];
        for (int i = 0; i < 10; i++) {
            stringArray[i] = "A constant string";
        }
        System.out.println("Array created successfully.");
        System.out.println(stringArray[0]);
    }
}
