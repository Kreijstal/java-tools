const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

function fixture(className, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-sibling-'));
  fs.writeFileSync(path.join(directory, `${className}.java`), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, `${className}.java`)]);
  return directory;
}

// The FunOrb transparent sprite blit: a row loop whose body is a 4x-unrolled
// pixel loop FOLLOWED BY a remainder loop. The two inner loops are siblings
// under the row loop, not a chain. Every loop is counted (single increment,
// single backedge, entry-computable start, literal bound), so the region is
// finite and the leaf must be admitted like a plain nest. Geoblox draws its
// panels with ~150,000 1x1 calls of this method per frame, so its per-call
// entry cost is the frame time.
const className = 'SiblingBlit';
const source = `
public class ${className} {
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
    // odd width exercises both inner loops; a 1x1 exercises the remainder only
    blit(dst, src, 0, 0, 5 * 64 + 3, 13, 7, 64 - 13, 16 - 13);
    blit(dst, src, 0, 0, 2, 1, 1, 63, 15);
    blit(dst, src, 0, 0, 0, 16, 1, 48, 0);
    System.out.println(checksum(dst));
  }
}
`;

function reference() {
  const dst = new Int32Array(64 * 16), src = new Int32Array(16 * 16);
  for (let i = 0; i < src.length; i++) src[i] = (i % 3 === 0) ? 0 : 0x100 + i;
  for (let i = 0; i < dst.length; i++) dst[i] = -i;
  const blit = (so, d, w, h, ds, ss) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { const v = src[so++]; if (v !== 0) dst[d] = v; d++; }
      d += ds; so += ss;
    }
  };
  blit(0, 5 * 64 + 3, 13, 7, 64 - 13, 16 - 13);
  blit(0, 2, 1, 1, 63, 15);
  blit(0, 0, 16, 1, 48, 0);
  let sum = 0n;
  for (let i = 0; i < dst.length; i++) sum = BigInt.asIntN(64, sum * 31n + BigInt(dst[i]));
  return sum.toString();
}

test('a counted row loop over sibling unrolled and remainder loops is a checked leaf',
  async (t) => {
  const classpath = fixture(className, source);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {compileWorker: false,
    warmupThreshold: 0, structuredSsa: true,
    checkedLeafDirectPositional: true}});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'blit', '([I[IIIIIIII)V');
  const generated = jvm.jit.getGeneratedFunction(method);
  t.equal(generated?.jvmStructuredLoopCount, 3, 'three loops');
  t.equal(generated?.jvmStructuredCountedLoopCount, 3,
    'all three loops are counted');
  t.equal(typeof generated?.jvmCheckedLeafDirectPositionalBody, 'function',
    'the sibling-loop region publishes a checked leaf');
  t.ok(generated?.jvmStructuredNestedRuntimeCheckedLeaf,
    'admitted through the nested runtime-counted region rule');
  const checkedSource = generated?.jvmCheckedLeafDirectPositionalSource || '';
  t.notOk(/safePointBudget/.test(checkedSource),
    'the checked leaf carries no per-iteration scheduler poll');
  // The work bound must add the sibling trip counts under the row loop,
  // not multiply them: a 1x1 blit has zero unrolled trips and one remainder
  // trip, and the guard has to admit it.
  const guard = /if \(!\((.*)\)\) return helpers\.asyncInvokeSentinel\(\)/.exec(
    checkedSource)?.[1] || '';
  t.ok(guard.includes('+'), 'sibling trips are summed in the entry guard: ' + guard);
  t.end();
});

test('the sibling-loop checked leaf computes the same pixels as the interpreter',
  async (t) => {
  const classpath = fixture(className, source);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const run = async (jit) => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => { output += String(chunk); return true; };
    try {
      const jvm = new JVM({classpath, jit});
      await jvm.run(className);
    } finally {
      process.stdout.write = originalWrite;
    }
    return output.trim();
  };
  const expected = reference();
  const interpreted = await run({compileWorker: false, enabled: false});
  const compiled = await run({compileWorker: false, warmupThreshold: 0,
    structuredSsa: true, checkedLeafDirectPositional: true});
  t.equal(interpreted, expected, 'interpreter matches the JS reference');
  t.equal(compiled, expected, 'compiled checked leaf matches the reference');
  t.end();
});

