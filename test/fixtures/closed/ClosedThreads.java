// Threads that stop inside closed-module code: contended monitors, wait and
// notifyAll, sleep and join. Every printed value is independent of the
// interleaving, so the output must equal HotSpot's.
public class ClosedThreads {
  static final Object lock = new Object();
  static int counter;

  static class Adder extends Thread {
    final int rounds;
    Adder(int rounds) { this.rounds = rounds; }
    public void run() {
      for (int i = 0; i < rounds; i++) {
        synchronized (lock) {
          int before = counter;
          // Holding the monitor across a sleep forces the other adder to
          // contend for it.
          if (i % 50 == 0) { try { Thread.sleep(1); } catch (InterruptedException e) { throw new RuntimeException(e); } }
          counter = before + 1;
        }
      }
    }
  }

  static class Buffer {
    private final int[] items = new int[4];
    private int head, size;
    synchronized void put(int value) throws InterruptedException {
      while (size == items.length) wait();
      items[(head + size) % items.length] = value;
      size++;
      notifyAll();
    }
    synchronized int take() throws InterruptedException {
      while (size == 0) wait();
      int value = items[head];
      head = (head + 1) % items.length;
      size--;
      notifyAll();
      return value;
    }
  }

  static long consumed;
  static synchronized void addConsumed(int value) { consumed += value; }

  public static void main(String[] args) throws Exception {
    Adder a = new Adder(400), b = new Adder(400);
    a.start(); b.start(); a.join(); b.join();
    System.out.println("counter " + counter);

    final Buffer buffer = new Buffer();
    Thread producer = new Thread() {
      public void run() {
        try { for (int i = 1; i <= 200; i++) buffer.put(i); buffer.put(-1); } catch (InterruptedException e) { throw new RuntimeException(e); }
      }
    };
    Thread consumer = new Thread() {
      public void run() {
        try { for (int v; (v = buffer.take()) != -1;) addConsumed(v); } catch (InterruptedException e) { throw new RuntimeException(e); }
      }
    };
    producer.start(); consumer.start(); producer.join(); consumer.join();
    System.out.println("consumed " + consumed);

    long start = System.currentTimeMillis();
    Thread.sleep(60);
    System.out.println("slept " + (System.currentTimeMillis() - start >= 50));
  }
}
