import java.util.ArrayList;
import java.util.List;
import java.lang.reflect.Method;

public class GenericsCrash {
    public static void main(String[] args) {
        List<String> stringList = new ArrayList<String>();
        stringList.add("Hello");

        try {
            Method add = stringList.getClass().getMethod("add", Object.class);
            add.invoke(stringList, 123);
        } catch (Exception e) {
            e.printStackTrace();
            return;
        }

        try {
            for (Object s : stringList) {
                String str = (String) s;
                System.out.println(str);
            }
        } catch (ClassCastException e) {
            System.out.println("Caught expected ClassCastException!");
        }
    }
}
