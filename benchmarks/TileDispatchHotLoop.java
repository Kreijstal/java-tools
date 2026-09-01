/**
 * Reduced hot loop for a dispatch-heavy loading gap.
 *
 * Derived from a boot CPU profile of tombracer on jvm.js. The single largest
 * guest-attributed cost in that profile is a tile-grid layout method whose
 * inner loop is call-dense rather than arithmetic-dense: each cell issues a
 * wide invokeinterface, two narrow interface getters, an invokestatic factory,
 * a checkcast, and three invokevirtual calls, around a small object cache.
 * Only 22% of the time under it was guest code; 56% was the JIT's call
 * boundary (tryInvokeSyncAt / tryInvokeResolvedTarget), and the method never
 * left the weakest "generated-sync" tier.
 *
 * CallBoundaryHotLoop covers the *static* call boundary. This fixture covers
 * the boundary shapes that dominate loading and that a static call does not
 * exercise: interface dispatch, polymorphic receivers, and a virtual call
 * behind a checkcast.
 *
 * Shapes, each (int iterations, int seed) -> int so they are directly
 * comparable and checksummable:
 *   - arith:  control. Straight-line integer work, no calls.
 *   - iface:  one interface call per iteration, single implementation loaded.
 *   - poly:   the same call site with three implementations in rotation.
 *   - tile:   the profiled mix -- interface + static + checkcast + virtual
 *             per cell of a nested grid walk.
 */
public final class TileDispatchHotLoop {

    /** Stands in for the wide game interface whose getters the loop calls. */
    interface Cell {
        int width(int bias);
        int height(int bias);
        boolean visible(int x, int y, int w, int h, Cell peer, int flags);
    }

    static final class PlainCell implements Cell {
        int w;
        int h;

        PlainCell(int w, int h) {
            this.w = w;
            this.h = h;
        }

        public int width(int bias) {
            return w + bias;
        }

        public int height(int bias) {
            return h + bias;
        }

        public boolean visible(int x, int y, int w2, int h2, Cell peer, int flags) {
            return ((x + y + w2 + h2 + flags) & 3) != 0;
        }
    }

    static final class ScaledCell implements Cell {
        int w;
        int h;

        ScaledCell(int w, int h) {
            this.w = w;
            this.h = h;
        }

        public int width(int bias) {
            return (w << 1) + bias;
        }

        public int height(int bias) {
            return (h << 1) + bias;
        }

        public boolean visible(int x, int y, int w2, int h2, Cell peer, int flags) {
            return ((x ^ y ^ w2 ^ h2 ^ flags) & 3) != 0;
        }
    }

    static final class ClippedCell implements Cell {
        int w;
        int h;

        ClippedCell(int w, int h) {
            this.w = w;
            this.h = h;
        }

        public int width(int bias) {
            return (w - bias) & 0xffff;
        }

        public int height(int bias) {
            return (h - bias) & 0xffff;
        }

        public boolean visible(int x, int y, int w2, int h2, Cell peer, int flags) {
            return ((x * 3 + y * 5 + w2 + h2 + flags) & 3) != 0;
        }
    }

    /** Base of the checkcast chain: the cache stores these, the loop needs Tile. */
    static class Entry {
        int tag;

        Entry(int tag) {
            this.tag = tag;
        }
    }

    static final class Tile extends Entry {
        int value;

        Tile(int tag, int value) {
            super(tag);
            this.value = value;
        }

        int blend(int x, int y, Cell cell, int flags) {
            return value + x * 31 + y * 17 + cell.width(1) + flags;
        }

        public int hashCode() {
            return value * 31 + tag;
        }
    }

    /** Stands in for the small keyed object cache the profiled loop consults. */
    static final class Cache {
        Entry[] slots;

        Cache(int size) {
            slots = new Entry[size];
        }

        Entry get(int key, long stamp) {
            return slots[(key + (int) stamp) & (slots.length - 1)];
        }

        void put(int key, Entry entry, long stamp) {
            slots[(key + (int) stamp) & (slots.length - 1)] = entry;
        }
    }

    /** Stands in for the static factory the loop calls per cell. */
    static Tile makeTile(int index, Cell cell, int bias, boolean scaled) {
        return new Tile(index & 0x7f, cell.height(bias) + (scaled ? 1 : 0));
    }

