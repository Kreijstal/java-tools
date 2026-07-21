public final class DekoblokoHotLoopBenchmark {
    static final int VERTICES = 128;
    static final int FACES = 192;

    public static final class Model {
        int[] x = new int[VERTICES];
        int[] y = new int[VERTICES];
        int[] z = new int[VERTICES];
        short[] faceA = new short[FACES];
        short[] faceB = new short[FACES];
        short[] faceC = new short[FACES];
        int[] projectedX = new int[VERTICES];
        int[] projectedY = new int[VERTICES];
        int[] colors = new int[FACES];

        Model() {
            for (int i = 0; i < VERTICES; i++) {
                x[i] = ((i * 37) & 1023) - 512;
                y[i] = ((i * 53) & 511) - 256;
                z[i] = ((i * 97) & 1023) + 256;
            }
            for (int i = 0; i < FACES; i++) {
                faceA[i] = (short) (i % VERTICES);
                faceB[i] = (short) ((i * 7 + 3) % VERTICES);
                faceC[i] = (short) ((i * 13 + 11) % VERTICES);
            }
        }
    }

    // Distilled from the first renderer natural loop: instance-field array
    // loads, overflow-sensitive fixed-point transforms, nested loops, and
    // projected-coordinate stores.
    public static int transformVertices(Model model, int passes, int angle, int scale) {
        int[] x = model.x;
        int[] y = model.y;
        int[] z = model.z;
        int[] projectedX = model.projectedX;
        int[] projectedY = model.projectedY;
        int checksum = 0;
        for (int pass = 0; pass < passes; pass++) {
            int phase = angle + pass * 17;
            int sin = ((phase * 25173 + 13849) & 65535) - 32768;
            int cos = ((phase * 13849 + 25173) & 65535) - 32768;
            for (int i = 0; i < x.length; i++) {
                int tx = x[i] + pass;
                int tz = z[i] - pass;
                int rx = (tx * cos + tz * sin) >> 15;
                int rz = (tz * cos - tx * sin) >> 15;
                int depth = rz + 768;
                int divisor = depth == 0 ? 1 : depth;
                int sx = (rx * scale) / divisor;
                int sy = (y[i] * scale + (rx >> 2)) / divisor;
                projectedX[i] = sx;
                projectedY[i] = sy;
                checksum = checksum * 31 + (sx ^ sy ^ rz);
            }
        }
        return checksum;
    }

    static int shade(int cross, int depth, int threshold) {
        int intensity = (cross ^ (cross >>> 16)) + depth * 13;
        if (intensity < threshold) intensity = threshold - intensity;
        return (intensity & 255) * 0x010101;
    }

    // Distilled from the face loop: short index arrays, projected vertex
    // gathers, cross-product visibility branches, a small integer helper, and
    // checked destination stores.
    public static int selectFaces(Model model, int passes, int threshold, int seed) {
        short[] faceA = model.faceA;
        short[] faceB = model.faceB;
        short[] faceC = model.faceC;
        int[] projectedX = model.projectedX;
        int[] projectedY = model.projectedY;
        int[] colors = model.colors;
        int checksum = seed;
        for (int pass = 0; pass < passes; pass++) {
            for (int face = 0; face < faceA.length; face++) {
                int a = faceA[face];
                int b = faceB[face];
                int c = faceC[face];
                int abx = projectedX[b] - projectedX[a];
                int aby = projectedY[b] - projectedY[a];
                int acx = projectedX[c] - projectedX[a];
                int acy = projectedY[c] - projectedY[a];
                int cross = abx * acy - aby * acx;
                int depth = (a + b + c + pass) & 1023;
                int color;
                if (cross > threshold) color = shade(cross, depth, threshold);
                else if (cross < -threshold) color = shade(-cross, depth, threshold) ^ 0x202020;
                else color = 0;
                colors[face] = color;
                checksum = (checksum << 5) - checksum + color + face;
            }
        }
        return checksum;
    }

    public static int renderModel(Model model, int passes, int seed) {
        int transformed = transformVertices(model, passes, seed & 2047, 512);
        return transformed ^ selectFaces(model, passes, 7, seed);
    }

    public static int benchmarkVertices(Model model, int passes, int seed) {
        return transformVertices(model, passes, seed & 2047, 512);
    }

    public static int benchmarkFaces(Model model, int passes, int seed) {
        transformVertices(model, 1, seed & 2047, 512);
        return selectFaces(model, passes, 7, seed);
    }

    private static int repeat(String name, Model model, int invocations, int passes, int seed) {
        int checksum = 0;
        if ("vertices".equals(name)) {
            for (int call = 0; call < invocations; call++) {
                checksum ^= benchmarkVertices(model, passes, seed + call);
            }
            return checksum;
        }
        if ("faces".equals(name)) {
            for (int call = 0; call < invocations; call++) {
                checksum ^= benchmarkFaces(model, passes, seed + call);
            }
            return checksum;
        }
        for (int call = 0; call < invocations; call++) {
            checksum ^= renderModel(model, passes, seed + call);
        }
        return checksum;
    }

    public static void main(String[] args) {
        int invocations = args.length > 0 ? Integer.parseInt(args[0]) : 40;
        int passes = args.length > 1 ? Integer.parseInt(args[1]) : 64;
        int rounds = args.length > 2 ? Integer.parseInt(args[2]) : 5;
        int warmups = args.length > 3 ? Integer.parseInt(args[3]) : 3;
        String[] names = {"vertices", "faces", "combined"};
        for (String name : names) {
            Model model = new Model();
            for (int warmup = 0; warmup < warmups; warmup++) {
                int checksum = repeat(name, model, invocations, passes, 123 + warmup);
                if (checksum == 0x12345678) System.out.print("");
            }
            for (int round = 0; round < rounds; round++) {
                long started = System.nanoTime();
                int checksum = repeat(name, model, invocations, passes, 0x12345678 + round);
                long elapsed = System.nanoTime() - started;
                System.out.println("RESULT " + name + " " + elapsed + " " + checksum);
            }
        }
    }
}