// ---------------------------------------------------------------------------
// Edge cases of the carried-index region guard. The guard is one predicate
// per (array, carried slot) at the row loop's preheader, so the leaf either
// performs the whole blit or bails before its first store (transactional).
//
// `epilogue` is appended to the row loop body: the empty string is the real
// blit, `dstOff += dst[0];` advances the carried counter by a value the model
// cannot express and must make the region fall back to loop-local guards.
function casesSource(className, epilogue) {
  return `
public class ${className} {
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
      ${epilogue}
    }
  }

  static long checksum(int[] dst) {
    long sum = 0;
    for (int i = 0; i < dst.length; i++) sum = sum * 31 + dst[i];
    return sum;
  }

  static int[] fresh(int length, int seed) {
    int[] array = new int[length];
    for (int i = 0; i < length; i++) array[i] = (i % 3 == seed) ? 0 : seed * 1000 + i;
    return array;
  }

  static void run(int dstLength, int srcLength, int srcOff, int dstOff,
      int w, int h, int dstStep, int srcStep) {
    int[] dst = fresh(dstLength, 0);
    int[] src = fresh(srcLength, 1);
    try {
      blit(dst, src, 0, srcOff, dstOff, w, h, dstStep, srcStep);
      System.out.println(checksum(dst));
    } catch (ArrayIndexOutOfBoundsException e) {
      System.out.println("caught");
      System.out.println(checksum(dst));
    }
  }

  static void runInPlace(int length, int srcOff, int dstOff, int w, int h,
      int dstStep, int srcStep) {
    int[] both = fresh(length, 2);
    try {
      blit(both, both, 0, srcOff, dstOff, w, h, dstStep, srcStep);
      System.out.println(checksum(both));
    } catch (ArrayIndexOutOfBoundsException e) {
      System.out.println("caught");
      System.out.println(checksum(both));
    }
  }

  public static void main(String[] args) {
    // shapes: empty width, empty height, remainder only, unrolled only, mixed
    run(64 * 16, 16 * 16, 0, 5, 0, 3, 64, 16);
    run(64 * 16, 16 * 16, 0, 5, 5, 0, 64 - 5, 16 - 5);
    run(64 * 16, 16 * 16, 3, 7, 1, 4, 64 - 1, 16 - 1);
    run(64 * 16, 16 * 16, 3, 7, 2, 4, 64 - 2, 16 - 2);
    run(64 * 16, 16 * 16, 3, 7, 3, 4, 64 - 3, 16 - 3);
    run(64 * 16, 16 * 16, 0, 9, 4, 4, 64 - 4, 16 - 4);
    run(64 * 16, 16 * 16, 0, 9, 8, 4, 64 - 8, 16 - 8);
    run(64 * 16, 16 * 16, 0, 5 * 64 + 3, 13, 7, 64 - 13, 16 - 13);
    // the whole destination, exactly: last pixel lands on dst.length - 1
    run(64 * 16, 64 * 16, 0, 0, 64, 16, 0, 0);
    // negative steps: rows drawn bottom-up (dst) and read bottom-up (src)
    run(64 * 16, 16 * 16, 0, 15 * 64 + 20, 13, 7, -64 - 13, 16 - 13);
    run(64 * 16, 16 * 16, 15 * 16, 20, 13, 7, 64 - 13, -16 - 13);
    run(64 * 16, 16 * 16, 15 * 16 + 3, 15 * 64 + 51, 13, 16, -64 - 13, -16 - 13);
    // out of bounds on the LAST pixel of the last row, forwards and backwards
    run(64 * 16, 16 * 16, 0, 64 * 16 - 13 * 7 - 6 * 51 + 1, 13, 7, 64 - 13, 16 - 13);
    run(64 * 16, 16 * 16, 0, 5 * 64 + 51, 13, 7, -64 - 13, 16 - 13);
    run(64 * 16, 16 * 16, 16 * 16 - 13 * 7 - 6 * 3 + 1, 5, 13, 7, 64 - 13, 16 - 13);
    // out of bounds on the first pixel: nothing may be written
    run(64 * 16, 16 * 16, 0, -1, 13, 7, 64 - 13, 16 - 13);
    run(64 * 16, 16 * 16, -1, 0, 13, 7, 64 - 13, 16 - 13);
    // in place with overlap: a bail after a partial copy would show here
    runInPlace(64 * 16, 0, 1, 13, 7, 64 - 13, 64 - 13);
    runInPlace(64 * 16, 64 * 16 - 13 * 7 - 6 * 51, 64 * 16 - 13 * 7 - 6 * 51 + 1, 13, 7, 64 - 13, 64 - 13);
  }
}
`;
}

