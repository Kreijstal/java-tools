// Calls from closed-module code into methods the module cannot hold: here
// anything using a lambda (invokedynamic). They run as ordinary frames while
// the caller is parked, returning every kind of value or throwing.
import java.util.function.IntUnaryOperator;

public class ClosedSlowCalls {
  // A <clinit> outside the module (it builds a lambda).
  static final IntUnaryOperator TRIPLE = x -> x * 3;
  static int seeded;
  static { seeded = TRIPLE.applyAsInt(14); }

  static class Box { final int v; Box(int v) { this.v = v; } }

  static int viaLambdaInt(int x) { IntUnaryOperator f = y -> y + 1; return f.applyAsInt(x); }
  static long viaLambdaLong(long x) { java.util.function.LongUnaryOperator f = y -> y * 2; return f.applyAsLong(x); }
  static double viaLambdaDouble(double x) { java.util.function.DoubleUnaryOperator f = y -> y / 4; return f.applyAsDouble(x); }
  static Box viaLambdaBox(int x) { java.util.function.IntFunction<Box> f = Box::new; return f.apply(x); }
  static String viaLambdaString(String s) { java.util.function.Function<String, String> f = t -> t + "!"; return f.apply(s); }
  static void viaLambdaThrow(int x) {
    Runnable r = () -> { throw new IllegalStateException("from lambda " + x); };
    r.run();
  }
  int base = 5;
  int viaLambdaInstance(int x) { IntUnaryOperator f = y -> y + base; return f.applyAsInt(x); }

  static int loop(int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) sum += viaLambdaInt(i);
    return sum;
  }

  public static void main(String[] args) {
    System.out.println("seeded " + seeded + " " + TRIPLE.applyAsInt(2));
    System.out.println("int " + viaLambdaInt(41) + " long " + viaLambdaLong(1L << 40) + " double " + viaLambdaDouble(10.0));
    System.out.println("box " + viaLambdaBox(9).v + " string " + viaLambdaString("hi"));
    System.out.println("instance " + new ClosedSlowCalls().viaLambdaInstance(10));
    try {
      viaLambdaThrow(7);
      System.out.println("no throw");
    } catch (IllegalStateException e) {
      System.out.println("caught " + e.getMessage());
    }
    System.out.println("loop " + loop(100));
  }
}
