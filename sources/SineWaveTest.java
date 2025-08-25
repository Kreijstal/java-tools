import javax.sound.sampled.*;

public class SineWaveTest {
    public static void main(String[] args) {
        System.out.println("SineWaveTest started.");
        try {
            final float sampleRate = 44100.0f;
            final double frequency = 440.0; // A4 note
            final double amplitude = 0.8;
            final double duration = 2.0; // seconds

            AudioFormat af = new AudioFormat(sampleRate, 16, 1, true, false);
            SourceDataLine line = (SourceDataLine) AudioSystem.getLine(new DataLine.Info(SourceDataLine.class, af));
            line.open(af);
            line.start();

            byte[] buffer = new byte[(int)(sampleRate * duration) * 2];
            for (int i = 0; i < buffer.length / 2; i++) {
                double angle = (i / sampleRate) * frequency * 2.0 * Math.PI;
                short sample = (short)(Math.sin(angle) * amplitude * Short.MAX_VALUE);
                buffer[2*i] = (byte)(sample & 0xFF);
                buffer[2*i+1] = (byte)((sample >> 8) & 0xFF);
            }

            line.write(buffer, 0, buffer.length);
            line.drain();
            line.close();
        } catch (Exception e) {
            e.printStackTrace();
        }
        System.out.println("SineWaveTest finished.");
    }
}
