public final class WasmBulkCopy {
    public static int drive(int[] source, int[] target, int count) {
        int sum = 0;
        for (int i = 0; i < count; i++) sum += copy(source, 0, target, 0, source.length);
        return sum;
    }
    public static int copy(int[] source, int from, int[] target, int to, int count) {
        System.arraycopy(source, from, target, to, count);
        int sum = 0;
        for (int value : target) sum += value;
        return sum;
    }
    public static int caught(int[] source, int[] target, int count) {
        try {
            System.arraycopy(source, 0, target, 0, count);
        } catch (NullPointerException e) { return 71; }
        catch (ArrayIndexOutOfBoundsException e) { return 72; }
        int sum = 0;
        for (int value : target) sum += value;
        return sum;
    }
}
