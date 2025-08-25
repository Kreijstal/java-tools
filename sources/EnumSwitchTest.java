public class EnumSwitchTest {
    public static void main(String[] args) {
        // Test RED case
        EnumTest.Color color = EnumTest.Color.RED;
        System.out.println("Testing RED: " + testColor(color));
        
        // Test GREEN case  
        color = EnumTest.Color.GREEN;
        System.out.println("Testing GREEN: " + testColor(color));
        
        // Test BLUE case
        color = EnumTest.Color.BLUE;
        System.out.println("Testing BLUE: " + testColor(color));
        
        // Test default case
        color = EnumTest.Color.YELLOW;
        System.out.println("Testing YELLOW: " + testColor(color));

        System.out.println("---");
        System.out.println("Testing Enum.valueOf()...");
        EnumTest.Color red = Enum.valueOf(EnumTest.Color.class, "RED");
        System.out.println("Enum.valueOf(Color.class, RED) = " + red);
    }
    
    public static String testColor(EnumTest.Color color) {
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