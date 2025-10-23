const test = require('tape');
const { inlinePureMethods } = require('../src/inlinePureMethods');
const { loadJasminFixture } = require('./helpers/loadJasminFixture');

test('inlinePureMethods inlines pure argument-returning statics', (t) => {
  const callee = loadJasminFixture('ReturnFirst');
  const caller = loadJasminFixture('ReturnFirstCaller');

  const combined = {
    classes: [...callee.classes, ...caller.classes],
  };

  const { changed, summary } = inlinePureMethods(combined);

  t.equal(changed, true, 'inline pass should modify the caller');

  const callerSignature = 'ReturnFirstCaller.call(III)I';
  t.ok(summary[callerSignature], 'summary should include caller details');
  t.same(
    summary[callerSignature][0],
    {
      callee: 'ReturnFirst.useAndReturnFirst(III)I',
      argIndex: 0,
      tempLocalIndex: 3,
    },
    'summary should report the inlined callee and argument index',
  );

  const callerClass = combined.classes.find((cls) => cls.className === 'ReturnFirstCaller');
  const methodItem = callerClass.items.find(
    (item) => item.type === 'method' && item.method.name === 'call',
  );

  const codeAttr = methodItem.method.attributes.find((attr) => attr.type === 'code');
  const { code } = codeAttr;

  t.equal(code.localsSize, '4', 'locals size should grow to accommodate the temp slot');

  const instructions = code.codeItems
    .map((ci) => ci.instruction)
    .filter(Boolean);

  t.notOk(
    instructions.some((insn) => insn.op === 'invokestatic' || insn === 'invokestatic'),
    'should remove the invokestatic call',
  );

  const storeInstr = instructions.find(
    (insn) => typeof insn === 'object' && insn.op === 'istore',
  );
  t.ok(storeInstr, 'should insert an istore for the temporary slot');
  t.equal(storeInstr.arg, '3', 'temporary slot should be the newly allocated index');

  const loadInstr = instructions.find(
    (insn) => typeof insn === 'object' && insn.op === 'iload',
  );
  t.ok(loadInstr, 'should reload the temporary value');
  t.equal(loadInstr.arg, '3', 'reload should target the same slot');

  const popCount = instructions.filter((insn) => insn === 'pop').length;
  t.equal(popCount, 2, 'should pop the unused arguments from the stack');

  t.end();
});
