// Conversions: float/double -> int/long/short/byte/char saturation and
// truncation, i2f/l2f/l2d rounding (round-to-nearest-even, no double
// rounding), d2f overflow/underflow.
public class SemFloatConvert {
  static String bits(float f) { return Integer.toHexString(Float.floatToRawIntBits(f)); }

  public static void main(String[] args) {
    StringBuilder sb = new StringBuilder();
    double[] d = {Double.NaN, -0.5, 0.5, -1.5, 2.5, 1e10, -1e10, 1e19, -1e19, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY, 2147483647.5, -2147483648.9, 9.223372036854776E18};
    long sacc = 0;
    for (int iter = 0; iter < 20000; iter++) {
      double x = d[iter % d.length];
      float fx = (float) x;
      sacc = sacc * 31 + (int) x + (long) x + (int) fx + (long) fx + (short) x + (byte) fx + (char) x;
    }
    System.out.println("saturate " + sacc);
    sb.setLength(0);
    for (double x : d) sb.append((int) x).append('/').append((long) x).append('/').append((int) (float) x).append('/').append((long) (float) x).append(' ');
    System.out.println(sb.toString().trim());

    int[] ints = {16777217, 16777219, -16777217, Integer.MAX_VALUE, Integer.MIN_VALUE, 33554435, 123456789};
    long[] longs = {(1L << 53) + 1, (1L << 24) + 1, Long.MAX_VALUE, Long.MIN_VALUE, 0x7fffffbfffffffffL, 0x20000020000001L, -9007199254740993L, 9007199254740993L, 0x1000_0010_0000_0001L};
    int racc = 0;
    for (int iter = 0; iter < 20000; iter++) {
      racc = racc * 31 + Float.floatToIntBits((float) ints[iter % ints.length]) + Float.floatToIntBits((float) longs[iter % longs.length])
        + (int) Double.doubleToLongBits((double) longs[iter % longs.length]);
    }
    System.out.println("round " + racc);
    sb.setLength(0);
    for (int x : ints) sb.append(bits((float) x)).append(' ');
    for (long x : longs) sb.append(bits((float) x)).append(' ').append(Double.doubleToLongBits((double) x)).append(' ');
    System.out.println(sb.toString().trim());
    double dd = 0.1;
    float fromDouble = (float) dd;
    System.out.println("d2f " + bits(fromDouble) + " " + Double.doubleToLongBits((double) fromDouble) + " " + bits((float) 1e40) + " " + bits((float) 1e-50) + " " + bits((float) -1e-50) + " " + bits((float) 3.4028235677973366E38));
  }
}
