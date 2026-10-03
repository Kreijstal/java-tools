const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

// Preparation compiles every method before any <clinit> runs, so at that
// point no class is INITIALIZED and a compile-time checked-leaf call would
// skip the invokestatic initialization trigger. The rule under test: a caller
// that is itself a method of the callee's class may still take the leaf
// (its class is initialized, or being initialized by this thread, whenever it
// runs); a caller in another class keeps the late-linked call site until the
// owner is initialized.

const leafSource = `
  static void blit(int[] dst, int[] src, int p, int srcOff, int dstOff,
      int w, int h, int dstStep, int srcStep) {
    int quads = -(w >> 2);
    int rem = -(w & 3);
    for (int y = -h; y < 0; y++) {
      for (int q = quads; q < 0; q++) {
        p = src[srcOff++]; if (p != 0) dst[dstOff++] = p; else dstOff++;
        p = src[srcOff++]; if (p != 0) dst[dstOff++] = p; else dstOff++;
        p = src[srcOff++]; if (p != 0) dst[dstOff++] = p; else dstOff++;
        p = src[srcOff++]; if (p != 0) dst[dstOff++] = p; else dstOff++;
      }
      for (int r = rem; r < 0; r++) {
        p = src[srcOff++]; if (p != 0) dst[dstOff++] = p; else dstOff++;
      }
      dstOff += dstStep;
      srcOff += srcStep;
    }
  }
`;

const ownerSource = `
public class ColdLeafOwner {
  static int inits = 0;
  static { inits += 1; }
  ${leafSource}

  // Same class as the leaf: the caller cannot run before ColdLeafOwner is
  // (being) initialized, so a prepared compile may insert the leaf.
  static void draw(int[] dst, int[] src, int x, int y) {
    blit(dst, src, 0, 0, y * 64 + x, 13, 7, 64 - 13, 16 - 13);
  }

  static long checksum(int[] dst) {
    long sum = 0;
    for (int i = 0; i < dst.length; i++) sum = sum * 31 + dst[i];
    return sum;
  }

  public static void main(String[] args) {
    int[] dst = new int[64 * 16];
    int[] src = new int[16 * 16];
    for (int i = 0; i < src.length; i++) src[i] = (i % 3 == 0) ? 0 : 0x100 + i;
    for (int i = 0; i < dst.length; i++) dst[i] = -i;
    draw(dst, src, 3, 5);
    draw(dst, src, 40, 2);
    ColdLeafOther.draw(dst, src, 20, 8);
    System.out.println(checksum(dst));
    System.out.println(inits);
  }
}
`;

const otherSource = `
public class ColdLeafOther {
  static void draw(int[] dst, int[] src, int x, int y) {
    ColdLeafOwner.blit(dst, src, 0, 0, y * 64 + x, 13, 7, 64 - 13, 16 - 13);
  }
}
`;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-cold-leaf-'));
  fs.writeFileSync(path.join(directory, 'ColdLeafOwner.java'), ownerSource);
  fs.writeFileSync(path.join(directory, 'ColdLeafOther.java'), otherSource);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'ColdLeafOwner.java'),
    path.join(directory, 'ColdLeafOther.java')]);
  return directory;
}

const leafJit = {compileWorker: false, warmupThreshold: 0, structuredSsa: true,
  checkedLeafDirectPositional: true};

async function compileCaller(classpath, owner, warm) {
  const jvm = new JVM({classpath, jit: leafJit});
  await jvm.loadClassByName('ColdLeafOwner');
  await jvm.loadClassByName('ColdLeafOther');
  if (warm) jvm.classInitializationState.set('ColdLeafOwner', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(owner, 'draw', '([I[III)V');
  return jvm.jit.getGeneratedFunction(method);
}

function reference() {
  const dst = new Int32Array(64 * 16), src = new Int32Array(16 * 16);
  for (let i = 0; i < src.length; i++) src[i] = (i % 3 === 0) ? 0 : 0x100 + i;
  for (let i = 0; i < dst.length; i++) dst[i] = -i;
  const draw = (x, y) => {
    let so = 0, d = y * 64 + x;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 13; col++) {
        const v = src[so++]; if (v !== 0) dst[d] = v; d++;
      }
      d += 64 - 13; so += 16 - 13;
    }
  };
  draw(3, 5); draw(40, 2); draw(20, 8);
  let sum = 0n;
  for (let i = 0; i < dst.length; i++) {
    sum = BigInt.asIntN(64, sum * 31n + BigInt(dst[i]));
  }
  return `${sum}\n1`;
}

