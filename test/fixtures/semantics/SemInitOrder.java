// Virtual dispatch from a superclass constructor sees subclass fields at their
// default values; static initializers run once, lazily, in dependency order.
public class SemInitOrder {
  static final StringBuilder log = new StringBuilder();

  static class Base {
    static { log.append("Base.clinit;"); }
    protected int baseValue = init("Base.field", 1);
    Base() {
      log.append("Base.ctor;");
      log.append("describe=").append(describe()).append(';');
    }
    String describe() { return "base"; }
    static int init(String what, int v) { log.append(what).append(';'); return v; }
  }

  static class Derived extends Base {
    static { log.append("Derived.clinit;"); }
    static final int CONSTANT = 42;                 // compile-time constant: no init
    static int counter = Base.init("Derived.counter", 7);
    private int x = init("Derived.x", 5);
    private final String name;
    private Object ref = new Object();
    Derived(String name) {
      super();
      this.name = name;
      log.append("Derived.ctor;");
    }
    @Override String describe() { return "derived x=" + x + " name=" + name + " ref=" + (ref == null ? "null" : "set") + " base=" + baseValue; }
  }

  static class Holder {
    static { log.append("Holder.clinit;"); }
    static int value = Other.value + 1;
  }

  static class Other {
    static { log.append("Other.clinit;"); }
    static int value = Holder.value + 10;    // cycle: sees Holder.value == 0
  }

  static int mark(String what, int v) { log.append(what).append(';'); return v; }

  static class Shape {
    final int sides;
    Shape() { sides = sides(); }
    int sides() { return 0; }
  }
  static class Tri extends Shape { int sides() { return 3; } }
  static class Quad extends Shape { int bonus = 1; int sides() { return 4 + bonus; } }

  public static void main(String[] args) {
    log.append("main;");
    int c = Derived.CONSTANT;
    log.append("constant=").append(c).append(';');
    System.out.println(log.toString()); log.setLength(0);
    Derived d = new Derived("first");
    System.out.println(log.toString()); log.setLength(0);
    new Derived("second");
    System.out.println(log.toString()); log.setLength(0);
    System.out.println("counter " + Derived.counter + " describe " + d.describe());
    System.out.println("cycle " + Holder.value + " " + Other.value);
    System.out.println(log.toString()); log.setLength(0);
    // A failing static initializer: SemInitFailure.
    // Interface initialization through default methods: SemInterfaceInit.
    int total = 0;
    for (int i = 0; i < 30000; i++) {
      Shape s = (i % 3 == 0) ? new Tri() : (i % 3 == 1) ? new Quad() : new Shape();
      total += s.sides * 10 + s.sides();
    }
    System.out.println("shapes " + total);
  }
}
