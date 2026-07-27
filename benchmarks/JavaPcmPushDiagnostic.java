import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.DataLine;
import javax.sound.sampled.SourceDataLine;

/**
 * A browser-audio diagnostic whose PCM producer is guest Java.
 *
 * The program deliberately uses the same SourceDataLine API as FunOrb. Public
 * static fields make the Java-side portions observable without adding a
 * benchmark-only native API to the JVM.
 */
public final class JavaPcmPushDiagnostic {
    private static final int SAMPLE_RATE = 22050;
    private static final int CHANNELS = 1;
    private static final int BYTES_PER_FRAME = 2;
    private static final int CHUNK_FRAMES = 512;
    private static final int BUFFER_CHUNKS = 8;
    private static final int[] MELODY = {
        262, 330, 392, 523, 392, 330, 294, 370,
        440, 587, 440, 370, 330, 415, 494, 659
    };

    public static long generationNanos;
    public static long writeNanos;
    public static long waitNanos;
    public static long pushNanos;
    public static long drainNanos;
    public static int targetFrames;
    public static int writtenFrames;
    public static int writtenBytes;
    public static int writes;
    public static int blockedPolls;
    public static int checksum;
    public static int error;
    public static int done;

    private static int phaseA;
    private static int phaseB;
    private static int phaseBass;

    private JavaPcmPushDiagnostic() {}

    public static void main(String[] args) {
        reset();
        int seconds = 2;
        if (args != null && args.length > 0) {
            try {
                seconds = Integer.parseInt(args[0]);
            } catch (NumberFormatException ignored) {
                seconds = 2;
            }
        }
        if (seconds < 1) seconds = 1;
        if (seconds > 30) seconds = 30;
        targetFrames = SAMPLE_RATE * seconds;

        SourceDataLine line = null;
        try {
            AudioFormat format =
                new AudioFormat((float) SAMPLE_RATE, 16, CHANNELS, true, false);
            int bufferBytes = CHUNK_FRAMES * BYTES_PER_FRAME * BUFFER_CHUNKS;
            DataLine.Info info =
                new DataLine.Info(SourceDataLine.class, format, bufferBytes);
            line = (SourceDataLine) AudioSystem.getLine(info);
            line.open(format, bufferBytes);
            line.start();

            byte[] pcm = new byte[CHUNK_FRAMES * BYTES_PER_FRAME];
            long pushStarted = System.nanoTime();
            while (writtenFrames < targetFrames) {
                int frames = Math.min(CHUNK_FRAMES, targetFrames - writtenFrames);
                int bytes = frames * BYTES_PER_FRAME;

                long waitStarted = System.nanoTime();
                while (line.available() < bytes) {
                    blockedPolls++;
                    try {
                        Thread.sleep(1L);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw interrupted;
                    }
                }
                waitNanos += System.nanoTime() - waitStarted;

                int melodyIndex =
                    (writtenFrames / (SAMPLE_RATE / 4)) % MELODY.length;
                int frequency = MELODY[melodyIndex];
                int stepA = frequency * 65536 / SAMPLE_RATE;
                int stepB = frequency * 5 / 4 * 65536 / SAMPLE_RATE;
                int stepBass = Math.max(1, frequency / 2 * 65536 / SAMPLE_RATE);

                long generationStarted = System.nanoTime();
                fillChunk(pcm, frames, writtenFrames, stepA, stepB, stepBass);
                generationNanos += System.nanoTime() - generationStarted;

                long writeStarted = System.nanoTime();
                int accepted = line.write(pcm, 0, bytes);
                writeNanos += System.nanoTime() - writeStarted;
                if (accepted != bytes) {
                    throw new IllegalStateException(
                        "short SourceDataLine write: " + accepted + " of " + bytes);
                }
                writtenFrames += frames;
                writtenBytes += accepted;
                writes++;
            }
            pushNanos = System.nanoTime() - pushStarted;

            long drainStarted = System.nanoTime();
            line.drain();
            drainNanos = System.nanoTime() - drainStarted;
        } catch (Exception exception) {
            error = 1;
            exception.printStackTrace();
        } finally {
            if (line != null) {
                try {
                    line.close();
                } catch (Exception ignored) {
                    error = 1;
                }
            }
            done = 1;
        }
    }

    private static void fillChunk(
        byte[] pcm,
        int frames,
        int frameBase,
        int stepA,
        int stepB,
        int stepBass
    ) {
        int a = phaseA;
        int b = phaseB;
        int bass = phaseBass;
        int hash = checksum;
        for (int frame = 0; frame < frames; frame++) {
            a = (a + stepA) & 65535;
            b = (b + stepB) & 65535;
            bass = (bass + stepBass) & 65535;
            int waveA = a < 32768 ? a * 2 - 32768 : 98303 - a * 2;
            int waveB = b < 32768 ? b * 2 - 32768 : 98303 - b * 2;
            int waveBass =
                bass < 32768 ? bass * 2 - 32768 : 98303 - bass * 2;
            int sample = (waveA * 5 >> 4) + (waveB * 3 >> 4)
                + (waveBass >> 3);
            if (((frameBase + frame) / 2756 & 1) == 0) {
                sample += ((frameBase + frame) * 1103515245 >> 27) * 22;
            }
            if (sample < -32768) sample = -32768;
            if (sample > 32767) sample = 32767;
            int offset = frame * 2;
            pcm[offset] = (byte) sample;
            pcm[offset + 1] = (byte) (sample >> 8);
            hash = hash * 31 + pcm[offset];
            hash = hash * 31 + pcm[offset + 1];
        }
        phaseA = a;
        phaseB = b;
        phaseBass = bass;
        checksum = hash;
    }

    private static void reset() {
        generationNanos = 0L;
        writeNanos = 0L;
        waitNanos = 0L;
        pushNanos = 0L;
        drainNanos = 0L;
        targetFrames = 0;
        writtenFrames = 0;
        writtenBytes = 0;
        writes = 0;
        blockedPolls = 0;
        checksum = 0;
        error = 0;
        done = 0;
        phaseA = 0;
        phaseB = 0;
        phaseBass = 0;
    }
}
