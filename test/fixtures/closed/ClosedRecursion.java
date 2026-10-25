// Recursion inside the closed module: StackOverflowError must be catchable
// (the module counts depth itself), recursion must work again afterwards,
// and mutual recursion through virtual calls is counted too.
public class ClosedRecursion {
    static int depth;

    static void forever() {
        depth++;
        forever();
    }

    static int fib(int n) {
        return n < 2 ? n : fib(n - 1) + fib(n - 2);
    }

    interface Node { int sum(int n); }

    static final class Even implements Node {
        Node other;
        public int sum(int n) { return n == 0 ? 0 : n + other.sum(n - 1); }
    }

    static final class Odd implements Node {
        Node other;
        public int sum(int n) { return n == 0 ? 0 : n * 2 + other.sum(n - 1); }
    }

    static int overflowOnce() {
        depth = 0;
        try {
            forever();
            return -1;
        } catch (StackOverflowError e) {
            return depth > 100 ? 1 : 0;
        }
    }

    public static void main(String[] args) {
        System.out.println("caught " + overflowOnce());
        System.out.println("fib " + fib(20));
        System.out.println("caught again " + overflowOnce());
        Even even = new Even();
        Odd odd = new Odd();
        even.other = odd;
        odd.other = even;
        System.out.println("mutual " + even.sum(200));
        int total = 0;
        for (int i = 0; i < 50; i++) total += overflowOnce();
        System.out.println("repeated " + total + " fib " + fib(15));
    }
}
