'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const {structureMethod, splitIrreducibleTerms} = require('../src/decompiler/exceptionStructurer');
const {buildCfgFromCode, printTree} = require('../src/decompiler/structurer');
const {verifyStructuredFlow} = require('../src/decompiler/structuredFlowVerifier');

function run(command, args, directory) {
  const result = spawnSync(command, args, {cwd: directory, encoding: 'utf8',
    timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('plain multi-entry loops split by default without changing actions or failure order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-plain-irreducible-'));
  try {
    const native = path.join(temporary, 'native'), rebuilt = path.join(temporary, 'rebuilt');
    fs.mkdirSync(native); fs.mkdirSync(rebuilt);
    const classFile = path.join(native, 'AlternatingLoop.class');
    assembleJasminSource(`.version 49 0
.class public super AlternatingLoop
.super java/lang/Object
.method public static compute : (II)I
 .code stack 3 locals 4
 iconst_0
 istore_2
 iconst_0
 istore_3
 iload_1
 ifgt Lstart
 iconst_0
 ireturn
Lstart:
 iload_0
 ifne Lsecond
Lfirst:
 iconst_1
 invokestatic Method LoopEffects step (I)I
 iload_2
 iadd
 istore_2
 iinc 3 1
 iload_3
 iload_1
 if_icmpge Ldone
 goto Lsecond
Lsecond:
 iconst_2
 invokestatic Method LoopEffects step (I)I
 iload_2
 iadd
 istore_2
 iinc 3 1
 iload_3
 iload_1
 if_icmpge Ldone
 goto Lfirst
Ldone:
 iload_2
 ireturn
 .end code
.end method
.end class`, classFile);
    const effects = `class LoopEffects {
      static int calls, salt, failAt; static StringBuilder trace;
      static void reset(int fail) {calls=0;salt=17;failAt=fail;trace=new StringBuilder();}
      static int step(int tag) {
        calls++;trace.append(tag);salt=salt*31+tag;
        if(calls==failAt)throw new IllegalArgumentException("step"+tag);
        return salt^tag;
      }
    }`;
    const driver = `class LoopDriver {
      static String invoke(boolean reference,int entry,int limit,int fail) {
        LoopEffects.reset(fail);String result;
        try {
          int sum=0;
          if(reference){int tag=entry==0?1:2;for(int i=0;i<limit;i++){sum+=LoopEffects.step(tag);tag=3-tag;}}
          else sum=AlternatingLoop.compute(entry,limit);
          result="value="+sum;
        }catch(Throwable failure){result=failure.getClass().getSimpleName()+":"+failure.getMessage();}
        return result+"/"+LoopEffects.trace+"/"+LoopEffects.calls+"/"+LoopEffects.salt;
      }
      public static void main(String[] args) {
        for(int entry:new int[]{-1,0,1,2})for(int limit:new int[]{-2,0,1,2,3,7,11})for(int fail:new int[]{0,1,2,5,12}) {
          String actual=invoke(false,entry,limit,fail),expected=invoke(true,entry,limit,fail);
          if(!actual.equals(expected))throw new AssertionError(actual+" != "+expected);
          System.out.println(entry+"/"+limit+"/"+fail+":"+actual);
        }
      }
    }`;
    for (const directory of [native, rebuilt]) {
      fs.writeFileSync(path.join(directory, 'LoopEffects.java'), effects);
      fs.writeFileSync(path.join(directory, 'LoopDriver.java'), driver);
    }
    run('javac', ['--release', '8', 'LoopEffects.java', 'LoopDriver.java'], native);
    const expected = run('java', ['-Xverify:all', '-cp', native, 'LoopDriver'], native);
    const diagnostics = [], source = decompileClassFile(classFile, {diagnostics});
    assertNoFallback(source);
    assert.deepEqual(diagnostics, []);
    assert.doesNotMatch(source, /switch\s*\(statePc\)/);
    fs.writeFileSync(path.join(rebuilt, 'AlternatingLoop.java'), source);
    run('javac', ['--release', '8', 'LoopEffects.java', 'LoopDriver.java', 'AlternatingLoop.java'], rebuilt);
    assert.equal(run('java', ['-Xverify:all', '-cp', rebuilt, 'LoopDriver'], rebuilt), expected);
    assert.equal(expected.trim().split('\n').length, 140);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});

test('plain splitting proves original edges and retains bounded refusal', () => {
  const code = [
    {labelDef:'L0:',pc:0,instruction:'iload_0'},
    {pc:1,instruction:{op:'ifne',arg:'L10'}},
    {labelDef:'L4:',pc:4,instruction:'iinc 1 1'},
    {pc:5,instruction:'iload_1'},
    {pc:6,instruction:{op:'ifeq',arg:'L18'}},
    {pc:7,instruction:{op:'goto',arg:'L10'}},
    {labelDef:'L10:',pc:10,instruction:'iinc 1 -1'},
    {pc:11,instruction:'iload_1'},
    {pc:12,instruction:{op:'ifeq',arg:'L18'}},
    {pc:13,instruction:{op:'goto',arg:'L4'}},
    {labelDef:'L18:',pc:18,instruction:'return'},
  ];
  const snapshot = JSON.stringify(code), cfg = buildCfgFromCode(code);
  const result = structureMethod(code, []);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.normalFlowVerified, true);
  assert.ok(result.splitBlocks > 0);
  assert.doesNotMatch(printTree(result.tree, result.render), /\bgoto\b/);
  const flow = {entry: cfg.entry, blocks: cfg.term.map((term, block) => ({block, term}))};
  assert.equal(verifyStructuredFlow(result.tree, flow), true);
  const damaged = JSON.parse(JSON.stringify(result.tree));
  function corrupt(node) {
    if (node.t === 'straight') {node.block=-1;return true;}
    if (node.t === 'seq') return node.body.some(corrupt);
    if (node.t === 'if') return corrupt(node.then) || node.els && corrupt(node.els);
    if (node.body) return corrupt(node.body);
    return false;
  }
  assert.ok(corrupt(damaged));
  assert.equal(verifyStructuredFlow(damaged, flow), false);
  assert.equal(splitIrreducibleTerms(cfg.term, cfg.entry, {maxTerms: cfg.n}), null);
  assert.equal(JSON.stringify(code), snapshot);
});