test('a cold same-class caller inserts the checked leaf, a cold other-class ' +
  'caller keeps its call site until the owner is initialized', async (t) => {
  const classpath = fixture();
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const sameCold = await compileCaller(classpath, 'ColdLeafOwner', false);
  t.equal(sameCold?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'ColdLeafOwner.draw compiled before initialization inserts the leaf');
  t.ok(/ssaInlineCheckedLeaf/.test(
    String(sameCold?.jvmRestoringDirectPositionalBody)),
  'the restoring body holds the lexical leaf block');
  t.notOk(/fastPositional/.test(
    String(sameCold?.jvmRestoringDirectPositionalBody)),
  'no late-linked positional call to the leaf remains');
  const otherCold = await compileCaller(classpath, 'ColdLeafOther', false);
  t.equal(otherCold?.jvmStructuredLexicalCheckedLeafCallCount, 0,
    'ColdLeafOther.draw compiled before initialization keeps the call site');
  t.ok(/fastPositional/.test(
    String(otherCold?.jvmRestoringDirectPositionalBody)),
  'the other-class caller links the leaf at run time');
  const otherWarm = await compileCaller(classpath, 'ColdLeafOther', true);
  t.equal(otherWarm?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'once the owner is initialized the other-class caller inserts it too');
  t.end();
});

// Geoblox dm.a(III)V: an instance draw passes its own pixel field to the
// static blit of its class. The field's array view is fed into the inserted
// leaf; the restoring body once deleted the feed's staging declaration and
// threw "ssaInline<n>_<pc>_v1 is not defined" on the first frame.
const feedSource = `
public class FeedLeafOwner {
  int[] pixels;
  int w = 13, h = 7;
  static int[] canvas = new int[64 * 16];
  ${leafSource}

  void draw(int x, int y) {
    blit(canvas, pixels, 0, 0, y * 64 + x, w, h, 64 - w, 16 - w);
  }

  public static void main(String[] args) {
    FeedLeafOwner sprite = new FeedLeafOwner();
    sprite.pixels = new int[16 * 16];
    for (int i = 0; i < sprite.pixels.length; i++) {
      sprite.pixels[i] = (i % 3 == 0) ? 0 : 0x100 + i;
    }
    for (int i = 0; i < canvas.length; i++) canvas[i] = -i;
    sprite.draw(3, 5);
    sprite.draw(40, 2);
    sprite.draw(20, 8);
    long sum = 0;
    for (int i = 0; i < canvas.length; i++) sum = sum * 31 + canvas[i];
    System.out.println(sum);
    System.out.println(1);
  }
}
`;

test('an inserted leaf fed its caller\'s field array view declares the feed ' +
  'in every body and runs with the interpreter\'s results', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-feed-leaf-'));
  t.teardown(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'FeedLeafOwner.java'), feedSource);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, 'FeedLeafOwner.java')]);
  const jvm = new JVM({classpath: directory, jit: leafJit});
  await jvm.loadClassByName('FeedLeafOwner');
  const method = await jvm.findMethodInHierarchy(
    'FeedLeafOwner', 'draw', '(II)V');
  const generated = jvm.jit.getGeneratedFunction(method);
  t.equal(generated?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'draw inserts the leaf');
  for (const key of ['jvmRestoringDirectPositionalBody',
    'jvmStructuredFramedBody']) {
    const body = String(generated?.[key] || '');
    const stages = new Set(body.match(/\bssaInline\d+_\d+_v\d+\b/g) || []);
    t.ok(stages.size > 0 && /checkedLeafFeed\d+/.test(body),
      `${key} feeds the leaf an array view`);
    t.deepEqual([...stages].filter((name) =>
      !new RegExp(`const ${name} = `).test(body)), [],
    `${key} declares every feed stage it reads`);
  }
  const run = async (jit) => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    try {
      await new JVM({classpath: directory, jit}).run('FeedLeafOwner');
    } finally {
      process.stdout.write = originalWrite;
    }
    return output.trim();
  };
  t.equal(await run(leafJit), reference(),
    'prepared compiled bodies match the JS reference');
  t.end();
});

test('a program prepared before main runs the inserted cold-class leaf with ' +
  'the interpreter\'s results and initializes the class exactly once',
  async (t) => {
  const classpath = fixture();
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const run = async (jit) => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    try {
      // prepareBeforeMain defaults on: every method is compiled cold, then
      // main() runs against the prepared bodies -- the browser lifecycle.
      const jvm = new JVM({classpath, jit});
      await jvm.run('ColdLeafOwner');
    } finally {
      process.stdout.write = originalWrite;
    }
    return output.trim();
  };
  const expected = reference();
  const interpreted = await run({compileWorker: false, enabled: false});
  const compiled = await run(leafJit);
  t.equal(interpreted, expected, 'interpreter matches the JS reference');
  t.equal(compiled, expected,
    'prepared compiled bodies match the reference and <clinit> ran once');
  t.end();
});
