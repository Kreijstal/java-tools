public class PotentialCrash1 {
    public static void main(String[] args) {
        // Test some potentially missing instructions
        testMonitorInstructions();
        testTableSwitch();
        testLookupSwitch();
    }
    
    public static void testMonitorInstructions() {
        Object obj = new Object();
        synchronized (obj) {
            System.out.println("In synchronized block");
        }
    }
    
    public static void testTableSwitch() {
        int x = 2;
        switch (x) {
            case 0: System.out.println("zero"); break;
            case 1: System.out.println("one"); break;
            case 2: System.out.println("two"); break;
            case 3: System.out.println("three"); break;
            default: System.out.println("other"); break;
        }
    }
    
    public static void testLookupSwitch() {
        int x = 100;
        switch (x) {
            case 10: System.out.println("ten"); break;
            case 100: System.out.println("hundred"); break;
            case 1000: System.out.println("thousand"); break;
            default: System.out.println("unknown"); break;
        }
    }
}