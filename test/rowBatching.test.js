const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Geoblox ma.a paints 9-slice panels with loops whose only effect is a
// one-pixel sprite draw: `while (~x > ~end) { s[4].b(x, y); x += s[4].w;
// if (flag != 0) break; }`. The loops below keep the obfuscated compare, the
// invariant flag exit, the field step read through an array element, a
// dispatching receiver, and a null field that throws mid-loop.
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

// HotSpot (OpenJDK 11) prints this for the program above.
const HOTSPOT_OUTPUT = '-5607760102343244344 6900 60';

async function run(directory) {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  const jvm = new JVM({classpath: directory});
  try {
    await jvm.run('RowMain');
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.trim();
}

test('9-slice panel loops over overriding sprite draws print the HotSpot checksum', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-row-batching-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'RowMain.java'), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'RowMain.java')]);
  t.equal(await run(directory), HOTSPOT_OUTPUT, 'same pixels, counts and exceptions as HotSpot');
  t.end();
});
