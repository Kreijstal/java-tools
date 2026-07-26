'use strict';

const test = require('tape');
const {
  splitCode,
  withoutSharedStores,
} = require('../src/passes/splitConcreteObjectReachingLocal');

// A store instruction defines exactly one local. When two candidates claimed the
// same store, the rewrite loop pointed it at whichever ran last and the other
// candidate's fresh local was left with loads but no definition at all -- an
// uninitialized read that fails JVM verification. Observed on ke.a(B)V, where
// candidates for local 5 both claimed the store at index 434.

/** Every slot that is loaded must be stored somewhere in the method. Parameter
 *  slots are excluded because the calling convention writes them, not a store. */
function orphanLoadedSlots(code, parameterSlots = []) {
  const loads = new Set();
  const writes = new Set(parameterSlots);
  for (const item of code.codeItems) {
    const insn = item && item.instruction;
    const op = typeof insn === 'string' ? insn : insn && insn.op;
    if (!op) continue;
    const match = /^[ailfd](load|store)(?:_([0-3]))?$/.exec(op);
    if (!match) continue;
    const slot = match[2] != null ? Number(match[2]) : Number(insn && insn.arg);
    if (Number.isInteger(slot)) (match[1] === 'load' ? loads : writes).add(slot);
  }
  return [...loads].filter((slot) => !writes.has(slot));
}

test('drops the candidate that shares a store with an earlier claimer', (t) => {
  const shared = { instruction: { op: 'astore', arg: '5' } };
  const own = { instruction: { op: 'astore', arg: '5' } };
  const high = { storeIndex: 434, local: '5', storeItems: [shared], loadItems: [{}] };
  const low = { storeIndex: 327, local: '5', storeItems: [own, shared], loadItems: [{}] };

  const kept = withoutSharedStores([low, high]);

  t.deepEqual(kept, [high], 'higher storeIndex claims the shared store first');
  t.end();
});

test('keeps candidates whose stores do not overlap', (t) => {
  const a = { storeIndex: 40, local: '3', storeItems: [{}], loadItems: [{}] };
  const b = { storeIndex: 20, local: '4', storeItems: [{}], loadItems: [{}] };

  t.deepEqual(withoutSharedStores([a, b]), [a, b]);
  t.end();
});

test('preserves input order of the surviving candidates', (t) => {
  const shared = {};
  const a = { storeIndex: 10, local: '3', storeItems: [{}], loadItems: [{}] };
  const b = { storeIndex: 50, local: '4', storeItems: [shared], loadItems: [{}] };
  const c = { storeIndex: 30, local: '4', storeItems: [shared], loadItems: [{}] };

  t.deepEqual(withoutSharedStores([a, b, c]), [a, b], 'c overlaps b and is dropped');
  t.end();
});

test('a single candidate is never dropped', (t) => {
  const only = { storeIndex: 1, local: '2', storeItems: [{}], loadItems: [{}] };
  t.deepEqual(withoutSharedStores([only]), [only]);
  t.end();
});

test('splitCode leaves no local loaded without a definition', (t) => {
  // Two reaching definitions of local 3 feeding a shared use, the shape that
  // produced overlapping candidates in the wild.
  const code = {
    localsSize: '4',
    stackSize: '2',
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'fd', ['a', '()Lmh;']] } },
      { instruction: { op: 'checkcast', arg: 'mh' } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'getfield', arg: ['Field', 'mh', ['mh_c', 'I']] } },
      { instruction: 'pop' },
      { labelDef: 'L1:', instruction: { op: 'invokestatic', arg: ['Method', 'fd', ['a', '()Lmh;']] } },
      { instruction: { op: 'checkcast', arg: 'mh' } },
      { instruction: { op: 'astore', arg: '3' } },
      { instruction: { op: 'aload', arg: '3' } },
      { instruction: { op: 'getfield', arg: ['Field', 'mh', ['mh_c', 'I']] } },
      { instruction: 'pop' },
      { instruction: 'return' },
    ],
    exceptionTable: [],
  };

  splitCode(code, { requireDominance: true, preserveOriginalLocals: true });

  t.deepEqual(orphanLoadedSlots(code, [0, 1, 2, 3]), [], 'no fresh local is read before it is written');
  t.end();
});
