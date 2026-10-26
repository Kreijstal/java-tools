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
    System.out.print(o);
    System.out.println();
    System.out.println(String.valueOf(o));
    System.out.println("concat " + o + " " + null);
    System.out.println(new StringBuilder().append(o).append((Object) null));
    System.out.println(new StringBuffer().append(o));
    Object nested = new Object() { @Override public String toString() { return "outer(" + o + ")"; } };
    System.out.println(nested);
    Object nul = new Object() { @Override public String toString() { return null; } };
    System.out.println(nul);
    System.out.println("x" + nul);
    long hot = 0;
    for (int i = 0; i < 20000; i++) {
      StringBuilder b = new StringBuilder().append(o).append(i).append(nested);
      hot += b.length() + String.valueOf(nested).length() + ("" + nul).length();
    }
    System.out.println("hot " + hot);
  }
}
