// instanceof and checkcast inside the module: class targets (struct type
// tests), an interface target (class-id list), and non-object values.
public class ClosedTypeTests {
  static class Base { int v; Base(int v) { this.v = v; } }
  static class Sub extends Base { Sub(int v) { super(v); } }
  interface Tag { }
  static class Tagged extends Base implements Tag { Tagged(int v) { super(v); } }

  static boolean isBase(Object o) { return o instanceof Base; }
  static boolean isSub(Object o) { return o instanceof Sub; }
  static boolean isTag(Object o) { return o instanceof Tag; }
  static int castSum(Object o) { return ((Base) o).v; }

  public static void main(String[] args) {
    Object[] keep = new Object[3000];
    for (int i = 0; i < keep.length; i++) keep[i] = (i % 3 == 0) ? new Tagged(i) : (i % 3 == 1) ? new Sub(i) : new Base(i);
    int bases = 0, subs = 0, tags = 0, early = 0, late = 0;
    long sum = 0;
    for (int i = 0; i < keep.length; i++) {
      Object o = keep[i];
      if (isBase(o)) bases++;
      if (isSub(o)) subs++;
      if (isTag(o)) { tags++; if (i < 100) early++; if (i >= keep.length - 100) late++; }
      sum += castSum(o);
    }
    Object s = "text";
    System.out.println(bases + " " + subs + " " + tags + " " + early + " " + late + " " + sum
        + " " + isBase(s) + " " + isTag(new int[1]) + " " + isBase(null));
  }
}
