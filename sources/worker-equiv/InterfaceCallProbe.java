interface IntOp {
  int apply(int x);
}
class IntAdd implements IntOp {
  public int apply(int x) { return x + 2; }
}
public class InterfaceCallProbe {
  static int run(IntOp o, int n) { int acc = 0; for (int i = 0; i < n; i++) acc = o.apply(acc); return acc; }
  public static void main(String[] args) { IntOp o = new IntAdd(); System.out.println(run(o, 30) + o.apply(5)); }
}
