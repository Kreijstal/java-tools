'use strict';

const test = require('tape');
const { analyzeRenameSafety } = require('../src/renameSafetyAnalyzer');

function workspaceFromClass(cls) {
  return {
    workspaceASTs: {
      [cls.className]: {
        ast: { classes: [cls] },
        constantPool: [],
      },
    },
  };
}

test('rename safety marks hard-coded Class.forName target unsafe', (t) => {
  const workspace = workspaceFromClass({
    className: 'Foo',
    superClassName: 'java/lang/Object',
    interfaces: [],
    items: [
      {
        type: 'method',
        method: {
          name: 'load',
          descriptor: '()V',
          attributes: [
            {
              type: 'code',
              code: {
                codeItems: [
                  { instruction: { op: 'ldc', arg: 'Foo' } },
                  {
                    instruction: {
                      op: 'invokestatic',
                      arg: ['Method', 'java/lang/Class', ['forName', '(Ljava/lang/String;)Ljava/lang/Class;']],
                    },
                  },
                  { instruction: 'return' },
                ],
              },
            },
          ],
        },
      },
    ],
  });

  const result = analyzeRenameSafety(workspace);
  t.equal(result.classes.Foo.rename, 'unsafe');
  t.equal(result.classes.Foo.reasons[0].kind, 'class-name-string');
  t.ok(result.classes.Foo.reasons.some((reason) => reason.kind === 'reflective-class-load'));
  t.end();
});

test('rename safety marks reflected member names unsafe', (t) => {
  const workspace = {
    workspaceASTs: {
      Bar: {
        ast: {
          classes: [
            {
              className: 'Bar',
              superClassName: 'java/lang/Object',
              interfaces: [],
              items: [
                {
                  type: 'method',
                  method: {
                    name: 'target',
                    descriptor: '()V',
                    attributes: [],
                  },
                },
                {
                  type: 'method',
                  method: {
                    name: 'reflect',
                    descriptor: '()V',
                    attributes: [
                      {
                        type: 'code',
                        code: {
                          codeItems: [
                            { instruction: { op: 'ldc', arg: 'Bar' } },
                            {
                              instruction: {
                                op: 'invokestatic',
                                arg: ['Method', 'java/lang/Class', ['forName', '(Ljava/lang/String;)Ljava/lang/Class;']],
                              },
                            },
                            { instruction: { op: 'ldc', arg: 'target' } },
                            { instruction: { op: 'aconst_null' } },
                            {
                              instruction: {
                                op: 'invokevirtual',
                                arg: ['Method', 'java/lang/Class', ['getDeclaredMethod', '(Ljava/lang/String;[Ljava/lang/Class;)Ljava/lang/reflect/Method;']],
                              },
                            },
                            { instruction: 'return' },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        constantPool: [],
      },
      Baz: {
        ast: {
          classes: [
            {
              className: 'Baz',
              superClassName: 'java/lang/Object',
              interfaces: [],
              items: [
                {
                  type: 'method',
                  method: {
                    name: 'target',
                    descriptor: '()V',
                    attributes: [],
                  },
                },
              ],
            },
          ],
        },
        constantPool: [],
      },
    },
  };

  const result = analyzeRenameSafety(workspace);
  const barTarget = result.classes.Bar.methods.find((method) => method.name === 'target');
  const bazTarget = result.classes.Baz.methods.find((method) => method.name === 'target');
  t.equal(barTarget.rename, 'unsafe');
  t.equal(barTarget.reasons[0].kind, 'reflected-method-name');
  t.equal(bazTarget.rename, 'safe', 'same method name on another class should not be poisoned');
  t.end();
});
