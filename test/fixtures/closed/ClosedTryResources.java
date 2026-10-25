// Handlers inside handlers, the shape javac gives try-with-resources:
// catch Throwable records the primary exception and rethrows; the finally
// handler closes the resource and attaches what close() throws as suppressed.
public class ClosedTryResources {
    static final class Res implements AutoCloseable {
        final String name;
        Res(String name) { this.name = name; System.out.println("open " + name); }
        void work(boolean fail) {
            System.out.println("work " + name);
            if (fail) throw new RuntimeException("work failed " + name);
        }
        public void close() {
            System.out.println("close " + name);
            if (name.startsWith("bad")) throw new IllegalStateException("close failed " + name);
        }
    }

    static void manual(String name, boolean fail) {
        try {
            Res r = new Res(name);
            Throwable primary = null;
            try {
                r.work(fail);
            } catch (Throwable t) {
                primary = t;
                throw t;
            } finally {
                if (r != null) {
                    if (primary != null) {
                        try { r.close(); } catch (Throwable x) { primary.addSuppressed(x); }
                    } else {
                        r.close();
                    }
                }
            }
        } catch (Exception e) {
            System.out.println("caught " + e.getMessage() + " suppressed " + e.getSuppressed().length);
        }
    }

    static void sugared(String name, boolean fail) {
        try (Res r = new Res(name); Res s = new Res(name + "2")) {
            r.work(fail);
            s.work(false);
        } catch (Exception e) {
            System.out.println("caught " + e.getMessage() + " suppressed " + e.getSuppressed().length);
            for (Throwable t : e.getSuppressed()) System.out.println("  " + t.getMessage());
        }
    }

    public static void main(String[] args) {
        manual("a", false);
        manual("b", true);
        manual("bad", true);
        manual("bad1", false);
        sugared("c", false);
        sugared("d", true);
        sugared("bad", true);
    }
}
