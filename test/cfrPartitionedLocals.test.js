'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const {getAST} = require('jvm_parser');
function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 15000});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

const assembly = `.version 49 0
.class public super PartitionCarrierLocals
.super java/lang/Object
.field public static RESULT I
.method public static huge : (II)V
  .code stack 3 locals 4
    iconst_0
    putstatic Field PartitionCarrierLocals RESULT I
    iload_1
    istore_3
    iconst_1
    newarray int
    astore_2
    aload_2
    iconst_0
    iload_0
    iastore
    ${Array(5001).fill('nop').join('\n')}
    goto Lbody0
${Array.from({length: 40}, (_, block) => `Lbody${block}:
    aload_2
    iconst_0
    iaload
    putstatic Field PartitionCarrierLocals RESULT I
    ${Array(50).fill('invokestatic Method PartitionEffects bump ()V').join('\n')}
    iload_3
    iflt Lend
    goto ${block === 39 ? 'Lend' : 'Lbody' + (block + 1)}`).join('\n')}
Lend:
    return
  .end code
.end method
.end class`;
const effects = `class PartitionEffects {
  static int count, throwAt;
  static void bump() {
    count++;
    if (count == throwAt) throw new IllegalArgumentException();
    PartitionCarrierLocals.RESULT++;
  }
}`;
const driver = `class PartitionRunner { public static void main(String[] args) {
  for (int seed : new int[]{-21,0,21}) for (int stop : new int[]{-1,0,1})
    for (int throwAt : new int[]{0,1,75,1000,2100}) {
      PartitionEffects.count=0; PartitionEffects.throwAt=throwAt;
      String outcome="return";
      try { PartitionCarrierLocals.huge(seed,stop); }
      catch (RuntimeException error) { outcome=error.getClass().getName(); }
      System.out.println(outcome+":"+PartitionCarrierLocals.RESULT+":"+PartitionEffects.count);
    }
} }`;

