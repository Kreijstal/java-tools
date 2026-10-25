public class ClosedArrayPressure {
  static byte[] ballast;

  static class Raster {
    int width = 16, height = 16;
    int[] pixels = new int[width * height];

    void outline(int color) {
      int[] next = new int[width * height];
      int index = 0;
      for (int row = 0; row < height; row++) {
        for (int column = 0; column < width; column++) {
          int value = pixels[index];
          if (value == 0 && ((column > 0 && pixels[index - 1] != 0)
              || (row > 0 && pixels[index - width] != 0)
              || (column + 1 < width && pixels[index + 1] != 0)
              || (row + 1 < height && pixels[index + width] != 0))) value = color;
          next[index++] = value;
        }
      }
      pixels = next;
    }
  }

  public static void main(String[] args) {
    Raster raster = new Raster();
    raster.pixels[17] = 7;
    // The original buffer fits, but its replacement cannot fit the 1 MiB
    // native heap used by this regression. Java storage is still available.
    ballast = new byte[1024 * 1024 - 2048];
    raster.outline(3);
    int sum = 0;
    for (int value : raster.pixels) sum += value;
    System.out.println("outline " + sum + " " + raster.pixels[17] + " " + ballast.length);
  }
}
