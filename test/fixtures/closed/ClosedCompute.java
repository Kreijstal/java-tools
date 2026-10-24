public class ClosedCompute {
  static int counter;
  static long seed = 12345L;
  static float[] table = new float[64];
  static int[][] grid = new int[8][8];
  static Shape[] shapes;
  static StringBuilder log = new StringBuilder();

  interface Shape { int area(); int perimeter(); }
  static abstract class Base implements Shape {
    int id;
    Base(int id) { this.id = id; }
    public int perimeter() { return 0; }
    int tag() { return id * 3; }
  }
  static final class Square extends Base {
    int side;
    Square(int id, int side) { super(id); this.side = side; }
    public int area() { return side * side; }
    public int perimeter() { return 4 * side; }
  }
  static class Rect extends Base {
    int w, h;
    Rect(int id, int w, int h) { super(id); this.w = w; this.h = h; }
    public int area() { return w * h; }
    int tag() { return super.tag() + 1; }
  }
  static class Node { int value; Node next; Node(int v, Node n) { value = v; next = n; } }

  static int next() {
    seed = seed * 6364136223846793005L + 1442695040888963407L;
    return (int) (seed >>> 33);
  }

  static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

  static long mix(int a, long b, float c, double d) {
    long r = a;
    r ^= b << 7;
    r += (long) (c * 1000f);
    r -= (long) (d * 1e6);
    r = (r >>> 3) | (r << 61);
    return r + (a % 7) - (b / 3) + (b % 5);
  }

  static int divisions(int a, int b) {
    int r = 0;
    r += a / b;
    r += a % b;
    r += Integer.MIN_VALUE / -1;
    r += Integer.MIN_VALUE % -1;
    return r;
  }

  static int classify(int x) {
    switch (x & 15) {
      case 0: return 10;
      case 1: case 2: return 20;
      case 5: return 50;
      case 9: counter++; return 90;
      default: return -1;
    }
  }

  static int sparse(int x) {
    switch (x) {
      case -100000: return 1;
      case 7: return 2;
      case 1 << 20: return 3;
      default: return 4;
    }
  }

  static float fill() {
    float sum = 0;
    for (int i = 0; i < table.length; i++) {
      table[i] = (float) Math.sin(i * 0.1) * 2.5f;
      sum += table[i];
    }
    return sum;
  }

  static int gridWalk() {
    int total = 0;
    for (int y = 0; y < grid.length; y++)
      for (int x = 0; x < grid[y].length; x++) {
        grid[y][x] = (x * 31 + y * 17) & 0xff;
        if (((x + y) & 3) == 0) continue;
        total += grid[y][x];
        if (total > 100000) break;
      }
    return total;
  }

  static int shapeTotals() {
    int area = 0, perimeter = 0, tags = 0;
    for (Shape s : shapes) {
      area += s.area();
      perimeter += s.perimeter();
      if (s instanceof Base) tags += ((Base) s).tag();
      if (s instanceof Square) tags += 1000;
    }
    return area * 7 + perimeter * 3 + tags;
  }

  static int listSum(Node head) {
    int sum = 0;
    for (Node n = head; n != null; n = n.next) sum += n.value;
    return sum;
  }

  static byte[] bytes(int n) {
    byte[] out = new byte[n];
    for (int i = 0; i < n; i++) out[i] = (byte) (i * 37);
    return out;
  }

  static int checksum(byte[] data) {
    int h = 0;
    for (byte b : data) h = h * 31 + (b & 0xff);
    char[] chars = new char[4];
    chars[1] = (char) 0xfffe;
    short[] shorts = { -1, 32767 };
    return h + chars[1] + shorts[0] + shorts[1];
  }

  static int nullField(Node n) { return n.value; }
  static int outOfBounds(int[] a, int i) { return a[i]; }

  static String describe(int n) {
    StringBuilder sb = new StringBuilder();
    sb.append("n=").append(n).append(',').append(n * 2L).append(':').append(fib(n % 15));
    return sb.toString();
  }

  public static void main(String[] args) {
    shapes = new Shape[] { new Square(1, 3), new Rect(2, 4, 5), new Square(3, 7), new Rect(4, 1, 9) };
    Node head = null;
    for (int i = 0; i < 50; i++) head = new Node(i * i, head);
    long acc = 0;
    for (int round = 0; round < 200; round++) {
      acc += next();
      acc += mix(round, acc, round * 0.5f, round * 0.25);
      acc += divisions(round * 13 - 1000, round % 9 + 1);
      acc += classify(round) + sparse(round == 7 ? 7 : round << 20 >> 20);
      acc += shapeTotals() + listSum(head) + gridWalk();
      acc += (long) (fill() * 100);
      acc += checksum(bytes(round + 1));
    }
    System.out.println(acc);
    System.out.println(counter);
    System.out.println(fib(20));
    System.out.println(describe(12));
    try { System.out.println(nullField(null)); } catch (NullPointerException e) { System.out.println("npe"); }
    try { System.out.println(outOfBounds(new int[3], 3)); } catch (ArrayIndexOutOfBoundsException e) { System.out.println("aioobe"); }
    try { System.out.println(divisions(1, 0)); } catch (ArithmeticException e) { System.out.println("arith"); }
    Object o = "str";
    try { Node bad = (Node) o; System.out.println(bad); } catch (ClassCastException e) { System.out.println("cce"); }
  }
}
