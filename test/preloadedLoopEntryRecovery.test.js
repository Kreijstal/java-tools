'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {recoverPreloadedLoopEntries: recover} = require('../src/decompiler/preloadedLoopEntryRecovery');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, decompilePath, assertNoFallback} = require('../src/decompiler/cfr');
const JSZip = require('jszip');

const insn = (label, instruction, pc) => ({labelDef: label + ':', instruction, pc, lineNumber: pc + 100});
function fixture(type = 'i', slot = 2) {
  return {localsSize: 12, stackSize: 8, exceptionTable: [], codeItems: [
    insn('preload', {op: type + 'load', arg: slot}, 0),
    insn('jump', {op: 'goto', arg: 'join'}, 2),
    insn('header', {op: type + 'load_' + slot}, 5),
    insn('join', {op: 'invokestatic', arg: ['Method', 'Effects', ['probe', '()Z']]}, 6),
    insn('decision', {op: 'ifeq', arg: 'exit'}, 9),
    insn('again', {op: 'goto', arg: 'header'}, 12),
    insn('exit', 'return', 15),
  ]};
}

test('local producers recover automatically without names, labels or slot selectors', () => {
  for (const type of ['i', 'l', 'f', 'd', 'a']) for (const slot of [0, 1, 2, 3]) {
    const code = fixture(type, slot), original = structuredClone(code);
    const next = recover(code, {retainDiagnostics: true});
    assert.equal(next.entriesRecovered, 1);
    assert.equal(code.codeItems[0].instruction, 'nop');
    assert.equal(code.codeItems[1].instruction.arg, 'header');
    for (let i = 0; i < code.codeItems.length; i++) {
      assert.equal(code.codeItems[i].pc, original.codeItems[i].pc);
      assert.equal(code.codeItems[i].labelDef, original.codeItems[i].labelDef);
      assert.equal(code.codeItems[i].lineNumber, original.codeItems[i].lineNumber);
      if (i > 1) assert.deepEqual(code.codeItems[i], original.codeItems[i]);
    }
    assert.equal(code.localsSize, original.localsSize);
    assert.equal(code.stackSize, original.stackSize);
    assert.equal(recover(code).entriesRecovered, 0);
    assert.deepEqual(recover(structuredClone(original), {retainDiagnostics: true}), next);
  }
  const alias = fixture();
  alias.codeItems.splice(2, 0, {labelDef: 'headerAlias:'});
  alias.codeItems[0].instruction.arg = '2';
  assert.equal(recover(alias).entriesRecovered, 1);
  assert.equal(alias.codeItems[1].instruction.arg, 'headerAlias');
});

test('every incoming join edge must carry the same local and enter before its load', () => {
  const mutations = [
    c => {c.codeItems[0].instruction.arg = 3;},
    c => {c.codeItems[0].instruction = 'aload_2';},
    c => {c.codeItems[0].instruction = {op: 'getstatic', arg: ['Field', 'Effects', ['value', 'I']]};
      c.codeItems[2].instruction = structuredClone(c.codeItems[0].instruction);},
    c => {c.codeItems[4].instruction.arg = 'jump';},
    c => {c.codeItems[4].instruction.arg = 'join';},
    c => {c.codeItems[5].instruction.arg = 'join';},
    c => {c.codeItems[5].instruction = {op: 'tableswitch', low: 0, labels: ['jump'], defaultLbl: 'exit'};},
    c => {c.codeItems[5].instruction = {op: 'lookupswitch', arg: {pairs: [[1, 'jump']], defaultLabel: 'exit'}};},
    c => {c.codeItems.splice(1, 0, insn('effect', {op: 'invokestatic', arg: ['Method', 'Effects', ['effect', '()V']]}, 1));},
    c => {c.codeItems[5].instruction = {op: 'jsr', arg: 'header'};},
    c => {c.codeItems.push(insn('exit', 'return', 20));},
    c => {c.codeItems[5].instruction.arg = 'missing';},
  ];
  for (const change of mutations) {
    const code = fixture(); change(code);
    const before = structuredClone(code);
    assert.equal(recover(code).entriesRecovered, 0);
    assert.deepEqual(code, before);
  }
});

