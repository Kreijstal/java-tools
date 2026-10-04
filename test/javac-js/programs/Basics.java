import java.util.*;

public class Basics {
    static int counter;
    static final int CONST = 7 * 6;
    static final String SCONST = "k" + CONST + 'c' + 1.5f + 2.0 + true + 10L;
    int field = 3;

    interface Shape { double area(); default String describe() { return "shape " + area(); } static Shape unit() { return () -> 1.0; } }
    record Point(int x, int y) implements Comparable<Point> {
        Point { if (x < 0) throw new IllegalArgumentException("neg"); }
        Point(int v) { this(v, v); }
        public int compareTo(Point o) { return Integer.compare(x * x + y * y, o.x * o.x + o.y * o.y); }
        static Point origin() { return new Point(0, 0); }
    }
    enum Op {
        ADD("+") { int apply(int a, int b) { return a + b; } },
        MUL("*") { int apply(int a, int b) { return a * b; } };
        final String sym;
        Op(String s) { sym = s; }
        abstract int apply(int a, int b);
    }
    enum Color { RED, GREEN, BLUE }

    class Inner { int get() { return field * 2; } class Deeper { int get2() { return field + Inner.this.get(); } } }
    static class Nested<T extends Comparable<T>> { T max(T a, T b) { return a.compareTo(b) >= 0 ? a : b; } }

    static String sw(Object o) {
        return switch (o) {
            case null -> "null";
            case Integer i when i > 10 -> "big int " + i;
            case Integer i -> "int " + i;
            case String s -> "str " + s.length();
            case Point(int x, int y) when x == y -> "diag " + x;
            case Point(var x, var y) -> "pt " + x + "," + y;
            default -> "other " + o.getClass().getSimpleName();
        };
    }

    static int colorSwitch(Color c) {
        switch (c) {
            case RED: return 1;
            case GREEN:
            case BLUE: return 2;
        }
        return -1;
    }

    static String strSwitch(String s) {
        switch (s) {
            case "a": return "A";
            case "Aa": return "Aa";
            case "BB": return "BB"; // same hash as Aa
            default: return "?";
        }
    }

    static int tryFinally(int x) {
        int r = 0;
        try {
            if (x == 0) return 10;
            r = 100 / x;
        } catch (ArithmeticException e) {
            r = -1;
        } finally {
            counter++;
        }
        return r;
    }

    static class Res implements AutoCloseable {
        final String n; final List<String> log;
        Res(String n, List<String> log) { this.n = n; this.log = log; log.add("open " + n); }
        public void close() { log.add("close " + n); }
    }

    static int sum(int... xs) { int s = 0; for (int x : xs) s += x; return s; }
    @SafeVarargs static <T> List<T> listOf(T... xs) { return new ArrayList<>(Arrays.asList(xs)); }

