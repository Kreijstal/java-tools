'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');
const {structureMethod, verifyRegionFlowContracts} = require('../src/decompiler/exceptionStructurer');

function fragmentedCode(handlerTail) {
  return [
    {labelDef:'L0:',pc:0,instruction:{op:'invokestatic',arg:['Method','Effects',['prefix','()V']]}},
    {labelDef:'L3:',pc:3,instruction:{op:'invokestatic',arg:['Method','Effects',['initial','()I']]}},
    {pc:6,instruction:{op:'goto',arg:'L12'}},
    {labelDef:'L9:',pc:9,instruction:{op:'invokestatic',arg:['Method','Effects',['retry','()I']]}},
    {labelDef:'L12:',pc:12,instruction:'istore_0'},
    {pc:13,instruction:'iload_0'},
    {pc:14,instruction:{op:'ifgt',arg:'L9'}},
    {labelDef:'L17:',pc:17,instruction:'iload_0'},
    {pc:18,instruction:'ireturn'},
    {labelDef:'L20:',pc:20,instruction:'astore_1'},
    ...handlerTail,
  ];
}
const fragmentedTable = [
  {start_pc:0,end_pc:3,handler_pc:20,catch_type:'java/lang/RuntimeException'},
  {start_pc:9,end_pc:17,handler_pc:20,catch_type:'java/lang/RuntimeException'},
];

test('each duplicated terminal handler retains its own source-flow contract', () => {
  const result=structureMethod(fragmentedCode([
    {pc:21,instruction:'aload_1'}, {pc:22,instruction:'athrow'},
  ]),fragmentedTable);
  assert.equal(result.ok,true,result.reason);assert.equal(result.regionExitsVerified,true);
  assert.equal(result.regionExitContracts.length,2);
  const damaged=structuredClone(result.tree);
  function removeCatch(node){
    if(!node)return false;
    if(node.t==='try'){node.catches=[];return true;}
    if(Array.isArray(node.body))return node.body.some(removeCatch);
    return removeCatch(node.body)||removeCatch(node.then)||removeCatch(node.els);
  }
  assert.equal(removeCatch(damaged),true);
  assert.equal(verifyRegionFlowContracts(damaged,result.regionExitContracts),false);
});

