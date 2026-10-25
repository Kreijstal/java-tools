// Exceptions thrown mid-loop after earlier stores: the stores before the
// faulting index must survive, the ones after must not happen.
public class SemArrayExceptions {
  static int[] sink;

  static int fillUntil(int[] a, int n, int value) {
    int i = 0;
    for (; i < n; i++) a[i] = value + i;          // AIOOBE when n > a.length
    return i;
  }

  static long fillLong(long[] a, int from, int n) {
    long sum = 0;
    for (int i = from; i < from + n; i++) { a[i] = i * 3L; sum += a[i]; }
    return sum;
  }

  static int copyThrough(int[] src, int[] dst) {
    int i = 0;
    for (; i < src.length; i++) dst[i] = src[i] * 2;   // dst may be shorter or null
    return i;
  }

  static int stridedStore(int[][] rows, int k) {
    int total = 0;
    for (int r = 0; r < rows.length; r++) { rows[r][k] = r + 1; total += r; }  // a null row -> NPE
    return total;
  }

  static int[] make(int n) { return new int[n]; }

  static int checksum(int[] a) {
    if (a == null) return -1;
    int h = 17;
    for (int v : a) h = h * 31 + v;
    return h;
  }

  public static void main(String[] args) {
    int caughtA = 0, caughtN = 0, caughtNeg = 0, hash = 0;
    for (int iter = 0; iter < 25000; iter++) {
      int len = 4 + (iter & 7);
      int[] a = new int[len];
      try {
        fillUntil(a, len + (iter % 3), iter);
      } catch (ArrayIndexOutOfBoundsException e) {
        caughtA++;
      }
      hash = hash * 31 + checksum(a);
      int[] dst = (iter % 5 == 0) ? null : new int[len - (iter & 1)];
      try {
        copyThrough(a, dst);
      } catch (NullPointerException e) {
        caughtN++;
      } catch (ArrayIndexOutOfBoundsException e) {
        caughtA++;
      }
      hash = hash * 31 + checksum(dst);
      try {
        sink = make((iter % 7 == 0) ? -(iter & 3) - 1 : (iter & 3));
      } catch (NegativeArraySizeException e) {
        caughtNeg++;
      }
    }
    System.out.println("loop caught aioobe=" + caughtA + " npe=" + caughtN + " neg=" + caughtNeg + " hash=" + hash);

    int[] a = new int[5];
    try { fillUntil(a, 9, 100); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe fill"); }
    System.out.println(Show.of(a));

    long[] l = new long[6];
    try { fillLong(l, 2, 10); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe long"); }
    System.out.println(Show.of(l));
    try { fillLong(l, -1, 3); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe negative index"); }
    System.out.println(Show.of(l));

    int[] src = {1, 2, 3, 4, 5, 6};
    int[] shortDst = new int[4];
    try { copyThrough(src, shortDst); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe copy"); }
    System.out.println(Show.of(shortDst));

    int[][] rows = {new int[3], new int[3], null, new int[3]};
    try { stridedStore(rows, 1); } catch (NullPointerException e) { System.out.println("npe row"); }
    System.out.println(Show.of(rows[0]) + Show.of(rows[1]) + Show.of(rows[3]));

    try { int[][] m = new int[3][-2]; System.out.println(m.length); } catch (NegativeArraySizeException e) { System.out.println("neg multi"); }
    try { Object[] o = new String[-1]; System.out.println(o.length); } catch (NegativeArraySizeException e) { System.out.println("neg object"); }
    int[] empty = new int[0];
    System.out.println("empty " + empty.length);

    // A store into an array whose length check fails after a successful
    // read-modify-write on an earlier element in the same statement.
    int[] b = {10, 20, 30};
    int j = 0;
    try {
      while (true) { b[j] += b[j + 1]; j++; }
    } catch (ArrayIndexOutOfBoundsException e) {
      System.out.println("rmw j=" + j + " " + Show.of(b));
    }
  }
}