// The Java program above, executed in JavaScript with Java int semantics.
function casesReference(rowExtra) {
  const lines = [];
  const fresh = (length, seed) => Int32Array.from({length}, (_unused, i) =>
    (i % 3 === seed) ? 0 : seed * 1000 + i);
  const checksum = (array) => {
    let sum = 0n;
    for (let i = 0; i < array.length; i++) {
      sum = BigInt.asIntN(64, sum * 31n + BigInt(array[i]));
    }
    return sum.toString();
  };
  const at = (array, index) => {
    if (index < 0 || index >= array.length) throw new RangeError('AIOOBE');
    return index;
  };
  const blit = (dst, src, srcOff, dstOff, w, h, dstStep, srcStep) => {
    const quads = -(w >> 2), rem = -(w & 3);
    const pixel = () => {
      const p = src[at(src, srcOff)]; srcOff = (srcOff + 1) | 0;
      if (p !== 0) dst[at(dst, dstOff)] = p;
      dstOff = (dstOff + 1) | 0;
    };
    for (let y = -h; y < 0; y++) {
      for (let q = quads; q < 0; q++) { pixel(); pixel(); pixel(); pixel(); }
      for (let r = rem; r < 0; r++) pixel();
      dstOff = (dstOff + dstStep) | 0;
      srcOff = (srcOff + srcStep) | 0;
      if (rowExtra) dstOff = (dstOff + dst[at(dst, 0)]) | 0;
    }
  };
  const attempt = (dst, src, ...rest) => {
    try {
      blit(dst, src, ...rest);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      lines.push('caught');
    }
    lines.push(checksum(dst));
  };
  const run = (dstLength, srcLength, ...rest) =>
    attempt(fresh(dstLength, 0), fresh(srcLength, 1), ...rest);
  const runInPlace = (length, ...rest) => {
    const both = fresh(length, 2);
    attempt(both, both, ...rest);
  };
  run(64 * 16, 16 * 16, 0, 5, 0, 3, 64, 16);
  run(64 * 16, 16 * 16, 0, 5, 5, 0, 64 - 5, 16 - 5);
  run(64 * 16, 16 * 16, 3, 7, 1, 4, 64 - 1, 16 - 1);
  run(64 * 16, 16 * 16, 3, 7, 2, 4, 64 - 2, 16 - 2);
  run(64 * 16, 16 * 16, 3, 7, 3, 4, 64 - 3, 16 - 3);
  run(64 * 16, 16 * 16, 0, 9, 4, 4, 64 - 4, 16 - 4);
  run(64 * 16, 16 * 16, 0, 9, 8, 4, 64 - 8, 16 - 8);
  run(64 * 16, 16 * 16, 0, 5 * 64 + 3, 13, 7, 64 - 13, 16 - 13);
  run(64 * 16, 64 * 16, 0, 0, 64, 16, 0, 0);
  run(64 * 16, 16 * 16, 0, 15 * 64 + 20, 13, 7, -64 - 13, 16 - 13);
  run(64 * 16, 16 * 16, 15 * 16, 20, 13, 7, 64 - 13, -16 - 13);
  run(64 * 16, 16 * 16, 15 * 16 + 3, 15 * 64 + 51, 13, 16, -64 - 13, -16 - 13);
  run(64 * 16, 16 * 16, 0, 64 * 16 - 13 * 7 - 6 * 51 + 1, 13, 7, 64 - 13, 16 - 13);
  run(64 * 16, 16 * 16, 0, 5 * 64 + 51, 13, 7, -64 - 13, 16 - 13);
  run(64 * 16, 16 * 16, 16 * 16 - 13 * 7 - 6 * 3 + 1, 5, 13, 7, 64 - 13, 16 - 13);
  run(64 * 16, 16 * 16, 0, -1, 13, 7, 64 - 13, 16 - 13);
  run(64 * 16, 16 * 16, -1, 0, 13, 7, 64 - 13, 16 - 13);
  runInPlace(64 * 16, 0, 1, 13, 7, 64 - 13, 64 - 13);
  runInPlace(64 * 16, 64 * 16 - 13 * 7 - 6 * 51, 64 * 16 - 13 * 7 - 6 * 51 + 1, 13, 7, 64 - 13, 64 - 13);
  return lines.join('\n');
}

