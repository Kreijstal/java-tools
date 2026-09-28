const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');

for (const mode of ['frameless', 'framed', 'resolved', 'async']) {
test(`contended synchronized ${mode} entry preserves compiled eligibility`, async (t) => {
  const method = {
    name: 'arbitrarySynchronizedFloat', descriptor: '()F',
    flags: ['synchronized'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: 'fconst_1' },
        { labelDef: 'L1:', instruction: 'freturn' },
      ],
      exceptionTable: [], localsSize: '1', stackSize: '1',
    } }],
  };
  const jvm = new JVM({ jit: {compileWorker: false,
    warmupThreshold: 0, preferWholeMethodJs: true, structuredSsa: true,
  } });
  jvm.classes.ArbitrarySynchronizedOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method },
    ] }] },
  };
  jvm.classInitializationState.set(
    'ArbitrarySynchronizedOwner', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmFramelessPositional,
    'the call-free float getter publishes its frameless scalar ABI');
  const site = {
    op: 'invokevirtual', declaredClassName: 'ArbitrarySynchronizedOwner',
    methodName: method.name, descriptor: method.descriptor,
    params: [], returnType: 'float',
    initializationToken: { initialized: true },
  };
  const target = {
    method, lookupClass: 'ArbitrarySynchronizedOwner', generated,
  };
  if (mode === 'framed') {
    target.generated = Object.assign((...args) => generated(...args), {jvmSynchronous: true});
  }
  const positional = mode === 'frameless' || mode === 'framed'
    ? jvm.jit.getPositionalGeneratedInvoker(site, target) : null;
  const parentMethod = {
    name: 'caller', descriptor: '()V', attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '0',
    } }],
  };
  const parent = new Frame(parentMethod);
  const receiver = {
    type: 'ArbitrarySynchronizedOwner', fields: {},
    isLocked: true, lockOwner: 99, lockCount: 1, waitSet: [],
  };
  const thread = {
    id: 7, status: 'runnable', pendingException: null, callStack: new CallStack(),
  };
  thread.callStack.push(parent);
  let result;
  if (positional) result = positional(receiver, thread);
  else {
    parent.stack.push(receiver);
    result = mode === 'resolved'
      ? jvm.jit.tryInvokeResolvedTarget(site, target, parent, thread)
      : await jvm.jit.invoke('invokevirtual', parent,
        {arg: [null, site.declaredClassName, [method.name, method.descriptor]]}, thread, 0);
  }

  t.ok(result?.deopt,
    'monitor contention exits through the canonical child-frame path');
  t.equal(thread.callStack.items.length, 2,
    'the omitted synchronized child is restored exactly once');
  t.equal(thread.callStack.items[0], parent,
    'the caller retains its original stack position');
  t.equal(thread.callStack.peek().method, method,
    'the contended child is restored above the caller for scheduling');
  t.equal(thread.status, 'BLOCKED',
    'the scheduler observes the monitor-contended child');
  t.equal(result.transient, true, 'lock contention is a temporary scheduling exit');
  t.equal(result.cooperativeSuspension, true, 'contention preserves eligible adaptive fast entries');
  jvm.jit.finishTryRunFrame(parent, thread, 'caller()V', result);
  t.notOk(jvm.jit.deoptedMethods.has(parentMethod),
    'contention does not permanently disable the compiled caller');
  t.notOk(parent.jitJsDisabled, 'the caller activation remains eligible for compiled resume');
  t.equal(receiver.lockOwner, 99, 'contention preserves the current lock owner');
  t.equal(receiver.lockCount, 1, 'contention does not increment another owner’s lock');
  t.deepEqual(parent.stack.items, [], 'no result is published before acquiring the lock');
  receiver.isLocked = false;
  receiver.lockOwner = null;
  receiver.lockCount = 0;
  thread.status = 'runnable';
  const child = thread.callStack.peek();
  t.ok(jvm.enterFrameMonitorIfNeeded(child, thread),
    'the restored child can acquire the released monitor');
  const completion = jvm.jit.tryRunFrame(child, thread);
  t.ok(completion?.handled,
    'the scheduler-visible child completes through the normal JIT entry');
  t.deepEqual(parent.stack.items, [1],
    'the non-void synchronized return reaches the original caller');
  t.equal(thread.callStack.items.length, 1, 'child completes exactly once');
  t.notOk(receiver.isLocked, 'completed child releases its monitor');
  t.end();
});
}
