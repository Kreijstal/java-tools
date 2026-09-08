public final class DenseWasmFieldLoop {
    public int value;
    public int sum(int count) {
        int total = 0;
        for (int i = 0; i < count; i++) total += value;
        return total;
    }
    public int mutate(int count) {
        int total = 0;
        for (int i = 0; i < count; i++) {
            value++;
            total += value;
        }
        return total;
    }
}