test('handler retries and independently protected handler code cannot be duplicated', () => {
  const retry=structureMethod(fragmentedCode([{pc:21,instruction:{op:'goto',arg:'L12'}}]),fragmentedTable);
  assert.equal(retry.ok,false);
  const nested=structureMethod(fragmentedCode([
    {labelDef:'L21:',pc:21,instruction:{op:'invokestatic',arg:['Method','Effects',['cleanup','()V']]}},
    {labelDef:'L24:',pc:24,instruction:'aload_1'}, {pc:25,instruction:'athrow'},
    {labelDef:'L26:',pc:26,instruction:'astore_1'}, {pc:27,instruction:'aload_1'}, {pc:28,instruction:'athrow'},
  ]),[...fragmentedTable,{start_pc:21,end_pc:24,handler_pc:26,catch_type:'java/lang/Exception'}]);
  assert.equal(nested.ok,false);
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', timeout: 20000,
    maxBuffer: 4 * 1024 * 1024, env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('fragmented terminal catch retains the outside read and protected retry in a real loop', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-fragmented-catch-'));
  try {
    const native = path.join(temporary, 'native'), rebuilt = path.join(temporary, 'rebuilt');
    fs.mkdirSync(native);fs.mkdirSync(rebuilt);
    const file = path.join(native, 'FragmentedLoop.class');
    assembleJasminSource(`.version 49 0
.class public super FragmentedLoop
.super java/lang/Object
.method public static compute : ()I
 .code stack 2 locals 2
 .catch java/lang/RuntimeException from Lprefix to Loutside using Lhandler
 .catch java/lang/RuntimeException from Lretry to Lreturn using Lhandler
Lprefix:
 invokestatic Method FragmentEffects prefix ()V
Loutside:
 invokestatic Method FragmentEffects initial ()I
 goto Lcompare
Lretry:
 invokestatic Method FragmentEffects retry ()I
Lcompare:
 istore_0
 iload_0
 ifle Lreturn
 iload_0
 invokestatic Method FragmentEffects step (I)V
 goto Lretry
Lreturn:
 iload_0
 ireturn
Lhandler:
 astore_1
 aload_1
 invokestatic Method FragmentEffects wrap (Ljava/lang/RuntimeException;)Ljava/lang/RuntimeException;
 athrow
 .end code
.end method
.end class`, file);
    const effects = `class FragmentEffects {
      static int remaining, steps, retries;static String fail, trace;static boolean error;
      static void reset(int value,String failure,boolean fatal){remaining=value;steps=0;retries=0;fail=failure;error=fatal;trace="";}
      static void effect(String tag){trace+=tag+";";if(tag.equals(fail)){if(error)throw new AssertionError(tag);throw new IllegalArgumentException(tag);}}
      static void prefix(){effect("prefix");}
      static int initial(){effect("initial");return remaining;}
      static void step(int value){effect("step"+(++steps));if(value!=remaining)throw new AssertionError("stale value");remaining--;}
      static int retry(){effect("retry"+(++retries));return remaining;}
      static RuntimeException wrap(RuntimeException cause){trace+="wrap;";return new IllegalStateException("wrapped",cause);}
    }`;
    const driver = `class FragmentDriver {
      static int reference(){
        try{FragmentEffects.prefix();}catch(RuntimeException failure){throw FragmentEffects.wrap(failure);}
        int value=FragmentEffects.initial();
        while(value>0){try{FragmentEffects.step(value);value=FragmentEffects.retry();}catch(RuntimeException failure){throw FragmentEffects.wrap(failure);}}
        return value;
      }
      static String invoke(boolean oracle,int value,String fail,boolean error){
        FragmentEffects.reset(value,fail,error);String result;
        try{result="value="+(oracle?reference():FragmentedLoop.compute());}
        catch(Throwable failure){result=failure.getClass().getSimpleName()+":"+failure.getMessage();if(failure.getCause()!=null)result+="/cause="+failure.getCause().getClass().getSimpleName()+":"+failure.getCause().getMessage();}
        return result+"/"+FragmentEffects.trace+"/"+FragmentEffects.remaining;
      }
      public static void main(String[] args){
        for(int value:new int[]{-1,0,1,4})for(String fail:new String[]{"none","prefix","initial","step1","retry1","step3","retry3"})for(boolean error:new boolean[]{false,true}){
          String actual=invoke(false,value,fail,error),expected=invoke(true,value,fail,error);
          if(!actual.equals(expected))throw new AssertionError(actual+" != "+expected);
          System.out.println(value+"/"+fail+"/"+error+":"+actual);
        }
      }
    }`;
    for (const directory of [native, rebuilt]) {
      fs.writeFileSync(path.join(directory, 'FragmentEffects.java'), effects);
      fs.writeFileSync(path.join(directory, 'FragmentDriver.java'), driver);
    }
    run('javac', ['--release', '8', 'FragmentEffects.java', 'FragmentDriver.java'], native);
    const expected = run('java', ['-Xverify:all', '-cp', native, 'FragmentDriver'], native);
    const diagnostics = [], source = decompileClassFile(file, {diagnostics});
    assertNoFallback(source);assert.deepEqual(diagnostics, []);
    assert.doesNotMatch(source, /switch\s*\(statePc\)/);
    assert.equal((source.match(/catch \(java\.lang\.RuntimeException/g) || []).length, 2);
    fs.writeFileSync(path.join(rebuilt, 'FragmentedLoop.java'), source);
    run('javac', ['--release', '8', 'FragmentEffects.java', 'FragmentDriver.java', 'FragmentedLoop.java'], rebuilt);
    assert.equal(run('java', ['-Xverify:all', '-cp', rebuilt, 'FragmentDriver'], rebuilt), expected);
    assert.equal(expected.trim().split('\n').length, 56);
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
});
