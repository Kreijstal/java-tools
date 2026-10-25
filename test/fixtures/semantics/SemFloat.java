// Float semantics: fcmpg/fcmpl with NaN, single-precision rounding of every
// intermediate, -0.0f.
public class SemFloat {
  static float filter(float[] in, float[] out, float a, float b) {
    float state = 0f;
    for (int i = 0; i < in.length; i++) {
      state = state * a + in[i] * b;     // must round to float after each op
      out[i] = state;
    }
    return state;
  }

  static int compares(float x, float y) {
    int r = 0;
    if (x < y) r |= 1;      // fcmpg
    if (x > y) r |= 2;      // fcmpl
    if (x <= y) r |= 4;
    if (x >= y) r |= 8;
    if (x == y) r |= 16;
    if (x != y) r |= 32;
    if (!(x < y)) r |= 64;
    if (!(x > y)) r |= 128;
    return r;
  }

  static int dcompares(double x, double y) {
    int r = 0;
    if (x < y) r |= 1;
    if (x > y) r |= 2;
    if (!(x <= y)) r |= 4;
    if (!(x >= y)) r |= 8;
    return r;
  }

  // Bits only: float-to-decimal formatting is covered by SemFloatToString.
  static String bits(float f) { return Integer.toHexString(Float.floatToRawIntBits(f)); }

  public static void main(String[] args) {
    float[] in = new float[257];
    for (int i = 0; i < in.length; i++) in[i] = (float) Math.sin(i * 0.37) * 1000.1f + i / 3f;
    float[] out = new float[in.length];
    int h = 0;
    float last = 0;
    for (int iter = 0; iter < 20000; iter++) {
      last = filter(in, out, 0.9137f, 0.0863f + (iter & 7) * 1e-7f);
      h = h * 31 + Float.floatToIntBits(last) + Float.floatToIntBits(out[iter % out.length]);
    }
    System.out.println("filter " + h + " " + bits(last));

    float sum = 0f;
    for (int i = 1; i <= 100000; i++) sum += 1f / i;
    System.out.println("harmonic " + bits(sum));
    float big = 16777216f;
    System.out.println("ulp " + bits(big + 1f) + " " + bits(big + 2f) + " " + bits(0.1f + 0.2f) + " " + bits(0.1f * 3f));
    float prod = 1f;
    for (int i = 0; i < 30; i++) prod = prod * 1.1f;
    System.out.println("prod " + bits(prod) + " fdiv " + bits(1f / 3f) + " frem " + bits(5.5f % 2.25f) + " " + bits(-5.5f % 2.25f));

    float[] specials = {Float.NaN, -0.0f, 0.0f, 1f, -1f, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY, Float.MIN_VALUE, Float.MAX_VALUE};
    int cacc = 0;
    for (int iter = 0; iter < 20000; iter++) {
      float x = specials[iter % specials.length], y = specials[(iter / specials.length) % specials.length];
      cacc = cacc * 31 + compares(x, y) + dcompares(x, y) * 256;
    }
    System.out.println("compares " + cacc);
    StringBuilder sb = new StringBuilder();
    for (float x : specials) sb.append(compares(x, Float.NaN)).append(',').append(compares(Float.NaN, x)).append(',').append(compares(x, -0.0f)).append(' ');
    System.out.println(sb.toString().trim());
    System.out.println("cmp " + Float.compare(0.0f, -0.0f) + " " + Float.compare(Float.NaN, Float.POSITIVE_INFINITY) + " " + Double.compare(-0.0, 0.0) + " " + (0.0f == -0.0f));
    float nz = -0.0f;
    System.out.println("negzero " + bits(nz) + " " + bits(nz + 0f) + " " + bits(nz * -1f) + " " + bits(-nz) + " " + bits(0f - 0f) + " " + bits(-(0f)) + " " + bits(1f / nz) + " " + bits(Math.min(0.0f, -0.0f)) + " " + bits(Math.max(-0.0f, 0.0f)) + " " + bits(Math.abs(-0.0f)));

  }
}
