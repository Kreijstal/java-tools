public class ClosedOverflowLoop {
  public static int sum(int[] values, int rounds) {
    int checksum = 0;
    for (int r = 0; r < rounds; r++) {
      for (int i = 0; i < values.length; i++) {
        values[i] = (values[i] + r) & 255;
        checksum += values[i];
      }
    }
    return checksum;
  }
  public static void main(String[] args) {
    int[] small = new int[1];
    small[0] = sum(small, 1);
  }
}
