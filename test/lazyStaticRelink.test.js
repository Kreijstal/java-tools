const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Preparation compiles a sprite blit before main() initializes the raster
// class, so every getstatic in its positional body is a lazy location that
// is re-resolved on each entry -- once per pixel for a 1x1 panel sprite.
// Once the owner is initialized the JIT recompiles the body once and
// republishes it at its call sites; the result must not change.
const source = `
class Raster {
  static int width, clipLeft, clipRight;
  static int[] pixels;
  static void init(int w) {
    width = w; clipLeft = 2; clipRight = w - 3; pixels = new int[w * w];
  }
}

class Sprite {
  int u, r;
  int[] v;
  Sprite(int x, int w, int argb) {
    u = x; r = w; v = new int[w];
    for (int i = 0; i < w; i++) v[i] = argb + i;
  }
  void b(int x, int y) {
    x += u;
    int w = r, src = 0;
    if (x < Raster.clipLeft) { int k = Raster.clipLeft - x; w -= k; src += k; x = Raster.clipLeft; }
    if (x + w > Raster.clipRight) w -= x + w - Raster.clipRight;
    int dst = x + y * Raster.width;
    for (int i = 0; i < w; i++) Raster.pixels[dst + i] = v[src + i];
  }
}

public class RelinkMain {
  public static void main(String[] args) {
    Raster.init(24);
    Sprite one = new Sprite(0, 1, 5);
    Sprite wide = new Sprite(-1, 3, 50);
    for (int frame = 0; frame < 40; frame++) {
      for (int y = 0; y < 24; y++) {
        for (int x = 0; x < 24; x++) one.b(x, y);
        for (int x = 0; x < 24; x += 3) wide.b(x, y);
      }
      try { Thread.sleep(1); } catch (InterruptedException e) { }
    }
    long sum = 0;
    for (int i = 0; i < Raster.pixels.length; i++) sum = sum * 31 + Raster.pixels[i];
    System.out.println(sum);
  }
}
`;

const jit = {compileWorker: false, structuredSsa: true,
  checkedLeafDirectPositional: true};

async function run(directory, disable) {
  const saved = process.env.JVM_DISABLE_LAZY_STATIC_RELINK;
  if (disable) process.env.JVM_DISABLE_LAZY_STATIC_RELINK = '1';
  else delete process.env.JVM_DISABLE_LAZY_STATIC_RELINK;
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  const jvm = new JVM({classpath: directory, prepareBeforeMain: true, jit});
  try {
    await jvm.run('RelinkMain');
    // Let a relink scheduled in the last turn finish before inspecting it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.stdout.write = originalWrite;
    if (saved === undefined) delete process.env.JVM_DISABLE_LAZY_STATIC_RELINK;
    else process.env.JVM_DISABLE_LAZY_STATIC_RELINK = saved;
  }
  return {jvm, output: output.trim()};
}

test('a positional body compiled with cold static owners is relinked ' +
  'once they are initialized', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-static-relink-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'RelinkMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'RelinkMain.java')]);

  const baseline = await run(directory, true);
  t.equal(baseline.jvm.jit.lazyStaticRelinkCount, 0, 'disabled: no relink');
  const relinked = await run(directory, false);
  t.ok(relinked.jvm.jit.lazyStaticRelinkCount > 0, 'the blit was relinked');
  const method = relinked.jvm.findMethod(
    relinked.jvm.classes.Sprite, 'b', '(II)V');
  const generated = relinked.jvm.jit.codegenCache.get(method);
  t.deepEqual(generated?.jvmLazyStaticOwners, [],
    'the republished body reads Raster statics directly');
  t.ok(/^-?\d+$/.test(baseline.output), 'baseline printed a checksum');
  t.equal(relinked.output, baseline.output, 'same pixels with and without relink');
  t.end();
});