    static int sink;
    // Machine-readable results for the browser harness. Console output stays
    // unchanged for the Node/HotSpot benchmark, while the browser can inspect
    // these fields without timing terminal rendering or parsing guest output.
    static int[] measuredNanos;
    static int[] measuredChecksums;

    public static int runArith(int iterations, int seed) {
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            int x = value + i;
            x = x + 0x1357;
            x = ((x << 5) | (x >>> 27)) ^ 0x2468;
            x = x * 33 + 17;
            x = x ^ (x >>> 11);
            value = x + (x >>> 3) + 0x55aa;
        }
        return value;
    }

    // Both call loops below carry a loop-carried dependency through the call
    // argument. Without it HotSpot folds the monomorphic case to a closed form
    // (0.5 ns/iter measured), which makes the slowdown ratio a division by a
    // denominator that no longer contains a call at all.
    public static int runIface(int iterations, int seed) {
        Cell cell = new PlainCell(seed & 0xff, (seed >>> 8) & 0xff);
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            value = value + cell.width(value & 7);
        }
        return value;
    }

    public static int runPoly(int iterations, int seed) {
        Cell[] cells = new Cell[3];
        cells[0] = new PlainCell(seed & 0xff, (seed >>> 8) & 0xff);
        cells[1] = new ScaledCell(seed & 0x7f, (seed >>> 4) & 0x7f);
        cells[2] = new ClippedCell(seed & 0x3f, (seed >>> 2) & 0x3f);
        int value = seed;
        for (int i = 0; i < iterations; i++) {
            value = value + cells[i % 3].width(value & 7);
        }
        return value;
    }

    /**
     * The profiled shape: a nested grid walk whose body is a mix of interface,
     * static, virtual and cache calls with a checkcast, and almost no
     * arithmetic. `iterations` is the total cell count; the grid is 16 wide.
     */
    public static int runTile(int iterations, int seed) {
        Cell[] cells = new Cell[3];
        cells[0] = new PlainCell(seed & 0xff, (seed >>> 8) & 0xff);
        cells[1] = new ScaledCell(seed & 0x7f, (seed >>> 4) & 0x7f);
        cells[2] = new ClippedCell(seed & 0x3f, (seed >>> 2) & 0x3f);
        Cache cache = new Cache(64);
        Cell peer = cells[0];
        int value = seed;
        int columns = 16;
        int rows = iterations / columns;
        for (int y = 0; y < rows; y++) {
            Cell cell = cells[y % 3];
            for (int x = 0; x < columns; x++) {
                if (!cell.visible(x, y, cell.width(1), cell.height(1), peer, value & 7)) {
                    continue;
                }
                Entry cached = cache.get(x + y, (long) (value & 3));
                Tile tile;
                if (cached instanceof Tile) {
                    tile = (Tile) cached;
                } else {
                    tile = makeTile(x + y, cell, 1, (value & 1) != 0);
                    cache.put(x + y, tile, (long) (value & 3));
                }
                value = value + tile.blend(x, y, cell, value & 7);
                sink = tile.hashCode();
            }
        }
        return value + sink;
    }

    public static void main(String[] args) {
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 2000000;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 5;
        int warmups = args.length > 2 ? Integer.parseInt(args[2]) : 3;
        String[] names = {"arith", "iface", "poly", "tile"};
        measuredNanos = new int[names.length * rounds];
        measuredChecksums = new int[names.length * rounds];
        int measured = 0;
        for (String name : names) {
            for (int round = 0; round < warmups + rounds; round++) {
                long started = System.nanoTime();
                int checksum = name.equals("arith")
                    ? runArith(iterations, 12345)
                    : name.equals("iface")
                        ? runIface(iterations, 12345)
                        : name.equals("poly")
                            ? runPoly(iterations, 12345)
                            : runTile(iterations, 12345);
                long elapsed = System.nanoTime() - started;
                if (round >= warmups) {
                    measuredNanos[measured] = (int) elapsed;
                    measuredChecksums[measured++] = checksum;
                    System.out.println("RESULT " + name + " " + round + " "
                        + elapsed + " " + checksum);
                }
            }
        }
    }
}
