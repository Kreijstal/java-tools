'use strict';

const test = require('tape');
const { computeMethodEffects, makeMethodKey } = require('../src/methodEffectsAnalyzer');

test('computeMethodEffects propagates throws across calls', (t) => {
  const ast = {
    classes: [
      {
        className: 'Helper',
        items: [
          {
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
          },
        ],
      },
      {
        className: 'Main',
        items: [
          {
            type: 'method',
            method: {
              name: 'caller',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '1',
                    localsSize: '0',
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['pure', '()V']] } },
                      { pc: 1, labelDef: 'L1:', instruction: 'return' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
                { type: 'exceptions', exceptions: ['java/io/IOException'] },
              ],
            },
          },
        ],
      },
    ],
  };
  const effects = computeMethodEffects(ast);
  const helperKey = makeMethodKey('Helper', 'pure', '()V');
  const callerKey = makeMethodKey('Main', 'caller', '()V');
  t.ok(effects.has(helperKey), 'should include helper');
  t.equal(effects.get(helperKey).throws.size, 0, 'pure method has no throws');
  t.ok(effects.has(callerKey), 'should include caller');
  t.equal(effects.get(callerKey).throws.size, 0, 'throws should propagate to caller');
  t.end();
});

test('computeMethodEffects marks unknown callees as throwing', (t) => {
  const ast = {
    classes: [
      {
        className: 'Main',
        items: [
          {
            type: 'method',
            method: {
              name: 'caller',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '1',
                    localsSize: '0',
                    codeItems: [
                      { pc: 0, labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'Missing', ['foo', '()V']] } },
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
  const effects = computeMethodEffects(ast);
  const callerKey = makeMethodKey('Main', 'caller', '()V');
  t.ok(effects.get(callerKey).throwsUnknown, 'unknown callee should mark throwsUnknown');
  t.end();
});
