public class EnumSwitchCrash {
    public enum SimpleColor {
        RED, GREEN, BLUE
    }

    public static void main(String[] args) {
        SimpleColor color = SimpleColor.RED;
        switch (color) {
            case RED:
                System.out.println("It is red");
                break;
            default:
                System.out.println("It is not red");
                break;
        }
    }
}