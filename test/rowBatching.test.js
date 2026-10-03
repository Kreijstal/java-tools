const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Geoblox ma.a paints 9-slice panels with loops whose only effect is a
// one-pixel sprite draw: `while (~x > ~end) { s[4].b(x, y); x += s[4].w;
// if (flag != 0) break; }`. Row batching hands the remaining iterations of
// such a loop to the leaf's row entry. The loops below keep the obfuscated
// compare, the invariant flag exit, the field step read through an array
// element and a dispatching receiver; the program's output must not change.
const source = `
class Raster {
  static int width, clipLeft, clipRight, clipTop, clipBottom;
  static int[] pixels;
  static void init(int w, int h) {
    width = w; clipLeft = 1; clipRight = w - 2; clipTop = 1; clipBottom = h - 1;
    pixels = new int[w * h];
  }
}

class Sprite {
  int u, p, w, h;
  int[] v;
  Sprite(int x, int y, int ww, int hh, int argb) {
    u = x; p = y; w = ww; h = hh; v = new int[ww * hh];
    for (int i = 0; i < v.length; i++) v[i] = argb + i;
  }
  void b(int x, int y) {
    x += u; y += p;
    int dst = x + y * Raster.width, src = 0, hh = h, ww = w;
    int dstStep = Raster.width - ww, srcStep = 0;
    if (y < Raster.clipTop) {
      int k = Raster.clipTop - y; hh -= k; y = Raster.clipTop; src += k * ww; dst += k * Raster.width;
    }
    if (y + hh > Raster.clipBottom) hh -= y + hh - Raster.clipBottom;
    if (x < Raster.clipLeft) {
      int k = Raster.clipLeft - x; ww -= k; x = Raster.clipLeft; src += k; dst += k; srcStep += k; dstStep += k;
    }
    if (x + ww > Raster.clipRight) { int k = x + ww - Raster.clipRight; ww -= k; srcStep += k; dstStep += k; }
    if (ww > 0 && hh > 0) blit(Raster.pixels, v, src, dst, ww, hh, dstStep, srcStep);
  }
  static void blit(int[] dst, int[] src, int s, int d, int w, int h, int dstStep, int srcStep) {
    for (int row = -h; row < 0; row++) {
      for (int col = -w; col < 0; col++) { int c = src[s++]; if (c != 0) dst[d] = c; d++; }
      d += dstStep; s += srcStep;
    }
  }
}

// Overrides the leaf: a receiver of this class must not run Sprite's row.
class Tinted extends Sprite {
  Tinted(int argb) { super(0, 0, 1, 1, argb); }
  void b(int x, int y) {
    if (x >= Raster.clipLeft && x < Raster.clipRight && y >= Raster.clipTop && y < Raster.clipBottom)
      Raster.pixels[x + y * Raster.width] ^= v[0];
  }
}

// Writes a field: never a row entry, still correct through the loop.
class Counting extends Sprite {
  int count;
  Counting(int argb) { super(0, 0, 1, 1, argb); }
  void b(int x, int y) { count++; super.b(x, y); }
}

public class RowMain {
  static void panel(Sprite[] s, int x0, int x1, int y0, int y1, int flag) {
    int y = y0;
    while (~y > ~y1) {
      int x = x0;
      while (~x > ~x1) {
        s[4].b(x, y);
        x += s[4].w;
        if (flag != 0) break;
      }
      y += s[4].h;
    }
    for (int x = x0; x < x1; x += 2) s[1].b(x, y0 - 1);
  }

  public static void main(String[] args) {
    Raster.init(40, 30);
    Sprite[] plain = new Sprite[9];
    for (int i = 0; i < 9; i++) plain[i] = new Sprite(0, 0, 1, 1, 10 * i + 1);
    Sprite[] wide = new Sprite[9];
    for (int i = 0; i < 9; i++) wide[i] = new Sprite(-1, 0, 3, 2, 100 * i + 7);
    Sprite[] tinted = new Sprite[9];
    for (int i = 0; i < 9; i++) tinted[i] = new Tinted(1000 + i);
    Counting counting = new Counting(5);
    Sprite[] counted = new Sprite[9];
    for (int i = 0; i < 9; i++) counted[i] = counting;
    Sprite[] broken = new Sprite[9];
    for (int i = 0; i < 9; i++) broken[i] = new Sprite(0, 0, 1, 1, 3);
    broken[4].v = null;
    int thrown = 0;
    for (int frame = 0; frame < 60; frame++) {
      panel(plain, -2, 41, 0, 30, 0);
      panel(wide, frame % 5, 37, 2, 29, 0);
      panel(plain, 3, 30, 4, 20, 1);
      panel(tinted, 0, 39, 1, 28, 0);
      panel(counted, 5, 25, 5, 15, frame & 1);
      try { panel(broken, 10, 20, 10, 12, 0); } catch (NullPointerException e) { thrown++; }
      try { Thread.sleep(1); } catch (InterruptedException e) { }
    }
    long sum = 0;
    for (int i = 0; i < Raster.pixels.length; i++) sum = sum * 31 + Raster.pixels[i];
    System.out.println(sum + " " + counting.count + " " + thrown);
  }
}
`;

