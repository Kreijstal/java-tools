const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

// A static-array span fill (the shape of a 2D raster blend) compiled after its
// static field sites have linked. The restoring positional variant renders a
// versioned loop body twice under the same SSA names; the one-use propagation
// pass used to take the second declaration of a name for its use and rewrite
// the declaration itself into `const (x) = x;`, a syntax error that rejected
// the whole structured compile and left the loop on the scalar tier.
test('structured SSA survives duplicate declarations of versioned loop bodies', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-fixture-'));
  t.teardown(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, 'SpanFillHarness.java'), `
public final class SpanFillHarness {
  static int top, bottom, left, right, stride;
  static int[] pixels;
  static void fill(int x, int y, int width, int color, int alpha) {
    if (y < top || y >= bottom) return;
    if (x < left) { width -= left - x; x = left; }
    if (x + width > right) width = right - x;
    int inverse = 256 - alpha;
    int red = (color >> 16 & 255) * alpha;
    int green = (color >> 8 & 255) * alpha;
    int blue = (color & 255) * alpha;
    int index = x + y * stride;
    for (int i = 0; i < width; i++) {
      int r = (pixels[index] >> 16 & 255) * inverse;
      int g = (pixels[index] >> 8 & 255) * inverse;
      int b = (pixels[index] & 255) * inverse;
      pixels[index++] = (red + r >> 8 << 16) + (green + g >> 8 << 8) + (blue + b >> 8);
    }
  }
}
`);
  execFileSync('javac', ['-g', '-d', tempDir, path.join(tempDir, 'SpanFillHarness.java')], { stdio: 'inherit' });

  const jvm = new JVM({ classpath: tempDir, jit: {
    warmupThreshold: 1000000, preferWholeMethodJs: true, profileMethods: false,
    scalarLoops: true, scalarGuestBodies: true, structuredSsa: true, rendererPipeline: true,
  } });
  const classData = await jvm.loadClassByName('SpanFillHarness');
  jvm.classInitializationState.set('SpanFillHarness', 'INITIALIZED');
  if (!classData.staticFields) classData.staticFields = new Map();
  const pixels = new Array(64).fill(0x102030);
  pixels.type = '[I';
  for (const [key, value] of [['top:I', 0], ['bottom:I', 8], ['left:I', 0], ['right:I', 8], ['stride:I', 8], ['pixels:[I', pixels]]) {
    classData.staticFields.set(key, value);
  }
  const thread = { id: 0, name: 'span-fill', callStack: new Stack(), status: 'runnable', pendingException: null };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const method = await jvm.findMethodInHierarchy('SpanFillHarness', 'fill', '(IIIII)V');
  // Interpret a few spans first so every static field site links a direct target.
  for (let row = 0; row < 3; row += 1) {
    const frame = new Frame(method);
    frame.className = 'SpanFillHarness';
    [1, row, 6, 0xffffff, 128].forEach((value, index) => { frame.locals[index] = value; });
    const before = thread.callStack.size();
    thread.callStack.push(frame);
    while (thread.callStack.size() > before) {
      const result = await jvm.executeTick();
      if (result.completed) break;
    }
  }
  const expected = pixels.slice();

  jvm.jit.structuredSsa.lastRejectionReason = null;
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated, `structured compile succeeds (${jvm.jit.structuredSsa.lastRejectionReason || 'no rejection'})`);
  if (!generated) return t.end();
  t.equal(jvm.jit.structuredSsa.lastRejectionReason, null, 'no rejection reason recorded');
  const positional = generated.jvmRestoringDirectPositionalSource || '';
  t.notOk(/\b(const|let)\s*\(/.test(positional), 'positional variant declares only identifiers');
  t.ok(generated.jvmSynchronous, 'body is synchronous');
  t.end();
});
