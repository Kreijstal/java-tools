const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');

// The renderer publishes a statement-level fragment list for each positional
// body it emits, so a consumer can outline, partition or environment-lift a
// body by selecting fragments instead of re-parsing the generated JavaScript.
// These assertions pin the contract that consumer depends on.

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fragment-fixture-'));
  t.teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

const DIRECTIVE = "'use strict';\n";

function bodyOf(source) {
  return source.startsWith(DIRECTIVE) ? source.slice(DIRECTIVE.length) : source;
}

async function compileMethod(t, className, source, methodName, descriptor) {
  const classpath = compileJavaFixture(t, className, source);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, methodName, descriptor);
  return jvm.jit.structuredSsa.compile(method);
}

test('published region fragments reassemble a looping positional body',
  async (t) => {
    const className = 'FragmentLoopHarness';
    const generated = await compileMethod(t, className, `
public final class FragmentLoopHarness {
  static void scale(int[] data, int count, int factor) {
    for (int index = 0; index < count; index += 1) {
      data[index] = data[index] * factor;
    }
  }
}
`, 'scale', '([III)V');
    const fragments = generated?.jvmStructuredRegionFragments;
    t.ok(fragments, 'the renderer publishes region fragments');
    const variant = 'jvmRestoringDirectPositionalSource';
    t.ok(Array.isArray(fragments[variant]),
      'the restoring positional body publishes a fragment list');
    const list = fragments[variant];
    t.equal(list.flatMap((fragment) => fragment.lines).join('\n'),
      bodyOf(generated[variant]),
      'the fragments joined in order are exactly the published source');
    const loops = list.filter((fragment) => fragment.kind === 'loop');
    t.ok(loops.length >= 1, 'the guest loop is its own fragment');
    for (const loop of loops) {
      t.ok(loop.lines.length > 2, 'a loop fragment carries its whole body');
      t.ok(loop.lines[0].trim().includes('while ('),
        'a loop fragment starts at the loop header');
      t.equal(loop.lines[loop.lines.length - 1].trim(), '}',
        'a loop fragment ends at the matching close');
      let depth = 0;
      for (const line of loop.lines) {
        depth += (line.match(/\{/g) || []).length -
          (line.match(/\}/g) || []).length;
      }
      t.equal(depth, 0, 'a loop fragment is balanced');
      t.ok(loop.reads.some((name) => /^local\d+$/.test(name)),
        'a loop fragment reports the enclosing locals it reads');
    }
    t.ok(list.some((fragment) => fragment.reads.includes('helpers')),
      'the fragments report the ambient names the body needs');
    const declared = new Set(list.flatMap((fragment) => fragment.declares));
    for (const fragment of list) {
      for (const name of fragment.declares) {
        t.notOk(fragment.reads.includes(name),
          `${name} is introduced by its own fragment, not read into it`);
      }
    }
    const names = generated.jvmStructuredRegionLocalNames?.[variant];
    t.ok(names, 'the renderer publishes the body-level declaration names');
    for (const name of names.declared) {
      t.ok(declared.has(name),
        `${name} is declared by one of the published fragments`);
      t.ok(names.kinds[name] === 'let' || names.kinds[name] === 'const',
        `${name} publishes its declaration kind`);
    }
    t.end();
  });

test('published region fragments keep a try/catch in one fragment',
  async (t) => {
    const className = 'FragmentTryHarness';
    const generated = await compileMethod(t, className, `
public final class FragmentTryHarness {
  static int guarded(int[] data, int index) {
    int[] copy = new int[index];
    copy[0] = data[0];
    return copy[0];
  }
}
`, 'guarded', '([II)I');
    const fragments = generated?.jvmStructuredRegionFragments || {};
    const variant = 'jvmRestoringDirectPositionalSource';
    const list = fragments[variant];
    t.ok(Array.isArray(list),
      'the restoring positional body publishes a fragment list');
    t.equal(list.flatMap((fragment) => fragment.lines).join('\n'),
      bodyOf(generated[variant]),
      'the fragments joined in order are exactly the published source');
    const tries = list.filter((fragment) => fragment.kind === 'try');
    t.ok(tries.length >= 1,
      'the guest allocation try/catch is one fragment');
    for (const fragment of tries) {
      t.ok(fragment.lines[0].trim().startsWith('try {'),
        'a try fragment starts at its own `try {`');
      let depth = 0;
      for (const line of fragment.lines) {
        depth += (line.match(/\{/g) || []).length -
          (line.match(/\}/g) || []).length;
      }
      t.equal(depth, 0, 'a try fragment is balanced');
    }
    t.end();
  });
