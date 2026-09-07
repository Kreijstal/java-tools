public class StaticFieldProbe {
  static int counter;
  static int bump() { counter += 3; return counter; }
  static int run(int n) { int acc = 0; for (int i = 0; i < n; i++) acc += bump(); return acc; }
  public static void main(String[] args) { System.out.println(run(50) + counter); }
}
