public class PreparedResumeCalls {
    public static int calls;
    public static int result;
    static int step(int value) { calls++; return value * 31 + 7; }
    public static void countLoops(int count) {
        for (int i = 0; i < count; i++) calls++;
    }
    public static void nestedCoarse(int rounds) {
        int sum = 0;
        for (int a = 0; a < 64; a++) {
            int b = 0;
            while ((b & 255) < rounds) {
                for (int c = 0; c < 64; c++) sum += c;
                int d = 80 + (a & 3) + b;
                while ((d & 255) != 0) { sum = sum * 31 + d; d--; }
                b++;
            }
        }
        result = sum;
    }
    public static void run(int count) {
        int sum = 0;
        for (int i = 0; i < count; i++) {
            if ((i & 1) == 0) {
                for (int k = 0; k < 4; k++) sum += step(i + k);
            } else {
                for (int k = 0; k < 4; k++) sum -= step(i - k);
            }
        }
        result = sum;
    }
}
