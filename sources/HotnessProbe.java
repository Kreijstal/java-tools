public class HotnessProbe {
  static int step(int x) { return (x * 31 + 7) & 0xffff; }
  static int spin(int n) { int acc = 0; for (int i = 0; i < n; i++) acc = step(acc + i); return acc; }
  static int once(int x) { return x + 1; }
  public static void main(String[] args) {
    int acc = once(0);
    for (int round = 0; round < 400; round++) acc = spin(64) + step(acc);
    System.out.println(acc);
  }
}
