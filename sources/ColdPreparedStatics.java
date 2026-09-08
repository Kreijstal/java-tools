public final class ColdPreparedStatics {
    public static void fill(int size) {
        ColdPreparedArray.values = new int[size];
        for (int i = 0; i < size; i++) ColdPreparedArray.values[i] = i + 7;
    }
    public static void main(String[] args) {
        fill(3);
        if (ColdPreparedArray.values[2] != 9) throw new RuntimeException();
    }
}
class ColdPreparedArray {
    static int[] values = null;
}
