// println(Object) / String.valueOf(Object) / concatenation call the
// argument's toString().
public class SemPrintObject {
  public static void main(String[] args) {
    StringBuilder sb = new StringBuilder("built");
    sb.append(' ').append(42);
    System.out.println(sb);
    System.out.println((Object) sb);
    System.out.println(String.valueOf(sb));
    System.out.println("concat " + sb);
    Object o = new Object() { @Override public String toString() { return "custom"; } };
    System.out.println(o);
  }
}