test('exception entries and boundaries cannot bypass the producer; enclosing protection stays intact', () => {
  for (const entry of [
    {startLbl: 'preload', endLbl: 'exit', handlerLbl: 'jump'},
    {startLbl: 'preload', endLbl: 'exit', handlerLbl: 'header'},
    {startLbl: 'preload', endLbl: 'exit', handlerLbl: 'join'},
    {start_pc: 0, end_pc: 15, handler_pc: 2},
    {startLbl: 'join', endLbl: 'exit', handlerLbl: 'exit'},
    {startLbl: 'preload', endLbl: 'exit', handlerLbl: 'missing'},
  ]) {
    const code = fixture(); code.exceptionTable = [entry];
    const original = structuredClone(code);
    assert.equal(recover(code).entriesRecovered, 0);
    assert.deepEqual(code, original);
  }
  const protectedCode = fixture();
  protectedCode.exceptionTable = [{startLbl: 'preload', endLbl: 'exit', handlerLbl: 'exit'}];
  const table = protectedCode.exceptionTable;
  assert.equal(recover(protectedCode).entriesRecovered, 1);
  assert.equal(protectedCode.exceptionTable, table);
});

test('indexed work stays proportional and recovering entries never grows the instruction list', () => {
  function many(n) {
    const code = {codeItems: [], exceptionTable: []};
    for (let i = 0; i < n; i++) for (const item of fixture().codeItems) {
      const copy = structuredClone(item); copy.labelDef = 'p' + i + '_' + copy.labelDef;
      if (typeof copy.instruction?.arg === 'string') copy.instruction.arg = 'p' + i + '_' + copy.instruction.arg;
      code.codeItems.push(copy);
    }
    return code;
  }
  const a = many(64), b = many(128), aLength = a.codeItems.length, bLength = b.codeItems.length;
  const x = recover(a, {retainDiagnostics: true}), y = recover(b, {retainDiagnostics: true});
  assert.equal(x.entriesRecovered, 64); assert.equal(y.entriesRecovered, 128);
  assert.equal(y.diagnostics.instructionsIndexed, 2 * x.diagnostics.instructionsIndexed);
  assert.equal(y.diagnostics.edgesIndexed, 2 * x.diagnostics.edgesIndexed);
  assert.equal(a.codeItems.length, aLength); assert.equal(b.codeItems.length, bLength);
});

