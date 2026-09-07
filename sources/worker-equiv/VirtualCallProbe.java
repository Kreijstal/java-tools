class VirtualBase {
  int f(int x) { return x + 1; }
}
class VirtualDerived extends VirtualBase {
  int f(int x) { return x * 2; }
}
public class VirtualCallProbe {
  static int run(VirtualBase b, int n) { int acc = 1; for (int i = 0; i < n; i++) acc = b.f(acc); return acc; }
  public static void main(String[] args) { VirtualBase b = new VirtualDerived(); System.out.println(run(b, 20) + b.f(7)); }
}
