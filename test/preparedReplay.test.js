'use strict';
const test = require('tape');
const fs = require('node:fs');
const path = require('node:path');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('prepared-replay-');

test('fresh JVM restores prepared methods without duplicating reserved tables', async t => {
  const classpath = fixture(t, 'Replay', `public class Replay {
    static int factor; static int calls;
    static int scale(int value) { calls++; return value * factor; }
    static int sum(int[] values) { int sum=0; for(int i=0;i<values.length;i++) sum+=scale(values[i]); return sum; }
  }`);
  const options = {classpath,jit:{compileWorker:false,structuredSsa:true,
    compiledCallChains:true,ordinaryAdaptiveFramelessPositional:true,
    preferWholeMethodJs:true,retainCompilerDiagnostics:true}};
  const source = new JVM(options), target = new JVM(options);
  for (const jvm of [source,target]) {
    await jvm.loadClassByName('Replay');
    jvm.classInitializationState.set('Replay','INITIALIZED');
    jvm.classes.Replay.staticFields.set('factor:I',jvm === source ? 2 : 3);
    jvm.classes.Replay.staticFields.set('calls:I',0);
    jvm.jit.effectfulPreparationActive = true;
  }
  const entries = [];
  for (const [name,descriptor] of [['scale','(I)I'],['sum','([I)I']]) {
    const method = await source.findMethodInHierarchy('Replay',name,descriptor);
    const before = source.jit.siteIdWatermark();
    const body = source.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
    t.deepEqual(source.jit.untransportableTableGrowth(before),[], 'all allocated tables can cross');
    const file = path.join(classpath, `${name}.prepared.json`);
    fs.writeFileSync(file, JSON.stringify(
      source.jit.serializeGeneratedResult(body,{siteTablesSince:before})));
    entries.push({name,descriptor,file,after:source.jit.siteIdWatermark()});
  }
  const reserved = source.jit.siteIdWatermark();
  target.jit.compileMethod = () => { throw new Error('receiver must not compile during replay'); };
  for (const {name,descriptor,file,after} of entries) {
    // Read only this method's payload. Its reserved range must suffice;
    // replay does not need the next method or a whole-program allocation.
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    target.jit.reserveSiteIdSpace(after);
    const method = await target.findMethodInHierarchy('Replay',name,descriptor);
    const body = target.jit.materializeGeneratedResult(payload,method);
    t.ok(body, `${name} restores in an independent JVM`);
    target.jit.codegenCache.set(method,body);
    target.jit.preparedCodegenMethods.add(method);
    t.deepEqual(target.jit.siteIdWatermark(),after,'binding stays inside this method\'s reserved tables');
  }
  const invoke = async jvm => {
    const method = await jvm.findMethodInHierarchy('Replay','sum','([I)I');
    const frame = new Frame(method); frame.className='Replay'; frame.locals[0]=[3,5,-2];
    const thread = {status:'runnable',callStack:new CallStack()}; thread.callStack.push(frame);
    jvm._nextEventLoopYieldAt=Infinity;
    const result = jvm.jit.codegenCache.get(method)(frame,thread,jvm.jit,false);
    t.equal(thread.callStack.size(),0,'completed call retires the frame');
    return result.value;
  };
  t.equal(await invoke(source),12,'source execution uses its static field');
  t.equal(await invoke(target),18,'restored execution uses receiver static storage');
  t.equal(target.classes.Replay.staticFields.get('calls:I'),3,'side effects occur exactly once');
  target.classes.Replay.staticFields.set('factor:I',4);
  t.equal(await invoke(target),24,'restored links observe later static writes');
  t.equal(target.classes.Replay.staticFields.get('calls:I'),6,'second call does not replay work');
  t.equal(target.jit.registerFieldSite(['Field','Replay',['later','I']]),reserved.fieldSites,
    'ordinary field allocation follows the reserved range');
  t.equal(target.jit.registerSyncCallSite('invokestatic',
    {arg:['Method','Replay',['scale','(I)I']]}),reserved.syncCallSites,
    'ordinary call allocation follows the reserved range');
  t.end();
});
