const test = require('node:test');
const assert = require('node:assert/strict');
const { castCode } = require('../src/passes/castStaticInvokeArgsToDeclaredTypes');

test('casts narrower static invoke argument to declared reference type', () => {
  const method = {
    descriptor: '(Ljava/lang/String;)I',
    flags: [],
  };
  const code = {
    codeItems: [
      { instruction: 'aload_1' },
      { instruction: { op: 'invokevirtual', arg: ['Method', 'java/lang/String', ['toLowerCase', '()Ljava/lang/String;']] } },
      { instruction: 'astore_1' },
      { instruction: { op: 'bipush', arg: '120' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'vla', ['a', '(BLjava/lang/CharSequence;)I']] } },
      { instruction: 'ireturn' },
    ],
  };

  assert.equal(castCode(code, method), 1);
  assert.deepEqual(code.codeItems[5].instruction, { op: 'checkcast', arg: 'java/lang/CharSequence' });
});

test('does not cast already matching static invoke argument type', () => {
  const method = {
    descriptor: '(Ljava/lang/CharSequence;)I',
    flags: [],
  };
  const code = {
    codeItems: [
      { instruction: { op: 'bipush', arg: '120' } },
      { instruction: 'aload_1' },
      { instruction: { op: 'invokestatic', arg: ['Method', 'vla', ['a', '(BLjava/lang/CharSequence;)I']] } },
      { instruction: 'ireturn' },
    ],
  };

  assert.equal(castCode(code, method), 0);
});
