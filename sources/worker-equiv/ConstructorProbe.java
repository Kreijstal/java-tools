public class ConstructorProbe {
  int a, b;
  ConstructorProbe(int a, int b) { this.a = a; this.b = b; }
  int sum() { return a + b; }
  static int run(int n) { int acc = 0; for (int i = 0; i < n; i++) acc += new ConstructorProbe(i, i * 2).sum(); return acc; }
  public static void main(String[] args) { System.out.println(run(30)); }
}
