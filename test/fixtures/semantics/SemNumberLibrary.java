// java.lang.Math / Integer / Long helpers beyond the basics: exact
// arithmetic, unsigned and bit operations, parsing, ulp and rounding edges.
public class SemNumberLibrary {
  static String exact(java.util.function.IntSupplier op) {
    try { return String.valueOf(op.getAsInt()); } catch (ArithmeticException e) { return "AE:" + e.getMessage(); }
  }

  static String exactLong(java.util.function.LongSupplier op) {
    try { return String.valueOf(op.getAsLong()); } catch (ArithmeticException e) { return "AE:" + e.getMessage(); }
  }

  // Long.divideUnsigned/remainderUnsigned by zero say "BigInteger divide by
  // zero" on JDK 8/11 and "/ by zero" on 17+ (and the message depends on the
  // dividend's sign on 11), so only the exception is compared.
  static String unsignedLong(java.util.function.LongSupplier op) {
    try { return String.valueOf(op.getAsLong()); } catch (ArithmeticException e) { return "AE"; }
  }

  public static void main(String[] args) {
    int[] ints = {0, 1, -1, 7, -7, 3, Integer.MAX_VALUE, Integer.MIN_VALUE, 0x12345678, 0x80000001};
    long[] longs = {0L, 1L, -1L, 7L, -7L, Long.MAX_VALUE, Long.MIN_VALUE, 0x123456789abcdefL, 1L << 40};
    StringBuilder sb = new StringBuilder();
    for (int a : ints) {
      sb.append(Integer.numberOfTrailingZeros(a)).append(',').append(Integer.rotateLeft(a, 5)).append(',')
        .append(Integer.rotateRight(a, 37)).append(',').append(Integer.reverse(a)).append(',')
        .append(Integer.reverseBytes(a)).append(',').append(Integer.toOctalString(a)).append(',')
        .append(Integer.toUnsignedString(a)).append(',').append(Integer.toUnsignedLong(a)).append(',')
        .append(Integer.highestOneBit(a)).append(',').append(Integer.bitCount(a)).append(' ');
      for (int b : new int[] {1, -1, 3, -3, 0}) {
        sb.append(exact(() -> Integer.divideUnsigned(a, b))).append('/').append(exact(() -> Integer.remainderUnsigned(a, b)))
          .append('/').append(exact(() -> Math.addExact(a, b))).append('/').append(exact(() -> Math.multiplyExact(a, b)))
          .append('/').append(exact(() -> Math.subtractExact(a, b))).append('/').append(exact(() -> Math.floorMod(a, b))).append(' ');
      }
      sb.append(exact(() -> Math.negateExact(a))).append(' ').append(exact(() -> Math.incrementExact(a))).append('\n');
    }
    for (long a : longs) {
      sb.append(Long.numberOfTrailingZeros(a)).append(',').append(Long.numberOfLeadingZeros(a)).append(',')
        .append(Long.rotateLeft(a, 13)).append(',').append(Long.rotateRight(a, 70)).append(',')
        .append(Long.reverse(a)).append(',').append(Long.reverseBytes(a)).append(',')
        .append(Long.toHexString(a)).append(',').append(Long.toBinaryString(a)).append(',')
        .append(Long.toOctalString(a)).append(',').append(Long.highestOneBit(a)).append(',')
        .append(Long.lowestOneBit(a)).append(',').append(Long.signum(a)).append(' ');
      for (long b : new long[] {1L, -1L, 3L, -3L, 0L, Long.MIN_VALUE}) {
        sb.append(unsignedLong(() -> Long.divideUnsigned(a, b))).append('/').append(unsignedLong(() -> Long.remainderUnsigned(a, b)))
          .append('/').append(Long.compareUnsigned(a, b)).append('/').append(exactLong(() -> Math.addExact(a, b)))
          .append('/').append(exactLong(() -> Math.multiplyExact(a, b))).append('/').append(exactLong(() -> Math.floorDiv(a, b))).append(' ');
      }
      sb.append(exact(() -> Math.toIntExact(a))).append('\n');
    }
    for (String s : new String[] {"0", "-0", "+5", "9223372036854775807", "-9223372036854775808", "9223372036854775808", "12x", "", "-", "7fffffffffffffff"}) {
      try { sb.append(Long.parseLong(s)).append(' '); } catch (NumberFormatException e) { sb.append("NFE:").append(e.getMessage()).append(' '); }
      try { sb.append(Long.parseLong(s, 16)).append(' '); } catch (NumberFormatException e) { sb.append("NFE16 "); }
    }
    sb.append('\n');
    double[] ds = {0.0, -0.0, 1.0, 0.1, 1e300, Double.MAX_VALUE, Double.MIN_VALUE, Double.MIN_NORMAL, 0.49999999999999994, -0.5, 2.5, -2.5, 1e19, -1e19, Double.NaN, Double.POSITIVE_INFINITY};
    for (double d : ds) {
      float f = (float) d;
      sb.append(Math.ulp(d)).append(',').append(Math.ulp(f)).append(',').append(Math.round(d)).append(',').append(Math.round(f))
        .append(',').append(Math.signum(d)).append(',').append(Math.copySign(1.5, d)).append(',').append(Math.copySign(2.5f, f)).append(' ');
    }
    sb.append('\n');
    long hot = 0;
    for (int i = 0; i < 200000; i++) {
      long x = i * 2654435761L;
      hot += Math.floorMod(x, 97L) + Math.floorDiv((int) x, 13) + Long.bitCount(x) + Integer.numberOfTrailingZeros((int) x | 1 << 20) + Math.round(i * 0.37) + Math.round(i * 0.37f);
    }
    sb.append("hot ").append(hot);
    System.out.println(sb);
  }
}
