// ArrayStoreException: System.arraycopy copies the compatible prefix then
// throws on the first incompatible element; mismatched primitive kinds and
// non-arrays throw before copying; aastore checks the runtime element type.
public class SemArrayStore {
  static int copyAll(Object[] src, Object[] dst) {
    int stored = 0;
    for (int i = 0; i < src.length; i++) { dst[i] = src[i]; stored++; }   // aastore check per element
    return stored;
  }

  public static void main(String[] args) {
    int ok = 0, ase = 0;
    Object[] letters = {"a", "b", "c", "d"};
    Object[] mixedHot = {"a", "b", 3, "d"};
    for (int iter = 0; iter < 20000; iter++) {
      Object[] target = new String[4];
      try { ok += copyAll((iter & 1) == 0 ? letters : mixedHot, target); } catch (ArrayStoreException e) { ase++; ok += target[1] != null && target[2] == null ? 100 : 0; }
    }
    System.out.println("hot aastore ok=" + ok + " ase=" + ase);
    Object[] mixed = {"x", "y", 7, "z"};
    String[] strings = new String[4];
    try { System.arraycopy(mixed, 0, strings, 0, 4); } catch (ArrayStoreException e) { System.out.println("ase element"); }
    System.out.println("partial " + Show.of(strings));
    try { System.arraycopy(new int[2], 0, new long[2], 0, 2); } catch (ArrayStoreException e) { System.out.println("ase primitive kinds"); }
    try { System.arraycopy(new int[2], 0, new Object[2], 0, 2); } catch (ArrayStoreException e) { System.out.println("ase primitive to object"); }
    try { System.arraycopy("notarray", 0, new Object[2], 0, 1); } catch (ArrayStoreException e) { System.out.println("ase not array"); }
    Object[] upcast = new Integer[3];
    try { upcast[0] = "s"; } catch (ArrayStoreException e) { System.out.println("ase aastore"); }
  }
}
