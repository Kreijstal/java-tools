public class ClosedObjectPressure {
  static byte[] ballast;
  static Voice[] voices;
  static class Base {
    int value;
    Object reference;
    Base(int value) { this.value = value; }
    int read() { return value; }
  }
  static final class Voice extends Base implements Cloneable {
    int value;
    long wide;
    float fraction;
    double precise;
    byte small;
    short signed;
    char character;
    boolean active;
    Voice(int value) {
      super(value);
      this.value = value + 2;
      wide = 9007199254740993L;
      fraction = 1.25f;
      precise = 2.5;
      small = -7;
      signed = -300;
      character = '\ufffe';
      active = true;
      reference = this;
    }
    int read() { return super.value + value; }
    Voice copy() throws CloneNotSupportedException { return (Voice)clone(); }
  }
  static final class Defaults {
    int integer;
    long wide;
    float fraction;
    double precise;
    boolean active;
    Object reference;
  }
  static Voice create(int value) { return new Voice(value); }
  static int exercise(Voice voice) throws Exception {
    Base base = voice;
    if (base.read() != 16 || voice.value != 9 || base.value != 7) throw new Error("dispatch");
    if (voice.wide != 9007199254740993L || voice.fraction != 1.25f || voice.precise != 2.5 ||
        voice.small != -7 || voice.signed != -300 || voice.character != 65534 || !voice.active) throw new Error("fields");
    Voice copy = voice.copy();
    if (copy == voice || copy.reference != voice || copy.read() != 16 || copy.wide != voice.wide ||
        copy.fraction != voice.fraction || copy.precise != voice.precise || copy.small != voice.small ||
        copy.signed != voice.signed || copy.character != voice.character || !copy.active) throw new Error("clone");
    copy.value = 11;
    if (voice.value != 9 || copy.read() != 18) throw new Error("alias");
    synchronized (voice) { voice.value++; }
    try { Voice missing = null; int ignored = missing.value; throw new Error("null"); }
    catch (NullPointerException expected) {}
    return voice.read() + copy.read();
  }
  public static void main(String[] args) throws Exception {
    Voice nativeVoice = create(7);
    // Keep a native object alive while forcing all later objects off-heap.
    ballast = new byte[1024 * 1024 - 4096];
    voices = new Voice[128];
    for (int i = 0; i < voices.length; i++) voices[i] = create(7);
    Voice spill = voices[voices.length - 1];
    Defaults defaults = new Defaults();
    if (defaults.integer != 0 || defaults.wide != 0L || defaults.fraction != 0.0f ||
        defaults.precise != 0.0 || defaults.active || defaults.reference != null) throw new Error("defaults");
    int result = exercise(spill);
    Voice nativeCopy = nativeVoice.copy();
    if (nativeCopy == nativeVoice || nativeCopy.read() != 16 || nativeCopy.reference != nativeVoice ||
        nativeCopy.wide != nativeVoice.wide || nativeCopy.precise != nativeVoice.precise) throw new Error("native clone");
    if (nativeVoice.value != 9 || nativeVoice.read() != 16) throw new Error("native alias");
    System.out.println("objects " + result + " " + nativeVoice.read());
  }
}
