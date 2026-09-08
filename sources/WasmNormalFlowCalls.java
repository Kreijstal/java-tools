public class WasmNormalFlowCalls {
    int value;
    int calls;
    int read(int index) { calls++; return value + index; }
    public static int mix(WasmNormalFlowCalls voice, int[] samples, int count) {
        int total = 0;
        for (int index = 0; index < count; index++) total += voice.read(index) + samples[index];
        return total;
    }
    public static int protectedMix(WasmNormalFlowCalls voice, int[] samples, int count) {
        try {
            return mix(voice, samples, count);
        } catch (NullPointerException failure) {
            return -100;
        }
    }
    public static int protectedLoop(WasmNormalFlowCalls voice, int[] samples, int count) {
        try {
            int total = 0;
            for (int index = 0; index < count; index++) total += voice.read(index) + samples[index];
            return total;
        } catch (NullPointerException failure) {
            return -100;
        }
    }
}
