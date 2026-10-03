const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Geoblox il.b(II)V draws a 1x1 sprite once per pixel of a panel: it reads
// the sprite's offsets and size and the raster's clip bounds, then calls a
// static blit that the compiler inserts as a checked leaf. Its field reads
// kept it out of the lexical wrapper shape, so every pixel paid for a
// restoring body with lazy frame reconstruction. Reads that precede the only
// effect are transactional: a failed read returns to the canonical caller
// before anything happened. A read after the effect is not, so such a
// wrapper must keep its restoring body.
const source = `
class Raster {
  static int width, clipTop, clipBottom, clipLeft, clipRight;
  static int[] pixels;
}

class Sprite {
  int u, p, m, r;
  int[] v;
  Sprite next;

  Sprite(int x, int y, int w, int h, int argb) {
    u = x; p = y; r = w; m = h; v = new int[w * h];
    for (int i = 0; i < v.length; i++) v[i] = argb + i;
  }

  void draw(int x, int y) {
    x += u;
    y += p;
    int dst = x + y * Raster.width;
    int src = 0, h = m, w = r, dstStep = Raster.width - w, srcStep = 0;
    if (y < Raster.clipTop) {
      int skip = Raster.clipTop - y;
      h -= skip; y = Raster.clipTop; src += skip * w; dst += skip * Raster.width;
    }
    if (y + h > Raster.clipBottom) h -= y + h - Raster.clipBottom;
    if (x < Raster.clipLeft) {
      int skip = Raster.clipLeft - x;
      w -= skip; x = Raster.clipLeft; src += skip; dst += skip;
      srcStep += skip; dstStep += skip;
    }
    if (x + w > Raster.clipRight) {
      int skip = x + w - Raster.clipRight;
      w -= skip; srcStep += skip; dstStep += skip;
    }
    if (w > 0 && h > 0) copy(Raster.pixels, v, src, dst, w, h, dstStep, srcStep);
  }

  // The effect comes first, then a read that may throw (next may be null).
  void drawThenFollow(int x, int y) {
    copy(Raster.pixels, v, 0, x + y * Raster.width, 1, 1, 0, 0);
    int ignored = next.u;
  }

  private static void copy(int[] dst, int[] src, int s, int d, int w, int h,
      int dstStep, int srcStep) {
    for (int row = -h; row < 0; row++) {
      for (int col = -w; col < 0; col++) dst[d++] = src[s++];
      d += dstStep;
      s += srcStep;
    }
  }
}

public class WrapperMain {
  public static void main(String[] args) {
    Raster.width = 16; Raster.clipTop = 2; Raster.clipBottom = 12;
    Raster.clipLeft = 3; Raster.clipRight = 14;
    Raster.pixels = new int[16 * 16];
    Sprite one = new Sprite(0, 0, 1, 1, 7);
    Sprite block = new Sprite(-1, -2, 3, 4, 100);
    for (int y = 0; y < 16; y++) {
      for (int x = 0; x < 16; x++) one.draw(x, y);
    }
    for (int y = -4; y < 18; y += 3) {
      for (int x = -4; x < 18; x += 2) block.draw(x, y);
    }
    int caught = 0;
    for (int i = 0; i < 4; i++) {
      try { one.drawThenFollow(i, 0); } catch (NullPointerException e) { caught++; }
    }
    long sum = 0;
    for (int i = 0; i < Raster.pixels.length; i++) sum = sum * 31 + Raster.pixels[i];
    System.out.println(sum + " " + caught);
  }
}
`;

function reference() {
  const width = 16, top = 2, bottom = 12, left = 3, right = 14;
  const pixels = new Int32Array(256);
  const sprite = (u, p, w, h, argb) => ({u, p, w, h,
    v: Array.from({length: w * h}, (_, i) => argb + i)});
  const draw = (s, x, y) => {
    x += s.u; y += s.p;
    let dst = x + y * width, src = 0, h = s.h, w = s.w;
    let dstStep = width - w, srcStep = 0;
    if (y < top) { const k = top - y; h -= k; y = top; src += k * w; dst += k * width; }
    if (y + h > bottom) h -= y + h - bottom;
    if (x < left) { const k = left - x; w -= k; x = left; src += k; dst += k; srcStep += k; dstStep += k; }
    if (x + w > right) { const k = x + w - right; w -= k; srcStep += k; dstStep += k; }
    if (w > 0 && h > 0) {
      for (let row = -h; row < 0; row++) {
        for (let col = -w; col < 0; col++) pixels[dst++] = s.v[src++];
        dst += dstStep; src += srcStep;
      }
    }
  };
  const one = sprite(0, 0, 1, 1, 7), block = sprite(-1, -2, 3, 4, 100);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) draw(one, x, y);
  for (let y = -4; y < 18; y += 3) for (let x = -4; x < 18; x += 2) draw(block, x, y);
  for (let i = 0; i < 4; i++) pixels[i] = 7;
  let sum = 0n;
  for (const value of pixels) sum = BigInt.asIntN(64, sum * 31n + BigInt(value));
  return `${sum} 4`;
}

const jit = {compileWorker: false, warmupThreshold: 0, structuredSsa: true,
  checkedLeafDirectPositional: true};

test('a wrapper whose field and static reads precede its inserted leaf ' +
  'publishes a frame-free checked leaf', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-leaf-wrapper-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'WrapperMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'WrapperMain.java')]);

  const jvm = new JVM({classpath: directory, jit});
  await jvm.loadClassByName('Sprite');
  await jvm.loadClassByName('Raster');
  const draw = jvm.jit.getGeneratedFunction(
    await jvm.findMethodInHierarchy('Sprite', 'draw', '(II)V'));
  t.equal(draw?.jvmStructuredLexicalCheckedLeafWrapper, true,
    'draw is a lexical checked-leaf wrapper');
  t.equal(draw?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'the blit is inserted into it');
  const trusted = String(draw?.jvmTrustedCheckedLeafDirectPositionalBody || '');
  t.ok(trusted.length > 0, 'draw has a trusted checked-leaf body');
  // The inserted call's ordinary protocol still follows its bail as
  // unreachable text; what must be gone is the restoring ABI itself.
  t.notOk(/materializeDirectFrameSlots|restoreDirectFrameSlots|\btry\s*\{/
    .test(trusted), 'the trusted body carries no restoring frame reconstruction');

  const follow = jvm.jit.getGeneratedFunction(
    await jvm.findMethodInHierarchy('Sprite', 'drawThenFollow', '(II)V'));
  t.notOk(follow?.jvmStructuredLexicalCheckedLeafWrapper,
    'a read after the inserted effect keeps the wrapper out');
  t.notOk(typeof follow?.jvmCheckedLeafDirectPositionalBody === 'function',
    'and publishes no checked leaf, which would repeat the effect on a bail');

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    await new JVM({classpath: directory, jit}).run('WrapperMain');
  } finally {
    process.stdout.write = originalWrite;
  }
  t.equal(output.trim(), reference(),
    'clipped, unclipped and off-raster draws match the JS reference');
  t.end();
});
