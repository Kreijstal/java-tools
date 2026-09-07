public class CaptureProbe {
  static int calls;
  static int[] table = new int[64];
  int field;
  static int bump(int x) { calls++; return (x * 5 + 3) & 63; }
  static int walk(CaptureProbe p, int n) {
    int acc = p.field;
    for (int i = 0; i < n; i++) { acc = bump(acc + i); table[acc] += 1; }
    p.field = acc;
    return acc;
  }
  public static void main(String[] args) {
    CaptureProbe p = new CaptureProbe();
    int acc = 0;
    for (int round = 0; round < 300; round++) acc += walk(p, 32);
    System.out.println(acc + calls + table[7]);
  }
}
