public class SimplestSipushCrash {
    public static void main(String[] args) {
        System.out.println("This will crash on the very next line...");
        // The simplest possible sipush crash: any number > 127
        int number = 128;
        System.out.println("If you see this, sipush is fixed: " + number);
    }
}