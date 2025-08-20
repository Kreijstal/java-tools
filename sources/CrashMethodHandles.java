import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;

public class CrashMethodHandles {
    public static void main(String[] args) throws Throwable {
        MethodHandles.Lookup lookup = MethodHandles.lookup();
        MethodType type = MethodType.methodType(String.class, int.class, int.class);
        MethodHandle handle = lookup.findVirtual(String.class, "substring", type);

        String str = "hello world";
        String sub = (String) handle.invoke(str, 0, 5);

        System.out.println(sub);
    }
}