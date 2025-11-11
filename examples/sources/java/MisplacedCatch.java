public class MisplacedCatch {

    public static int funnel(int value) {
        try {
            if (value < 0) {
                throw new IllegalArgumentException("negative");
            }
            return value + 1;
        } catch (IllegalArgumentException ex) {
            return value - 1;
        }
    }

    public static void main(String[] args) {
        System.out.println(funnel(args.length - 1));
    }
}
