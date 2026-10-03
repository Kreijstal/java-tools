const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');
const constants = require('../src/instructions/constants');
const dispatch = require('../src/instructions');
const fallback = require('../src/instructions/syncFallback');

for (const [op, handler] of [['ldc', constants.ldcSync], ['ldc_w', constants.ldcWideSync]]) {
  test(`${op} loads warm constants without asynchronous dispatch`, async t => {
    const jvm = new JVM({jit: {compileWorker: false, enabled: false}});
    const frame = {stack: new Stack(), method: {}};
    for (const [value, expected] of [[-123456, -123456], [{value: 1.25, type: 'Float'}, 1.25], ['message', jvm.internString('message')]]) {
      const instruction = {op, arg: value};
      t.equal(handler(frame, instruction, jvm), undefined, 'warm operation is synchronous');
      t.equal(frame.stack.pop(), expected, 'constant value or interned identity is preserved');
      await constants[op](frame, instruction, jvm);
      t.equal(frame.stack.pop(), expected, 'canonical dispatcher agrees');
    }
    const instruction = {op, arg: ['Class', 'Loaded']};
    jvm.classes.Loaded = {ast: {classes: [{className: 'Loaded', items: []}]}};
    t.equal(handler(frame, instruction, jvm), undefined, 'loaded class literal is synchronous');
    t.equal(frame.stack.pop(), jvm.getClassObjectSync('Loaded'), 'Class mirror identity is preserved');
    t.notEqual(jvm.classInitializationState.get('Loaded'), 'INITIALIZED', 'class literal does not initialize its target');
    const code = [{instruction}];
    dispatch.prepareSyncInstructions(code);
    t.equal(code[0][dispatch.syncHandler], handler, 'burst dispatcher selects the warm handler');
    t.end();
  });
}

test('cold class constants leave the stack untouched until asynchronous resolution finishes', async t => {
  const frame = {stack: new Stack(), method: {constantPool: [null, ['Class', 'Cold']]}};
  frame.stack.push(7);
  const mirror = {type: 'java/lang/Class'};
  let resolve, requests = 0;
  const jvm = {getClassObjectSync: () => null, getClassObject: () => {
    requests++;
    return new Promise(done => {resolve = done;});
  }};
  const instruction = {op: 'ldc_w', arg: '1'};
  t.equal(constants.ldcWideSync(frame, instruction, jvm), fallback, 'cold literal requests canonical fallback');
  t.equal(dispatch.dispatchSync(frame, instruction, jvm), false, 'direct synchronous dispatch reports fallback');
  t.equal(requests, 0, 'warm probe starts no asynchronous operation');
  t.deepEqual(frame.stack.items, [7], 'warm probe leaves operands intact');
  const pending = constants.ldc_w(frame, instruction, jvm);
  t.equal(requests, 1, 'canonical handler resolves once');
  t.deepEqual(frame.stack.items, [7], 'pending resolution does not push a partial result');
  resolve(mirror); await pending;
  t.deepEqual(frame.stack.items, [7, mirror], 'resolved mirror is pushed once');
  t.end();
});
