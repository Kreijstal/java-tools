final class td {
    /*
     * Structured donor for td.c(Lvl;)V. This is the same BZip decode state
     * machine as the bytecode reduction, written so javac emits CFR-friendly
     * reducible control flow.
     */
    private static final void c(vl var0) {
        int var2 = var0.I;
        int var3 = var0.p;
        int var4 = var0.b;
        int var5 = var0.o;
        int[] var6 = wb.Zb;
        int var7 = var0.z;
        byte[] var8 = var0.w;
        int var9 = var0.E;
        int var10 = var0.e;
        int var11 = var10;
        int var12 = var0.m + 1;

        outer: while (true) {
            if (var3 > 0) {
                while (var10 != 0) {
                    if (var3 != 1) {
                        var8[var9] = (byte) var2;
                        --var3;
                        ++var9;
                        --var10;
                        continue;
                    }
                    if (var10 == 0) {
                        var3 = 1;
                        break outer;
                    }
                    var8[var9] = (byte) var2;
                    ++var9;
                    --var10;
                    break;
                }
                if (var10 == 0) {
                    break;
                }
            }

            while (true) {
                if (var4 == var12) {
                    var3 = 0;
                    break outer;
                }
                var2 = (byte) var5;
                var7 = var6[var7];
                int var1 = (byte) var7;
                var7 >>= 8;
                ++var4;
                if (var1 != var5) {
                    var5 = var1;
                    if (var10 == 0) {
                        var3 = 1;
                        break outer;
                    }
                    var8[var9] = (byte) var2;
                    ++var9;
                    --var10;
                    continue;
                }
                if (var4 == var12) {
                    if (var10 == 0) {
                        var3 = 1;
                        break outer;
                    }
                    var8[var9] = (byte) var2;
                    ++var9;
                    --var10;
                    continue;
                }
                var3 = 2;
                var7 = var6[var7];
                var1 = (byte) var7;
                var7 >>= 8;
                ++var4;
                if (var4 == var12) {
                    continue outer;
                }
                if (var1 != var5) {
                    var5 = var1;
                    continue outer;
                }
                var3 = 3;
                var7 = var6[var7];
                var1 = (byte) var7;
                var7 >>= 8;
                ++var4;
                if (var4 == var12) {
                    continue outer;
                }
                if (var1 != var5) {
                    var5 = var1;
                    continue outer;
                }
                var7 = var6[var7];
                var1 = (byte) var7;
                var7 >>= 8;
                ++var4;
                var3 = (var1 & 255) + 4;
                var7 = var6[var7];
                var5 = (byte) var7;
                var7 >>= 8;
                ++var4;
                continue outer;
            }
        }

        int var13 = var0.f;
        var0.f += var11 - var10;
        if (var0.f < var13) {
            // Keep the original empty overflow check visible to javac.
        }
        var0.I = (byte) var2;
        var0.p = var3;
        var0.b = var4;
        var0.o = var5;
        wb.Zb = var6;
        var0.z = var7;
        var0.w = var8;
        var0.E = var9;
        var0.e = var10;
    }
}
