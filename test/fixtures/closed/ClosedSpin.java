// A loop that never blocks. Its only host call is in a method a save cannot
// stop in, so the save has to come to rest in main.
public class ClosedSpin {
  static long state = 1;
  static void work() {
    if (Thread.currentThread() == null) state = 0;
    for (int i = 0; i < 2000; i++) state = state * 6364136223846793005L + 1442695040888963407L;
  }
  public static void main(String[] args) {
    for (int frame = 0; frame < 600000; frame++) work();
    System.out.println(state);
  }
}
