import java.util.Arrays;

// Reference stores that are legal and must not raise ArrayStoreException:
// rows of multianewarray results, arrays of a superclass or interface,
// clones, Arrays.copyOf results and arrays filled through arraycopy. Each
// shape runs in a hot loop so the compiled tiers check it too.
public class SemArrayStoreShapes {
    interface Drawable { int id(); }
    static class State { int base = 1; }
    static class Picture extends State implements Drawable {
        final int n;
        Picture(int n) { this.n = n; }
        public int id() { return n + base; }
    }

    static int sum(Object[] row) {
        int total = 0;
        for (Object o : row) if (o != null) total += ((Drawable) o).id();
        return total;
    }

    static int round(int i) {
        Picture p = new Picture(i);
        int total = 0;

        Picture[][] grid = new Picture[7][3];
        grid[i % 7][i % 3] = p;
        total += sum(grid[i % 7]);

        Picture[][][] cube = new Picture[2][2][2];
        cube[i & 1][(i >> 1) & 1][(i >> 2) & 1] = p;
        total += sum(cube[i & 1][(i >> 1) & 1]);

        Picture[][] ragged = new Picture[3][];
        ragged[i % 3] = new Picture[2];
        ragged[i % 3][1] = p;
        total += sum(ragged[i % 3]);

        State[] states = new State[4];
        states[i & 3] = p;
        Drawable[] drawables = new Drawable[4];
        drawables[i & 3] = p;
        total += sum(drawables) + states.length;

        Picture[] cloned = new Picture[3].clone();
        cloned[i % 3] = p;
        total += sum(cloned);

        Picture[] copied = Arrays.copyOf(new Picture[] { p }, 4);
        copied[3] = p;
        total += sum(copied);

        Object[] widened = new Object[2];
        System.arraycopy(new Picture[] { p, p }, 0, widened, 0, 2);
        widened[0] = "text";
        total += widened.length;

        Picture[] target = new Picture[2];
        System.arraycopy(new Object[] { p, null }, 0, target, 0, 2);
        target[1] = p;
        total += sum(target);
        return total;
    }

    public static void main(String[] args) {
        long total = 0;
        for (int i = 0; i < 20000; i++) total += round(i);
        System.out.println("total " + total);
        try {
            Object[] narrow = new Picture[1][2];
            narrow[0] = new State[2];
            System.out.println("no exception");
        } catch (ArrayStoreException e) {
            System.out.println("ASE " + e.getMessage());
        }
    }
}
