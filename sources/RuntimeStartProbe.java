public class RuntimeStartProbe {
  static { RuntimeStartObserver.observe(); }
  public static void main(String[] args) { RuntimeStartObserver.observe(); }
}
class RuntimeStartObserver {
  static native void observe();
}