function fixture(name, options, structured = false, caught = false, expectStructured = structured, externalLoopExit = false) {
return test(name, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-partition-carriers-'));
  try {
    const native = path.join(temporary, 'native'); fs.mkdirSync(native);
    const classFile = path.join(native, 'PartitionCarrierLocals.class');
    let selectedAssembly = assembly;
    let selectedEffects = effects;
    let selectedDriver = driver;
    if (structured) {
      selectedAssembly = selectedAssembly.replace(/    iload_3\n    iflt Lend/g,
        '    iload_3\n    ifge Lcontinue\n    return\nLcontinue:');
      let next = 0;
      selectedAssembly = selectedAssembly.replace(/Lcontinue/g, () => 'Lcontinue' + Math.floor(next++ / 2));
      // Mutable parameters must remain shared carrier fields, including stores
      // after crossing helper boundaries. The final value affects the result.
      selectedAssembly = selectedAssembly.replace('Lbody20:', 'Lbody20:\n    iinc 0 7')
        .replace('Lend:\n    return', 'Lend:\n    getstatic Field PartitionCarrierLocals RESULT I\n    iload_0\n    iadd\n    putstatic Field PartitionCarrierLocals RESULT I\n    return');
    }
    if (caught) {
      selectedAssembly = selectedAssembly.replace('.code stack 3 locals 4',
        '.code stack 3 locals 4\n    .catch java/io/IOException from Lbody0 to Lend using Lhandler')
        .replace('  .end code', 'Lhandler:\n    pop\n    bipush -7\n    putstatic Field PartitionCarrierLocals RESULT I\n    return\n  .end code');
      selectedEffects = selectedEffects.replace('static void bump() {', 'static void bump() throws java.io.IOException {')
        .replace('new IllegalArgumentException()', 'new java.io.IOException()');
      selectedDriver = selectedDriver.replace('catch (RuntimeException error)', 'catch (Throwable error)');
    }
    if (externalLoopExit) {
      selectedAssembly = assembly.replace(/    goto Lbody0\n[\s\S]*?Lend:\n    return/, `    goto Lbody0
Lbody0:
    iload_0
    ifle Lend
    aload_2
    iconst_0
    iaload
    putstatic Field PartitionCarrierLocals RESULT I
    ${Array(1200).fill('invokestatic Method PartitionEffects bump ()V').join('\n')}
    iload_1
    ifeq Lend
    iinc 0 -1
    goto Lbody0
Lend:
    return`);
    }
    assembleJasminSource(selectedAssembly, classFile);
    fs.writeFileSync(path.join(native, 'PartitionEffects.java'), selectedEffects);
    fs.writeFileSync(path.join(native, 'PartitionRunner.java'), selectedDriver);
    run('javac', ['--release', '8', '-cp', native, '-d', native,
      path.join(native, 'PartitionEffects.java'), path.join(native, 'PartitionRunner.java')], native);
    const expected = run('java', ['-cp', native, 'PartitionRunner'], native);
    assert.equal(expected.trim().split('\n').length, 45);
    if (caught) assert.match(expected, /return:-7:1/);
    else assert.match(expected, /java.lang.IllegalArgumentException/);
    if (!structured && !externalLoopExit) assert.match(expected, /return:29:50/);
    const diagnostics = [];
    const source = decompileClassFile(classFile,
      {diagnostics, ...options, preserveFieldNames: new Set(['RESULT'])});
    assertNoFallback(source);
    if (expectStructured) {
      assert.match(source, /class \$CfrPartitionedBody/);
      assert.doesNotMatch(source, /switch \(statePc\)/);
      assert.ok((source.match(/void runChunk\d+\(/g) || []).length >= 2);
      assert.match(JSON.stringify(diagnostics), /structuredMethodPartition/);
      if (caught) assert.match(source, /throws java\.io\.IOException/);
    } else {
      assert.match(source, /class \$CfrPartitionedState/);
      assert.ok((source.match(/void runPartition\d+\(\)/g) || []).length >= 2);
      assert.match(JSON.stringify(diagnostics), options.structureOversizedMethods === false
        ? /partitioned oversized CFG/ : /oversized structured body cannot be safely partitioned/);
    }
    const rebuilt = path.join(temporary, 'rebuilt'); fs.mkdirSync(rebuilt);
    const javaFile = path.join(rebuilt, 'PartitionCarrierLocals.java');
    fs.writeFileSync(javaFile, source);
    fs.writeFileSync(path.join(rebuilt, 'PartitionEffects.java'), selectedEffects);
    fs.writeFileSync(path.join(rebuilt, 'PartitionRunner.java'), selectedDriver);
    run('javac', ['--release', '8', '-d', rebuilt, javaFile,
      path.join(rebuilt, 'PartitionEffects.java'), path.join(rebuilt, 'PartitionRunner.java')], rebuilt);
    assert.equal(run('java', ['-cp', rebuilt, 'PartitionRunner'], rebuilt), expected);
    for (const file of fs.readdirSync(rebuilt).filter(file => /CfrPartitioned.*\.class$/.test(file))) {
      const {ast} = await getAST(new Uint8Array(fs.readFileSync(path.join(rebuilt, file))));
      for (const method of ast.methods) {
        assert.ok(method.code.codeLength < 32768,
          `${file}.${method.name} has ${method.code.codeLength} code bytes`);
      }
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

}
for (const coalesce of [false, true]) fixture(`partitioned locals persist across cases and helpers: coalesce=${coalesce}`,
  {structureOversizedMethods: false, coalesceStateMachineChains: coalesce});
fixture('structured helpers preserve early returns, mutable parameters and shared arrays', {forceOwnedStructurer: true}, true);
fixture('structured helpers preserve checked catches across helper boundaries', {forceOwnedStructurer: true}, true, true);
fixture('a refused source budget retains executable typed CFG fallback',
  {forceOwnedStructurer: true, structuredPartitionSourceBudget: 128}, true, true, false);
fixture('outlined loop bodies leave nonlocal breaks at their original loop scope',
  {forceOwnedStructurer: true}, false, false, true, true);
