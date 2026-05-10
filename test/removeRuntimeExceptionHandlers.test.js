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
