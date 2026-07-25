'use strict';

const test = require('tape');
const { removeRuntimeExceptionHandlers } = require('../src/passes/removeRuntimeExceptionHandlers');

function astWithHandlers() {
  return {
    classes: [{
      className: 'A',
      items: [{
        type: 'method',
        method: {
          name: 'f',
          descriptor: '()V',
          attributes: [{
            type: 'code',
            code: {
              codeItems: [
                { labelDef: 'L0:', instruction: 'return' },
                { labelDef: 'L1:', instruction: 'athrow' },
                { labelDef: 'L2:', instruction: 'athrow' },
              ],
              exceptionTable: [
                { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'L1', catch_type: 'java/lang/RuntimeException' },
                { startLbl: 'L0', endLbl: 'L1', handlerLbl: 'L2', catch_type: 'java/lang/Throwable' },
              ],
            },
          }],
        },
      }],
    }],
  };
}

test('removeRuntimeExceptionHandlers drops RuntimeException table entries only', (t) => {
  const ast = astWithHandlers();
  const result = removeRuntimeExceptionHandlers(ast);
  const code = ast.classes[0].items[0].method.attributes[0].code;

  t.ok(result.changed, 'reports change');
  t.equal(result.removals.length, 1, 'reports one removal');
  t.equal(code.exceptionTable.length, 1, 'keeps non-RuntimeException handler');
  t.equal(code.exceptionTable[0].catch_type, 'java/lang/Throwable', 'remaining handler is Throwable');
  t.deepEqual(code.codeItems.map((item) => item.instruction).filter(Boolean), ['return', 'athrow', 'athrow'], 'handler code stays by default');
  t.end();
});

test('removeRuntimeExceptionHandlers preserves recovery handlers when requested', (t) => {
  const ast = astWithHandlers();
  const code = ast.classes[0].items[0].method.attributes[0].code;
  code.codeItems.push(
    { labelDef: 'L3:', instruction: { op: 'astore_1' } },
    { labelDef: 'L4:', instruction: { op: 'ifnonnull', arg: 'L6' } },
    { labelDef: 'L5:', instruction: 'return' },
    { labelDef: 'L6:', instruction: 'return' },
  );
  code.exceptionTable.push({
    startLbl: 'L0',
    endLbl: 'L1',
    handlerLbl: 'L3',
    catch_type: 'java/lang/RuntimeException',
  });

  const result = removeRuntimeExceptionHandlers(ast, { preserveRecoveryHandlers: true });

  t.equal(result.removals.length, 1, 'removes only the linear athrow handler');
  t.equal(code.exceptionTable.length, 2, 'keeps the branching recovery handler and other catch type');
  t.ok(code.exceptionTable.some((entry) => entry.handlerLbl === 'L3'),
    'branching RuntimeException recovery remains in the table');
  t.end();
});

test('removeRuntimeExceptionHandlers preserves static primitive loop reporters when requested', (t) => {
  const ast = astWithHandlers();
  const method = ast.classes[0].items[0].method;
  const code = method.attributes[0].code;
  method.flags = ['static'];
  method.descriptor = '(BII)I';
  code.codeItems.splice(1, 0,
    { labelDef: 'Lloop:', instruction: { op: 'iinc', arg: [1, -1] } },
    { instruction: { op: 'ifne', arg: 'Lloop' } },
  );

  const result = removeRuntimeExceptionHandlers(ast, {
    preserveRecoveryHandlers: true,
    preserveStaticPrimitiveLoopHandlers: true,
  });

  t.equal(result.removals.length, 0, 'keeps the reporter on the primitive loop helper');
  t.equal(code.exceptionTable.length, 2, 'keeps both exception-table entries');
  t.end();
});
