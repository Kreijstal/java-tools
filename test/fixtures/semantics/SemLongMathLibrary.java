// java.lang.Math / java.lang.Long helpers on longs (and ints), hot and at the
// Long.MIN_VALUE edges.
public class SemLongMathLibrary {
  static long kernel(long[] v) {
    long acc = 0;
    for (int i = 0; i < v.length; i++) {
      long x = v[i], y = v[(i + 1) % v.length];
      acc += Math.abs(x) ^ Math.min(x, y) ^ Math.max(x, y);
      if (y != 0) acc += Math.floorDiv(x, y) * 7 + Math.floorMod(x, y);
      int xi = (int) x, yi = (int) y;
      if (yi != 0) acc += Math.floorDiv(xi, yi) + Math.floorMod(xi, yi);
      acc += Long.signum(x) + Long.numberOfTrailingZeros(x) + Long.numberOfLeadingZeros(y) + Long.bitCount(x);
      acc = acc * 31 + 7;
    }
    return acc;
  }

  public static void main(String[] args) {
    long[] v = {Long.MIN_VALUE, Long.MAX_VALUE, -1, 1, 0, -7, 7, 3, -3, Long.MIN_VALUE + 1, 1L << 40, -(1L << 33), -2};
    long acc = 0;
    for (int iter = 0; iter < 20000; iter++) acc = acc * 31 + kernel(v);
    System.out.println("kernel " + acc);
    System.out.println("abs " + Math.abs(Long.MIN_VALUE) + " " + Math.abs(Long.MIN_VALUE + 1));
    System.out.println("floorDiv " + Math.floorDiv(-7L, 2L) + " " + Math.floorDiv(7L, -2L) + " " + Math.floorDiv(Long.MIN_VALUE, -1L) + " " + Math.floorDiv(-1L, Long.MAX_VALUE));
    System.out.println("floorMod " + Math.floorMod(-7L, 2L) + " " + Math.floorMod(7L, -2L) + " " + Math.floorMod(Long.MIN_VALUE, -1L) + " " + Math.floorMod(Long.MIN_VALUE, 3L));
    System.out.println("int floor " + Math.floorDiv(Integer.MIN_VALUE, -1) + " " + Math.floorMod(-7, 3));
    try { System.out.println(Math.floorDiv(1L, 0L)); } catch (ArithmeticException e) { System.out.println("floorDiv by zero"); }
    System.out.println("bits " + Long.signum(Long.MIN_VALUE) + " " + Long.numberOfTrailingZeros(Long.MIN_VALUE) + " " + Long.numberOfLeadingZeros(1L) + " " + Long.bitCount(-1L));
  }
}
