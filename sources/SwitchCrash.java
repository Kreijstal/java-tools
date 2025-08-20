public class SwitchCrash {
    public static void main(String[] args) {
        // "FB" and "Ea" have the same hash code, but are not equal.
        // This will test the `equals` method after the `lookupswitch`.
        String value = "Ea";
        int result = -1;
        switch (value) {
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
        value = "G!";
        result = -1;
        switch (value) {
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