async function runProgram(classpath, className, jit) {
  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    const jvm = new JVM({classpath, jit});
    await jvm.run(className);
  } finally {
    process.stdout.write = originalWrite;
  }
  return output.trim();
}

async function compileBlit(classpath, className) {
  const jvm = new JVM({classpath, jit: {compileWorker: false,
    warmupThreshold: 0, structuredSsa: true,
    checkedLeafDirectPositional: true}});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'blit', '([I[IIIIIIII)V');
  return jvm.jit.getGeneratedFunction(method);
}

const compiledJit = {compileWorker: false, warmupThreshold: 0,
  structuredSsa: true, checkedLeafDirectPositional: true};
const interpretedJit = {compileWorker: false, enabled: false};

test('edge shapes, negative steps, last-pixel overflow and in-place overlap ' +
  'behave like the interpreter through the sibling-loop checked leaf',
  async (t) => {
  const className = 'SiblingBlitCases';
  const classpath = fixture(className, casesSource(className, ''));
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const generated = await compileBlit(classpath, className);
  t.ok(generated?.jvmStructuredNestedRuntimeCheckedLeaf,
    'the cases fixture is admitted as a checked leaf');
  t.equal(generated?.jvmStructuredCarriedIndexRangeGuardCount, 10,
    'all ten array accesses are proven by the carried-index region guards');
  t.equal(generated?.jvmStructuredArrayRangeGuardCount -
    generated?.jvmStructuredCoalescedArrayRangeGuardCount, 2,
  'one guard per (array, carried slot) survives coalescing');
  const expected = casesReference(false);
  const interpreted = await runProgram(classpath, className, interpretedJit);
  const compiled = await runProgram(classpath, className, compiledJit);
  t.equal(interpreted, expected, 'interpreter matches the JS reference');
  t.equal(compiled, expected, 'compiled tiers match the JS reference');
  const caught = expected.split('\n').filter((line) => line === 'caught');
  t.equal(caught.length, 6,
    'the overflow scenarios throw ArrayIndexOutOfBoundsException');
  t.end();
});

test('a carried counter advanced by an unmodelled value keeps the region ' +
  'out of the checked leaf and still computes correctly', async (t) => {
  const className = 'SiblingBlitOpaque';
  const classpath = fixture(className,
    casesSource(className, 'dstOff += dst[0];'));
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const generated = await compileBlit(classpath, className);
  t.equal(generated?.jvmStructuredCountedLoopCount, 3,
    'the loops themselves are still counted');
  t.equal(generated?.jvmStructuredNestedRuntimeCheckedLeaf, false,
    'the region is not admitted through the nested counted-region rule');
  t.notEqual(typeof generated?.jvmCheckedLeafDirectPositionalBody, 'function',
    'no checked leaf is published');
  t.ok(generated?.jvmStructuredCarriedIndexRangeGuardCount < 10,
    'the accesses through the opaque counter are not carried-index proven: ' +
    generated?.jvmStructuredCarriedIndexRangeGuardCount);
  const expected = casesReference(true);
  const interpreted = await runProgram(classpath, className, interpretedJit);
  const compiled = await runProgram(classpath, className, compiledJit);
  t.equal(interpreted, expected, 'interpreter matches the JS reference');
  t.equal(compiled, expected, 'compiled tiers match the JS reference');
  t.end();
});

