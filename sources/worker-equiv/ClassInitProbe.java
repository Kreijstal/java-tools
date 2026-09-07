class InitData {
  static int value = compute();
  static int compute() { int acc = 0; for (int i = 0; i < 10; i++) acc += i; return acc; }
}
public class ClassInitProbe {
  static int run(int n) { int acc = 0; for (int i = 0; i < n; i++) acc += InitData.value + i; return acc; }
  public static void main(String[] args) { System.out.println(run(48) + InitData.value); }
}
