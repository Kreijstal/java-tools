public class ClosedPreparationProgress {
  static int initialized;
  static { initialized = 7; }
  public static void main(String[] args) { initialized += 5; }
  static int work(int value) { return value * 3; }
}
