// Array formatting for the semantics fixtures, written in plain Java so the
// fixtures depend on bytecode semantics rather than on java.util.Arrays.
public final class Show {
  private Show() {}
  public static String of(int[] a) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(", "); sb.append(a[i]); }
    return sb.append(']').toString();
  }
  public static String of(long[] a) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(", "); sb.append(a[i]); }
    return sb.append(']').toString();
  }
  public static String of(double[] a) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(", "); sb.append(a[i]); }
    return sb.append(']').toString();
  }
  public static String of(Object[] a) {
    StringBuilder sb = new StringBuilder("[");
    for (int i = 0; i < a.length; i++) { if (i > 0) sb.append(", "); sb.append(String.valueOf(a[i])); }
    return sb.append(']').toString();
  }
}
