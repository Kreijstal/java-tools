const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');
const {inlineCalls} = require('../src/jit/wasmInline');

// Geoblox's 9-slice painter calls a sprite draw per pixel; the draw clips and
// calls a static blit whose loops count up to zero. Deep inlining (opt-in)
// splices the draw and the blit into the painter's module. A spliced loop has
// no caller pc to take a fuel exit at, so only loops that provably terminate
// are admitted.
const source = `
class Raster {
  static int width = 8, clipLeft = 0, clipRight = 8;
  static int[] pixels = new int[64];
}

class Sprite {
  int u, w;
  int[] v = new int[4];
  void b(int x, int y) {
    x += u;
    int ww = w;
    if (x + ww > Raster.clipRight) ww = Raster.clipRight - x;
    if (ww > 0) blit(Raster.pixels, v, x + y * Raster.width, ww);
  }
  static void blit(int[] dst, int[] src, int d, int w) {
    for (int col = -w; col < 0; col++) { int c = src[col + w]; if (c != 0) dst[d] = c; d++; }
  }
  void spin(int x) { loop(x); }
  static void loop(int n) {
    // Not counted: the counter moves both ways, so it is never admitted.
    for (int i = 0; i < 10; i++) { if (n > 3) i -= 2; n--; }
  }
}

public class DeepMain {
  static void paint(Sprite s, int x0, int x1, int y) {
    for (int x = x0; x < x1; x++) s.b(x, y);
  }
  static void spinAll(Sprite s, int n) { s.spin(n); }
  public static void main(String[] args) {
    Sprite s = new Sprite();
    s.w = 2; s.v[0] = 5; s.v[1] = 6;
    paint(s, 0, 8, 1);
    spinAll(s, 5);
    System.out.println(Raster.pixels[9]);
  }
}
`;

test('deep inlining splices a sprite draw and its counted blit, and only ' +
  'counted loops', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-deep-inline-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'DeepMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory, path.join(directory, 'DeepMain.java')]);

  const jvm = new JVM({classpath: directory, jit: {compileWorker: false}});
  await jvm.run('DeepMain');
  const code = (cls, name, descriptor) => jvm.findMethod(jvm.classes[cls], name, descriptor)
    .attributes.find((attribute) => attribute.type === 'code');
  const hierarchy = jvm.jit.wasmJit.hierarchy;
  const options = (deepInline) => ({hierarchy, callerClassName: 'DeepMain',
    callerIsStatic: true, maxCalleeItems: 200, budget: 4096, deepInline});

  t.equal(inlineCalls(jvm, code('DeepMain', 'paint', '(LSprite;III)V'), options(false)),
    null, 'off by default: the draw calls a looping blit and stays a call');
  const deep = inlineCalls(jvm, code('DeepMain', 'paint', '(LSprite;III)V'), options(true));
  t.equal(deep?.inlined, 1, 'deep: the draw site is spliced');
  t.equal(deep?.loopSites, 1, 'and it sits in the caller loop (a Wasm candidate)');
  const ops = (deep?.items || []).map((item) => typeof item.instruction === 'string'
    ? item.instruction : item.instruction?.op);
  t.notOk(ops.some((op) => op === 'invokestatic' || op === 'invokevirtual'),
    'no call is left: the blit was spliced into the draw');
  t.ok(ops.filter((op) => op === 'iinc').length >= 1, 'the blit loop came along');
  t.equal(deep.ehOrigIdx.length, deep.items.length, 'every item maps to a caller pc');
  t.ok(deep.origIdx.some((orig) => orig === -1), 'spliced items have no resume pc');

  t.equal(inlineCalls(jvm, code('DeepMain', 'spinAll', '(LSprite;I)V'), options(true)),
    null, 'a loop whose counter also moves backwards is never spliced');
  t.end();
});
