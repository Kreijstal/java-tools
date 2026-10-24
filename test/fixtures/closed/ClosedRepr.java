import java.util.HashMap;
import java.util.ArrayList;

public class ClosedRepr {
  static int si = 7; static long sl = -5L; static float sf = 1.5f; static double sd = 2.25;
  static boolean sz = true; static byte sb = -3; static char sc = 'x'; static short ss = -300;
  static String sstr = "static"; static int[] sarr = {1, 2, 3}; static Node shead;
  static Object[] sobjs = new Object[3];

  static class Base implements Cloneable {
    int a = 1; long b = 2L; Object ref = "base"; float f = 0.25f; double d = 0.5;
    int sum() { return a + (int) b; }
    public Object clone() throws CloneNotSupportedException { return super.clone(); }
  }
  static class Derived extends Base {
    char c = 'q'; Base other; int[] data = new int[4]; byte z = 5;
    int sum() { return super.sum() * 10 + c; }
  }
  static class Node {
    int value; Node next;
    Node(int value, Node next) { this.value = value; this.next = next; }
    public int hashCode() { return value * 31; }
    public boolean equals(Object o) { return o instanceof Node && ((Node) o).value == value; }
  }
  interface Shape { int area(); }
  static class Square implements Shape { int s; Square(int s) { this.s = s; } public int area() { return s * s; } }

  public static void main(String[] args) throws Exception {
    StringBuilder out = new StringBuilder();
    Derived d = new Derived();
    d.other = new Base();
    d.other.a = 42;
    d.data[2] = 99;
    out.append(d.sum()).append(' ').append(d.other.a).append(' ').append(d.data[2]).append(' ').append(d.ref).append('\n');
    d.ref = d;
    out.append(d.ref == d).append(' ').append(((Derived) d.ref).c).append('\n');
    Derived copy = (Derived) d.clone();
    copy.a = 1000; copy.data = new int[1];
    out.append(d.a).append(' ').append(copy.a).append(' ').append(copy.other == d.other).append(' ').append(copy.ref == d).append('\n');
    // statics of every kind
    si += 1; sl *= 3; sf *= 2; sd += 1; sz = !sz; sb--; sc++; ss *= 2;
    out.append(si).append(sl).append(sf).append(sd).append(sz).append(sb).append(sc).append(ss).append(sstr).append(sarr[1]).append('\n');
    shead = new Node(1, new Node(2, new Node(3, null)));
    int total = 0;
    for (Node n = shead; n != null; n = n.next) total += n.value;
    out.append(total).append('\n');
    // reference arrays, multi-dim, arrays of arrays
    Node[] nodes = new Node[5];
    for (int i = 0; i < nodes.length; i++) nodes[i] = new Node(i, i > 0 ? nodes[i - 1] : null);
    int[][] grid = new int[3][4];
    grid[1][2] = 7;
    long[][][] cube = new long[2][2][2];
    cube[1][1][1] = 5L;
    Object[][] mixed = new Object[2][];
    mixed[0] = nodes; mixed[1] = new String[] {"a", "b"};
    out.append(nodes[4].next.value).append(grid[1][2]).append(grid.length).append(grid[0].length)
       .append(cube[1][1][1]).append(((Node[]) mixed[0])[3].value).append(((String[]) mixed[1])[1]).append('\n');
    Node[] cloned = nodes.clone();
    cloned[0] = null;
    out.append(nodes[0] != null).append(cloned[1] == nodes[1]).append('\n');
    System.arraycopy(nodes, 1, nodes, 0, 3);
    out.append(nodes[0].value).append(nodes[2].value).append('\n');
    // guest objects in JRE collections
    HashMap<Node, String> map = new HashMap<>();
    map.put(new Node(5, null), "five");
    out.append(map.get(new Node(5, null))).append('\n');
    ArrayList<Shape> shapes = new ArrayList<>();
    for (int i = 1; i <= 3; i++) shapes.add(new Square(i));
    int area = 0;
    for (Shape s : shapes) area += s.area();
    out.append(area).append('\n');
    sobjs[0] = nodes; sobjs[1] = "str"; sobjs[2] = new int[] {4};
    out.append(((int[]) sobjs[2])[0]).append(sobjs[1]).append('\n');
    try {
      Object o = sobjs[1];
      Node bad = (Node) o;
      out.append(bad.value);
    } catch (ClassCastException e) { out.append("cce\n"); }
    try { nodes[9] = null; } catch (ArrayIndexOutOfBoundsException e) { out.append("aioobe\n"); }
    System.out.print(out.toString());
  }
}
