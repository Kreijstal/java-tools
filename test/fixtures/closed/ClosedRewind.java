import java.util.HashMap;
// Cumulative state of every storage kind: each round reads what the last one
// left, so anything a rewind misses shows up in the final hash.
public class ClosedRewind {
  static final class Node { final int value; Node next; Node(int value, Node next) { this.value = value; this.next = next; } }
  static final class Holder { Node current; long counter; byte[] bytes = new byte[32]; }
  static Node head;
  static Object[] table = new Object[5];
  static int[] counters = new int[16];
  static long total = 7;
  static double scale = 1.5;
  static String label = "";
  static HashMap<Integer, Integer> map = new HashMap<Integer, Integer>();
  static Holder holder = new Holder();
  static long round(int i) throws Exception {
    counters[i & 15] += i + counters[(i + 1) & 15];
    head = new Node((i * 37 + 11) ^ counters[(i + 3) & 15], head);
    int carried = holder.current == null ? 3 : holder.current.value;
    if (holder.current != null) holder.current.next = i % 7 == 0 ? null : holder.current.next;
    holder.current = (i & 1) == 0 && head.next != null ? head.next : head;
    holder.counter = holder.counter * 3 + holder.current.value + carried;
    holder.bytes[i & 31] += (byte) (holder.counter ^ i);
    Object previous = table[(i + 1) % 5];
    table[i % 5] = head;
    int seen = previous == null ? 1 : ((Node) previous).value;
    Integer old = map.get(i & 7);
    map.put(i & 7, (old == null ? 0 : old) * 5 + seen);
    label = (label + (char) ('a' + (seen & 15)));
    if (label.length() > 12) label = label.substring(3);
    scale = scale * 1.0625 + 0.5;
    if (scale > 1000) scale /= 512;
    total = total * 31 + seen + map.get(i & 7) + label.hashCode() + (long) scale + holder.bytes[(i * 3) & 31];
    Thread.sleep(2);
    return total;
  }
  public static void main(String[] args) throws Exception {
    long last = 0;
    for (int i = 0; i < 90; i++) last = round(i) ^ (last >>> 3);
    int length = 0;
    for (Node node = head; node != null; node = node.next) length++;
    System.out.println(last + " " + length + " " + label + " " + map.size() + " " + holder.counter + " " + scale);
  }
}
