'use strict';

const test = require('tape');
const { runDeadCodePass } = require('../src/deadCodePass');
const { computeMethodEffects } = require('../src/methodEffectsAnalyzer');

function createSyntheticMisplacedAst() {
  return {
    classes: [
      {
        className: 'Misplaced',
        items: [
          {
            type: 'method',
            method: {
              name: 'funnel',
              descriptor: '(I)I',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '2',
                    localsSize: '1',
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
                      { pc: 1, labelDef: 'L1:', instruction: { op: 'goto', arg: 'L3' } },
                      { pc: 2, labelDef: 'L2:', instruction: 'athrow' },
                      { pc: 3, labelDef: 'L3:', instruction: 'iconst_1' },
                      { pc: 4, labelDef: 'L4:', instruction: 'ireturn' },
                    ],
                    exceptionTable: [
                      {
                        start_pc: 0,
                        end_pc: 3,
                        handler_pc: 3,
                        catch_type: 'java/lang/Exception',
                      },
                    ],
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
}

test('dead-code pass emits diagnostics for misplaced catch handlers', (t) => {
  const ast = createSyntheticMisplacedAst();
  const { diagnostics, changed } = runDeadCodePass(ast);
  t.ok(changed, 'optimizer should modify the AST');
  t.equal(diagnostics.length, 1, 'exactly one diagnostic expected');
  t.equal(diagnostics[0].className, 'Misplaced', 'diagnostic class name matches');
  t.equal(diagnostics[0].methodName, 'funnel', 'diagnostic method matches');
  t.end();
});

function createAstWithDeclaredExceptions() {
  return {
    classes: [
      {
        className: 'Declared',
        items: [
          {
            type: 'method',
            method: {
              name: 'noop',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '1',
                    localsSize: '1',
                    codeItems: [{ pc: 0, labelDef: 'L0:', instruction: 'return' }],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
                {
                  type: 'exceptions',
                  exceptions: ['java/io/IOException'],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('dead-code pass removes declared exceptions that cannot fire', (t) => {
  const ast = createAstWithDeclaredExceptions();
  const { diagnostics, changed } = runDeadCodePass(ast);
  t.ok(changed, 'pass should flag structural change');
  const removal = diagnostics.find((diag) => diag.message.includes('Removed declared exceptions'));
  t.ok(removal, 'diagnostics should mention exception removal');
  const method = ast.classes[0].items[0].method;
  t.equal(
    method.attributes.filter((attr) => attr.type === 'exceptions').length,
    0,
    'exceptions attribute should be removed',
  );
  t.end();
});

function createAbstractMethodAst() {
  return {
    classes: [
      {
        className: 'AbstractExample',
        items: [
          {
            type: 'method',
            method: {
              name: 'missingBody',
              descriptor: '()V',
              flags: ['public', 'abstract'],
              attributes: [
                {
                  type: 'exceptions',
                  exceptions: ['java/io/IOException'],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test('dead-code pass preserves declared exceptions on abstract methods', (t) => {
  const ast = createAbstractMethodAst();
  const { changed } = runDeadCodePass(ast);
  t.notOk(changed, 'no changes expected for abstract declarations');
  const method = ast.classes[0].items[0].method;
  t.equal(
    method.attributes.filter((attr) => attr.type === 'exceptions').length,
    1,
    'abstract method should retain declared exceptions',
  );
  t.end();
});

function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

function createHelperCallAst() {
  const helper = {
    type: 'method',
    method: {
      name: 'pure',
      descriptor: '()V',
      flags: ['public', 'static'],
      attributes: [
        {
          type: 'code',
          code: {
            stackSize: '0',
            localsSize: '0',
            codeItems: [{ pc: 0, labelDef: 'L0:', instruction: 'return' }],
            exceptionTable: [],
            attributes: [],
          },
        },
      ],
    },
  };
  const caller = {
    type: 'method',
    method: {
      name: 'useHelper',
      descriptor: '()V',
      flags: ['public', 'static'],
      attributes: [
        {
          type: 'code',
          code: {
            stackSize: '1',
            localsSize: '0',
            codeItems: [
              {
                pc: 0,
                labelDef: 'L0:',
                instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['pure', '()V']] },
              },
              { pc: 1, labelDef: 'L1:', instruction: 'return' },
            ],
            exceptionTable: [],
            attributes: [],
          },
        },
        {
          type: 'exceptions',
          exceptions: ['java/io/IOException'],
        },
      ],
    },
  };
  return {
    main: {
      classes: [
        {
          className: 'Main',
          items: [cloneNode(caller)],
        },
      ],
    },
    merged: {
      classes: [
        {
          className: 'Main',
          items: [cloneNode(caller)],
        },
        {
          className: 'Helper',
          items: [cloneNode(helper)],
        },
      ],
    },
  };
}

test('dead-code pass removes declared exceptions when callees provably cannot throw', (t) => {
  const { main, merged } = createHelperCallAst();
  const methodEffects = computeMethodEffects(merged);
  const { changed } = runDeadCodePass(main, { methodEffects });
  t.ok(changed, 'pass should modify AST');
  const method = main.classes[0].items[0].method;
  t.equal(
    method.attributes.filter((attr) => attr.type === 'exceptions').length,
    0,
    'declared exceptions should be stripped when callees do not throw',
  );
  t.end();
});

function createPureVoidCallAst() {
  const helper = {
    type: 'method',
    method: {
      name: 'noop',
      descriptor: '()V',
      flags: ['public', 'static'],
      attributes: [
        {
          type: 'code',
          code: {
            stackSize: '0',
            localsSize: '0',
            codeItems: [{ pc: 0, labelDef: 'L0:', instruction: 'return' }],
            exceptionTable: [],
            attributes: [],
          },
        },
      ],
    },
  };
  const caller = {
    type: 'method',
    method: {
      name: 'callHelper',
      descriptor: '()V',
      flags: ['public', 'static'],
      attributes: [
        {
          type: 'code',
          code: {
            stackSize: '1',
            localsSize: '0',
            codeItems: [
              {
                pc: 0,
                labelDef: 'L0:',
                instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['noop', '()V']] },
              },
              { pc: 1, labelDef: 'L1:', instruction: 'return' },
            ],
            exceptionTable: [],
            attributes: [],
          },
        },
      ],
    },
  };
  return {
    main: {
      classes: [
        {
          className: 'Main',
          items: [cloneNode(caller)],
        },
      ],
    },
    merged: {
      classes: [
        {
          className: 'Main',
          items: [cloneNode(caller)],
        },
        {
          className: 'Helper',
          items: [cloneNode(helper)],
        },
      ],
    },
  };
}

test('dead-code pass removes pure void invocations', (t) => {
  const { main, merged } = createPureVoidCallAst();
  const methodEffects = computeMethodEffects(merged);
  const { changed } = runDeadCodePass(main, { methodEffects });
  t.ok(changed, 'pure call removal should modify AST');
  const method = main.classes[0].items[0].method;
  const remainingInstructions = method.attributes[0].code.codeItems.filter((item) => !!item.instruction);
  t.equal(remainingInstructions.length, 1, 'only the return instruction should remain');
  t.equal(remainingInstructions[0].instruction, 'return', 'remaining instruction should be return');
  t.end();
});

test('dead-code pass keeps abstract invocations', (t) => {
  const ast = {
    classes: [
      {
        className: 'InterfaceExample',
        items: [
          {
            type: 'method',
            method: {
              name: 'doWork',
              descriptor: '()V',
              flags: ['public', 'abstract'],
              attributes: [
                {
                  type: 'exceptions',
                  exceptions: ['java/io/IOException'],
                },
              ],
            },
          },
        ],
      },
      {
        className: 'Main',
        items: [
          {
            type: 'method',
            method: {
              name: 'callInterface',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '1',
                    localsSize: '0',
                    codeItems: [
                      {
                        pc: 0,
                        labelDef: 'L0:',
                        instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'InterfaceExample', ['doWork', '()V']] },
                      },
                      { pc: 1, labelDef: 'L1:', instruction: 'return' },
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
  const methodEffects = computeMethodEffects(ast);
  const { changed } = runDeadCodePass(ast, { methodEffects });
  t.notOk(changed, 'abstract invocation should remain untouched');
  const method = ast.classes[1].items[0].method;
  t.equal(
    method.attributes[0].code.codeItems.filter((item) => item.instruction).length,
    2,
    'invokeinterface should remain',
  );
  t.end();
});