    public static void main(String[] args) throws Exception {
        System.out.println(CONST + " " + SCONST);
        Basics b = new Basics();
        Basics.Inner in = b.new Inner();
        Basics.Inner.Deeper d = in.new Deeper();
        System.out.println(in.get() + " " + d.get2());
        System.out.println(new Nested<String>().max("abc", "abd"));
        Shape sq = () -> 4.0;
        System.out.println(sq.describe() + " " + Shape.unit().area());
        Point p = new Point(3, 4), q = new Point(5);
        System.out.println(p + " " + q + " " + p.equals(new Point(3, 4)) + " " + (p.hashCode() == new Point(3, 4).hashCode()) + " " + p.compareTo(q));
        try { new Point(-1, 0); } catch (IllegalArgumentException e) { System.out.println("caught " + e.getMessage()); }
        for (Op op : Op.values()) System.out.println(op + op.sym + op.apply(6, 7) + " " + op.ordinal() + " " + Op.valueOf(op.name()));
        System.out.println(colorSwitch(Color.BLUE) + " " + colorSwitch(Color.RED) + " " + strSwitch("BB") + strSwitch("Aa") + strSwitch("a") + strSwitch("zz"));
        for (Object o : new Object[] { null, 5, 50, "hey", new Point(2, 2), new Point(1, 2), 3.5 }) System.out.println(sw(o));
        System.out.println(tryFinally(0) + " " + tryFinally(5) + " " + tryFinally(-0) + " counter=" + counter);
        List<String> log = new ArrayList<>();
        try (Res r1 = new Res("a", log); Res r2 = new Res("b", log)) {
            log.add("body");
            throw new RuntimeException("boom");
        } catch (RuntimeException e) { log.add("catch " + e.getMessage()); }
        finally { log.add("finally"); }
        System.out.println(log);
        System.out.println(sum() + " " + sum(1) + " " + sum(1, 2, 3) + " " + listOf("x", "y"));
        // boxing, compound ops
        byte by = 10; by += 300; char ch = 'a'; ch++; ch += 2; short sh = 1; sh *= 1000; sh <<= 4;
        Integer boxed = 5; boxed++; boxed += 10; long lg = boxed; double dd = lg / 3; float ff = 1 / 3f;
        System.out.println(by + " " + ch + " " + (int) ch + " " + sh + " " + boxed + " " + lg + " " + dd + " " + ff);
        int[][] grid = new int[3][4]; grid[1][2] = 7; int[] arr = { 1, 2, 3 };
        System.out.println(grid[1][2] + grid.length + grid[0].length + " " + Arrays.toString(arr) + arr.length);
        // ternary promotion
        boolean flag = args.length == 0;
        Object t1 = flag ? 1 : 'c'; Object t2 = flag ? 1 : 2.0; Object t3 = flag ? (Integer) 1 : "s";
        System.out.println(t1 + " " + t2 + " " + t3);
        // labeled loops
        outer:
        for (int i = 0; i < 5; i++) {
            for (int j = 0; j < 5; j++) {
                if (j == 3) continue outer;
                if (i == 3) break outer;
                System.out.print(i * 10 + j + " ");
            }
        }
        System.out.println();
        // lambdas capturing locals and this
        int base = 100;
        java.util.function.IntUnaryOperator add = x -> x + base + b.field;
        java.util.function.Supplier<String> sup = b::toStringX;
        java.util.function.Function<String, Integer> len = String::length;
        java.util.function.BiFunction<Integer, Integer, Integer> max = Math::max;
        java.util.function.Function<Integer, int[]> mk = int[]::new;
        java.util.function.Supplier<ArrayList<String>> ctor = ArrayList::new;
        System.out.println(add.applyAsInt(1) + " " + sup.get() + " " + len.apply("hello") + " " + max.apply(3, 9) + " " + mk.apply(4).length + " " + ctor.get().size());
        // streams
        List<String> words = List.of("pear", "apple", "fig", "banana");
        System.out.println(words.stream().filter(w -> w.length() > 3).map(String::toUpperCase).sorted().reduce("", (a, c) -> a + c + ";"));
        Map<Integer, List<String>> byLen = new TreeMap<>();
        for (String w : words) byLen.computeIfAbsent(w.length(), k -> new ArrayList<>()).add(w);
        System.out.println(byLen);
        // anonymous and local classes capturing
        String prefix = "pre";
        class Local { String tag(int n) { return prefix + n + base; } }
        Comparator<String> cmp = new Comparator<String>() {
            public int compare(String a, String c) { return Integer.compare(a.length(), c.length()) * (prefix.length() > 0 ? 1 : -1); }
        };
        List<String> sorted = new ArrayList<>(words); sorted.sort(cmp);
        System.out.println(new Local().tag(5) + " " + sorted);
        // instanceof patterns
        Object o = "pattern";
        if (o instanceof String s && s.length() > 3) System.out.println("matched " + s);
        if (!(o instanceof Integer n)) System.out.println("not int"); else System.out.println(n);
        // string switch expression with yield
        String day = "TUE";
        int num = switch (day) { case "MON" -> 1; case "TUE" -> { int k = 2; yield k * 10; } default -> 0; };
        System.out.println(num);
        // synchronized
        synchronized (b) { b.field++; }
        System.out.println(b.field);
        // long and double math, shifts, char arithmetic
        long big = 1L << 40; int neg = -17; double nan = 0.0 / 0.0;
        System.out.println(big + " " + (neg >> 2) + " " + (neg >>> 28) + " " + (neg % 5) + " " + Double.isNaN(nan) + " " + (char) ('a' + 2) + " " + ('a' + 2) + " " + (5 / 2.0) + " " + Long.MAX_VALUE + " " + Integer.MIN_VALUE + " " + 1e10 + " " + 100.0f + " " + 1.0E-5);
        // exceptions multi-catch
        try { Object x = null; x.hashCode(); } catch (NullPointerException | IllegalStateException e) { System.out.println("npe " + (e instanceof NullPointerException)); }
        // iterator over map entries
        for (Map.Entry<Integer, List<String>> e : byLen.entrySet()) System.out.print(e.getKey() + "=" + e.getValue().size() + ",");
        System.out.println();
        StringBuilder sb = new StringBuilder();
        for (char c : "abc".toCharArray()) sb.append(c).append(c);
        System.out.println(sb);
    }

    String toStringX() { return "B" + field; }
}