const jit = {compileWorker: false, structuredSsa: true,
  checkedLeafDirectPositional: true, compiledCallChains: true,
  ordinaryAdaptiveFramelessPositional: true,
  ordinaryAdaptiveCallChainSafePointBudget: 1};

async function run(directory, disable) {
  const saved = process.env.JVM_DISABLE_ROW_BATCHING;
  if (disable) process.env.JVM_DISABLE_ROW_BATCHING = '1';
  else delete process.env.JVM_DISABLE_ROW_BATCHING;
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  const jvm = new JVM({classpath: directory, prepareBeforeMain: true, jit});
  try {
    await jvm.run('RowMain');
  } finally {
    process.stdout.write = originalWrite;
    if (saved === undefined) delete process.env.JVM_DISABLE_ROW_BATCHING;
    else process.env.JVM_DISABLE_ROW_BATCHING = saved;
  }
  return {jvm, output: output.trim()};
}

test('counted loops that only call a checked leaf hand rows to its row ' +
  'entry without changing the result', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-row-batching-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'RowMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'RowMain.java')]);

  const baseline = await run(directory, true);
  t.ok(/^-?\d+ \d+ 60$/.test(baseline.output),
    `baseline ran every panel (${baseline.output})`);
  const batched = await run(directory, false);
  t.equal(batched.output, baseline.output, 'same pixels, counts and exceptions');

  const {jvm} = batched;
  t.equal(baseline.jvm.jit.structuredSsa.rowBatchCount, 0, 'disabled: no hand-over');
  t.ok(jvm.jit.structuredSsa.rowBatchCount > 0,
    `rows were handed over (${jvm.jit.structuredSsa.rowBatchCount})`);
  const methodOf = (cls, name, descriptor) =>
    jvm.findMethod(jvm.classes[cls], name, descriptor);
  const panel = jvm.jit.codegenCache.get(
    methodOf('RowMain', 'panel', '([LSprite;IIIII)V'));
  t.ok(/ssaRowFor\d+/.test(String(panel?.jvmAdaptivePositionalSource ||
    panel?.jvmStructuredSource || '')), 'the panel loops hand rows over');
  t.deepEqual(Object.keys(panel?.jvmStructuredLinkRecordCaptures || {})
    .filter((name) => /undefined/.test(name)), [],
    'a constant row step captures no field site');
  const sprite = jvm.jit.codegenCache.get(methodOf('Sprite', 'b', '(II)V'));
  t.equal(typeof sprite?.jvmCheckedLeafRowBodyFor?.(1), 'function',
    'the sprite draw publishes a row entry for its x argument');
  const counting = jvm.jit.codegenCache.get(methodOf('Counting', 'b', '(II)V'));
  t.notOk(counting?.jvmCheckedLeafRowBodyFor,
    'a draw that writes a field publishes none');
  t.end();
});
