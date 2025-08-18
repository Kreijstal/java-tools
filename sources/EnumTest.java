public class EnumTest {
    public static void main(String[] args) {
        System.out.println("=== Enum Test ===");
        
        // Test enum constants
        Color red = Color.RED;
        System.out.println("Color: " + red);
        System.out.println("Red value: " + red.getRed());
        System.out.println("Hex: " + red.getHex());
        
        // Test enum comparison
        Color anotherRed = Color.RED;
        System.out.println("RED == RED: " + (red == anotherRed));
        System.out.println("RED equals RED: " + red.equals(anotherRed));
        
        // Test enum in switch statement
        System.out.println("=== Enum Switch Test ===");
        for (Color color : Color.values()) {
            testEnumSwitch(color);
        }
        
        // Test valueOf
        System.out.println("=== valueOf Test ===");
        try {
            Color blue = Color.valueOf("BLUE");
            System.out.println("valueOf(BLUE): " + blue);
            
            Color invalid = Color.valueOf("YELLOW"); // Should throw exception
        } catch (IllegalArgumentException e) {
            System.out.println("Caught expected exception for invalid enum: " + e.getClass().getSimpleName());
        }
    }
    
    public static void testEnumSwitch(Color color) {
        switch (color) {
            case RED:
                System.out.println("It's red!");
                break;
            case GREEN:
                System.out.println("It's green!");
                break;
            case BLUE:
                System.out.println("It's blue!");
                break;
            default:
                System.out.println("Unknown color");
        }
    }
}