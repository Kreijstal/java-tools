'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');

// javac omits Object upcasts, but other classfile producers emit them.
function castLoop(target = 'java/lang/Object') {
  const instructions = [
    'aload_0', 'astore_3', 'iconst_0', 'istore_2',
    'aload_0', {op:'checkcast',arg:'java/lang/Object'},
    'aconst_null', 'astore_0', 'astore_1',
    'aload_1', {op:'checkcast',arg:target}, 'astore_0',
    {op:'iinc',varnum:2,incr:1}, 'iload_2', 'iconst_3',
    {op:'if_icmplt',arg:'L4'},
    'aload_1', 'aload_3', {op:'if_acmpne',arg:'L21'},
    'iconst_1', 'ireturn', 'iconst_0', 'ireturn',
  ];
  return {name:'castLoop',descriptor:'(Ljava/lang/Object;)I',flags:['public','static'],
    attributes:[{type:'code',code:{localsSize:'4',stackSize:'2',exceptionTable:[],
      codeItems:instructions.map((instruction,i)=>({labelDef:`L${i}:`,instruction}))}}]};
}

for (const tier of ['baseline','scalar','structured']) {
  test(`${tier}: Object casts preserve references and real cast failures`, async t => {
    const jvm = new JVM({jit:{compileWorker:false,structuredSsa:true,scalarGuestBodies:true,
      compiledCallChains:true,preferWholeMethodJs:true,retainCompilerDiagnostics:true}});
    await jvm.loadClassByName('java/lang/Object');
    await jvm.loadClassByName('java/lang/String');
    jvm.jit.effectfulPreparationActive = true;
    jvm._nextEventLoopYieldAt = Infinity;
    const compile = method => tier === 'baseline' ? jvm.jit.compileBaselineMethod(method)
      : tier === 'scalar' ? jvm.jit.compileScalarIntegerLoop(method)
      : jvm.jit.getGeneratedFunction(method,{allowEffectfulCalls:true,compileLocally:true});
    let checks = 0;
    const original = jvm.jit.tryCheckCastSourceSync;
    jvm.jit.tryCheckCastSourceSync = function(source,target) {
      t.notEqual(target,'java/lang/Object','Object cast never performs runtime type lookup');
      checks++;
      return original.call(this,source,target);
    };
    let lastFrame;
    const invoke = async (method,body,value) => {
      const frame = lastFrame = new Frame(method); frame.className = 'CastFixture'; frame.locals[0] = value;
      const thread = {status:'runnable',callStack:new CallStack()}; thread.callStack.push(frame);
      return {result:await body(frame,thread,jvm.jit,false),frame};
    };
    const method = castLoop(), body = compile(method);
    t.ok(body, 'compiles requested tier');
    if (!body) {t.end();return;}
    if (tier === 'scalar') t.ok(body.jvmScalarLoop,'scalar emitter is exercised');
    if (tier === 'structured') t.ok(body.jvmStructuredSsa,'structured emitter is exercised');
    for (const value of [null,'text',{_className:'java/lang/Object'},
      Object.assign(Int32Array.of(3),{type:'[I'}),{type:'[Ljava/lang/String;',elements:['x'],length:1}]) {
      const {result,frame} = await invoke(method,body,value);
      t.equal(result.value,1,'identity survives casts and overwritten source local');
      t.equal(frame.locals[0],value,'materialized reference is unchanged');
    }
    t.equal(checks,0,'no Object cast helpers called');
    const narrower = castLoop('java/lang/String'), narrowBody = compile(narrower);
    t.ok(narrowBody,'real cast also compiles');
    t.equal((await invoke(narrower,narrowBody,'text')).result.value,1,'valid String cast succeeds');
    t.equal((await invoke(narrower,narrowBody,null)).result.value,1,'null String cast succeeds');
    let error;
    try {await invoke(narrower,narrowBody,{_className:'java/lang/Object'});} catch(e) {error=e;}
    t.equal(error?.type,'java/lang/ClassCastException','invalid narrower cast still throws');
    t.ok(checks>0,'real cast retains runtime type check');
    t.equal(lastFrame.pc,10,'failed cast retains exact bytecode PC');
    t.equal(lastFrame.stack.items[0],lastFrame.locals[1],'failed cast retains operand identity');
    t.equal(lastFrame.locals[0],null,'preceding local write survives the exception');
    t.end();
  });
}
