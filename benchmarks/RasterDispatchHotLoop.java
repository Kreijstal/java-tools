public final class RasterDispatchHotLoop {
    static abstract class Sprite {
        final int[] pixels;
        final int width;
        final int height;

        Sprite(int seed, int width, int height) {
            this.width = width;
            this.height = height;
            this.pixels = new int[width * height];
            int value = seed;
            for (int i = 0; i < pixels.length; i++) {
                value = value * 1103515245 + 12345;
                pixels[i] = value & 0x00ffffff;
            }
        }

        abstract void draw(int[] destination, int offset, int stride);
    }

    static final class OpaqueSprite extends Sprite {
        OpaqueSprite(int seed, int width, int height) {
            super(seed, width, height);
        }

        void draw(int[] destination, int offset, int stride) {
            blitOpaque(destination, pixels, offset, stride, width, height);
        }
    }

    static final class MaskedSprite extends Sprite {
        MaskedSprite(int seed, int width, int height) {
            super(seed, width, height);
            for (int i = 0; i < pixels.length; i += 7) pixels[i] = 0;
        }

        void draw(int[] destination, int offset, int stride) {
            blitMasked(destination, pixels, offset, stride, width, height);
        }
    }

    static final class AdditiveSprite extends Sprite {
        AdditiveSprite(int seed, int width, int height) {
            super(seed, width, height);
        }

        void draw(int[] destination, int offset, int stride) {
            blitAdditive(destination, pixels, offset, stride, width, height);
        }
    }

    // Browser reflection currently exposes primitive int arrays most simply.
    // Store microseconds so a slow interpreted/reference shape cannot wrap at
    // roughly 2.1 seconds; 1 us over 100k dispatches still gives 0.01 ns per
    // dispatch reporting resolution.
    static int[] measuredMicros;
    static int[] measuredChecksums;
    static int[] measuredMonoMicros;
    static int[] measuredMonoChecksums;
    static int[] measuredStaticMicros;
    static int[] measuredStaticChecksums;
    static int sink;

    static void blitOpaque(int[] destination, int[] source, int offset,
            int stride, int width, int height) {
        int sourceIndex = 0;
        int rowSkip = stride - width;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                destination[offset++] = source[sourceIndex++];
            }
            offset += rowSkip;
        }
    }

    static void blitMasked(int[] destination, int[] source, int offset,
            int stride, int width, int height) {
        int sourceIndex = 0;
        int rowSkip = stride - width;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int color = source[sourceIndex++];
                if (color != 0) destination[offset] = color;
                offset++;
            }
            offset += rowSkip;
        }
    }

    static void blitAdditive(int[] destination, int[] source, int offset,
            int stride, int width, int height) {
        int sourceIndex = 0;
        int rowSkip = stride - width;
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int left = destination[offset];
                int right = source[sourceIndex++];
                destination[offset++] = (left + right) & 0x00ffffff;
            }
            offset += rowSkip;
        }
    }

    static int runRaster(int iterations, int seed) {
        final int stride = 640;
        final int rows = 480;
        final int spriteSize = 8;
        Sprite[] sprites = new Sprite[64];
        for (int i = 0; i < sprites.length; i++) {
            int type = i % 3;
            if (type == 0) {
                sprites[i] = new OpaqueSprite(seed + i, spriteSize, spriteSize);
            } else if (type == 1) {
                sprites[i] = new MaskedSprite(seed + i, spriteSize, spriteSize);
            } else {
                sprites[i] = new AdditiveSprite(seed + i, spriteSize, spriteSize);
            }
        }
        int[] destination = new int[stride * rows];
        int state = seed;
        for (int i = 0; i < iterations; i++) {
            state = state * 1664525 + 1013904223;
            Sprite sprite = sprites[(state >>> 19) & 63];
            int x = (state >>> 8) & 511;
            int y = (state >>> 23) & 31;
            sprite.draw(destination, y * stride + x, stride);
        }
        return checksum(destination, state);
    }

    static int runMonomorphic(int iterations, int seed) {
        final int stride = 640;
        OpaqueSprite sprite = new OpaqueSprite(seed, 8, 8);
        int[] destination = new int[stride * 480];
        int state = seed;
        for (int i = 0; i < iterations; i++) {
            state = state * 1664525 + 1013904223;
            int x = (state >>> 8) & 511;
            int y = (state >>> 23) & 31;
            sprite.draw(destination, y * stride + x, stride);
        }
        return checksum(destination, state);
    }

    static int runStatic(int iterations, int seed) {
        final int stride = 640;
        int[] source = new int[64];
        int value = seed;
        for (int i = 0; i < source.length; i++) {
            value = value * 1103515245 + 12345;
            source[i] = value & 0x00ffffff;
        }
        int[] destination = new int[stride * 480];
        int state = seed;
        for (int i = 0; i < iterations; i++) {
            state = state * 1664525 + 1013904223;
            int x = (state >>> 8) & 511;
            int y = (state >>> 23) & 31;
            blitOpaque(destination, source, y * stride + x, stride, 8, 8);
        }
        return checksum(destination, state);
    }

    static int checksum(int[] destination, int state) {
        int checksum = state;
        for (int i = 0; i < destination.length; i += 257) {
            checksum = checksum * 31 + destination[i];
        }
        sink = checksum;
        return checksum;
    }

    public static void main(String[] args) {
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 100000;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 3;
        int warmups = args.length > 2 ? Integer.parseInt(args[2]) : 3;
        measuredMicros = new int[rounds];
        measuredChecksums = new int[rounds];
        measuredMonoMicros = new int[rounds];
        measuredMonoChecksums = new int[rounds];
        measuredStaticMicros = new int[rounds];
        measuredStaticChecksums = new int[rounds];
        for (int round = 0; round < warmups + rounds; round++) {
            long started = System.nanoTime();
            int checksum = runRaster(iterations, 12345);
            long elapsed = System.nanoTime() - started;
            started = System.nanoTime();
            int monoChecksum = runMonomorphic(iterations, 12345);
            long monoElapsed = System.nanoTime() - started;
            started = System.nanoTime();
            int staticChecksum = runStatic(iterations, 12345);
            long staticElapsed = System.nanoTime() - started;
            if (round >= warmups) {
                int measured = round - warmups;
                measuredMicros[measured] = (int) (elapsed / 1000L);
                measuredChecksums[measured] = checksum;
                measuredMonoMicros[measured] = (int) (monoElapsed / 1000L);
                measuredMonoChecksums[measured] = monoChecksum;
                measuredStaticMicros[measured] = (int) (staticElapsed / 1000L);
                measuredStaticChecksums[measured] = staticChecksum;
                System.out.println("RESULT raster " + measured + " "
                    + elapsed + " " + checksum);
                System.out.println("RESULT mono " + measured + " "
                    + monoElapsed + " " + monoChecksum);
                System.out.println("RESULT static " + measured + " "
                    + staticElapsed + " " + staticChecksum);
            }
        }
    }
}
