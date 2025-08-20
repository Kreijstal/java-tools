public class EnumSwitchTest {
    public enum Color {
        RED, GREEN, BLUE, YELLOW
    }

    public static void main(String[] args) {
        // Test RED case
        Color color = Color.RED;
        System.out.println("Testing RED: " + testColor(color));
        
        // Test GREEN case  
        color = Color.GREEN;
        System.out.println("Testing GREEN: " + testColor(color));
        
        // Test BLUE case
        color = Color.BLUE;
        System.out.println("Testing BLUE: " + testColor(color));
        
        // Test default case
        color = Color.YELLOW;
        System.out.println("Testing YELLOW: " + testColor(color));

        System.out.println("---");
        System.out.println("Testing Enum.valueOf()...");
        Color red = Enum.valueOf(Color.class, "RED");
        System.out.println("Enum.valueOf(Color.class, RED) = " + red);
    }
    
    public static String testColor(Color color) {
        switch (color) {
            case RED:
                return "It is red";
            case GREEN:
                return "It is green";
            case BLUE:
                return "It is blue";
            default:
                return "Unknown color";
        }
    }
}