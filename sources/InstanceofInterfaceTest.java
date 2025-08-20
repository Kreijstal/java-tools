interface IIFace {}

class CClass implements IIFace {}

public class InstanceofInterfaceTest {
    public static void main(String[] args) {
        CClass obj = new CClass();
        if (obj instanceof IIFace) {
            System.out.println("is_iiface");
        } else {
            System.out.println("is_not_iiface");
        }

        String s = "a string";
        if (s instanceof CharSequence) {
             System.out.println("is_charsequence");
        } else {
             System.out.println("is_not_charsequence");
        }
    }
}
