public class ClosedExceptions {
  static int sideEffects;
  static final Object LOCK = new Object();
  static int[] data = new int[8];

  static class Box { int v; Box next; }
  static class CustomException extends RuntimeException {
    final int code;
    CustomException(int code) { super("custom " + code); this.code = code; }
  }

  static int thrower(int x) {
    if (x % 3 == 0) throw new CustomException(x);
    if (x % 5 == 0) throw new IllegalStateException("five");
    return x * 2;
  }

  static int catchCustom(int x) {
    int before = x * 10;
    try {
      before += 1;
      return thrower(x) + before;
    } catch (CustomException e) {
      return -e.code - before;
    } catch (IllegalStateException e) {
      return -1000 - before;
    }
  }

  static int nested(int x) {
    int r = 0;
    try {
      try {
        r += 1;
        r += thrower(x);
      } finally {
        r += 100;
        sideEffects++;
      }
    } catch (RuntimeException e) {
      r += 10000;
    }
    return r;
  }

  static int finallyReturn(int x) {
    try {
      if (x > 5) return x;
      return thrower(x);
    } finally {
      sideEffects += 7;
    }
  }

  static int loopWithHandler(int n) {
    int total = 0, failures = 0;
    for (int i = 0; i < n; i++) {
      try {
        total += thrower(i);
      } catch (CustomException e) {
        failures++;
        total -= e.code;
      } catch (RuntimeException e) {
        failures += 100;
      }
    }
    return total * 1000 + failures;
  }

  static int npeInTry(Box b) {
    int seen = 1;
    try {
      seen = 2;
      int v = b.v;
      seen = 3;
      return v;
    } catch (NullPointerException e) {
      return -seen;
    }
  }

  static int npeDeep(Box b) {
    try { return depth(b); } catch (NullPointerException e) { return -77; }
  }
  static int depth(Box b) { return b.next.next.v; }

  static int bounds(int i) {
    try { return data[i]; } catch (ArrayIndexOutOfBoundsException e) { return -i; }
  }

  // Guest-side parsing: jvm.js's Integer.parseInt does not throw
  // NumberFormatException for malformed input (a separate JRE gap).
  static int digits(String s) {
    int r = 0;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c < '0' || c > '9') throw new NumberFormatException(s);
      r = r * 10 + (c - '0');
    }
    return r;
  }

  static int parse(String s) {
    try { return digits(s); } catch (NumberFormatException e) { return -1; }
  }

  static int rethrow(int x) {
    try {
      return thrower(x);
    } catch (RuntimeException e) {
      sideEffects += 3;
      throw e;
    }
  }

  static int divide(int a, int b) {
    try { return a / b; } catch (ArithmeticException e) { return Integer.MIN_VALUE; }
  }

  static synchronized int syncStatic(int x) { sideEffects += x; return sideEffects; }
  synchronized int syncInstance(int x) { return x + 1; }

  static int syncBlock(int x) {
    synchronized (LOCK) {
      sideEffects += x;
      if (x == 13) throw new CustomException(13);
      return sideEffects;
    }
  }

  public static void main(String[] args) {
    StringBuilder out = new StringBuilder();
    for (int i = 0; i < 16; i++) out.append(catchCustom(i)).append(',');
    out.append('\n');
    for (int i = 0; i < 16; i++) out.append(nested(i)).append(',');
    out.append('\n');
    for (int i = 0; i < 8; i++) {
      try { out.append(finallyReturn(i)); } catch (RuntimeException e) { out.append('E'); }
      out.append(',');
    }
    out.append('\n').append(loopWithHandler(40)).append('\n');
    Box b = new Box();
    b.v = 9;
    out.append(npeInTry(b)).append(' ').append(npeInTry(null)).append(' ').append(npeDeep(b)).append('\n');
    out.append(bounds(3)).append(' ').append(bounds(8)).append(' ').append(bounds(-1)).append('\n');
    out.append(parse("123")).append(' ').append(parse("x")).append('\n');
    try { rethrow(3); } catch (CustomException e) { out.append("rethrown ").append(e.code).append('\n'); }
    out.append(divide(7, 2)).append(' ').append(divide(7, 0)).append('\n');
    out.append(syncStatic(5)).append(' ').append(new ClosedExceptions().syncInstance(4)).append(' ').append(syncBlock(2)).append('\n');
    try { syncBlock(13); } catch (CustomException e) { out.append("sync-exc ").append(syncBlock(1)).append('\n'); }
    out.append(sideEffects).append('\n');
    System.out.print(out.toString());
  }
}
