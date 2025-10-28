const test = require('tape');
const { eliminateDeadCode } = require('../src/deadCodeEliminator');
const { loadJasminFixture } = require('./helpers/loadJasminFixture');

test('dead code eliminator removes unused stack computations', (t) => {
  const converted = loadJasminFixture('ReturnFirst');
  const { changed, methods } = eliminateDeadCode(converted);

  t.equal(changed, true, 'optimization should report changes');

  const signature = 'ReturnFirst.useAndReturnFirst(III)I';
  t.ok(methods[signature], 'method should have optimization details');
  t.deepEqual(
    methods[signature].removed,
    ['iload_1', 'iload_2', 'iadd', 'pop'],
    'should remove unused stack operations',
  );
  t.equal(methods[signature].stackSize, '1', 'stack size should shrink to depth 1');

  const method = converted.classes[0].items.find(
    (item) => item.type === 'method' && item.method.name === 'useAndReturnFirst',
  );
  const codeItems = method.method.attributes.find((attr) => attr.type === 'code').code
    .codeItems;

  const remainingOps = codeItems
    .map((ci) => {
      if (!ci.instruction) {
        return null;
      }
      if (typeof ci.instruction === 'string') {
        return ci.instruction;
      }
      return ci.instruction.op;
    })
    .filter(Boolean);

  t.deepEqual(remainingOps, ['iload_0', 'ireturn'], 'only essential instructions remain');

  t.end();
});

test('dead code eliminator prunes unused arguments in complex methods', (t) => {
  const ast = {
    classes: [
      {
        className: 'ReturnFirstTest',
        items: [
          {
            type: 'method',
            method: {
              name: 'main',
              descriptor: '([Ljava/lang/String;)V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '5',
                    localsSize: '3',
                    codeItems: [
                      { instruction: { op: 'bipush', arg: '42' } },
                      { instruction: { op: 'bipush', arg: '7' } },
                      { instruction: 'iconst_5' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: { op: 'istore', arg: '2' } },
                      { instruction: { op: 'iload', arg: '2' } },
                      { instruction: 'istore_1' },
                      { instruction: 'iload_1' },
                      { instruction: { op: 'bipush', arg: '42' } },
                      { instruction: { op: 'if_icmpeq', arg: 'L29' } },
                      { instruction: { op: 'new', arg: 'java/lang/AssertionError' } },
                      { instruction: 'dup' },
                      { instruction: 'iload_1' },
                      {
                        instruction: {
                          op: 'invokedynamic',
                          arg: {
                            nameAndType: {
                              name: 'makeConcatWithConstants',
                              descriptor: '(I)Ljava/lang/String;',
                            },
                          },
                        },
                      },
                      {
                        instruction: {
                          op: 'invokespecial',
                          arg: [
                            'Method',
                            'java/lang/AssertionError',
                            ['<init>', '(Ljava/lang/Object;)V'],
                          ],
                        },
                      },
                      { instruction: 'athrow' },
                      {
                        instruction: {
                          op: 'getstatic',
                          arg: [
                            'Field',
                            'java/lang/System',
                            ['out', 'Ljava/io/PrintStream;'],
                          ],
                        },
                      },
                      { instruction: 'iload_1' },
                      {
                        instruction: {
                          op: 'invokedynamic',
                          arg: {
                            nameAndType: {
                              name: 'makeConcatWithConstants',
                              descriptor: '(I)Ljava/lang/String;',
                            },
                          },
                        },
                      },
                      {
                        instruction: {
                          op: 'invokevirtual',
                          arg: [
                            'Method',
                            'java/io/PrintStream',
                            ['println', '(Ljava/lang/String;)V'],
                          ],
                        },
                      },
                      { instruction: 'return' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const { changed, methods } = eliminateDeadCode(ast);

  t.equal(changed, true, 'optimization should run on complex methods');

  const signature = 'ReturnFirstTest.main([Ljava/lang/String;)V';
  t.ok(methods[signature], 'should collect optimization summary for main method');
  t.deepEqual(
    methods[signature].removed,
    ['bipush', 'iconst_5', 'pop', 'pop'],
    'should remove unused argument preparation instructions',
  );
  t.equal(methods[signature].stackSize, '3', 'stack size should be recomputed');

  const codeAttr = ast.classes[0].items[0].method.attributes[0];
  const ops = codeAttr.code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));

  t.same(
    ops,
    [
      'bipush',
      'istore',
      'iload',
      'istore_1',
      'iload_1',
      'bipush',
      'if_icmpeq',
      'new',
      'dup',
      'iload_1',
      'invokedynamic',
      'invokespecial',
      'athrow',
      'getstatic',
      'iload_1',
      'invokedynamic',
      'invokevirtual',
      'return',
    ],
    'should retain only the meaningful instructions',
  );

  t.end();
});