test('standalone class, directory and JAR inputs recover a direct local loop test automatically', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preloaded-entry-smoke-'));
  try {
    const file = path.join(directory, 'PreloadedLoop.class');
    assembleJasminSource(`.version 49 0
.class public super PreloadedLoop
.super java/lang/Object
.method public static compute : (I)I
.code stack 2 locals 2
 iconst_0
 istore_1
 iload_0
 goto Lcondition
Lload: iload_0
Lcondition: iconst_m1
 if_icmpeq Lreturn
 iinc 1 1
 iinc 0 -1
 goto Lload
Lreturn: iload_1
 ireturn
.end code
.end method
.end class`, file);
    const bytes = fs.readFileSync(file), source = decompileClassFile(file);
    assertNoFallback(source);
    assert.match(source, /while \(param0 != -1\)/);
    assert.doesNotMatch(source, /stackIn_|switch\s*\(statePc\)/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const directoryOutput = await decompilePath(directory);
    assert.equal(directoryOutput.length, 1);
    assert.equal(directoryOutput[0].source, source);
    const zip = new JSZip(); zip.file('PreloadedLoop.class', bytes);
    const jar = path.join(directory, 'original.jar');
    fs.writeFileSync(jar, await zip.generateAsync({type: 'nodebuffer'}));
    const jarOutput = await decompilePath(jar);
    assert.equal(jarOutput.length, 1);
    assert.equal(jarOutput[0].source, source);
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});

test('native original classes, default output and forced fallback match an independent loop oracle', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preloaded-entry-native-'));
  function run(command, args) {
    const result = spawnSync(command, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const types = [
    {name: 'Int', descriptor: 'I', op: 'i', values: 'new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE}', next: 'value*31+17', format: 'Integer.toString(value)'},
    {name: 'Long', descriptor: 'J', op: 'l', values: 'new long[]{Long.MIN_VALUE,-1,0,1,Long.MAX_VALUE}', next: 'value*31+17', format: 'Long.toString(value)'},
    {name: 'Float', descriptor: 'F', op: 'f', values: 'new float[]{Float.NaN,-0.0f,0.0f,Float.NEGATIVE_INFINITY,Float.POSITIVE_INFINITY,1.25f}', next: '-value+0.25f', format: 'Integer.toHexString(Float.floatToRawIntBits(value))'},
    {name: 'Double', descriptor: 'D', op: 'd', values: 'new double[]{Double.NaN,-0.0,0.0,Double.NEGATIVE_INFINITY,Double.POSITIVE_INFINITY,1.25}', next: '-value+0.25', format: 'Long.toHexString(Double.doubleToRawLongBits(value))'},
    {name: 'Object', descriptor: 'Ljava/lang/Object;', op: 'a', values: 'new Object[]{FIRST,SECOND,null}', next: 'value==FIRST?SECOND:value==SECOND?null:FIRST', format: 'value==FIRST?"first":value==SECOND?"second":value==null?"null":"other"'},
  ];
  try {
    const native = path.join(directory, 'native'); fs.mkdirSync(native);
    let methods = '', helpers = '', cases = '', oracleMethods = '';
    for (const spec of types) {
      const javaType = spec.name === 'Int' ? 'int' : spec.name === 'Object' ? 'Object' : spec.name.toLowerCase();
      helpers += `static String show${spec.name}(${javaType} value){return ${spec.format};}
static boolean probe${spec.name}(${javaType} value){event("p"+show${spec.name}(value));return remaining-->0;}
static ${javaType} next${spec.name}(${javaType} value){event("n"+show${spec.name}(value));return ${spec.next};}\n`;
      oracleMethods += `static ${javaType} oracle${spec.name}(${javaType} value,boolean protect){try{while(probe${spec.name}(value))value=next${spec.name}(value);return value;}catch(RuntimeException failure){if(protect)throw caught(failure);throw failure;}}\n`;
      for (const protect of [false, true]) {
        const name = spec.name.toLowerCase() + (protect ? 'Protected' : 'Plain');
        const signature = '(' + spec.descriptor + ')' + spec.descriptor;
        methods += `.method public static ${name} : ${signature}
.code stack 6 locals 10
${protect ? '.catch java/lang/RuntimeException from LStart to LEnd using LHandler' : ''}
LStart: ${spec.op}load_0
 ${spec.op}store 6
 ${spec.op}load 6
 goto LJoin
LHeader: ${spec.op}load 6
LJoin: invokestatic Method Effects probe${spec.name} (${spec.descriptor})Z
 ifeq LResult
 ${spec.op}load 6
 invokestatic Method Effects next${spec.name} (${spec.descriptor})${spec.descriptor}
 ${spec.op}store 6
 goto LHeader
LResult: ${spec.op}load 6
LEnd: ${spec.op}return
${protect ? 'LHandler: invokestatic Method Effects caught (Ljava/lang/RuntimeException;)Ljava/lang/RuntimeException;\n athrow' : ''}
.end code
.end method
`;
        cases += `for(${javaType} initial:${spec.values})for(int steps:new int[]{-1,0,1,2,7})for(int injection=-1;injection<16;injection++){
reset(steps,injection);String expected;try{expected=show${spec.name}(oracle${spec.name}(initial,${protect}));}catch(RuntimeException error){expected=error==FAILURE?"same-failure":error.getClass().getName();}expected+=":"+calls+":"+trace;
reset(steps,injection);String actual;try{actual=show${spec.name}(EntryMatrix.${name}(initial));}catch(RuntimeException error){actual=error==FAILURE?"same-failure":error.getClass().getName();}actual+=":"+calls+":"+trace;
if(!actual.equals(expected))throw new AssertionError("${name}:"+steps+":"+injection+":"+actual+":"+expected);total++;}\n`;
      }
    }
    // An additional entry into the goto already supplies a stack value. It
    // must keep that value instead of evaluating the local producer again.
    methods += `.method public static bypass : (IZ)I
.code stack 2 locals 2
 iload_1
 ifeq LPreload
 bipush 7
 goto LMiddle
LPreload: iload_0
LMiddle: goto LJoin
LHeader: iload_0
LJoin: invokestatic Method Effects probeInt (I)Z
 ifeq LReturn
 iload_0
 invokestatic Method Effects nextInt (I)I
 istore_0
 goto LHeader
LReturn: iload_0
 ireturn
.end code
.end method
`;
    oracleMethods += 'static int oracleBypass(int value,boolean bypass){boolean first=true;while(probeInt(first&&bypass?7:value)){first=false;value=nextInt(value);}return value;}\n';
    cases += `for(int initial:new int[]{Integer.MIN_VALUE,-1,0,1,Integer.MAX_VALUE})for(boolean bypass:new boolean[]{false,true})for(int steps:new int[]{-1,0,1,2,7})for(int injection=-1;injection<16;injection++){
reset(steps,injection);String expected;try{expected=showInt(oracleBypass(initial,bypass));}catch(RuntimeException error){expected=error==FAILURE?"same-failure":error.getClass().getName();}expected+=":"+calls+":"+trace;
reset(steps,injection);String actual;try{actual=showInt(EntryMatrix.bypass(initial,bypass));}catch(RuntimeException error){actual=error==FAILURE?"same-failure":error.getClass().getName();}actual+=":"+calls+":"+trace;
if(!actual.equals(expected))throw new AssertionError("bypass:"+steps+":"+injection+":"+actual+":"+expected);total++;}\n`;
    const classFile = path.join(native, 'EntryMatrix.class');
    assembleJasminSource(`.version 49 0
.class public super EntryMatrix
.super java/lang/Object
${methods}
.end class`, classFile);
    const effects = `class Effects {
static final Object FIRST=new Object(),SECOND=new Object();static final RuntimeException FAILURE=new IllegalStateException();
static int remaining,failAt,calls;static StringBuilder trace;
static void reset(int steps,int injection){remaining=steps;failAt=injection;calls=0;trace=new StringBuilder();}
static void event(String value){trace.append(value).append(';');if(calls++==failAt)throw FAILURE;}
static RuntimeException caught(RuntimeException error){trace.append("caught:").append(error==FAILURE);return error;}
${helpers}${oracleMethods}}
class Runner extends Effects {public static void main(String[]args){int total=0;${cases}System.out.println(total+" cases");}}`;
    fs.writeFileSync(path.join(native, 'Effects.java'), effects);
    run('javac', ['--release', '8', '-cp', native, '-d', native, path.join(native, 'Effects.java')]);
    const expected = run('java', ['-Xverify:all', '-cp', native, 'Runner']);
    assert.equal(expected.trim(), '5100 cases');
    for (const forced of [false, true]) {
      const source = decompileClassFile(classFile, {forceStateMachine: forced});
      assertNoFallback(source);
      assert.equal(source.includes('switch (statePc)'), forced);
      const rebuilt = path.join(directory, forced ? 'fallback' : 'default'); fs.mkdirSync(rebuilt);
      fs.writeFileSync(path.join(rebuilt, 'EntryMatrix.java'), source);
      fs.writeFileSync(path.join(rebuilt, 'Effects.java'), effects);
      run('javac', ['--release', '8', '-d', rebuilt, path.join(rebuilt, 'EntryMatrix.java'), path.join(rebuilt, 'Effects.java')]);
      assert.equal(run('java', ['-Xverify:all', '-cp', rebuilt, 'Runner']), expected);
    }
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
});
