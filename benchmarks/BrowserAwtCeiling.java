import java.applet.Applet;
import java.awt.Graphics;
import java.awt.Image;
import java.awt.image.MemoryImageSource;

/**
 * Separates generated Java raster cost from the browser JVM's 800x600 AWT
 * publication and presentation costs. Results are exposed as static fields so
 * the browser diagnostics page can read them without adding benchmark-only
 * native methods to the JVM.
 */
public final class BrowserAwtCeiling extends Applet implements Runnable {
    private static final int WIDTH = 800;
    private static final int HEIGHT = 600;
    private static final int RASTER_FRAMES = 12;
    private static final int PUBLISH_FRAMES = 16;
    private static final int FULL_FRAMES = 12;
    private static final int RASTER_WARMUP_FRAMES = 128;

    public static long rasterNanos;
    public static long publishNanos;
    public static long fullNanos;
    public static int rasterFrames;
    public static int publishFrames;
    public static int fullFrames;
    public static int checksum;
    public static int phase;
    public static int done;
    public static int started;
    public static int[] rasterFrameMicros = new int[RASTER_FRAMES];
    public static int[] fullFrameMicros = new int[FULL_FRAMES];

    private int[] pixels;
    private MemoryImageSource source;
    private Image image;
    private Graphics graphics;

    public void init() {
        setSize(WIDTH, HEIGHT);
        pixels = new int[WIDTH * HEIGHT];
        source = new MemoryImageSource(WIDTH, HEIGHT, pixels, 0, WIDTH);
        image = createImage(source);
        graphics = getGraphics();
    }

    public void start() {
        started = 1;
        new Thread(this, "browser-awt-ceiling").start();
    }

    public void run() {
        for (int frame = 0; frame < RASTER_WARMUP_FRAMES; frame++) {
            raster(frame);
        }
        for (int index = 0; index < pixels.length; index++) {
            pixels[index] = 0;
        }
        // Recreate the original two-frame starting state after tier warmup so
        // historical checksums remain directly comparable.
        raster(0);
        raster(1);
        // Ordinary JavaScript kernels tier asynchronously in Firefox. Yield
        // once after warmup so the timed phase measures their steady-state
        // machine code rather than background compilation latency.
        try {
            Thread.sleep(50L);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }

        long started = System.nanoTime();
        for (int frame = 0; frame < RASTER_FRAMES; frame++) {
            long frameStarted = System.nanoTime();
            raster(frame);
            rasterFrameMicros[frame] =
                (int) ((System.nanoTime() - frameStarted) / 1000L);
        }
        rasterNanos = System.nanoTime() - started;
        rasterFrames = RASTER_FRAMES;
        phase = 1;

        started = System.nanoTime();
        for (int frame = 0; frame < PUBLISH_FRAMES; frame++) {
            pixels[frame] ^= 0x00ffffff;
            source.newPixels();
            graphics.drawImage(image, 0, 0, this);
            yieldToBrowser();
        }
        publishNanos = System.nanoTime() - started;
        publishFrames = PUBLISH_FRAMES;
        phase = 2;

        started = System.nanoTime();
        for (int frame = 0; frame < FULL_FRAMES; frame++) {
            long frameStarted = System.nanoTime();
            raster(frame);
            source.newPixels();
            graphics.drawImage(image, 0, 0, this);
            yieldToBrowser();
            fullFrameMicros[frame] =
                (int) ((System.nanoTime() - frameStarted) / 1000L);
        }
        fullNanos = System.nanoTime() - started;
        fullFrames = FULL_FRAMES;
        phase = 3;

        checksum = pixels[0] ^ pixels[pixels.length / 2]
            ^ pixels[pixels.length - 1];
        done = 1;
        phase = 4;
    }

    private void yieldToBrowser() {
        try {
            Thread.sleep(1L);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private void raster(int frame) {
        int red = frame * 1234567;
        int green = frame * 7654321;
        int blue = frame * 334455;
        int index = 0;
        for (int y = 0; y < HEIGHT; y++) {
            int rowRed = red;
            int rowGreen = green;
            int rowBlue = blue;
            for (int x = 0; x < WIDTH; x++) {
                int old = pixels[index];
                pixels[index++] = (old >> 1 & 8355711)
                    + (rowGreen >> 9 & 65280)
                    + (rowRed >> 1 & 16711680)
                    + (rowBlue >> 17 & 255);
                rowRed += 3171;
                rowGreen += 911;
                rowBlue += 1777;
            }
            red += 991;
            green += 313;
            blue += 271;
        }
    }
}