// The region guard, evaluated on its own against a brute-force oracle. The
// leaf's preamble is straight-line `const` arithmetic over the entry locals
// and the two array lengths, so it can be lifted out of the generated source
// and run directly. With every source pixel non-zero every destination
// position is accessed, so the guard has to be EXACT: true iff no access
// would throw. (A zero pixel skips its store; the guard still counts it,
// which is the conservative direction.)
test('the carried-index region guard is exact against a brute-force oracle',
  async (t) => {
  const className = 'SiblingBlitCases';
  const classpath = fixture(className, casesSource(className, ''));
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const generated = await compileBlit(classpath, className);
  const source = generated?.jvmCheckedLeafDirectPositionalSource || '';
  const lines = source.split('\n');
  const firstLoop = lines.findIndex((line) => /^L\d+: while/.test(line));
  const preamble = lines.slice(0, firstLoop).filter((line) =>
    /^(?:local\d+ = |const ssaCarriedRange|const ssaArrayRangeGuard)/.test(line));
  const guards = preamble.map((line) =>
    /^const (ssaArrayRangeGuard\d+) =/.exec(line)?.[1]).filter(Boolean);
  t.equal(guards.length, 2, 'two region guards are declared: ' + guards);
  const declared = new Set();
  for (const line of preamble) {
    for (const match of line.matchAll(/\blocal(\d+)\b/g)) {
      if (Number(match[1]) > 8) declared.add(`local${match[1]}`);
    }
  }
  const evaluate = new Function(
    'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6',
    'local7', 'local8', 'ssaEntryArrayData0', 'ssaEntryArrayData1',
    `let ${[...declared].join(', ')};\n${preamble.join('\n')}\n` +
    `return ${guards.join(' && ')};`);
  const oracle = (dstLength, srcLength, srcOff, dstOff, w, h, dstStep,
    srcStep) => {
    const quads = -(w >> 2), rem = -(w & 3);
    const pixel = () => {
      if (srcOff < 0 || srcOff >= srcLength) return false;
      srcOff += 1;
      if (dstOff < 0 || dstOff >= dstLength) return false;
      dstOff += 1;
      return true;
    };
    for (let y = -h; y < 0; y++) {
      for (let q = quads; q < 0; q++) {
        if (!(pixel() && pixel() && pixel() && pixel())) return false;
      }
      for (let r = rem; r < 0; r++) if (!pixel()) return false;
      dstOff += dstStep;
      srcOff += srcStep;
    }
    return true;
  };
  let seed = 0x9e3779b9;
  const random = (span) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 0) % span);
  };
  let mismatches = 0;
  let admitted = 0;
  const cases = 20000;
  for (let sample = 0; sample < cases; sample += 1) {
    const dstLength = 1 + random(40);
    const srcLength = 1 + random(40);
    const w = random(10);
    const h = random(5);
    const srcOff = random(srcLength + 6) - 3;
    const dstOff = random(dstLength + 6) - 3;
    const dstStep = random(41) - 20;
    const srcStep = random(41) - 20;
    const dst = new Int32Array(dstLength);
    const src = new Int32Array(srcLength).fill(1);
    const guard = Boolean(evaluate(dst, src, 0, srcOff, dstOff, w, h,
      dstStep, srcStep, dst, src));
    const expected = oracle(dstLength, srcLength, srcOff, dstOff, w, h,
      dstStep, srcStep);
    if (guard) admitted += 1;
    if (guard !== expected) {
      mismatches += 1;
      if (mismatches <= 5) {
        t.fail(`guard ${guard} but oracle ${expected} for ` + JSON.stringify(
          {dstLength, srcLength, srcOff, dstOff, w, h, dstStep, srcStep}));
      }
    }
  }
  t.equal(mismatches, 0, `guard agrees with the oracle on ${cases} samples`);
  t.ok(admitted > cases / 20 && admitted < cases * 19 / 20,
    `both outcomes are exercised (${admitted} admitted of ${cases})`);
  t.end();
});
