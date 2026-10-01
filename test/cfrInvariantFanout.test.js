'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

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

for (const protectedRegion of [false, true]) {
  for (const reversed of [false, true]) {
    test(`two-loop invariant fanout: protected=${protectedRegion}, reversed=${reversed}`, () => {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-invariant-fanout-'));
      const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
      try {
        const native = path.join(temporary, 'native');
        fs.mkdirSync(native);
        let assembly = original;
        if (reversed) assembly = assembly.replace('ifne LafterFill', 'ifeq LafterFill')
          .replace('ifeq Lfill', 'ifne Lfill');
        if (protectedRegion) assembly = assembly
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
          assert.equal(source.includes('switch (statePc)'), forced || protectedRegion);
          if (protectedRegion && !forced) assert.match(diagnostics[0].reason, /invariant conditional/);
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
