'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const {printTree} = require('../src/decompiler/structurer');

// Version 49 uses the JVM's verifier without requiring assembler-generated
// StackMapTable frames. Original bytecode is executed with verification enabled.
const original = fs.readFileSync(path.join(__dirname,
  'fixtures/invariant-loop-fanout.j'), 'utf8');

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 5000});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

test('a catch resuming inside a try uses the exact CFG without repeating setup', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-catch-reentry-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    const native = path.join(temporary, 'native');
    fs.mkdirSync(native);
    const classFile = path.join(native, 'CatchReentry.class');
    assembleJasminSource(`.version 49 0
.class public super CatchReentry
.super java/lang/Object
.field public static COUNT I
.method public static compute : (I)I
  .code stack 2 locals 1
    .catch java/lang/RuntimeException from Lsetup to Lhandler using Lhandler
    iconst_0
    putstatic Field CatchReentry COUNT I
Lsetup:
    getstatic Field CatchReentry COUNT I
    iconst_1
    iadd
    putstatic Field CatchReentry COUNT I
Lstep:
    iload_0
    ifne Ldone
    aconst_null
    arraylength
    pop
    goto Ldone
Lhandler:
    pop
    iconst_1
    istore_0
    goto Lstep
Ldone:
    getstatic Field CatchReentry COUNT I
    ireturn
  .end code
.end method
.end class`, classFile);
    const driver = `class ReentryRunner { public static void main(String[] args) {
      System.out.print(CatchReentry.compute(0)+","+CatchReentry.compute(1));
    } }`;
    fs.writeFileSync(path.join(native, 'ReentryRunner.java'), driver);
    run('javac', ['--release', '8', '-cp', native, '-d', native,
      path.join(native, 'ReentryRunner.java')], native);
    const expected = run('java', ['-cp', native, 'ReentryRunner'], native);
    assert.equal(expected, '1,1');
    const diagnostics = [];
    const source = decompileClassFile(classFile,
      {diagnostics, preserveFieldNames: new Set(['COUNT'])});
    assertNoFallback(source);
    assert.match(source, /switch \(statePc\)/);
    assert.match(JSON.stringify(diagnostics), /continuation reenters a different component/);
    const rebuilt = path.join(temporary, 'rebuilt');
    fs.mkdirSync(rebuilt);
    const javaFile = path.join(rebuilt, 'CatchReentry.java');
    fs.writeFileSync(javaFile, source);
    fs.writeFileSync(path.join(rebuilt, 'ReentryRunner.java'), driver);
    run('javac', ['--release', '8', '-d', rebuilt, javaFile,
      path.join(rebuilt, 'ReentryRunner.java')], rebuilt);
    assert.equal(run('java', ['-cp', rebuilt, 'ReentryRunner'], rebuilt), expected);
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('an empty conditional arm remains a no-op on every loop iteration', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-empty-loop-arm-'));
  try {
    const tree = { t: 'loop', label: 'L0', body: { t: 'seq', body: [
      { t: 'straight', block: 0 },
      { t: 'if', block: 1, then: { t: 'seq', body: [] }, els: { t: 'straight', block: 2 } },
      { t: 'straight', block: 3 }, { t: 'continue', label: 'L0' },
    ] } };
    const source = printTree(tree, {
      straight: id => ({0: ['if (index >= 3) break L0;'], 2: ['result += 5;'], 3: ['index++;']})[id],
      cond: () => 'skip', condInverted: () => '!skip',
    });
    const file = path.join(temporary, 'EmptyLoopArm.java');
    fs.writeFileSync(file, `class EmptyLoopArm {
      static int compute(boolean skip) { int index=0, result=0; ${source} return index*100+result; }
      public static void main(String[] args) { System.out.print(compute(false)+","+compute(true)); }
    }`);
    run('javac', ['--release', '8', '-d', temporary, file], temporary);
    assert.equal(run('java', ['-cp', temporary, 'EmptyLoopArm'], temporary), '315,300');
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

for (const protection of ['none', 'combined', 'separate', 'multiExit']) {
  const protectedRegion = protection !== 'none';
  for (const reversed of [false, true]) {
    test(`two-loop invariant fanout: protection=${protection}, reversed=${reversed}`, () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-invariant-fanout-'));
      const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
      try {
        const native = path.join(temporary, 'native');
        fs.mkdirSync(native);
        let assembly = original;
        if (reversed) assembly = assembly.replace('ifne LafterFill', 'ifeq LafterFill')
          .replace('ifeq Lfill', 'ifne Lfill');
        if (protection === 'combined') assembly = assembly
          .replace('.code stack 4 locals 5', `.code stack 4 locals 5
    .catch java/lang/RuntimeException from Lfill to Lreturn using Lhandler`)
          .replace('Lreturn:', `Lhandler:
        pop
        iconst_1
        newarray int
        dup
        iconst_0
        bipush -99
        iastore
        areturn
Lreturn:`);
        if (protection === 'separate') assembly = assembly
          .replace('iload_0\n        newarray int', 'iconst_1\n        newarray int')
          .replace('.code stack 4 locals 5', `.code stack 4 locals 5
    .catch java/lang/RuntimeException from Lfill to LafterFill using Lhandler1
    .catch java/lang/RuntimeException from Lcopy to Lreturn using Lhandler2`)
          .replace('.end code', `Lhandler1:
        pop
        aload_2
        iconst_0
        bipush 77
        iastore
        goto LafterFill
Lhandler2:
        pop
        aload_2
        iconst_0
        bipush 88
        iastore
        goto Lreturn
    .end code`);
        if (protection === 'multiExit') assembly = assembly
          .replace('iload_0\n        newarray int', 'iconst_1\n        newarray int')
          .replace(`${reversed ? 'ifeq' : 'ifne'} LafterFill`,
            `${reversed ? 'ifeq' : 'ifne'} LfirstExit`)
          .replace('Ldead:', `LfirstExit:
        iload 4
        iflt LearlyReturn
        goto LafterFill
Ldead:`)
          .replace('LafterFill:', `LearlyReturn:
        aload_2
        areturn
LafterFill:`)
          .replace('.code stack 4 locals 5', `.code stack 4 locals 5
    .catch java/lang/RuntimeException from Lfill to LearlyReturn using Lhandler
    .catch java/lang/RuntimeException from LafterFill to Lreturn using Lhandler`)
          .replace('.end code', `Lhandler:
        pop
        iconst_1
        newarray int
        dup
        iconst_0
        bipush -99
        iastore
        areturn
    .end code`);
        const classFile = path.join(native, 'InvariantConditionalBackedgeFanout.class');
        assembleJasminSource(assembly, classFile);
        const driver = `import java.util.Arrays;
public class FanoutRunner {
  public static void main(String[] args) {
    for (int flag : new int[]{-1, 0, 1, 42}) {
      InvariantConditionalBackedgeFanout.FLAG = flag;
      for (int n : new int[]{0, 1, 3, 7}) {
        int[] copy = new int[n]; Arrays.fill(copy, 7);
        for (int[] input : new int[][]{null, copy, new int[0]}) {
          try { System.out.println(Arrays.toString(
            InvariantConditionalBackedgeFanout.fill(n, input))); }
          catch (RuntimeException exception) {
            System.out.println(exception.getClass().getName());
          }
        }
      }
    }
  }
}`;
        const nativeDriver = path.join(native, 'FanoutRunner.java');
        fs.writeFileSync(nativeDriver, driver);
        run('javac', ['--release', '8', '-cp', native, '-d', native, nativeDriver], native);
        const expected = run('java', ['-cp', native, 'FanoutRunner'], native);
        for (const forced of [false, true]) {
          if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
          else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
          const diagnostics = [];
          const source = decompileClassFile(classFile,
            {diagnostics, preserveFieldNames: new Set(['FLAG'])});
          assertNoFallback(source);
          assert.equal(source.includes('switch (statePc)'), forced);
          if (protectedRegion && !forced) {
            assert.match(source, /try \{/);
            assert.match(source, /catch \(/);
          }
          const rebuilt = path.join(temporary, forced ? 'forced' : 'structured');
          fs.mkdirSync(rebuilt);
          const javaFile = path.join(rebuilt, 'InvariantConditionalBackedgeFanout.java');
          const rebuiltDriver = path.join(rebuilt, 'FanoutRunner.java');
          fs.writeFileSync(javaFile, source);
          fs.writeFileSync(rebuiltDriver, driver);
          run('javac', ['--release', '8', '-d', rebuilt, javaFile, rebuiltDriver], rebuilt);
          assert.equal(run('java', ['-cp', rebuilt, 'FanoutRunner'], rebuilt), expected);
        }
      } finally {
        if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
        else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
        fs.rmSync(temporary, {recursive: true, force: true});
      }
    });
  }
}
