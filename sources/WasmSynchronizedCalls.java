public final class WasmSynchronizedCalls {
    public int value;
    public synchronized int sum(int n) {
        int result = 0;
        for (int i = 0; i < n; i++) result += i;
        return result + value;
    }
    public synchronized int bump(int n) { value += n; return value; }
    public synchronized int recurse(int n) {
        if (n == 0) return value;
        return recurse(n - 1) + 1;
    }
    public synchronized int fail(int[] data) { return data[0]; }
    public synchronized int caught(int[] data) {
        try { return data[0]; }
        catch (NullPointerException e) { System.gc(); return value; }
    }
    public synchronized int park(int n) {
        value += n;
        if (n > 0) System.gc();
        value++;
        return value;
    }
    public static int drive(WasmSynchronizedCalls object, int count) {
        int sum = 0;
        for (int i = 0; i < count; i++) sum += object.bump(1);
        return sum;
    }
    public static int recursive(WasmSynchronizedCalls object, int count) {
        return object.recurse(count);
    }
    public static int failing(WasmSynchronizedCalls object, int[] data) {
        return object.fail(data);
    }
    public static int catching(WasmSynchronizedCalls object, int[] data) {
        return object.caught(data);
    }
    public static int parking(WasmSynchronizedCalls object, int count) {
        return object.park(count);
    }
}
