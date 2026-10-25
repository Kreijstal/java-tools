// tableswitch / lookupswitch: dense, sparse, negative keys, extremes,
// fallthrough, string and enum switches.
public class SemSwitch {
  enum Color { RED, GREEN, BLUE, ALPHA }

  static int dense(int k) {
    switch (k) {
      case 0: return 10;
      case 1: return 11;
      case 2: return 12;
      case 3: return 13;
      case 4: k += 100;   // fallthrough
      case 5: return k * 2;
      case 6: return 16;
      default: return -1;
    }
  }

  static int negativeDense(int k) {
    switch (k) {
      case -3: return 1;
      case -2: return 2;
      case -1: return 3;
      case 0: return 4;
      case 1: return 5;
      default: return 0;
    }
  }

  static int sparse(int k) {
    switch (k) {
      case Integer.MIN_VALUE: return 1;
      case -100000: return 2;
      case -7: return 3;
      case 0: return 4;
      case 99: return 5;
      case 1 << 20: return 6;
      case Integer.MAX_VALUE: return 7;
      default: return 0;
    }
  }

  static int extremes(int k) {
    switch (k) {
      case Integer.MAX_VALUE - 1: return 1;
      case Integer.MAX_VALUE: return 2;
      default: return 3;
    }
  }

  static int strings(String s) {
    switch (s) {
      case "alpha": return 1;
      case "beta": return 2;
      case "Aa": return 3;   // same hashCode as "BB"
      case "BB": return 4;
      case "": return 5;
      default: return 0;
    }
  }

  static int colors(Color c) {
    switch (c) {
      case RED: return 1;
      case BLUE: return 3;
      case ALPHA: return 4;
      default: return 9;
    }
  }

  static int chars(char c) {
    switch (c) {
      case 'a': case 'e': case 'i': case 'o': case 'u': return 1;
      case '￿': return 2;
      default: return 0;
    }
  }

  static long longKey(long k) {
    switch ((int) k) {   // key from a narrowed long
      case -1: return 5;
      case 0: return 6;
      default: return 7;
    }
  }

  public static void main(String[] args) {
    String[] words = {"alpha", "beta", "Aa", "BB", "", "gamma", "ALPHA"};
    Color[] colors = Color.values();
    int[] keys = {Integer.MIN_VALUE, -100000, -7, 0, 99, 1 << 20, Integer.MAX_VALUE, Integer.MAX_VALUE - 1, -8, 100};
    long acc = 0;
    for (int i = 0; i < 40000; i++) {
      int k = (i % 11) - 3;
      acc = acc * 31 + dense(k) + negativeDense(k) * 3 + sparse(keys[i % keys.length]) * 5
        + extremes(keys[i % keys.length]) * 7 + strings(words[i % words.length]) * 11
        + colors(colors[i % colors.length]) * 13 + chars((char) ('a' + (i % 26))) * 17 + longKey((long) k << 32 | (k & 0xffffffffL)) * 19;
    }
    System.out.println("loop " + acc);
    StringBuilder sb = new StringBuilder();
    for (int k = -4; k <= 8; k++) sb.append(dense(k)).append(',').append(negativeDense(k)).append(' ');
    System.out.println(sb.toString());
    sb.setLength(0);
    for (int k : keys) sb.append(sparse(k)).append(extremes(k)).append(' ');
    System.out.println(sb.toString());
    sb.setLength(0);
    for (String w : words) sb.append(strings(w));
    for (Color c : colors) sb.append(colors(c));
    sb.append(chars('￿')).append(chars('z'));
    System.out.println(sb.toString());
    try { strings(null); } catch (NullPointerException e) { System.out.println("npe string switch"); }
    try { colors(null); } catch (NullPointerException e) { System.out.println("npe enum switch"); }
  }
}
