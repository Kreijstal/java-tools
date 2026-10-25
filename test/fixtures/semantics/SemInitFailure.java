// A static initializer that throws: the first use gets
// ExceptionInInitializerError (cause = the thrown exception), later uses get
// NoClassDefFoundError, and the initializer never runs twice.
public class SemInitFailure {
  static final StringBuilder log = new StringBuilder();

  static class Failing {
    static int value;
    static { log.append("Failing.clinit;"); if (log.length() >= 0) throw new RuntimeException("boom"); }
  }

  public static void main(String[] args) {
    for (int i = 0; i < 2; i++) {
      try { System.out.println(Failing.value); } catch (ExceptionInInitializerError e) {
        System.out.println("eiie " + e.getCause().getMessage());
      } catch (NoClassDefFoundError e) {
        System.out.println("ncdfe");
      }
    }
    System.out.println(log.toString()); log.setLength(0);
    System.out.println(log.toString());
  }
}
