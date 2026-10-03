'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');

for (const difference of ['op', 'callerPc', 'callerMethod']) {
  test(`transport rejects call-site ${difference} conflicts before binding fields`, t => {
    const jit = new JVM({jit:{compileWorker:false}}).jit;
    const caller = {}, otherCaller = {};
    const index = jit.registerSyncCallSite('invokestatic',
      {arg:['Method','Target',['call','(I)I']]}, caller, 7);
    const original = jit.syncCallSites[index];
    const watermark = jit.siteIdWatermark();
    const incoming = {index,op:'invokestatic',className:'Target',
      methodName:'call',descriptor:'(I)I',callerPc:7};
    if (difference === 'op') incoming.op = 'invokevirtual';
    if (difference === 'callerPc') incoming.callerPc = 19;
    const reason = jit.placeSiteTables({
      directJreIntrinsics:[{index:0,className:'java/lang/Math',methodName:'sqrt',
        descriptor:'(D)D',isStatic:true,fieldWriteKeys:[]}],
      fieldSites:[{index:watermark.fieldSites,className:'Target',fieldName:'value',descriptor:'I'}],
      syncCallSites:[incoming],
    }, difference === 'callerMethod' ? otherCaller : caller);
    t.ok(reason, 'incompatible invocation/restoration identity is refused');
    t.equal(jit.syncCallSites[index], original, 'published call site is unchanged');
    t.deepEqual(jit.siteIdWatermark(), watermark, 'refusal allocates no preceding native or field sites');
    t.end();
  });
}

test('transport preflight detects conflicting duplicate fields and calls', t => {
  for (const table of ['fieldSites','syncCallSites']) {
    const jit = new JVM({jit:{compileWorker:false}}).jit;
    const watermark = jit.siteIdWatermark();
    const entry = table === 'fieldSites'
      ? {index:0,className:'Target',fieldName:'first',descriptor:'I'}
      : {index:0,op:'invokestatic',className:'Target',methodName:'first',descriptor:'()V',callerPc:7};
    const other = {...entry, [table === 'fieldSites' ? 'fieldName' : 'methodName']:'second'};
    t.ok(jit.placeSiteTables({[table]:[entry,other]}), `${table} duplicate conflict refused`);
    t.deepEqual(jit.siteIdWatermark(), watermark, 'no partial installation');
  }
  t.end();
});

test('compatible repeated transport preserves live call feedback', t => {
  const jit = new JVM({jit:{compileWorker:false}}).jit;
  const caller = {};
  const index = jit.registerSyncCallSite('invokestatic',
    {arg:['Method','Target',['call','(I)I']]}, caller, 7);
  const site = jit.syncCallSites[index];
  const feedback = {observed:true};
  site.targets.set('Receiver', feedback);
  const before = jit.siteIdWatermark();
  const entry = {index,op:'invokestatic',className:'Target',methodName:'call',
    descriptor:'(I)I',callerPc:7};
  t.equal(jit.placeSiteTables({syncCallSites:[entry,{...entry}]}, caller), null,
    'identical descriptors may be repeated');
  t.equal(jit.syncCallSites[index], site, 'live binding is reused');
  t.equal(site.targets.get('Receiver'), feedback, 'learned feedback survives');
  t.deepEqual(jit.siteIdWatermark(), before, 'compatible replay allocates no sites');
  t.end();
});

for (const table of ['classInitializationGuards', 'restoringFrameLayouts']) {
  for (const duplicate of [false, true]) {
    test(`${table} conflicts are rejected before any binding (${duplicate ? 'batch' : 'occupied'})`, t => {
      const jvm = new JVM({jit:{compileWorker:false}}), jit = jvm.jit;
      jvm.classInitializationState.set('First', 'INITIALIZED');
      jvm.classInitializationState.set('Second', 'INITIALIZED');
      const original = table === 'classInitializationGuards'
        ? {index:0,owners:['First']} : {index:0,slots:[0,2]};
      const other = table === 'classInitializationGuards'
        ? {index:0,owners:['Second']} : {index:0,slots:[2,0]};
      if (!duplicate) t.equal(jit.placeSiteTables({[table]:[original]}), null, 'initial entry installs');
      const before = jit.siteIdWatermark();
      const reason = jit.placeSiteTables({
        fieldSites:[{index:before.fieldSites,className:'First',fieldName:'value',descriptor:'I'}],
        [table]:duplicate ? [original,other] : [other],
      });
      t.ok(reason, 'different initialization or local-slot contract is refused');
      t.deepEqual(jit.siteIdWatermark(), before, 'refusal does not install earlier entries');
      if (!duplicate) t.equal(jit.placeSiteTables({[table]:[original]}), null, 'identical replay still works');
      t.end();
    });
  }
}

test('compatible guards and saved-frame layouts preserve runtime behavior', t => {
  const jvm = new JVM({jit:{compileWorker:false}}), jit = jvm.jit;
  jvm.classInitializationState.set('First', 'INITIALIZED');
  jvm.classInitializationState.set('Second', 'INITIALIZED');
  const tables = {
    classInitializationGuards:[{index:0,owners:['First','Second']}],
    restoringFrameLayouts:[{index:0,slots:[0,2]}],
  };
  t.equal(jit.placeSiteTables(tables), null, 'initial contracts install');
  const guard = jit.structuredSsa.classInitializationGuards[0];
  t.equal(jit.placeSiteTables({classInitializationGuards:[
    {index:0,owners:['Second','First','First']},
  ],restoringFrameLayouts:tables.restoringFrameLayouts}), null,
  'owner order and duplicate names do not change the guard contract');
  t.equal(jit.structuredSsa.classInitializationGuards[0], guard, 'guard identity remains stable');
  jvm.classInitializationState.delete('Second');
  t.notOk(jit.structuredSsa.verifyClassInitializationGuard(guard),
    'guard still observes every required initialized class');
  t.ok(jit.placeSiteTables({restoringFrameLayouts:[{index:0,slots:[2,0]}]}),
    'swapping receiver and value slots is refused');
  const receiver = {}, frame = {locals:[null,'untouched'],stack:{items:[]}};
  let restored = 0;
  jit.structuredSsa.restoreDirectFrame(0, {restoreFrame:()=>restored++},
    null, 0, frame, [receiver,42]);
  t.deepEqual(frame.locals, [receiver,'untouched',42], 'receiver and value restore into original slots');
  t.equal(restored, 1, 'restoration executes once');
  t.end();
});
