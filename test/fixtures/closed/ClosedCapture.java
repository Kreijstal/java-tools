// Frames of every shape on the stack while a thread sleeps in the module:
// nested calls, wide locals, operand stack under a call, a held monitor,
// a virtual call, a static synchronized method, and a second thread.
public class ClosedCapture {
  interface Step { long step(int round, long seed, double scale) throws Exception; }
  static class Leaf implements Step {
    int calls;
    public long step(int round, long seed, double scale) throws Exception {
      calls++;
      Thread.sleep(2);
      return seed + round + (long) scale + calls;
    }
  }
  static class Locked implements Step {
    final Step inner; long total;
    Locked(Step inner) { this.inner = inner; }
    public synchronized long step(int round, long seed, double scale) throws Exception {
      long before = total;
      total = before + 3 * inner.step(round, seed ^ 5L, scale * 1.5);
      return total - before;
    }
  }
  static int shared;
  static synchronized int bump(int by) throws Exception {
    int before = shared;
    Thread.sleep(1);
    shared = before + by;
    return shared;
  }
  static long mix(long a, long b, int c) { return a * 31 + b * 7 + c; }
  static long run(Step step, int rounds) throws Exception {
    long hash = 1234567890123L;
    double scale = 2.5;
    int[] seen = new int[rounds];
    for (int i = 0; i < rounds; i++) {
      hash = mix(hash, step.step(i, hash, scale), bump(1) > 0 ? i : -i);
      scale += 0.25;
      seen[i] = (int) (hash >>> 7);
    }
    long sum = 0;
    for (int value : seen) sum += value;
    return hash ^ sum;
  }
  public static void main(String[] args) throws Exception {
    final long[] other = new long[1];
    Thread thread = new Thread(new Runnable() {
      public void run() {
        try { other[0] = ClosedCapture.run(new Leaf(), 80); } catch (Exception e) { throw new RuntimeException(e); }
      }
    });
    thread.start();
    long mine = run(new Locked(new Locked(new Leaf())), 80);
    thread.join();
    System.out.println(mine + " " + other[0] + " " + shared);
  }
}
