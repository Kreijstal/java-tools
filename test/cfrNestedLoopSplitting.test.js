'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const original = fs.readFileSync(path.join(__dirname, 'fixtures/nested-exception-cycles.j'), 'utf8');
function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 10000});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}
for (const branch of ['ordinary', 'reversed', 'switch']) {
  test(`protected nested cycles retain effect order and catches: ${branch}`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-nested-cycles-'));
    const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
    try {
      const native = path.join(temporary, 'native');
      fs.mkdirSync(native);
      let assembly = original;
      if (branch === 'reversed') assembly = assembly.replace('ifne Lsecond', 'ifeq Lsecond');
      if (branch === 'switch') assembly = assembly.replace('ifne Lsecond', `lookupswitch
          -1 : Lfirst
           0 : Lfirst
           1 : Lsecond
          default : Lsecond`);
      const classFile = path.join(native, 'NestedExceptionCycles.class');
      assembleJasminSource(assembly, classFile);
      const effects = `class Effects {
        static int next(int result, int step, int throwAt, int kind) {
          if (step == throwAt) throw new IllegalArgumentException();
          return result * 31 + kind;
        }
      }`;
      const driver = `class NestedRunner { public static void main(String[] args) {
        for (int flag : new int[]{-1,0,1,42})
          for (int limit : new int[]{-1,0,1,2,3,5,10})
            for (int throwAt : new int[]{-1,1,2,5,9})
              System.out.println(NestedExceptionCycles.compute(limit,flag,throwAt));
      } }`;
      fs.writeFileSync(path.join(native, 'Effects.java'), effects);
      fs.writeFileSync(path.join(native, 'NestedRunner.java'), driver);
      run('javac', ['--release', '8', '-cp', native, '-d', native,
        path.join(native, 'Effects.java'), path.join(native, 'NestedRunner.java')], native);
      const expected = run('java', ['-cp', native, 'NestedRunner'], native);
      assert.equal(expected.trim().split('\n').length, 140);
      assert.match(expected, /-30000/); // first effect throws before updating result
      for (const forced of [false, true]) {
        if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1';
        else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
        const diagnostics = [];
        const source = decompileClassFile(classFile, {diagnostics});
        assertNoFallback(source);
        assert.equal(source.includes('switch (statePc)'), forced, JSON.stringify(diagnostics));
        assert.match(source, /catch \(/);
        const rebuilt = path.join(temporary, forced ? 'forced' : 'structured');
        fs.mkdirSync(rebuilt);
        const javaFile = path.join(rebuilt, 'NestedExceptionCycles.java');
        fs.writeFileSync(javaFile, source);
        fs.writeFileSync(path.join(rebuilt, 'Effects.java'), effects);
        fs.writeFileSync(path.join(rebuilt, 'NestedRunner.java'), driver);
        run('javac', ['--release', '8', '-d', rebuilt, javaFile,
          path.join(rebuilt, 'Effects.java'), path.join(rebuilt, 'NestedRunner.java')], rebuilt);
        assert.equal(run('java', ['-cp', rebuilt, 'NestedRunner'], rebuilt), expected);
      }
    } finally {
      if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });
}
