// A thread that never blocks: it polls a flag that another thread sets after
// sleeping, like a game loop running behind schedule. Module code must still
// give way to the sleeper (and to the host's event loop that wakes it).
public class ClosedPreemption {
  static volatile boolean done;
  static final Object lock = new Object();
  static int ticks;

  static class Setter extends Thread {
    public void run() {
      try { Thread.sleep(30); } catch (InterruptedException e) { throw new RuntimeException(e); }
      synchronized (lock) { ticks += 1000; }
      done = true;
    }
  }

  // Host calls (currentTimeMillis) and an uncontended monitor per round, no sleep.
  static long spin() {
    long rounds = 0;
    while (!done) {
      synchronized (lock) { ticks++; }
      if (System.currentTimeMillis() < 0) break;
      rounds++;
    }
    return rounds;
  }

  public static void main(String[] args) throws Exception {
    Setter setter = new Setter();
    setter.start();
    long rounds = spin();
    setter.join();
    System.out.println("done " + done + " spun " + (rounds > 0) + " setter ran " + (ticks >= 1000));
  }
}
