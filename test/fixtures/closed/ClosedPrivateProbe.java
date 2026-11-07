// Obfuscated FunOrb clients probe optional implementations reflectively, and
// some of those classes have only a private constructor that throws Error
// (Void Hunters' du). HotSpot refuses the call before the constructor runs.
public class ClosedPrivateProbe {
  static class Hidden {
    private Hidden() { throw new Error("constructor ran"); }
  }
  static class Open {
    public Open() {}
  }
  static Object probe(String name) {
    try {
      return Class.forName(name).newInstance();
    } catch (Throwable t) {
      return t.getClass().getName();
    }
  }
  public static void main(String[] args) {
    System.out.println(probe("ClosedPrivateProbe$Hidden"));
    System.out.println(probe("ClosedPrivateProbe$Open").getClass().getName());
    System.out.println("still running");
  }
}
