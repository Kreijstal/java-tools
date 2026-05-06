'use strict';

const test = require('tape');
const { simplifyCodeItems } = require('../src/simplifyNotCompare');

test('simplifyCodeItems rewrites ~x > k into x < ~k', (t) => {
  const codeItems = [
    { labelDef: 'L0:', instruction: { op: 'iload', arg: '6' } },
    { instruction: 'iconst_m1' },
    { instruction: 'ixor' },
    { instruction: { op: 'bipush', arg: '-66' } },
    { instruction: { op: 'if_icmpgt', arg: 'L1' } },
  ];

  t.equal(simplifyCodeItems(codeItems), 1, 'rewrites one comparison');
  t.deepEqual(codeItems, [
    { labelDef: 'L0:', instruction: { op: 'iload', arg: '6' } },
    { instruction: { op: 'bipush', arg: '65' } },
    { instruction: { op: 'if_icmplt', arg: 'L1' } },
  ]);
  t.end();
});

test('simplifyCodeItems rewrites k > ~x into x > ~k', (t) => {
  const codeItems = [
    { labelDef: 'L0:', instruction: { op: 'bipush', arg: '-91' } },
    { instruction: { op: 'iload', arg: '6' } },
    { instruction: 'iconst_m1' },
    { instruction: 'ixor' },
    { instruction: { op: 'if_icmpgt', arg: 'L1' } },
  ];

  t.equal(simplifyCodeItems(codeItems), 1, 'rewrites one comparison');
  t.deepEqual(codeItems, [
    { labelDef: 'L0:', instruction: { op: 'iload', arg: '6' } },
    { instruction: { op: 'bipush', arg: '90' } },
    { instruction: { op: 'if_icmpgt', arg: 'L1' } },
  ]);
  t.end();
});

test('simplifyCodeItems rewrites k != ~x into x != ~k', (t) => {
  const codeItems = [
    { instruction: { op: 'bipush', arg: '-61' } },
    { instruction: { op: 'iload', arg: '9' } },
    { instruction: 'iconst_m1' },
    { instruction: 'ixor' },
    { instruction: { op: 'if_icmpne', arg: 'L1' } },
  ];

  t.equal(simplifyCodeItems(codeItems), 1, 'rewrites one equality comparison');
  t.deepEqual(codeItems, [
    { instruction: { op: 'iload', arg: '9' } },
    { instruction: { op: 'bipush', arg: '60' } },
    { instruction: { op: 'if_icmpne', arg: 'L1' } },
  ]);
  t.end();
});

test('simplifyCodeItems preserves labelled interior instructions', (t) => {
  const codeItems = [
    { instruction: { op: 'goto', arg: 'Lmid' } },
    { instruction: { op: 'iload', arg: '6' } },
    { labelDef: 'Lmid:', instruction: 'iconst_m1' },
    { instruction: 'ixor' },
    { instruction: { op: 'bipush', arg: '-66' } },
    { instruction: { op: 'if_icmpgt', arg: 'L1' } },
  ];

  t.equal(simplifyCodeItems(codeItems), 0, 'does not rewrite across label targets');
  t.equal(codeItems.length, 6, 'items are unchanged');
  t.end();
});

test('runSimplifyNotCompare can restrict rewrites to char-derived locals', (t) => {
  const ast = {
    classes: [
      {
        items: [
          {
            type: 'method',
            method: {
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: { op: 'aload', arg: '1' } },
                      { instruction: 'iconst_0' },
                      { instruction: { op: 'invokeinterface', arg: ['InterfaceMethod', 'java/lang/CharSequence', ['charAt', '(I)C']] } },
                      { instruction: { op: 'istore', arg: '6' } },
                      { instruction: { op: 'iload', arg: '6' } },
                      { instruction: 'iconst_m1' },
                      { instruction: 'ixor' },
                      { instruction: { op: 'bipush', arg: '-66' } },
                      { instruction: { op: 'if_icmpgt', arg: 'L1' } },
                      { instruction: { op: 'iload', arg: '7' } },
                      { instruction: 'iconst_m1' },
                      { instruction: 'ixor' },
                      { instruction: { op: 'bipush', arg: '-66' } },
                      { instruction: { op: 'if_icmpgt', arg: 'L2' } },
                    ],
                    exceptionTable: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const { runSimplifyNotCompare } = require('../src/simplifyNotCompare');
  const result = runSimplifyNotCompare(ast, { charLocalsOnly: true });
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;

  t.equal(result.rewrites, 1, 'rewrites only the char local comparison');
  t.equal(codeItems[4].instruction.op, 'iload', 'keeps char local load');
  t.equal(codeItems[5].instruction.arg, '65', 'uses positive char bound');
  t.ok(codeItems.some((item) => item.instruction && item.instruction.op === 'iload' && item.instruction.arg === '7'), 'non-char local comparison remains');
  t.end();
});

test('runSimplifyNotCompare rewrites static char field comparisons', (t) => {
  const ast = {
    classes: [
      {
        items: [
          {
            type: 'method',
            method: {
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: { op: 'bipush', arg: '-94' } },
                      { instruction: { op: 'getstatic', arg: ['Field', 'el', ['G', 'C']] } },
                      { instruction: 'iconst_m1' },
                      { instruction: 'ixor' },
                      { instruction: { op: 'if_icmpeq', arg: 'L1' } },
                    ],
                    exceptionTable: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const { runSimplifyNotCompare } = require('../src/simplifyNotCompare');
  const result = runSimplifyNotCompare(ast, { charLocalsOnly: true });
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;

  t.equal(result.rewrites, 1, 'rewrites the static char comparison');
  t.deepEqual(codeItems, [
    { instruction: { op: 'getstatic', arg: ['Field', 'el', ['G', 'C']] } },
    { instruction: { op: 'bipush', arg: '93' } },
    { instruction: { op: 'if_icmpeq', arg: 'L1' } },
  ]);
  t.end();
});

test('runSimplifyNotCompare rewrites char parameter comparisons', (t) => {
  const ast = {
    classes: [
      {
        items: [
          {
            type: 'method',
            method: {
              flags: ['static'],
              descriptor: '(IC)Z',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      { instruction: { op: 'iload', arg: '1' } },
                      { instruction: 'iconst_m1' },
                      { instruction: 'ixor' },
                      { instruction: { op: 'sipush', arg: '-161' } },
                      { instruction: { op: 'if_icmpgt', arg: 'L1' } },
                    ],
                    exceptionTable: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const { runSimplifyNotCompare } = require('../src/simplifyNotCompare');
  const result = runSimplifyNotCompare(ast, { charLocalsOnly: true });
  const codeItems = ast.classes[0].items[0].method.attributes[0].code.codeItems;

  t.equal(result.rewrites, 1, 'rewrites the char parameter comparison');
  t.deepEqual(codeItems, [
    { instruction: { op: 'iload', arg: '1' } },
    { instruction: { op: 'sipush', arg: '160' } },
    { instruction: { op: 'if_icmplt', arg: 'L1' } },
  ]);
  t.end();
});
