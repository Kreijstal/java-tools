public class EnumTest {
    enum Color {
        RED(255, 0, 0),
        GREEN(0, 255, 0),
        BLUE(0, 0, 255),
        YELLOW(255, 255, 0);

        private final int r, g, b;

        Color(int r, int g, int b) {
            this.r = r;
            this.g = g;
            this.b = b;
        }

        public int getRed() { return r; }
        public int getGreen() { return g; }
        public int getBlue() { return b; }

        public String getHex() {
            return String.format("#%02x%02x%02x", r, g, b);
        }
    }

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
            
            Color yellow = Color.valueOf("YELLOW");
            System.out.println("valueOf(YELLOW): " + yellow);

            Color invalid = Color.valueOf("PURPLE"); // Should throw exception
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
            case YELLOW:
                System.out.println("It's yellow!");
                break;
            default:
                System.out.println("Unknown color");
        }
    }
}