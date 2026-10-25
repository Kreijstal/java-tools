// System.arraycopy with forward and backward overlap for every element kind,
// and bounds/null failures (no partial copy).
public class SemArrayCopy {
  static int hashInts(int[] a) { int h = 1; for (int v : a) h = h * 31 + v; return h; }

  public static void main(String[] args) {
    int[] ints = new int[40];
    long[] longs = new long[40];
    short[] shorts = new short[40];
    char[] chars = new char[40];
    byte[] bytes = new byte[40];
    boolean[] bools = new boolean[40];
    float[] floats = new float[40];
    double[] doubles = new double[40];
    Object[] objs = new Object[40];
    Integer[] boxes = new Integer[64];
    for (int i = 0; i < 64; i++) boxes[i] = i;
    long h = 0;
    for (int iter = 0; iter < 20000; iter++) {
      int len = 1 + (iter % 13);
      int src = iter % 9, dst = (iter / 9) % 9;
      if (iter % 500 == 0) {
        for (int i = 0; i < 40; i++) {
          ints[i] = i; longs[i] = -i; shorts[i] = (short) (i * 1000); chars[i] = (char) ('a' + i);
          bytes[i] = (byte) (i * 7); bools[i] = (i % 3) == 0; floats[i] = i / 4f; doubles[i] = i / 8.0;
          objs[i] = boxes[i];
        }
      }
      System.arraycopy(ints, src, ints, dst, len);
      System.arraycopy(longs, dst, longs, src, len);
      System.arraycopy(shorts, src, shorts, dst, len);
      System.arraycopy(chars, dst, chars, src, len);
      System.arraycopy(bytes, src, bytes, dst, len);
      System.arraycopy(bools, dst, bools, src, len);
      System.arraycopy(floats, src, floats, dst, len);
      System.arraycopy(doubles, dst, doubles, src, len);
      System.arraycopy(objs, src, objs, dst, len);
      h = h * 31 + ints[dst] + longs[src] + shorts[dst] + chars[src] + bytes[dst]
        + (bools[src] ? 1 : 0) + (long) (floats[dst] * 4) + (long) (doubles[src] * 8) + ((Integer) objs[dst]);
    }
    System.out.println("loop " + h);

    int[] f = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    System.arraycopy(f, 0, f, 3, 7);
    System.out.println("forward " + Show.of(f));
    int[] b = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    System.arraycopy(b, 3, b, 0, 7);
    System.out.println("backward " + Show.of(b));
    long[] lf = {0, 1, 2, 3, 4, 5, 6, 7};
    System.arraycopy(lf, 1, lf, 2, 6);
    System.out.println("long " + Show.of(lf));
    double[] df = {0.5, 1.5, 2.5, 3.5, 4.5};
    System.arraycopy(df, 0, df, 1, 4);
    System.out.println("double " + Show.of(df));
    char[] cf = "abcdefgh".toCharArray();
    System.arraycopy(cf, 2, cf, 0, 6);
    System.out.println("char " + new String(cf));
    String[] sf = {"a", "b", "c", "d", "e"};
    System.arraycopy(sf, 0, sf, 2, 3);
    System.out.println("object " + Show.of(sf));

    int[] bounds = {1, 2, 3, 4};
    int[] target = new int[4];
    try { System.arraycopy(bounds, 1, target, 0, 4); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe src"); }
    try { System.arraycopy(bounds, 0, target, 2, 3); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe dst"); }
    try { System.arraycopy(bounds, -1, target, 0, 1); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe negative"); }
    try { System.arraycopy(bounds, 0, target, 0, -1); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe length"); }
    System.out.println("untouched " + Show.of(target));
    try { System.arraycopy(null, 0, target, 0, 1); } catch (NullPointerException e) { System.out.println("npe src"); }
    try { System.arraycopy(bounds, 0, null, 0, 1); } catch (NullPointerException e) { System.out.println("npe dst"); }

    // ArrayStoreException cases: SemArrayStore.
    Number[] nums = new Number[3];
    System.arraycopy(new Integer[] {1, 2, 3}, 0, nums, 0, 3);
    System.out.println("widen " + Show.of(nums));
    System.arraycopy(nums, 0, nums, 0, 0);
    System.out.println("zero ok " + hashInts(new int[] {1, 2}));
  }
}
