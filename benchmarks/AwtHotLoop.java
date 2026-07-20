import java.applet.Applet;
import java.awt.Graphics;
import java.awt.Image;
import java.awt.image.MemoryImageSource;

public final class AwtHotLoop extends Applet {
    private static final int WIDTH = 64;
    private static final int HEIGHT = 64;
    private static final int RASTER_FRAMES = 10;
    private static final int PUBLISH_FRAMES = 10;
    private static final int PACED_FRAMES = 20;
    private static final int PRESENT_FRAMES = 20;

    public static long rasterNanos;
    public static long publishNanos;
    public static long pacedNanos;
    public static long presentNanos;
    public static int rasterFrames;
    public static int publishFrames;
    public static int pacedFrames;
    public static int presentFrames;
    public static int checksum;
    public static int phase;
    public static int done;

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
        raster(0);

        long started = System.nanoTime();
        for (int frame = 0; frame < RASTER_FRAMES; frame++) raster(frame);
        rasterNanos = System.nanoTime() - started;
        rasterFrames = RASTER_FRAMES;
        phase = 1;

        started = System.nanoTime();
        for (int frame = 0; frame < PUBLISH_FRAMES; frame++) {
            raster(frame);
            source.newPixels();
            graphics.drawImage(image, 0, 0, this);
        }
        publishNanos = System.nanoTime() - started;
        publishFrames = PUBLISH_FRAMES;
        phase = 2;

        started = System.nanoTime();
        for (int frame = 0; frame < PACED_FRAMES; frame++) {
            try {
                Thread.sleep(1L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        pacedNanos = System.nanoTime() - started;
        pacedFrames = PACED_FRAMES;
        phase = 3;

        started = System.nanoTime();
        for (int frame = 0; frame < PRESENT_FRAMES; frame++) {
            source.newPixels();
            graphics.drawImage(image, 0, 0, this);
            try {
                Thread.sleep(1L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        presentNanos = System.nanoTime() - started;
        presentFrames = PRESENT_FRAMES;
        phase = 4;
        checksum = pixels[0] ^ pixels[pixels.length / 2] ^ pixels[pixels.length - 1];
        done = 1;
        phase = 5;
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
