public final class IntermethodCallBenchmark {
    public abstract static class VirtualWorker {
        public abstract int apply(int value);
    }

    public interface InterfaceWorker {
        int apply(int value);
    }

    public static final class Worker extends VirtualWorker implements InterfaceWorker {
        public int apply(int value) {
            return chain(value);
        }
    }

    static int step0(int x) { return x + 0x1357; }
    static int step1(int x) { return ((x << 5) | (x >>> 27)) ^ 0x2468; }
    static int step2(int x) { return x * 33 + 17; }
    static int step3(int x) { return x ^ (x >>> 11); }
    static int step4(int x) { return ((x << 9) | (x >>> 23)) + 0x1020; }
    static int step5(int x) { return x * 9 - 7; }
    static int step6(int x) { return x ^ (x << 7); }
    static int step7(int x) { return x + (x >>> 3) + 0x55aa; }

    static int chain(int x) {
        x = step0(x);
        x = step1(x);
        x = step2(x);
        x = step3(x);
        x = step4(x);
        x = step5(x);
        x = step6(x);
        return step7(x);
    }

    public static int runMonolith(int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            int x = value + i;
            x = x + 0x1357;
            x = ((x << 5) | (x >>> 27)) ^ 0x2468;
            x = x * 33 + 17;
            x = x ^ (x >>> 11);
            x = ((x << 9) | (x >>> 23)) + 0x1020;
            x = x * 9 - 7;
            x = x ^ (x << 7);
            value = x + (x >>> 3) + 0x55aa;
        }
        return value;
    }

    public static int runStatic(int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            value = step0(value + i);
            value = step1(value);
            value = step2(value);
            value = step3(value);
            value = step4(value);
            value = step5(value);
            value = step6(value);
            value = step7(value);
        }
        return value;
    }

    public static int runVirtual(VirtualWorker worker, int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) value = worker.apply(value + i);
        return value;
    }

    public static int runInterface(InterfaceWorker worker, int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) value = worker.apply(value + i);
        return value;
    }

    private static long measure(String name, int iterations, int seed, Worker worker) {
        long started = System.nanoTime();
        int checksum;
        if ("monolith".equals(name)) checksum = runMonolith(iterations, seed);
        else if ("static".equals(name)) checksum = runStatic(iterations, seed);
        else if ("virtual".equals(name)) checksum = runVirtual(worker, iterations, seed);
        else checksum = runInterface(worker, iterations, seed);
        long elapsed = System.nanoTime() - started;
        System.out.println("RESULT " + name + " " + iterations + " " + elapsed + " " + checksum);
        return elapsed;
    }

    public static void main(String[] args) {
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 1000000;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 5;
        int warmups = args.length > 2 ? Integer.parseInt(args[2]) : 5;
        Worker worker = new Worker();
        for (int warmup = 0; warmup < warmups; warmup++) {
            runMonolith(iterations, 123 + warmup);
            runStatic(iterations, 123 + warmup);
            runVirtual(worker, iterations, 123 + warmup);
            runInterface(worker, iterations, 123 + warmup);
        }
        for (int round = 0; round < rounds; round++) {
            int seed = 0x12345678 + round;
            measure("monolith", iterations, seed, worker);
            measure("static", iterations, seed, worker);
            measure("virtual", iterations, seed, worker);
            measure("interface", iterations, seed, worker);
        }
    }
}
