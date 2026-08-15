public class OverloadDemo {
    public static void main(String[] args) {
        emit(1);
        emit("two");
        emit(3, 4L);
        System.out.println("done");
    }

    public static void emit(int value) {
        System.out.println(value);
    }

    public static void emit(String value) {
        System.out.println(value);
    }

    public static void emit(int first, long second) {
        System.out.println(first + second);
    }
}
