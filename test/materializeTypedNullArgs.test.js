'use strict';

const test = require('tape');
const { rewriteCode } = require('../src/passes/materializeTypedNullArgs');

test('materializes typed null invoke argument into fresh local', (t) => {
  const code = {
    locals: '6',
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: 'aconst_null' },
      { instruction: { op: 'checkcast', arg: 'ce' } },
      { instruction: { op: 'bipush', arg: '126' } },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'kf', ['a', '(Lce;B)Z']] } },
      { instruction: 'pop' },
    ],
  };

  t.equal(rewriteCode(code), 1);
  t.equal(code.locals, '7');
  t.deepEqual(code.codeItems.map((item) => item.instruction), [
    'aload_0',
    'aconst_null',
    { op: 'checkcast', arg: 'ce' },
    'dup',
    { op: 'astore', arg: '6' },
    { op: 'bipush', arg: '126' },
    { op: 'invokevirtual', arg: ['Method', 'kf', ['a', '(Lce;B)Z']] },
    'pop',
  ]);
  t.end();
});

test('keeps checkcast null when following invoke does not consume that type', (t) => {
  const code = {
    locals: '2',
    codeItems: [
      { instruction: 'aconst_null' },
      { instruction: { op: 'checkcast', arg: 'ce' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'kf', ['a', '(Ljava/lang/CharSequence;B)Ljava/lang/String;']] } },
    ],
  };

  t.equal(rewriteCode(code), 0);
  t.equal(code.codeItems.length, 3);
  t.end();
});
