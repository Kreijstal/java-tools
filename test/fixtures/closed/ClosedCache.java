public class ClosedCache {
  static int count = 1;
  static Object lock = new Object();
  static int unused() { return 17; }
  static synchronized int sum(int n) {
    synchronized (lock) {
      try {
        int result = 0;
        for (int i = 0; i < n; i++) result += i;
        return result + count++;
      } finally {
        count++;
      }
    }
  }
  public static void main(String[] args) {
    System.out.println(sum(10));
  }
}
