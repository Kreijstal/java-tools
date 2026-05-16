const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeCode } = require('../src/passes/materializeBranchJoinReferenceLocals');

test('copies branch reference local into join local before shared use', () => {
  const code = {
    codeItems: [
      { instruction: 'aload_0' },
      { instruction: { op: 'ifnull', arg: 'Lelse' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Bytes', ['make', '()[B']] } },
      { instruction: { op: 'astore', arg: '5' } },
      { instruction: { op: 'goto', arg: 'Ljoin' } },
      { labelDef: 'Lelse:', instruction: { op: 'invokestatic', arg: ['Method', 'Bytes', ['make', '()[B']] } },
      { instruction: { op: 'astore', arg: '6' } },
      { labelDef: 'Ljoin:', instruction: { op: 'aload', arg: '6' } },
      { instruction: { op: 'invokestatic', arg: ['Method', 'Use', ['bytes', '([B)V']] } },
    ],
  };

  assert.equal(materializeCode(code), 1);
  assert.deepEqual(code.codeItems[4].instruction, { op: 'aload', arg: '5' });
  assert.deepEqual(code.codeItems[5].instruction, { op: 'astore', arg: '6' });
  assert.deepEqual(code.codeItems[6].instruction, { op: 'goto', arg: 'Ljoin' });
});
