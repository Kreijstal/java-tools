public class AnsiColorDemo {
    public static void main(String[] args) {
        // ANSI color codes
        String reset = "\u001B[0m";
        String red = "\u001B[31m";
        String green = "\u001B[32m";
        String yellow = "\u001B[33m";
        String blue = "\u001B[34m";
        String purple = "\u001B[35m";
        String cyan = "\u001B[36m";
        String white = "\u001B[37m";
        
        System.out.println(red + "This is RED text" + reset);
        System.out.println(green + "This is GREEN text" + reset);
        System.out.println(yellow + "This is YELLOW text" + reset);
        System.out.println(blue + "This is BLUE text" + reset);
        System.out.println(purple + "This is PURPLE text" + reset);
        System.out.println(cyan + "This is CYAN text" + reset);
        System.out.println(white + "This is WHITE text" + reset);
        
        // Demonstration of mixed colors
        System.out.println(red + "R" + green + "A" + blue + "I" + yellow + "N" + purple + "B" + cyan + "O" + white + "W" + reset + " text!");
        
        // Background colors
        String bgRed = "\u001B[41m";
        String bgGreen = "\u001B[42m";
        System.out.println(bgRed + "Red background" + reset);
        System.out.println(bgGreen + "Green background" + reset);
        
        System.out.println("Normal text without colors");
    }
}