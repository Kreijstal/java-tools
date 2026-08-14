/**
 * Minimal hot-loop reproducer for the Tomb Racer LOADING slowdown.
 *
 * Loading is bound on the JS region tier (~3.7M region-tier runs vs ~180k
 * wasm runs during one boot), and its hot methods are buffer unpackers:
 * byte[] reads through tiny instance methods that advance a position field
 * (the vma.b()[B shape). Five loops decompose that mix so the JS-tier cost
 * of each ingredient is visible in isolation:
 *   - runArith: straight-line integer work, no calls, no memory. Baseline
 *     code quality of the tier (identical body to CallBoundaryHotLoop).
 *   - runArray: the same unpack work done inline — byte[] loads, masks,
 *     shifts, int[] store — no calls, no fields. Array-access cost.
 *   - runField: getfield/putfield on an instance in a loop, no calls.
 *   - runCall: ONE tiny instance call per iteration. The receiver-dispatch
 *     boundary in isolation.
 *   - runUnpack: the realistic blend — three instance-method byte reads
 *     with a position field plus a little arithmetic per element, i.e.
 *     what the loading-hot methods actually do per datum.
 */
public final class LoadingUnpackHotLoop {
    static final class Buffer {
        byte[] data;
        int pos;

        Buffer(byte[] data) {
            this.data = data;
        }

        int readUByte() {
            return data[pos++] & 0xff;
        }

        int readUShort() {
            int high = readUByte();
            return (high << 8) | readUByte();
        }

        int step(int x) {
            return x * 33 + 17 + pos;
        }
    }

    static byte[] fill(int length, int seed) {
        byte[] data = new byte[length];
        int state = seed;
        for (int i = 0; i < length; i++) {
            state = state * 1103515245 + 12345;
            data[i] = (byte) (state >> 16);
        }
        return data;
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

    public static int runArray(int iterations, int seed) {
        byte[] data = fill(4096, seed);
        int[] out = new int[1024];
        int checksum = 0;
        int pos = 0;
        for (int i = 0; i < iterations; i++) {
            if (pos + 3 > data.length) pos = 0;
            int v = ((data[pos++] & 0xff) << 16)
                | ((data[pos++] & 0xff) << 8)
                | (data[pos++] & 0xff);
            out[i & 1023] = v ^ (v >>> 7);
            checksum = checksum * 31 + out[i & 1023];
        }
        return checksum;
    }

    public static int runField(int iterations, int seed) {
        Buffer buf = new Buffer(new byte[4]);
        int checksum = seed;
        for (int i = 0; i < iterations; i++) {
            buf.pos = checksum & 0xffff;
            checksum = checksum * 33 + buf.pos + i;
        }
        return checksum;
    }

    public static int runCall(int iterations, int seed) {
        Buffer buf = new Buffer(new byte[4]);
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            value = buf.step(value + i);
        }
        return value;
    }

    public static int runUnpack(int iterations, int seed) {
        Buffer buf = new Buffer(fill(4096, seed));
        int checksum = 0;
        for (int i = 0; i < iterations; i++) {
            if (buf.pos + 3 > buf.data.length) buf.pos = 0;
            int v = (buf.readUByte() << 16) | buf.readUShort();
            checksum = checksum * 31 + (v ^ (v >>> 7));
        }
        return checksum;
    }

    static int run(String name, int iterations, int seed) {
        if (name.equals("arith")) return runArith(iterations, seed);
        if (name.equals("array")) return runArray(iterations, seed);
        if (name.equals("field")) return runField(iterations, seed);
        if (name.equals("call")) return runCall(iterations, seed);
        return runUnpack(iterations, seed);
    }

    public static void main(String[] args) {
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 2000000;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 5;
        int warmups = args.length > 2 ? Integer.parseInt(args[2]) : 3;
        String[] names = {"arith", "array", "field", "call", "unpack"};
        for (String name : names) {
            for (int round = 0; round < warmups + rounds; round++) {
                long started = System.nanoTime();
                int checksum = run(name, iterations, 12345);
                long elapsed = System.nanoTime() - started;
                if (round >= warmups) {
                    System.out.println("RESULT " + name + " " + iterations
                        + " " + elapsed + " " + checksum);
                }
            }
        }
    }
}
