'use strict';
const test = require('tape');
const Renderer = require('../src/jit/JvmSsaBlockRenderer');

for (const generator of [false, true]) {
  test(`explicit framed spills preserve cold outcomes (generator ${generator})`, t => {
    for (const kind of ['normal', 'async', 'deopt', 'child', 'blocked', 'throw']) {
      const run = explicit => {
        const renderer = Object.create(Renderer.prototype);
        renderer.coldContinue = {continue: true}; renderer.coldExit = {exit: true};
        const sentinel = {}, reference = {identity: 1}, thrown = new Error('materialization failed');
        const frame = {locals: [3, 4, 5], stack: {items: [99, 100, 101]}};
        const thread = {status: kind === 'blocked' ? 'blocked' : 'runnable', callStack: {items: kind === 'child' ? [{}] : []}};
        const slots = [0, 3, 5, 7], values = [19, -0, NaN, reference];
        const out = kind === 'async' ? sentinel : kind === 'deopt' || kind === 'throw' || kind === 'child' ? {deopt: true, reason: kind} : 0;
        renderer.jit = {
          asyncInvokeSentinel: () => sentinel, linkStructuredCallChild: () => kind === 'child',
          skipJitOnce: f => { f.jitSkipOnce = true; },
          materialize: (f, locals, stack, pc) => { if (kind === 'throw') throw thrown; f.pc = pc; },
        };
        const args = [frame, thread, out, 0, 7, 'int', 18, false];
        const name = generator ? 'coldCallContinuation' : 'coldCallOrdinary';
        let result, sameException = false;
        try {
          result = explicit
            ? renderer[name + 'Slots'](...args, [reference, 40], 1, frame.locals, slots, values)
            : renderer[name](...args, () => slots.forEach((slot, i) => {frame.locals[slot] = values[i];}), [reference, 40], 1);
          if (generator) {
            const first = result.next();
            thread.status = 'runnable';
            if (kind === 'child' && !first.done) { thread.callStack.items.length = 0; frame.stack.items.push(123); }
            result = {first, last: first.done ? null : result.next()};
          }
        } catch (error) {sameException = error === thrown;}
        if (kind !== 'normal') {
          t.equal(frame.locals[7], reference, 'reference identity is preserved');
          t.ok(Object.is(frame.locals[3], -0), 'negative zero is preserved');
          t.ok(Number.isNaN(frame.locals[5]), 'NaN is preserved');
        }
        return {result, sameException, locals: frame.locals, stack: frame.stack.items, pc: frame.pc, skip: frame.jitSkipOnce};
      };
      t.deepEqual(run(true), run(false), `${kind}: exact locals, operands, PC, outcome and exception identity`);
    }
    t.end();
  });
}
