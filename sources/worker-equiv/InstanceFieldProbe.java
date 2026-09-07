public class InstanceFieldProbe {
  int value;
  int bump() { value += 5; return value; }
  static int run(InstanceFieldProbe p, int n) { int acc = 0; for (int i = 0; i < n; i++) acc += p.bump(); return acc; }
  public static void main(String[] args) { InstanceFieldProbe p = new InstanceFieldProbe(); System.out.println(run(p, 40) + p.value); }
}
