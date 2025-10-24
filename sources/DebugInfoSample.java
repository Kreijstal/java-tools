import java.util.List;
import java.lang.reflect.Field;

public class DebugInfoSample {
    public static final int ANSWER = 42;
    public static final String GREETING = "hi";

    public static int add(int a, int b) {
        int sum = a + b;
        int doubled = sum * 2;
        return doubled;
    }

    public <T extends CharSequence> void consume(List<T> input) {
        for (T value : input) {
            System.out.println(value);
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("ANSWER=" + ANSWER);
        System.out.println("GREETING=" + GREETING);

        Field answerField = DebugInfoSample.class.getField("ANSWER");
        System.out.println("REFL_ANSWER=" + answerField.getInt(null));

        Field greetingField = DebugInfoSample.class.getField("GREETING");
        System.out.println("REFL_GREETING=" + (String) greetingField.get(null));
    }
}
