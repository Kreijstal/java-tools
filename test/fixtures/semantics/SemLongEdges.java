// Long edge cases: division by zero throws ArithmeticException (ldiv, lrem,
// idiv, irem); Math.abs(Long.MIN_VALUE) and Math.abs(Integer.MIN_VALUE) wrap
// to themselves.
public class SemLongEdges {
  static long divide(long x, long y) { return x / y + x % y; }
  static int divide(int x, int y) { return x / y + x % y; }

  public static void main(String[] args) {
    long[] divisors = {3, -1, 0, 7, Long.MIN_VALUE};
    long acc = 0;
    int thrown = 0;
    for (int iter = 0; iter < 20000; iter++) {
      long y = divisors[iter % divisors.length];
      try { acc += divide(Long.MAX_VALUE - iter, y); } catch (ArithmeticException e) { thrown++; }
      try { acc += divide(iter, (int) y); } catch (ArithmeticException e) { thrown++; }
    }
    System.out.println("divide " + acc + " thrown=" + thrown);
    long z = divisors[2];
    try { System.out.println(5L / z); } catch (ArithmeticException e) { System.out.println("ldiv " + e.getMessage()); }
    try { System.out.println(5L % z); } catch (ArithmeticException e) { System.out.println("lrem " + e.getMessage()); }
    long abs = 0;
    for (int iter = 0; iter < 20000; iter++) abs += Math.abs(Long.MIN_VALUE + (iter & 1));
    System.out.println("abs " + Math.abs(Long.MIN_VALUE) + " " + abs + " " + Math.abs(Integer.MIN_VALUE));
  }
}
