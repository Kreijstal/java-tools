public class ExceptionProbe {
  static int guard(int x) { if (x < 0) throw new IllegalArgumentException("neg"); return x; }
  static int run(int n) { int caught = 0; for (int i = 0; i < n; i++) { try { guard(i - 5); } catch (RuntimeException e) { caught++; } } return caught; }
  public static void main(String[] args) { System.out.println(run(40)); }
}
