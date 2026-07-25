public final class DekoblokoRendererTrafficBenchmark {
    static final int WIDTH = 512;
    static final int HEIGHT = 256;
    static final int TRAFFIC_UNITS = 192;
    static final int COPY_CALLS_PER_UNIT = 22;
    static final int BUFFER_SIZE = 16384;

    static int clipLeft = 0;
    static int clipRight = WIDTH;
    static int clipTop = 0;
    static int clipBottom = HEIGHT;
    static int surfaceWidth = WIDTH;
    static int[] pixels = new int[WIDTH * HEIGHT];

    public static final class Model {
        int[] buckets = new int[BUFFER_SIZE];

        Model() {
            for (int index = 0; index < buckets.length; index++) {
                buckets[index] = index * 0x45d9f3b ^ index >>> 3;
            }
        }
    }

    // Distilled from the hot clipped horizontal-span method. The real method
    // has descriptor (IIII)V, reads an initialized static software surface and
    // clip bounds, and performs a checked int[] store loop.
    static void fillSpan(int x, int y, int count, int color) {
        if (y < clipTop || y >= clipBottom) return;
        if (x < clipLeft) {
            count -= clipLeft - x;
            x = clipLeft;
        }
        if (x + count > clipRight) count = clipRight - x;
        int index = x + y * surfaceWidth;
        for (int offset = 0; offset < count; offset++) {
            pixels[index + offset] = color;
        }
    }

    // Same descriptor and opcode family as the live structural primitive-copy
    // intrinsic. Eight-way unrolling makes both directions recognizable while
    // retaining overlap/memmove ordering.
    static void copyInts(int[] source, int sourceIndex, int[] destination,
            int destinationIndex, int length) {
        if (source == destination) {
            if (sourceIndex == destinationIndex) return;
            if (destinationIndex > sourceIndex &&
                    destinationIndex < sourceIndex + length) {
                int sourceEnd = sourceIndex + length;
                int destinationEnd = destinationIndex + length;
                while (length >= 8) {
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    destination[--destinationEnd] = source[--sourceEnd];
                    length -= 8;
                }
                while (length-- > 0) destination[--destinationEnd] = source[--sourceEnd];
                return;
            }
        }
        int sourceEnd = sourceIndex + length;
        while (sourceIndex + 7 < sourceEnd) {
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
            destination[destinationIndex++] = source[sourceIndex++];
        }
        while (sourceIndex < sourceEnd) {
            destination[destinationIndex++] = source[sourceIndex++];
        }
    }

    static int spanTraffic(Model model, int passes, int seed) {
        int checksum = seed;
        for (int pass = 0; pass < passes; pass++) {
            for (int unit = 0; unit < TRAFFIC_UNITS; unit++) {
                int x = ((seed + unit * 17 + pass * 7) & 575) - 32;
                int y = ((seed + unit * 11 + pass * 3) & 287) - 16;
                int count = 8 + ((unit + seed) & 63);
                int color = (seed * 31 + pass * 131 + unit * 65793) | 0xff000000;
                fillSpan(x, y, count, color);
                int sampleX = x < clipLeft ? clipLeft : x;
                if (y >= clipTop && y < clipBottom && sampleX >= clipLeft && sampleX < clipRight) {
                    checksum = checksum * 31 + pixels[sampleX + y * surfaceWidth];
                } else {
                    checksum = checksum * 31 + unit;
                }
            }
        }
        return checksum;
    }

    static int copyTraffic(Model model, int passes, int seed) {
        int[] buckets = model.buckets;
        int checksum = seed;
        for (int pass = 0; pass < passes; pass++) {
            for (int unit = 0; unit < TRAFFIC_UNITS; unit++) {
                for (int copy = 0; copy < COPY_CALLS_PER_UNIT; copy++) {
                    int source = (seed + pass * 97 + unit * 37 + copy * 13) & (BUFFER_SIZE - 128);
                    int length = 8 + ((unit + copy) & 31);
                    int destination = source + 1 + (copy & 3);
                    copyInts(buckets, source, buckets, destination, length);
                    checksum = checksum * 31 + buckets[destination + length - 1];
                }
            }
        }
        return checksum;
    }

    static int renderTraffic(Model model, int passes, int seed) {
        int checksum = seed;
        for (int pass = 0; pass < passes; pass++) {
            checksum = checksum * 31 + spanTraffic(model, 1, seed + pass);
            checksum = checksum * 31 + copyTraffic(model, 1, seed - pass);
        }
        return checksum;
    }

    public static int benchmarkSpans(Model model, int passes, int seed) {
        return spanTraffic(model, passes, seed);
    }

    public static int benchmarkCopies(Model model, int passes, int seed) {
        return copyTraffic(model, passes, seed);
    }

    private static int repeat(String name, Model model, int invocations, int passes, int seed) {
        int checksum = 0;
        for (int call = 0; call < invocations; call++) {
            if ("spans".equals(name)) checksum ^= benchmarkSpans(model, passes, seed + call);
            else if ("copies".equals(name)) checksum ^= benchmarkCopies(model, passes, seed + call);
            else checksum ^= renderTraffic(model, passes, seed + call);
        }
        return checksum;
    }

    public static void main(String[] args) {
        int invocations = args.length > 0 ? Integer.parseInt(args[0]) : 20;
        int passes = args.length > 1 ? Integer.parseInt(args[1]) : 4;
        int rounds = args.length > 2 ? Integer.parseInt(args[2]) : 5;
        int warmups = args.length > 3 ? Integer.parseInt(args[3]) : 3;
        String[] names = {"spans", "copies", "composed"};
        for (String name : names) {
            Model model = new Model();
            pixels = new int[WIDTH * HEIGHT];
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
