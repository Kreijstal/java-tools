const test = require('node:test');
const assert = require('node:assert/strict');
const { runRemoveUnreachableCodeCfg } = require('../src/passes/removeUnreachableCodeCfg');

function method(codeItems, extra = {}) {
  return {
    classes: [{
      className: 'T',
      items: [{
        type: 'method',
        method: {
          name: 'm', descriptor: '()V', flags: ['static'],
          attributes: [{ type: 'code', code: { codeItems, exceptionTable: [], stackSize: '2', ...extra } }],
        },
      }],
    }],
  };
}

function ops(codeItems) {
  return codeItems.map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction && it.instruction.op));
}

test('nops an instruction island unreachable from entry', () => {
  // 0: goto L2 ; [dead: getstatic;pop] ; L2: return
  const code = [
    { instruction: { op: 'goto', arg: 'L2' } },
    { instruction: { op: 'getstatic', arg: ['Field', 'T', ['x', 'I']] } },
    { instruction: 'pop' },
    { instruction: 'return', labelDef: 'L2:' },
  ];
  const ast = method(code);
  const result = runRemoveUnreachableCodeCfg(ast);
  assert.equal(result.changed, true);
  assert.equal(result.rewrites, 2);
  assert.deepEqual(ops(code), ['goto', 'nop', 'nop', 'return']);
  // the reachable goto target and return survive
  assert.equal(code[3].labelDef, 'L2:');
});

test('leaves fully reachable code untouched', () => {
  const code = [
    { instruction: 'iconst_0' },
    { instruction: { op: 'ifeq', arg: 'L3' } },
    { instruction: 'nop' },
    { instruction: 'return', labelDef: 'L3:' },
  ];
  const ast = method(code);
  const result = runRemoveUnreachableCodeCfg(ast);
  assert.equal(result.changed, false);
  assert.deepEqual(ops(code), ['iconst_0', 'ifeq', 'nop', 'return']);
});

test('appends a stack-neutral sentinel when the method tail goes dead', () => {
  // 0: return ; [dead tail: aload_0] — after nopping, execution could fall off
  // the end, so a terminating aconst_null;athrow is appended.
  const code = [
    { instruction: 'return' },
    { instruction: 'aload_0' },
  ];
  const ast = method(code);
  const result = runRemoveUnreachableCodeCfg(ast);
  assert.equal(result.changed, true);
  const out = ops(code);
  assert.equal(out[0], 'return');
  assert.equal(out[1], 'nop');
  assert.deepEqual(out.slice(-2), ['aconst_null', 'athrow']);
});

test('keeps a handler reachable only via the exception table', () => {
  // The handler block is not reached by normal control flow but is a live
  // exception target, so it must not be nopped.
  const code = [
    { instruction: 'iconst_0', labelDef: 'L0:' },
    { instruction: 'pop' },
    { instruction: 'return', labelDef: 'L1:' },
    { instruction: 'astore_0', labelDef: 'H:' },
    { instruction: 'return' },
  ];
  const ast = method(code, {
    exceptionTable: [{ startLbl: 'L0:', endLbl: 'L1:', handlerLbl: 'H:', catchType: null }],
  });
  const result = runRemoveUnreachableCodeCfg(ast);
  assert.equal(result.changed, false);
  assert.deepEqual(ops(code), ['iconst_0', 'pop', 'return', 'astore_0', 'return']);
});
