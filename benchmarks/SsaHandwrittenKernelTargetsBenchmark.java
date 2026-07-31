public final class SsaHandwrittenKernelTargetsBenchmark {
    static int[] bilinearDestination;
    static int[] polygonDestination;
    static int polygonWidth = 64;
    static int polygonHeight = 64;
    static int polygonClipLeft = 0;
    static int polygonClipRight = 64;
    static int polygonClipTop = 0;
    static int polygonClipBottom = 64;

    int width;
    int height;
    int[] source;

    SsaHandwrittenKernelTargetsBenchmark(int width, int height, int[] source) {
        this.width = width;
        this.height = height;
        this.source = source;
    }

    static void tiledBlit(int destinationIndex, int sourceWidth, int rowCount,
            int sourceRow, byte tag, int[] destination, int copyWidth,
            int[] source, int destinationRowSkip, int sourceX,
            int sourceIndex, int sourceHeight) {
        if (tag != -64) return;
        int sourceStartX = sourceX;
        int sourceCycle = sourceHeight * sourceWidth;
        for (int row = 0; row < rowCount; row++) {
            for (int column = 0; column < copyWidth; column++) {
                destination[destinationIndex++] = source[sourceIndex++];
                if (++sourceX == sourceWidth) {
                    sourceIndex -= sourceWidth;
                    sourceX = 0;
                }
            }
            destinationIndex += destinationRowSkip;
            sourceIndex = sourceIndex - sourceX + sourceStartX + sourceWidth;
            sourceX = sourceStartX;
            if (++sourceRow == sourceHeight) {
                sourceRow = 0;
                sourceIndex -= sourceCycle;
            }
        }
    }

    static void perspectiveSpan(int[] destination, int[] texture,
            int unusedCoordinate, int unusedColor, int destinationIndex,
            int startX, int endX, int shade, int shadeStep,
            int uNumerator, int vNumerator, int wNumerator,
            int uStep, int vStep, int wStep) {
        if (endX > 128) endX = 128;
        if (startX < 0) startX = 0;
        if (startX >= endX) return;
        destinationIndex += startX;
        shade += shadeStep * startX;
        int remaining = endX - startX;
        int relativeX = startX - 64;
        uNumerator += (uStep >> 3) * relativeX;
        vNumerator += (vStep >> 3) * relativeX;
        wNumerator += (wStep >> 3) * relativeX;

        int denominator = wNumerator >> 12;
        int u0 = denominator == 0 ? 0 : uNumerator / denominator;
        int v0 = denominator == 0 ? 0 : vNumerator / denominator;
        uNumerator += uStep;
        vNumerator += vStep;
        wNumerator += wStep;
        denominator = wNumerator >> 12;
        int u1 = denominator == 0 ? 0 : uNumerator / denominator;
        int v1 = denominator == 0 ? 0 : vNumerator / denominator;
        int coordinate = (u0 << 20) + v0;
        int coordinateStep = ((u1 - u0) >> 3 << 20) + ((v1 - v0) >> 3);
        int blockCount = remaining >> 3;
        shadeStep <<= 3;
        int brightness = shade >> 8;

        while (blockCount-- > 0) {
            for (int pixel = 0; pixel < 8; pixel++) {
                int color = texture[(coordinate & 4032) + (coordinate >>> 26)];
                if (color != 0) {
                    destination[destinationIndex] =
                        (((color & 0x00ff00ff) * brightness & 0xff00ff00) +
                         ((color & 0x0000ff00) * brightness & 0x00ff0000)) >> 8;
                }
                destinationIndex++;
                coordinate += coordinateStep;
            }
            u0 = u1;
            v0 = v1;
            uNumerator += uStep;
            vNumerator += vStep;
            wNumerator += wStep;
            denominator = wNumerator >> 12;
            u1 = denominator == 0 ? 0 : uNumerator / denominator;
            v1 = denominator == 0 ? 0 : vNumerator / denominator;
            coordinate = (u0 << 20) + v0;
            coordinateStep = ((u1 - u0) >> 3 << 20) + ((v1 - v0) >> 3);
            shade += shadeStep;
            brightness = shade >> 8;
        }
        remaining &= 7;
        while (remaining-- > 0) {
            int color = texture[(coordinate & 4032) + (coordinate >>> 26)];
            if (color != 0) {
                destination[destinationIndex] =
                    (((color & 0x00ff00ff) * brightness & 0xff00ff00) +
                     ((color & 0x0000ff00) * brightness & 0x00ff0000)) >> 8;
            }
            destinationIndex++;
            coordinate += coordinateStep;
        }
    }

    void bilinearSample(int destinationIndex, int sourceX, int sourceY,
            int fractionX, int fractionY) {
        int index = sourceY * width + sourceX;
        fractionX &= 4095;
        fractionY &= 4095;
        int p00 = 0, p10 = 0, p01 = 0, p11 = 0;
        int w00 = 0, w10 = 0, w01 = 0, w11 = 0;
        if (sourceY >= 0) {
            if (sourceX >= 0) {
                p00 = source[index];
                if (p00 != 0) w00 = (4096 - fractionX) * (4096 - fractionY);
            }
            if (sourceX < width - 1) {
                p10 = source[index + 1];
                if (p10 != 0) w10 = fractionX * (4096 - fractionY);
            }
        }
        if (sourceY < height - 1) {
            if (sourceX >= 0) {
                p01 = source[index + width];
                if (p01 != 0) w01 = (4096 - fractionX) * fractionY;
            }
            if (sourceX < width - 1) {
                p11 = source[index + width + 1];
                if (p11 != 0) w11 = fractionX * fractionY;
            }
        }
        w00 >>= 16;
        w10 >>= 16;
        w01 >>= 16;
        w11 >>= 16;
        int alpha = w00 + w10 + w01 + w11;
        if (alpha < 128) return;
        int redBlue = (p00 & 0xff00ff) * w00 + (p10 & 0xff00ff) * w10
            + (p01 & 0xff00ff) * w01 + (p11 & 0xff00ff) * w11;
        int green = (p00 & 0xff00) * w00 + (p10 & 0xff00) * w10
            + (p01 & 0xff00) * w01 + (p11 & 0xff00) * w11;
        int color;
        if (alpha >= 256) {
            color = (redBlue >>> 8 & 0xff00ff) + (green >>> 8 & 0xff00);
        } else {
            color = ((redBlue >>> 16) / alpha << 16)
                + (green / alpha & 0xff00) + (redBlue & 65535) / alpha;
        }
        bilinearDestination[destinationIndex] = color == 0 ? 1 : color;
    }

    static void polygonSpan(int x, int y, int count, int color) {
        if (y < polygonClipTop || y >= polygonClipBottom) return;
        if (x < polygonClipLeft) {
            count -= polygonClipLeft - x;
            x = polygonClipLeft;
        }
        if (x + count > polygonClipRight) count = polygonClipRight - x;
        int index = y * polygonWidth + x;
        for (int offset = 0; offset < count; offset++) {
            polygonDestination[index + offset] = color;
        }
    }

    static void polygonFill(int[] vertices, int color) {
        int pairs = vertices.length >> 1;
        for (int y = 0; y < polygonHeight; y++) {
            int left = polygonWidth;
            int right = -1;
            int previous = pairs - 1;
            for (int current = 0; current < pairs; current++) {
                int x0 = vertices[previous << 1];
                int y0 = vertices[(previous << 1) + 1];
                int x1 = vertices[current << 1];
                int y1 = vertices[(current << 1) + 1];
                if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
                    int x = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
                    if (x < left) left = x;
                    if (x > right) right = x;
                }
                previous = current;
            }
            if (left <= right) polygonSpan(left, y, right - left + 1, color);
        }
    }
}
