class RefCell {
  int v;
}
public class ReferenceArrayProbe {
  static int run(RefCell[] cells) { int acc = 0; for (int i = 0; i < cells.length; i++) { cells[i].v += i; acc += cells[i].v; } return acc; }
  public static void main(String[] args) { RefCell[] cells = new RefCell[16]; for (int i = 0; i < cells.length; i++) { cells[i] = new RefCell(); cells[i].v = i; } System.out.println(run(cells) + cells[3].v); }
}
