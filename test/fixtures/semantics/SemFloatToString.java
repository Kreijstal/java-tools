// Float (single-precision) decimal formatting: string concatenation and
// Float.toString print the shortest decimal that rounds to the float.
public class SemFloatToString {
  public static void main(String[] args) {
    float[] values = {0.1f, 0.3f, 1f / 3f, 17.44941f, -67.53868f, 1.0f, 100f, 1e7f, 1.0e-3f, 1e-4f,
      3.4028235e38f, 1.4e-45f, 2.14748365E9f, 9.223372E18f, -0.0f, Float.NaN, Float.NEGATIVE_INFINITY};
    float sum = 0f;
    for (int i = 1; i <= 20000; i++) sum += 1f / i;
    System.out.println("sum " + sum);
    for (float f : values) System.out.println(f + " " + Float.toString(f) + " " + String.valueOf(f) + " " + new StringBuilder().append(f).toString());
  }
}
