import java.io.Serializable;

public class ObscureGenerics {

    // This method will trigger an 'invokeinterface' instruction for compareTo
    public static <T extends Comparable<T> & Serializable> T max(T x, T y) {
        return x.compareTo(y) > 0 ? x : y;
    }

    public static void main(String[] args) {
        System.out.println("Testing invokeinterface bug.");
        String s1 = "hello";
        String s2 = "world";
        // The following line will cause the crash if invokeinterface is broken.
        System.out.println("max(\"hello\", \"world\") = " + max(s1, s2));
        System.out.println("Test finished.");
    }
}
