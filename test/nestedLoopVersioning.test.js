const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {JVM} = require('../src/core/jvm');

function fixture(className, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-versioning-'));
  fs.writeFileSync(path.join(directory, `${className}.java`), source);
  execFileSync('javac', ['-g', '-d', directory,
    path.join(directory, `${className}.java`)]);
  return directory;
}

function loopHeaderCounts(source) {
  const text = Array.isArray(source) ? source.join('\n') : String(source);
  const counts = new Map();
  for (const match of text.matchAll(/\bL\d+: while\b/g)) {
    counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return counts;
}

// Two-arm loop versioning copies a rendered loop body into a fast and a slow
// arm. Nesting versioned loops therefore doubled the emitted code at every
// level: Deko Bloko's synthesizer method va.d rendered 256 copies of its
// innermost loops (7.3 MB for a 602-line method, 2.3 s of compile time for
// one invocation). Only the innermost versioned loop may keep two arms.
test('nested versioned loops do not multiply the restoring body',
  async (t) => {
  const className = 'NestedVersionedLoops';
  const classpath = fixture(className, `
public class ${className} {
  static void fill(float[] out, float[] tmp, int n, int half, int quarter) {
    for (int a = 0; a < n; a++) {
      for (int b = 0; b < half; b++) {
        for (int c = 0; c < quarter; c++) {
          out[half + c] = out[half - c - 1] * 0.5f;
          tmp[c] = out[c] + 1.0f;
        }
        out[quarter + b] = -tmp[b];
      }
      out[a] = out[a] * (float) Math.sin(1.5707963267948966 * a / n);
    }
  }
  public static void main(String[] args) {
    float[] out = new float[64];
    float[] tmp = new float[64];
    for (int i = 0; i < out.length; i++) out[i] = i * 0.25f + 1.0f;
    fill(out, tmp, 5, 16, 8);
    double sum = 0;
    for (int i = 0; i < out.length; i++) sum += out[i] * (i + 1);
    System.out.println((long) (sum * 1000));
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {warmupThreshold: 0, structuredSsa: true}});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(className, 'fill', '([F[FIII)V');
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated?.jvmRestoringDirectPositionalSource,
    'the loop nest compiles a restoring direct positional body');
  const counts = loopHeaderCounts(generated.jvmRestoringDirectPositionalSource);
  const most = Math.max(...counts.values());
  t.ok(counts.size >= 3, `three loop headers are rendered (${counts.size})`);
  t.ok(most <= 2,
    `no loop header is emitted more than twice (worst ${most})`);
  t.ok(generated.jvmStructuredNestedVersionedLoopSuppressionCount >= 1,
    'an enclosing loop declines its own two-arm versioning');
  t.ok(generated.jvmStructuredVersionedLoopCount >= 1,
    'the innermost loop still keeps its versioned fast arm');

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { output += String(chunk); return true; };
  try {
    const runner = new JVM({classpath, jit: {warmupThreshold: 0, structuredSsa: true}});
    await runner.run(className);
  } finally {
    process.stdout.write = originalWrite;
  }
  t.equal(output.trim(), '22085784',
    'the loop nest computes the same values as HotSpot');
  t.end();
});
