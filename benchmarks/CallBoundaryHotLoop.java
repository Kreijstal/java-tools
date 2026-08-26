/**
 * Minimal hot-loop reproducer for a call-boundary slowdown.
 *
 * Three loops isolate the blend that produces the whole-app ~11x gap on the
 * production wasm tier:
 *   - runArith: straight-line integer work, no calls. Near-native (~1.1x).
 *   - runCall: one tiny static call per iteration. The pathological
 *     ingredient (~30-100x): every call crosses the generated-code boundary
 *     into the dispatch runtime.
 *   - runBlend: a handful of arithmetic ops per call, the approximate mix
 *     at which the two ingredients blend to the observed whole-app ~11x
 *     (the real gamepack's obfuscated methods are similarly call-dense).
 */
public final class CallBoundaryHotLoop {
    static int step(int x) {
        return x * 33 + 17;
    }

    public static int runArith(int iterations, int seed) {
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

    public static int runCall(int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            value = step(value + i);
        }
        return value;
    }

    public static int runBlend(int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            int x = value + i;
            x = x + 0x1357;
            x = ((x << 5) | (x >>> 27)) ^ 0x2468;
            x = x ^ (x >>> 11);
            x = x * 9 - 7;
            value = step(x);
        }
        return value;
    }

    public static void main(String[] args) {
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 2000000;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 5;
        int warmups = args.length > 2 ? Integer.parseInt(args[2]) : 3;
        String[] names = {"arith", "call", "blend"};
        for (String name : names) {
            for (int round = 0; round < warmups + rounds; round++) {
                long started = System.nanoTime();
                int checksum = name.equals("arith")
                    ? runArith(iterations, 12345)
                    : name.equals("call")
                        ? runCall(iterations, 12345)
                        : runBlend(iterations, 12345);
                long elapsed = System.nanoTime() - started;
                if (round >= warmups) {
                    System.out.println("RESULT " + name + " " + iterations
                        + " " + elapsed + " " + checksum);
                }
            }
        }
    }
}
