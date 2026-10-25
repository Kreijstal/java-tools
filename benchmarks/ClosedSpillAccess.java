// Run on the same runtime with 1 MiB (spilled fields) and 4 MiB (native
// fields). Only the loop is timed; loading and preparation are excluded.
public class ClosedSpillAccess {
  static final class Cell {
    int value = 7;
    long total;
    double scale = 1.25;
  }
  static byte[] ballast;
  static Cell[] cells;
  public static void main(String[] args) {
    ballast = new byte[1024 * 1024 - 4096];
    cells = new Cell[256];
    for (int i = 0; i < cells.length; i++) cells[i] = new Cell();
    Cell cell = cells[cells.length - 1];
    long started = System.nanoTime();
    for (int i = 0; i < 200000; i++) {
      cell.value++;
      cell.total += cell.value;
      cell.scale += 0.5;
    }
    long elapsed = System.nanoTime() - started;
    if (cell.value != 200007 || cell.total != 20001500000L || cell.scale != 100001.25)
      throw new Error("checksum");
    System.out.println("loopNs=" + elapsed + " value=" + cell.value + " total=" + cell.total);
  }
}
