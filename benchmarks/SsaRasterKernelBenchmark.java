public final class SsaRasterKernelBenchmark {
    private SsaRasterKernelBenchmark() {
    }

    /*
     * Four-pixel-unrolled transparent int blit used to compare generic SSA
     * code generation with the established structural-kernel oracle. The
     * benchmark driver resolves this method from bytecode; its identity is not
     * used by the optimizer.
     */
    static void transparentBlit(int[] destination, int[] source, int pixel,
            int sourceIndex, int destinationIndex, int width, int height,
            int destinationRowSkip, int sourceRowSkip) {
        int groups = -(width >> 2);
        int remainder = -(width & 3);
        for (int row = -height; row < 0; row++) {
            for (int group = groups; group < 0; group++) {
                pixel = source[sourceIndex++];
                if (pixel != 0) destination[destinationIndex++] = pixel;
                else destinationIndex++;
                pixel = source[sourceIndex++];
                if (pixel != 0) destination[destinationIndex++] = pixel;
                else destinationIndex++;
                pixel = source[sourceIndex++];
                if (pixel != 0) destination[destinationIndex++] = pixel;
                else destinationIndex++;
                pixel = source[sourceIndex++];
                if (pixel != 0) destination[destinationIndex++] = pixel;
                else destinationIndex++;
            }
            for (int tail = remainder; tail < 0; tail++) {
                pixel = source[sourceIndex++];
                if (pixel != 0) destination[destinationIndex++] = pixel;
                else destinationIndex++;
            }
            destinationIndex += destinationRowSkip;
            sourceIndex += sourceRowSkip;
        }
    }
}
