/*
 * Differential oracle for the wasm backends' opcode lowering.
 *
 * The structured backend (StructuredWasmCompiler.emitNode) and the dispatcher
 * backend (WasmJit) are SEPARATE emitters for the same bytecode, so a lowering
 * bug in one is invisible to the other -- and invisible to the whole test
 * suite, which never compares them against a real JVM. Tomb Racer's kr.e is
 * miscompiled by the structured backend and compiled correctly by the
 * dispatcher, with 516 wasm tests passing either way; this exists so that
 * class of bug fails a test instead of corrupting a guest array index.
 *
 * Every method is a loop (wasm only admits methods with a backward branch)
 * over deliberately awkward values: negatives, sign-extension boundaries,
 * shift counts above the word size, and division edge cases. Each returns an
 * order-dependent checksum, so a single wrong intermediate changes the result.
 */
public class OpcodeDifferential {

  static int mix(int acc, int v) { return acc * 31 + v; }

  // Shifts: Java masks the count to 5 bits for int and 6 for long; wasm does
  // the same, but only if the lowering does not add its own masking.
  public static int shiftInt(int n, int seed) {
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int v = seed + i;
      acc = mix(acc, v << (i & 63));
      acc = mix(acc, v >> (i & 63));
      acc = mix(acc, v >>> (i & 63));
      acc = mix(acc, -v >>> (i & 31));
      acc = mix(acc, -v >> (i & 31));
    }
    return acc;
  }

  public static int shiftLong(int n, int seed) {
    int acc = seed;
    for (int i = 0; i < n; i++) {
      long v = ((long) seed << 20) + i - 7L;
      acc = mix(acc, (int) (v << (i & 127)));
      acc = mix(acc, (int) (v >> (i & 127)));
      acc = mix(acc, (int) (v >>> (i & 127)));
      acc = mix(acc, (int) ((v >>> 32) ^ v));
    }
    return acc;
  }

  // Narrowing conversions: the classic source of a wrong index is a byte that
  // should sign-extend and does not (or a char that should not and does).
  public static int narrowing(int n, int seed) {
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int v = seed * (i + 1) - 12345;
      acc = mix(acc, (byte) v);
      acc = mix(acc, (short) v);
      acc = mix(acc, (char) v);
      acc = mix(acc, (byte) (v >>> 8));
      acc = mix(acc, (char) (v >> 3));
      acc = mix(acc, (int) (long) (byte) v);
    }
    return acc;
  }

  // Division and remainder with negative operands truncate toward zero in
  // Java; i32.div_s/rem_s agree, but only if operands are not swapped.
  public static int divRem(int n, int seed) {
    int acc = seed;
    for (int i = 1; i <= n; i++) {
      int a = seed - i * 7;
      int b = (i % 13) - 6;
      if (b == 0) b = 5;
      acc = mix(acc, a / b);
      acc = mix(acc, a % b);
      acc = mix(acc, (-a) / b);
      acc = mix(acc, a % (-b));
    }
    return acc;
  }

  // Element loads must sign-extend byte/short and zero-extend char. A wrong
  // extension here is exactly how a decoded offset becomes an invalid index.
  public static int arrayKinds(int n, int seed) {
    byte[] b = new byte[64];
    char[] c = new char[64];
    short[] s = new short[64];
    int[] ints = new int[64];
    for (int i = 0; i < 64; i++) {
      b[i] = (byte) (seed + i * 37);
      c[i] = (char) (seed + i * 37);
      s[i] = (short) (seed + i * 37);
      ints[i] = seed + i * 37;
    }
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int k = i & 63;
      acc = mix(acc, b[k]);
      acc = mix(acc, c[k]);
      acc = mix(acc, s[k]);
      acc = mix(acc, ints[k]);
      acc = mix(acc, b[k] & 0xff);
      acc = mix(acc, s[k] & 0xffff);
    }
    return acc;
  }

  // Comparisons and branch polarity across a join, which is where phi copies
  // and the structurer's if/else reconstruction interact.
  public static int branches(int n, int seed) {
    int acc = seed;
    int x = seed;
    for (int i = 0; i < n; i++) {
      if (x < 0) x = x + i; else x = x - i;
      if (x >= seed) acc = mix(acc, 1); else acc = mix(acc, -1);
      if ((x & 1) == 0) { acc = mix(acc, x >>> 1); } else { acc = mix(acc, x << 1); }
      int y = x > 0 ? x % 97 : -x % 89;
      acc = mix(acc, y);
    }
    return mix(acc, x);
  }

  // Nested loops with carried values: exercises loop-header phis, which the
  // dispatcher never builds because it re-materializes locals per block.
  public static int nestedLoops(int n, int seed) {
    int acc = seed;
    int carry = 0;
    for (int i = 0; i < n; i++) {
      for (int j = 0; j < (i & 7); j++) {
        carry = carry + (i ^ j);
        if (carry > 1000) carry -= 977;
      }
      acc = mix(acc, carry);
    }
    return acc;
  }

  // Long arithmetic round-tripping through int, where i64/i32 conversions are
  // emitted differently by the two backends.
  public static int longMath(int n, int seed) {
    int acc = seed;
    long v = seed;
    for (int i = 0; i < n; i++) {
      v = v * 6364136223846793005L + 1442695040888963407L;
      acc = mix(acc, (int) v);
      acc = mix(acc, (int) (v >>> 32));
      acc = mix(acc, Long.compare(v, i));
      if (v < 0) v = -v;
    }
    return acc;
  }

  /*
   * Compound assignment to an array element is the only common way javac
   * emits dup2, which duplicates the (arrayref, index) pair so the element can
   * be read and written in one expression. Getting that duplication's ORDER
   * wrong swaps an array with its index -- which is how a decoded offset turns
   * into an out-of-bounds access rather than a merely wrong number.
   */
  public static int compoundArray(int n, int seed) {
    int[] a = new int[64];
    byte[] b = new byte[64];
    char[] c = new char[64];
    short[] s = new short[64];
    for (int i = 0; i < 64; i++) {
      a[i] = seed + i;
      b[i] = (byte) (seed + i);
      c[i] = (char) (seed + i);
      s[i] = (short) (seed + i);
    }
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int k = i & 63;
      int j = (i * 7 + 3) & 63;
      a[k] += seed + i;
      a[j] ^= a[k];
      a[k]++;
      a[j] -= (a[k] >>> 3);
      b[k] += (byte) i;
      c[k] += (char) i;
      s[k] -= (short) i;
      acc = mix(acc, a[k]);
      acc = mix(acc, b[j]);
      acc = mix(acc, c[j]);
      acc = mix(acc, s[j]);
    }
    return acc;
  }

  // Two-slot stack shuffles reached through nested array indexing, where the
  // index is itself an array element (a[b[i]] patterns in decoders).
  public static int indirectIndex(int n, int seed) {
    int[] table = new int[64];
    byte[] idx = new byte[64];
    for (int i = 0; i < 64; i++) {
      table[i] = seed ^ (i * 2654435761L != 0 ? i * 31 : 1);
      idx[i] = (byte) (i * 5 + 1);
    }
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int k = i & 63;
      int p = idx[k] & 63;
      table[p] += table[k];
      acc = mix(acc, table[idx[p] & 63]);
      acc = mix(acc, table[p]);
    }
    return acc;
  }

  /*
   * The shape of a bytecode-stream decoder, which is what Tomb Racer's kr.e
   * is: a loop of static helper calls that each advance a position field on
   * the receiver and return a byte, with the decoded values then used as
   * array indices. The interesting part is the interaction, not any one
   * opcode -- the helpers get inlined, so the caller's cached read of the
   * position field must be invalidated by the inlined body's write to it. If
   * it is not, every later read is stale and a decoded index goes out of
   * range rather than merely wrong.
   */
  int pos;
  int limit;
  byte[] buf;

  static int readU8(OpcodeDifferential s) {
    int v = s.buf[s.pos] & 0xff;
    s.pos = s.pos + 1;
    if (s.pos >= s.limit) s.pos = 0;
    return v;
  }

  static int readU16(OpcodeDifferential s) {
    int hi = readU8(s);
    int lo = readU8(s);
    return (hi << 8) | lo;
  }

  public static int streamDecode(int n, int seed) {
    OpcodeDifferential s = new OpcodeDifferential();
    s.buf = new byte[257];
    s.limit = 257;
    s.pos = 0;
    for (int i = 0; i < 257; i++) s.buf[i] = (byte) (seed + i * 29);
    int[] table = new int[128];
    for (int i = 0; i < 128; i++) table[i] = seed ^ (i * 7919);
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int a = readU8(s);
      int b = readU16(s);
      int idx = (a ^ (b >>> 3)) & 127;
      table[idx] += a + b;
      acc = mix(acc, table[idx]);
      acc = mix(acc, s.pos);
      if ((a & 7) == 0) {
        s.pos = (s.pos + 3) % s.limit;
        acc = mix(acc, readU8(s));
      }
      acc = mix(acc, table[(s.pos) & 127]);
    }
    return mix(acc, s.pos);
  }

  /*
   * kr.e's actual allocation shape: a static array field, lazily created on
   * first use behind an ifnonnull guard, sized from an instance field that was
   * written moments earlier, then indexed for the rest of the method. Also
   * covers aaload, which the other shapes never reach because they use no
   * arrays of arrays.
   */
  static int[] lazyFlat;
  static int[][] lazyGrid;
  int width;

  public static int staticLazyArrays(int n, int seed) {
    lazyFlat = null;
    lazyGrid = null;
    OpcodeDifferential s = new OpcodeDifferential();
    s.width = 1 + (Math.abs(seed) % 7);
    if (lazyFlat == null) lazyFlat = new int[s.width * 128];
    if (lazyGrid == null) {
      lazyGrid = new int[s.width][];
      for (int i = 0; i < s.width; i++) lazyGrid[i] = new int[64];
    }
    int acc = seed;
    for (int i = 0; i < n; i++) {
      int k = i % (s.width * 128);
      lazyFlat[k] += seed + i;
      acc = mix(acc, lazyFlat[k]);
      int row = i % s.width;
      int[] r = lazyGrid[row];
      if (r != null) {
        int c = i & 63;
        r[c] += lazyFlat[k] >>> 2;
        acc = mix(acc, r[c]);
        acc = mix(acc, lazyGrid[row][(c + 1) & 63]);
      }
      acc = mix(acc, s.width);
    }
    return acc;
  }

  private static final String[] NAMES = {
    "shiftInt", "shiftLong", "narrowing", "divRem",
    "arrayKinds", "branches", "nestedLoops", "longMath",
    "compoundArray", "indirectIndex", "streamDecode", "staticLazyArrays",
  };

  static int dispatch(String name, int n, int seed) {
    if (name.equals("shiftInt")) return shiftInt(n, seed);
    if (name.equals("shiftLong")) return shiftLong(n, seed);
    if (name.equals("narrowing")) return narrowing(n, seed);
    if (name.equals("divRem")) return divRem(n, seed);
    if (name.equals("arrayKinds")) return arrayKinds(n, seed);
    if (name.equals("branches")) return branches(n, seed);
    if (name.equals("nestedLoops")) return nestedLoops(n, seed);
    if (name.equals("longMath")) return longMath(n, seed);
    if (name.equals("compoundArray")) return compoundArray(n, seed);
    if (name.equals("indirectIndex")) return indirectIndex(n, seed);
    if (name.equals("streamDecode")) return streamDecode(n, seed);
    if (name.equals("staticLazyArrays")) return staticLazyArrays(n, seed);
    throw new IllegalArgumentException(name);
  }

  public static void main(String[] args) {
    int n = args.length > 0 ? Integer.parseInt(args[0]) : 4000;
    int seed = args.length > 1 ? Integer.parseInt(args[1]) : 123456789;
    for (String name : NAMES) {
      System.out.println("RESULT " + name + " " + dispatch(name, n, seed));
    }
  }
}
