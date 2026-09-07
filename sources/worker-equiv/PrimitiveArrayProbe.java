public class PrimitiveArrayProbe {
  static int run(int[] a) { int acc = 0; for (int i = 0; i < a.length; i++) { a[i] = a[i] + i; acc += a[i]; } return acc; }
  public static void main(String[] args) { int[] a = new int[32]; for (int i = 0; i < a.length; i++) a[i] = i; System.out.println(run(a) + a[7]); }
}
