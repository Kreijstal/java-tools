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

  /*
   * Many live locals carried across a long loop. A wasm run that exhausts its
   * fuel budget is the ONE point where a structured module writes its SSA
   * values back into frame.locals, and it only writes the slots the SSA
   * builder recorded as reaching that block. Any live slot it misses keeps its
   * method-entry value when the interpreter resumes, so a loop bound can come
   * back stale and overrun its array by one. Tomb Racer's kr.e has 35 locals;
   * the other shapes here have under ten, which is not enough pressure.
   * Run with a small JVM_WASM_FUEL to force the spill path repeatedly.
   */
  public static int manyLocalsSpill(int n, int seed) {
    int a0 = seed, a1 = seed + 1, a2 = seed + 2, a3 = seed + 3, a4 = seed + 4;
    int a5 = seed + 5, a6 = seed + 6, a7 = seed + 7, a8 = seed + 8, a9 = seed + 9;
    int b0 = seed ^ 11, b1 = seed ^ 12, b2 = seed ^ 13, b3 = seed ^ 14;
    int b4 = seed ^ 15, b5 = seed ^ 16, b6 = seed ^ 17, b7 = seed ^ 18;
    int c0 = 1, c1 = 2, c2 = 3, c3 = 4, c4 = 5, c5 = 6, c6 = 7, c7 = 8;
    int bound = 64 + (Math.abs(seed) % 17);
    byte[] out = new byte[bound];
    int acc = seed;
    for (int i = 0; i < n; i++) {
      a0 += i; a1 ^= a0; a2 += a1; a3 ^= a2; a4 += a3;
      a5 ^= a4; a6 += a5; a7 ^= a6; a8 += a7; a9 ^= a8;
      b0 += a9; b1 ^= b0; b2 += b1; b3 ^= b2;
      b4 += b3; b5 ^= b4; b6 += b5; b7 ^= b6;
      c0 = (c0 + 1) & 31; c1 = (c1 + c0) & 31; c2 = (c2 + c1) & 31;
      c3 = (c3 + c2) & 31; c4 = (c4 + c3) & 31; c5 = (c5 + c4) & 31;
      c6 = (c6 + c5) & 31; c7 = (c7 + c6) & 31;
      // bound is loaded from a local that must survive every spill/resume
      for (int k = 0; k < bound; k++) out[k] = (byte) (a0 + k);
      acc = mix(acc, out[(i + c7) % bound]);
      acc = mix(acc, bound);
    }
    acc = mix(acc, a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8 + a9);
    acc = mix(acc, b0 + b1 + b2 + b3 + b4 + b5 + b6 + b7);
    return mix(acc, c0 + c1 + c2 + c3 + c4 + c5 + c6 + c7);
  }

  /*
   * Locals whose FIRST assignment is inside a loop. At the loop header such a
   * slot joins (undef from before the loop, the body's own definition), and a
   * single RPO pass over the phis merges that to "no kind" because the body's
   * value is not kinded yet. Consumers read an unkinded phi as a dead slot, so
   * the fuel-exit spill used to drop it and the interpreter resumed on the
   * stale entry value -- which is how Tomb Racer's kr.e lost the byte[6] in
   * slot 27 and indexed past its end. Reference slots matter most: a dropped
   * array reference means the next access uses the wrong array entirely.
   * Run with a small JVM_WASM_FUEL so the spill path actually executes.
   */
  public static int loopLocalArrays(int n, int seed) {
    int acc = seed;
    for (int i = 0; i < n; i++) {
      // every one of these slots is first written here, inside the loop
      byte[] small = new byte[6];
      int[] wide = new int[1 + (i & 15)];
      int w = wide.length;
      char[] chars = new char[w];
      for (int k = 0; k < 6; k++) small[k] = (byte) (seed + i + k);
      for (int k = 0; k < w; k++) { wide[k] = seed ^ (i * 31 + k); chars[k] = (char) (i + k); }
      int j = 0;
      while (j < w) { acc = mix(acc, wide[j] + chars[j]); j++; }
      acc = mix(acc, small[i % 6]);
      acc = mix(acc, w);
      if ((i & 3) == 0) {
        byte[] alt = new byte[3];
        alt[i % 3] = (byte) i;
        acc = mix(acc, alt[(i + 1) % 3]);
      }
    }
    return acc;
  }

  /*
   * kr.e's actual control-flow shape, which no shape above builds.
   *
   * Every shape above is a `for` loop, so its headers have exactly two
   * predecessors and its induction variables are syntactically obvious. The
   * method that motivated this oracle has 33 `while (true)` loops, 43 labels,
   * 41 labeled continues, 22 labeled breaks and zero `for` loops -- the
   * decompiler's rendering of obfuscated goto flow, now readable because the
   * gamepack has been decompiled and recompiles cleanly.
   *
   * Why that difference matters: a labeled `continue` from an inner loop is an
   * extra predecessor on an OUTER header, so one loop-carried value needs phis
   * at several headers at once and a header phi can take its back-edge
   * argument from another phi. Those are the phis a9d9138 had to kind to a
   * fixpoint, and an unkinded one is dropped from a mid-method exit's spill and
   * resumed stale (a597135). The reported kr.e signature was an index equal to
   * the length, i.e. a fill loop resuming on a drifted counter, so each shape
   * here keeps an index -- and in streamBoundLoops the BOUND too, since kr.e
   * reads its loop bounds out of the bit stream -- live across several headers.
   *
   * Run these with a small JVM_WASM_FUEL: the spill/resume path is the
   * mechanism, and at default fuel these loops may never exit mid-method.
   */
  public static int labeledBackEdges(int n, int seed) {
    int[] data = new int[48];
    int acc = seed;
    int idx = 0;
    int outer = 0;
    L0: while (true) {
      if (outer >= n) break L0;
      outer++;
      int inner = 0;
      L1: while (true) {
        if (inner >= 5) continue L0;
        inner++;
        idx = (idx + outer + inner) & 31;
        data[idx] = mix(data[idx], acc + inner);
        acc = mix(acc, data[idx]);
        if ((acc & 7) == 3) continue L1;
        if ((acc & 15) == 5) continue L0;
      }
    }
    return acc;
  }

  // The index and the length are both live across two headers, and the bound
  // check sits at the inner header. A resume on a stale idx indexes at exactly
  // buf.length, which is the signature this whole file exists for.
  public static int crossHeaderIndex(int n, int seed) {
    int[] buf = new int[17];
    int acc = seed;
    int i = 0;
    int guard = 0;
    L0: while (true) {
      if (guard >= n) break L0;
      guard++;
      L1: while (true) {
        if (i >= buf.length) { i = 0; continue L0; }
        buf[i] = mix(buf[i], acc + i);
        acc = mix(acc, buf[i]);
        i++;
        if ((acc & 3) == 0) continue L0;
        if ((acc & 31) == 7) break L1;
      }
      acc = mix(acc, i);
    }
    return acc;
  }

  // kr.e is a bit-stream decoder whose loop bounds are themselves read from the
  // stream, so `take` is loop-carried rather than a constant -- an unkinded
  // bound is as damaging as an unkinded counter.
  public static int streamBoundLoops(int n, int seed) {
    byte[] stream = new byte[64];
    int k = 0;
    while (k < stream.length) { stream[k] = (byte) (seed + k * 7); k++; }
    int[] out = new int[32];
    int acc = seed;
    int pos = 0;
    int rounds = 0;
    L0: while (true) {
      if (rounds >= n) break L0;
      rounds++;
      int take = (stream[pos & 63] & 7) + 1;
      int w = 0;
      L1: while (true) {
        if (w >= take) continue L0;
        int slot = (pos + w) & 31;
        out[slot] = mix(out[slot], stream[(pos + w) & 63]);
        acc = mix(acc, out[slot]);
        w++;
        pos++;
        if ((acc & 63) == 11) continue L0;
      }
    }
    return acc;
  }

  // A header phi whose back-edge argument is another phi, reached through
  // labeled flow instead of a for-loop nest. One reverse-postorder pass kinds
  // the inner phi only after giving up on the outer one.
  public static int phiOfPhi(int n, int seed) {
    int[] a = new int[24];
    int acc = seed;
    int x = seed & 7;
    int y = 0;
    int t = 0;
    L0: while (true) {
      if (t >= n) break L0;
      t++;
      int spins = 0;
      L1: while (true) {
        if (++spins > 6) break L1;
        y = x;
        x = (x + y + t) & 15;
        a[x] = mix(a[x], y);
        acc = mix(acc, a[x] + y);
        if ((acc & 3) == 1) continue L1;
        if ((acc & 7) == 2) continue L0;
        break L1;
      }
      acc = mix(acc, x + y);
    }
    return acc;
  }

  // Four nested headers with exits jumping two and three levels out, so a
  // single value is carried through headers it does not belong to.
  public static int deepLabeledExit(int n, int seed) {
    int[] g = new int[40];
    int acc = seed;
    int t = 0;
    L0: while (true) {
      if (t >= n) break L0;
      t++;
      int i = 0;
      L1: while (true) {
        if (i >= 3) continue L0;
        i++;
        int j = 0;
        L2: while (true) {
          if (j >= 3) continue L1;
          j++;
          int m = 0;
          L3: while (true) {
            if (m >= 3) continue L2;
            m++;
            int slot = (i * 9 + j * 3 + m) % g.length;
            g[slot] = mix(g[slot], acc + i + j + m);
            acc = mix(acc, g[slot]);
            if ((acc & 7) == 0) continue L1;
            if ((acc & 15) == 1) continue L0;
            if ((acc & 31) == 2) break L2;
          }
        }
      }
    }
    return acc;
  }

  /*
   * The same labeled graph with NO call in the loop body: the mixing is
   * inlined as acc*31+v, so the module contains no invoke and its blocks are
   * pure arithmetic, array access and branches.
   *
   * Read the census counters carefully when judging whether these shapes reach
   * the spill path. `exits` is the transient-exit count and increments whenever
   * a module leaves mid-method with its locals spilled -- that IS the path
   * a597135 named as the only point SSA values are written back to
   * frame.locals, and every labeled shape here reports exits >= 1.
   * `fuelExits` is NOT a general fuel counter: WasmJit only bumps it when the
   * exit status equals the entry pc, which its own comment calls "possible but
   * rare". A shape reporting exits=2 fuelExits=0 has exercised the spill twice;
   * do not read the zero as "never spilled" (I did, and added this shape on
   * that false premise -- it is kept because a call-free labeled loop is
   * genuinely different codegen, not because it changed the fuel behaviour).
   *
   * Note this returns the same checksum as crossHeaderIndex by construction:
   * the inlined mixing is arithmetically identical to mix(). The value being
   * equal is expected; what differs is the emitted module.
   */
  public static int callFreeLabeledLoop(int n, int seed) {
    int[] buf = new int[17];
    int acc = seed;
    int i = 0;
    int guard = 0;
    L0: while (true) {
      if (guard >= n) break L0;
      guard++;
      L1: while (true) {
        if (i >= buf.length) { i = 0; continue L0; }
        buf[i] = buf[i] * 31 + (acc + i);
        acc = acc * 31 + buf[i];
        i++;
        if ((acc & 3) == 0) continue L0;
        if ((acc & 31) == 7) break L1;
      }
      acc = acc * 31 + i;
    }
    return acc;
  }

  private static final String[] NAMES = {
    "shiftInt", "shiftLong", "narrowing", "divRem",
    "arrayKinds", "branches", "nestedLoops", "longMath",
    "compoundArray", "indirectIndex", "streamDecode", "staticLazyArrays",
    "manyLocalsSpill", "loopLocalArrays",
    "labeledBackEdges", "crossHeaderIndex", "streamBoundLoops",
    "phiOfPhi", "deepLabeledExit", "callFreeLabeledLoop",
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
    if (name.equals("manyLocalsSpill")) return manyLocalsSpill(n, seed);
    if (name.equals("loopLocalArrays")) return loopLocalArrays(n, seed);
    if (name.equals("labeledBackEdges")) return labeledBackEdges(n, seed);
    if (name.equals("crossHeaderIndex")) return crossHeaderIndex(n, seed);
    if (name.equals("streamBoundLoops")) return streamBoundLoops(n, seed);
    if (name.equals("phiOfPhi")) return phiOfPhi(n, seed);
    if (name.equals("deepLabeledExit")) return deepLabeledExit(n, seed);
    if (name.equals("callFreeLabeledLoop")) return callFreeLabeledLoop(n, seed);
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
