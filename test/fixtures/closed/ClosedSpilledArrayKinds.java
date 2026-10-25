public class ClosedSpilledArrayKinds {
  public static void main(String[] args) {
    // Every array exceeds the 64 KiB native heap, even after collection.
    int n = 65536, checks = 0;
    boolean[] zs = new boolean[n];
    byte[] bs = new byte[n];
    char[] cs = new char[n];
    short[] ss = new short[n];
    int[] is = new int[n];
    long[] ls = new long[n];
    float[] fs = new float[n];
    double[] ds = new double[n];
    zs[n - 1] = true;
    bs[n - 1] = -128;
    cs[n - 1] = 65535;
    ss[n - 1] = -32768;
    is[n - 1] = Integer.MIN_VALUE;
    ls[n - 1] = Long.MIN_VALUE;
    fs[n - 1] = -1.25f;
    ds[n - 1] = 3.5;
    if (zs[n - 1] && !zs[0]) checks++;
    if (bs[n - 1] == -128 && bs[0] == 0) checks++;
    if (cs[n - 1] == 65535 && cs[0] == 0) checks++;
    if (ss[n - 1] == -32768 && ss[0] == 0) checks++;
    if (is[n - 1] == Integer.MIN_VALUE && is[0] == 0) checks++;
    if (ls[n - 1] == Long.MIN_VALUE && ls[0] == 0) checks++;
    if (fs[n - 1] == -1.25f && fs[0] == 0) checks++;
    if (ds[n - 1] == 3.5 && ds[0] == 0) checks++;
    Object alias = is;
    if (alias == is && ((int[]) alias).length == n) checks++;
    try { checks += is[-1]; } catch (ArrayIndexOutOfBoundsException expected) { checks++; }
    try { is[n] = 9; } catch (ArrayIndexOutOfBoundsException expected) { checks++; }
    int[] absent = null;
    try { checks += absent[0]; } catch (NullPointerException expected) { checks++; }
    int[] copy = is.clone();
    copy[n - 1] = 17;
    if (copy != is && is[n - 1] == Integer.MIN_VALUE && copy[n - 1] == 17) checks++;
    System.arraycopy(copy, n - 1, is, 0, 1);
    if (is[0] == 17) checks++;
    System.out.println("kinds " + checks);
  }
}
