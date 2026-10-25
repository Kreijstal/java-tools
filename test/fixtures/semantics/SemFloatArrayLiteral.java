// A float array initializer after a hot loop (the method runs in a JIT tier
// by the time it reaches the initializer) keeps every constant exactly.
public class SemFloatArrayLiteral {
  public static void main(String[] args) {
    int n = 0;
    for (int i = 0; i < 30000; i++) n += i;
    float[] fs = {3.4028235e38f, 2.14748365E9f, 1.5f, -2.5f, 1e-40f};
    double[] ds = {1e300, 2147483648.5, 0.1};
    StringBuilder sb = new StringBuilder();
    for (float f : fs) sb.append(Integer.toHexString(Float.floatToRawIntBits(f))).append(' ');
    for (double d : ds) sb.append(Double.doubleToLongBits(d)).append(' ');
    System.out.println(sb.toString() + n);
  }
}
