// Initializing a class initializes its superinterfaces that declare default
// methods (JLS 12.4.1); a default method is invoked with invokevirtual on the
// implementing class.
public class SemInterfaceInit {
  static final StringBuilder log = new StringBuilder();

  interface Iface {
    int I = SemInitOrder.mark("Iface.I", 3);
    default int get() { return I; }
  }

  static class Impl implements Iface {
    static { log.append("Impl.clinit;"); }
  }

  static int mark(String what, int v) { log.append(what).append(';'); return v; }

  public static void main(String[] args) {
    Impl impl = new Impl();
    System.out.println(log.toString()); log.setLength(0);
    System.out.println("iface " + impl.get());
    System.out.println(log.toString()); log.setLength(0);

    int total = 0;
    for (int i = 0; i < 20000; i++) total += new Impl().get();
    System.out.println("hot " + total);
  }
}
