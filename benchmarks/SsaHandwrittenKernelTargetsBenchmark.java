public final class SsaHandwrittenKernelTargetsBenchmark {
    static int[] bilinearDestination;
    static int[] polygonDestination;
    static int polygonWidth = 64;
    static int polygonHeight = 64;
    static int polygonClipLeft = 0;
    static int polygonClipRight = 64;
    static int polygonClipTop = 0;
    static int polygonClipBottom = 64;
    static int[] polygonEdgeScratch;
    static int polygonEdgeCount;
    static int polygonEdgeLeft;
    static int polygonEdgeRight;
    static int polygonEdgeY;
    static int polygonEdgeActiveEnd;
    static int polygonEdgePairCursor;
    static int polygonEdgeExpiredStart;

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

    static void tiledBlitFromCaller(int[] destination, int[] source, int item) {
        int sourceX = item & 15;
        int sourceRow = item & 15;
        tiledBlit(0, 32, 8, sourceRow, (byte) -64, destination, 16,
            source, 16, sourceX, sourceRow * 32 + sourceX, 16);
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

    static void polygonQuickSortEdges(int[] scratch, int start, int end) {
        if (end <= start + 4) return;
        int pivotIndex = start;
        int pivot0 = scratch[pivotIndex];
        int pivot1 = scratch[pivotIndex + 1];
        int pivot2 = scratch[pivotIndex + 2];
        int pivot3 = scratch[pivotIndex + 3];
        for (int index = start + 4; index < end; index += 4) {
            int sortValue = scratch[index + 1];
            if (sortValue < pivot1) {
                scratch[pivotIndex] = scratch[index];
                scratch[pivotIndex + 1] = sortValue;
                scratch[pivotIndex + 2] = scratch[index + 2];
                scratch[pivotIndex + 3] = scratch[index + 3];
                pivotIndex += 4;
                scratch[index] = scratch[pivotIndex];
                scratch[index + 1] = scratch[pivotIndex + 1];
                scratch[index + 2] = scratch[pivotIndex + 2];
                scratch[index + 3] = scratch[pivotIndex + 3];
            }
        }
        scratch[pivotIndex] = pivot0;
        scratch[pivotIndex + 1] = pivot1;
        scratch[pivotIndex + 2] = pivot2;
        scratch[pivotIndex + 3] = pivot3;
        polygonQuickSortEdges(scratch, start, pivotIndex);
        polygonQuickSortEdges(scratch, pivotIndex + 4, end);
    }

    static void polygonSortActiveEdges(int[] scratch, int start, int end) {
        while (end >= start + 8) {
            int sorted = 1;
            for (int index = start + 4; index < end; index += 4) {
                int leftX = scratch[index - 4];
                int rightX = scratch[index];
                if (leftX > rightX) {
                    sorted = 0;
                    scratch[index - 4] = rightX;
                    scratch[index] = leftX;
                    int swap = scratch[index - 2];
                    scratch[index - 2] = scratch[index + 2];
                    scratch[index + 2] = swap;
                    swap = scratch[index - 1];
                    scratch[index - 1] = scratch[index + 3];
                    scratch[index + 3] = swap;
                }
            }
            if (sorted != 0) return;
            end -= 4;
        }
    }

    static void polygonEdgeFill(int[] vertices, int color) {
        int vertexLength = vertices.length;
        int[] scratch = polygonEdgeScratch;
        int edgeCount = 0;
        int previous = vertexLength - 2;
        for (int current = 0; current < vertexLength; current += 2) {
            int previousY = vertices[previous + 1];
            int currentY = vertices[current + 1];
            if (previousY < currentY) {
                scratch[edgeCount++] = vertices[previous];
                scratch[edgeCount++] = previousY;
                scratch[edgeCount++] = vertices[current];
                scratch[edgeCount++] = currentY;
            } else if (currentY < previousY) {
                scratch[edgeCount++] = vertices[current];
                scratch[edgeCount++] = currentY;
                scratch[edgeCount++] = vertices[previous];
                scratch[edgeCount++] = previousY;
            }
            previous = current;
        }

        polygonQuickSortEdges(scratch, 0, edgeCount);
        int y = scratch[1];
        if (y < polygonClipTop) y = polygonClipTop;
        int activeEnd = 0;
        while (activeEnd < edgeCount) {
            int edgeY = scratch[activeEnd + 1];
            if (y < edgeY) break;
            int x0 = scratch[activeEnd];
            int x1 = scratch[activeEnd + 2];
            int y1 = scratch[activeEnd + 3];
            int step = ((x1 - x0) << 16) / (y1 - edgeY);
            int fixed = (x0 << 16) + 32768;
            scratch[activeEnd] = fixed + (y - edgeY) * step;
            scratch[activeEnd + 2] = step;
            activeEnd += 4;
        }
        int expiredStart = 0;
        int pairCursor = activeEnd;
        int storedActiveEnd = activeEnd;
        int storedExpiredStart = expiredStart;
        int storedPairCursor = pairCursor;
        y--;
        int outputLeft = polygonEdgeLeft;
        int outputRight = polygonEdgeRight;

        while (true) {
            if (pairCursor < activeEnd) {
                outputLeft = scratch[pairCursor] >> 16;
                outputRight = scratch[pairCursor + 4] >> 16;
                scratch[pairCursor] += scratch[pairCursor + 2];
                scratch[pairCursor + 4] += scratch[pairCursor + 6];
                pairCursor += 8;
                storedPairCursor = pairCursor;
                polygonSpan(outputLeft, y, outputRight - outputLeft, color);
                continue;
            }

            y++;
            if (y >= polygonClipBottom) break;
            int newExpiredStart = expiredStart;
            while (activeEnd < edgeCount) {
                int edgeY = scratch[activeEnd + 1];
                if (y < edgeY) break;
                int x0 = scratch[activeEnd];
                int x1 = scratch[activeEnd + 2];
                int y1 = scratch[activeEnd + 3];
                int step = ((x1 - x0) << 16) / (y1 - edgeY);
                scratch[activeEnd] = (x0 << 16) + 32768;
                scratch[activeEnd + 2] = step;
                activeEnd += 4;
            }
            for (int index = newExpiredStart; index < activeEnd; index += 4) {
                int endY = scratch[index + 3];
                if (y >= endY) {
                    scratch[index] = scratch[newExpiredStart];
                    scratch[index + 1] = scratch[newExpiredStart + 1];
                    scratch[index + 2] = scratch[newExpiredStart + 2];
                    scratch[index + 3] = scratch[newExpiredStart + 3];
                    newExpiredStart += 4;
                }
            }
            if (newExpiredStart == edgeCount) {
                edgeCount = 0;
                break;
            }
            expiredStart = newExpiredStart;
            polygonSortActiveEdges(scratch, expiredStart, activeEnd);
            storedExpiredStart = expiredStart;
            storedActiveEnd = activeEnd;
            pairCursor = expiredStart;
        }

        polygonEdgeCount = edgeCount;
        polygonEdgeScratch = scratch;
        polygonEdgeLeft = outputLeft;
        polygonEdgeRight = outputRight;
        polygonEdgeY = y;
        polygonEdgeActiveEnd = storedActiveEnd;
        polygonEdgePairCursor = storedPairCursor;
        polygonEdgeExpiredStart = storedExpiredStart;
    }
}
