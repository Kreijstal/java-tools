public class SwitchCrash {
    public static void main(String[] args) {

        System.out.println("Testing tableswitch:");
        tableSwitchTest(0);
        tableSwitchTest(1);
        tableSwitchTest(2);
        tableSwitchTest(3); // default

        System.out.println("\nTesting lookupswitch:");
        lookupSwitchTest(10);
        lookupSwitchTest(100);
        lookupSwitchTest(1000);
        lookupSwitchTest(1001); // default
    }

    public static void tableSwitchTest(int value) {
        switch (value) {
            case 0:
                System.out.println("Case 0");
                break;
            case 1:
                System.out.println("Case 1");
                break;
            case 2:
                System.out.println("Case 2");
                break;
            default:
                System.out.println("Default case");
        }
    }

    public static void lookupSwitchTest(int value) {
        switch (value) {
            case 10:
                System.out.println("Case 10");
                break;
            case 100:
                System.out.println("Case 100");
                break;
            case 1000:
                System.out.println("Case 1000");
                break;
            default:
                System.out.println("Default case");
        }

        // "FB" and "Ea" have the same hash code, but are not equal.
        // This will test the `equals` method after the `lookupswitch`.
        String stringValue = "Ea";
        int result = -1;
        switch (stringValue) {
            case "FB":
                result = 1;
                break;
            case "Ea":
                result = 2;
                break;
            case "three":
                result = 3;
                break;
            default:
                result = -1;
                break;
        }
        System.out.println(result);

        // Test with a value that is not in the switch, but has the same hash code as one of the cases.
        // "G!" also has the same hash code as "FB" and "Ea".
        stringValue = "G!";
        result = -1;
        switch (stringValue) {
            case "FB":
                result = 1;
                break;
            case "Ea":
                result = 2;
                break;
            default:
                result = 4;
                break;
        }
        System.out.println(result);

    }
}
