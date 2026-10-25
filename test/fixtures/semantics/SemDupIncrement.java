// dup_x1 / dup_x2 / dup2_x1 / dup2_x2 shapes: post- and pre-increment and
// compound assignment on fields, statics and array elements used as values.
public class SemDupIncrement {
  int f;
  long lf;
  double df;
  static int sf;
  static long slf;
  static double sdf;

  static int arrayPostInc(int[] a, int n) {
    int i = 0, acc = 0;
    while (i < n) {
      acc += a[i++] += 3;          // iaload/iastore with dup_x2
      acc ^= a[i - 1]++;           // post-increment of an array element
    }
    return acc;
  }

  static long longArray(long[] a, int n) {
    long acc = 0;
    for (int i = 0; i < n; i++) {
      acc += a[i]++;               // dup2_x2
      acc += (a[i] += i) * 2;      // dup2_x2
      acc -= ++a[i];
    }
    return acc;
  }

  static double doubleArray(double[] a, int n) {
    double acc = 0;
    for (int i = 0; i < n; i++) {
      acc += a[i]++;
      acc += (a[i] *= 1.5);
    }
    return acc;
  }

  int fieldOps(int n) {
    int acc = 0;
    for (int i = 0; i < n; i++) {
      acc += f++;                  // dup_x1
      acc += ++f;
      acc += (f += i) & 0xff;
      lf += (lf++ & 7) + i;        // dup2_x1
      acc += (int) (lf++);
      df += df++ * 0.0 + 0.25;
      acc += (int) (df += 0.5);
    }
    return acc;
  }

  static long staticOps(int n) {
    long acc = 0;
    for (int i = 0; i < n; i++) {
      acc += sf++;
      acc += slf++;
      acc += (slf += sf) & 1023;
      sdf += 0.125;
      acc += (long) sdf++;
    }
    return acc;
  }

  static int index = 0;
  static int nextIndex() { return index++; }

  public static void main(String[] args) {
    int[] a = new int[64];
    long[] l = new long[64];
    double[] d = new double[64];
    long total = 0;
    for (int iter = 0; iter < 20000; iter++) {
      total += arrayPostInc(a, 1 + (iter & 63));
      total += longArray(l, 1 + (iter & 31));
      total += Double.doubleToLongBits(doubleArray(d, 1 + (iter & 15))) & 0xffff;   // not (long): d2l saturation is SemFloatConvert's
      if ((iter & 1023) == 0) for (int z = 0; z < d.length; z++) d[z] = 0.0;
    }
    System.out.println("arrays " + total + " a0=" + a[0] + " a63=" + a[63] + " l0=" + l[0] + " l31=" + l[31] + " d0=" + d[0]);

    SemDupIncrement o = new SemDupIncrement();
    long ftotal = 0;
    for (int iter = 0; iter < 20000; iter++) ftotal += o.fieldOps(5);
    System.out.println("fields " + ftotal + " f=" + o.f + " lf=" + o.lf + " df=" + o.df);

    long stotal = 0;
    for (int iter = 0; iter < 20000; iter++) stotal += staticOps(3);
    System.out.println("statics " + stotal + " sf=" + sf + " slf=" + slf + " sdf=" + sdf);

    // Evaluation order: the index expression runs once, before the RHS.
    int[] e = new int[4];
    e[nextIndex()] += nextIndex() * 10;
    e[nextIndex()]++;
    System.out.println("order " + Show.of(e) + " index=" + index);

    // Overflow through increments.
    o.f = Integer.MAX_VALUE;
    int before = o.f++;
    System.out.println("overflow " + before + " " + o.f);
    o.lf = Long.MAX_VALUE;
    long lbefore = o.lf++;
    System.out.println("loverflow " + lbefore + " " + o.lf);
    byte[] bytes = {127, -128};
    bytes[0]++;
    bytes[1]--;
    short[] shorts = {Short.MAX_VALUE};
    shorts[0] += 1;
    char[] chars = {'￿'};
    chars[0]++;
    System.out.println("narrow " + bytes[0] + " " + bytes[1] + " " + shorts[0] + " " + (int) chars[0]);
    int x = 5;
    x = x++ + ++x;
    System.out.println("x " + x);
  }
}
