public class ClosedReceiverFields {
    int width = 16, mask = 15, tint = 0x10203;
    volatile int barrier;
    static ClosedReceiverFields target;
    static int[] pixels, texture;
    static float[] depth;

    int raster(int[] pixels, float[] depth, int[] texture, int count, float w, float u) {
        int checksum = 0;
        for (int i = 0; i < count; i++) {
            float z = 1.0f / w;
            if (z < depth[i]) {
                int x = (int) (u * z * width) & mask;
                int y = (i / width) & mask;
                int color = texture[y * width + x] ^ tint;
                pixels[i] = color;
                depth[i] = z;
                checksum += color;
            }
            u += 0.00037f;
            w += 0.00001f;
        }
        return checksum;
    }

    int aliasWrite(ClosedReceiverFields alias) {
        int sum = 0;
        for (int i = 0; i < 4; i++) {sum += width; alias.width++;}
        return sum;
    }
    static void mutate() {target.width++;}
    int acrossCall() {
        int sum = 0;
        for (int i = 0; i < 4; i++) {sum += width; mutate();}
        return sum;
    }
    int volatileRead() {
        int sum = 0;
        for (int i = 0; i < 4; i++) sum += barrier + width;
        return sum;
    }
    int otherReceiver(ClosedReceiverFields other, int[] effect) {
        int sum = 0;
        for (int i = 0; i < 4; i++) {effect[0]++; sum += other.width;}
        return sum;
    }
    int exceptionOrder(int[] effect) {
        int sum = 0;
        for (int i = 0; i < 4; i++) {effect[i] = width; sum += width;}
        return sum;
    }
    public static int bench(int repetitions) {
        int checksum = 0;
        for (int n = 0; n < repetitions; n++) {
            for (int i = 0; i < depth.length; i++) depth[i] = 100.0f;
            checksum ^= target.raster(pixels, depth, texture, pixels.length, 0.5f, 0.0f);
        }
        return checksum;
    }
    public static void main(String[] args) {
        target = new ClosedReceiverFields();
        pixels = new int[1024]; texture = new int[256];
        depth = new float[1024];
        for (int i = 0; i < texture.length; i++) texture[i] = i * 0x010305;
        for (int i = 0; i < depth.length; i++) depth[i] = 100.0f;
        System.out.println(target.raster(pixels, depth, texture, pixels.length, 0.5f, 0.0f));
        System.out.println(pixels[1023]);
        System.out.println(Float.floatToIntBits(depth[1023]));
        System.out.println(target.aliasWrite(target));
        System.out.println(target.acrossCall());
        System.out.println(target.volatileRead());
        int[] effect = new int[1];
        try {target.otherReceiver(null, effect);} catch (NullPointerException expected) {System.out.println(effect[0]);}
        try {target.exceptionOrder(effect);} catch (ArrayIndexOutOfBoundsException expected) {System.out.println(effect[0]);}
        target.width = 16;
    }
}
