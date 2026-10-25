// Long Math helpers and shifts at Long.MIN_VALUE edges, and narrowing stores
// (i2b / i2s / i2c, byte/short/char arrays written from int).
public class SemLongMathNarrow {
  // java.lang.Math's long helpers, written out (the JDK's algorithms) so this
  // fixture tests the bytecode; SemLongMathLibrary calls the library ones.
  static long floorDiv(long x, long y) {
    long r = x / y;
    if ((x ^ y) < 0 && (r * y != x)) r--;
    return r;
  }
  static long floorMod(long x, long y) { return x - floorDiv(x, y) * y; }
  static int signum(long i) { return (int) ((i >> 63) | (-i >>> 63)); }
  static int trailingZeros(long v) {
    if (v == 0) return 64;
    int n = 0;
    while ((v & 1L) == 0) { v >>>= 1; n++; }
    return n;
  }

  static long kernel(long[] v, int n) {
    long acc = 0;
    for (int i = 0; i < n; i++) {
      long x = v[i], y = v[(i + 1) % n];
      acc += Math.abs(x) ^ Math.min(x, y) ^ Math.max(x, y);
      if (y != 0) {
        acc += floorDiv(x, y) * 7 + floorMod(x, y);
        acc += x / y + x % y;
      }
      acc += (x >>> (i & 63)) + (x >> (i + 1)) + (x << i);   // shift counts are masked to 6 bits
      acc += x >>> 64 + i;                                   // ditto, count >= 64
      acc = acc * 6364136223846793005L + 1442695040888963407L;
    }
    return acc;
  }

  static int narrow(byte[] b, short[] s, char[] c, int[] src) {
    int acc = 0;
    for (int i = 0; i < src.length; i++) {
      int v = src[i];
      b[i] = (byte) v;
      s[i] = (short) v;
      c[i] = (char) v;
      acc += b[i] + s[i] + c[i];
      acc ^= (byte) (v >> 3) * 31 + (short) (v * 3) + (char) (v - 1);
    }
    return acc;
  }

  public static void main(String[] args) {
    long[] v = {Long.MIN_VALUE, Long.MAX_VALUE, -1, 1, 0, -7, 7, 3, -3, Long.MIN_VALUE + 1, 1L << 40, -(1L << 33), 123456789012345L, -2};
    long acc = 0;
    for (int iter = 0; iter < 20000; iter++) acc = acc * 31 + kernel(v, v.length - (iter & 3));
    System.out.println("kernel " + acc);

    System.out.println("abs " + Math.abs(Long.MIN_VALUE + 1));  // abs(Long/Integer.MIN_VALUE): SemLongEdges
    System.out.println("minmax " + Math.min(Long.MIN_VALUE, Long.MAX_VALUE) + " " + Math.max(-1L, Long.MIN_VALUE));
    System.out.println("floorDiv " + floorDiv(-7L, 2L) + " " + floorDiv(7L, -2L) + " " + floorDiv(Long.MIN_VALUE, -1L) + " " + floorDiv(-1L, Long.MAX_VALUE));
    System.out.println("floorMod " + floorMod(-7L, 2L) + " " + floorMod(7L, -2L) + " " + floorMod(Long.MIN_VALUE, -1L) + " " + floorMod(Long.MIN_VALUE, 3L));
    System.out.println("div " + (Long.MIN_VALUE / -1L) + " " + (Long.MIN_VALUE % -1L) + " " + (-7L / 2) + " " + (-7L % 2));
    try { System.out.println(floorDiv(1L, 0L)); } catch (ArithmeticException e) { System.out.println("floorDiv by zero"); }
    System.out.println("ushr " + (Long.MIN_VALUE >>> 1) + " " + (-1L >>> 63) + " " + (-1L >>> 64) + " " + (-1L >>> 65) + " " + (Long.MIN_VALUE >> 63));
    System.out.println("shl " + (1L << 63) + " " + (1L << 64) + " " + (3L << -1));
    int shift = 33;
    System.out.println("int shift " + (1 << shift) + " " + (-1 >>> shift) + " " + (-1 >>> 32));
    System.out.println("negate " + (-Long.MIN_VALUE) + " " + (Long.MIN_VALUE - 1) + " " + (Long.MAX_VALUE + 1));
    System.out.println("mul " + (Long.MIN_VALUE * -1) + " " + (0x7fffffffffffffffL * 3) + " " + trailingZeros(Long.MIN_VALUE));
    System.out.println("cmp " + Long.compare(Long.MIN_VALUE, 0) + " " + signum(-5L) + " " + (Long.MIN_VALUE < Long.MAX_VALUE));
    System.out.println("l2i " + (int) Long.MIN_VALUE + " " + (int) 0x1_8000_0001L + " " + (int) -1L + " " + (short) 0x12345678L + " " + (byte) 0x1ffL);

    int[] src = new int[48];
    for (int i = 0; i < src.length; i++) src[i] = (i * 0x01020407) ^ (i << 13) ^ -i * 977;
    src[0] = Integer.MIN_VALUE; src[1] = Integer.MAX_VALUE; src[2] = 0xff; src[3] = 0x80; src[4] = 0x7fff; src[5] = 0x8000; src[6] = 0xffff; src[7] = 0x10000; src[8] = -1;
    byte[] b = new byte[48];
    short[] s = new short[48];
    char[] c = new char[48];
    int nacc = 0;
    for (int iter = 0; iter < 20000; iter++) {
      src[9 + (iter % 39)] += iter;
      nacc = nacc * 31 + narrow(b, s, c, src);
    }
    System.out.println("narrow " + nacc);
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < 9; i++) sb.append(b[i]).append('/').append(s[i]).append('/').append((int) c[i]).append(' ');
    System.out.println(sb.toString().trim());
    byte bb = (byte) 200;
    bb += 100;
    short ss = (short) 40000;
    ss *= 3;
    char cc = (char) -1;
    cc += 2;
    System.out.println("compound " + bb + " " + ss + " " + (int) cc);
    System.out.println("i2c sign " + (int) (char) (byte) -1 + " " + (short) (char) 0xffff + " " + (byte) (char) 0x180);
  }
}
