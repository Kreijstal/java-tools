'use strict';

const test = require('tape');
const {
  discoverInterproceduralSignatureCompactions,
  discoverInterproceduralConstantArguments,
  runConstantExpressionFold,
  runImmediateConstantBranchDce,
  runInterproceduralConstantArgumentFixedPoint,
  runInterproceduralConstantArguments,
  runInterproceduralSignatureCompaction,
  _internals,
} = require('../src/passes/interproceduralConstantArguments');

function method(name, descriptor, flags, codeItems) {
  return {
    type: 'method',
    method: {
      name,
      descriptor,
      flags,
      attributes: [{ type: 'code', code: { codeItems, exceptionTable: [], attributes: [] } }],
    },
  };
}

function classAst(className, items) {
  return { className, flags: [], superClassName: 'java/lang/Object', interfaces: [], items };
}

test('specializes an interclass direct-call parameter that is always constant', (t) => {
  const callee = method('d', '(B)V', ['private'], [
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'bipush', arg: '116' } },
    { instruction: { op: 'if_icmpne', arg: 'Ltrap' } },
    { instruction: 'return' },
    { labelDef: 'Ltrap:', instruction: 'aconst_null' },
    { instruction: 'athrow' },
  ]);
  const ast = {
    classes: [
      classAst('uk', [callee]),
      classAst('CallerA', [method('a', '()V', ['static'], [
        { instruction: 'aconst_null' },
        { instruction: { op: 'bipush', arg: '116' } },
        { instruction: { op: 'invokespecial', arg: ['Method', 'uk', ['d', '(B)V']] } },
        { instruction: 'return' },
      ])]),
      classAst('CallerB', [method('b', '()V', ['static'], [
        { instruction: 'aconst_null' },
        { instruction: { op: 'bipush', arg: '116' } },
        { instruction: { op: 'invokespecial', arg: ['Method', 'uk', ['d', '(B)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };

  const discovery = discoverInterproceduralConstantArguments(ast);
  t.equal(discovery.facts.length, 1);
  t.equal(discovery.facts[0].signature, 'uk.d(B)V');
  t.equal(discovery.facts[0].value, 116);
  t.equal(discovery.facts[0].callCount, 2);

  const result = runInterproceduralConstantArguments(ast, { facts: discovery.facts });
  t.equal(result.specializedMethods, 1);
  t.equal(result.replacedLoads, 1);
  t.equal(result.foldedBranches, 1);
  t.deepEqual(
    callee.method.attributes[0].code.codeItems.slice(0, 3).map((item) => item.instruction),
    ['nop', 'nop', 'nop'],
  );
  t.end();
});

test('rejects mixed, unknown, virtual, and reassigned parameter call shapes', (t) => {
  const ast = {
    classes: [
      classAst('Mixed', [method('d', '(I)V', ['static'], [{ instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' }])]),
      classAst('Unknown', [method('d', '(I)V', ['static'], [{ instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' }])]),
      classAst('Virtual', [method('d', '(I)V', [], [{ instruction: 'iload_1' }, { instruction: 'pop' }, { instruction: 'return' }])]),
      classAst('Reassigned', [method('d', '(I)V', ['static'], [{ instruction: 'iconst_0' }, { instruction: 'istore_0' }, { instruction: 'return' }])]),
      classAst('Calls', [method('all', '(I)V', ['static'], [
        { instruction: 'iconst_1' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Mixed', ['d', '(I)V']] } },
        { instruction: 'iconst_2' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Mixed', ['d', '(I)V']] } },
        { instruction: 'iload_0' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Unknown', ['d', '(I)V']] } },
        { instruction: 'aconst_null' },
        { instruction: 'iconst_1' },
        { instruction: { op: 'invokevirtual', arg: ['Method', 'Virtual', ['d', '(I)V']] } },
        { instruction: 'iconst_1' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Reassigned', ['d', '(I)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };

  const discovery = discoverInterproceduralConstantArguments(ast);
  t.deepEqual(discovery.facts, []);
  t.end();
});

test('rejects parameters modified by the parsed iinc varnum form', (t) => {
  const ast = {
    classes: [
      classAst('Incremented', [method('d', '(I)V', ['static'], [
        { instruction: { op: 'iinc', varnum: '0', incr: '1' } },
        { instruction: 'iload_0' },
        { instruction: 'pop' },
        { instruction: 'return' },
      ])]),
      classAst('Calls', [method('all', '()V', ['static'], [
        { instruction: 'iconst_1' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Incremented', ['d', '(I)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };

  t.deepEqual(discoverInterproceduralConstantArguments(ast).facts, []);
  t.end();
});

test('compacts specialized trailing parameters and rewrites labeled direct calls', (t) => {
  const callee = method('d', '(Ljava/lang/String;II)V', ['private'], [
    { instruction: 'aload_1' },
    { instruction: 'pop' },
    { instruction: 'return' },
  ]);
  const callItems = [
    { instruction: 'aconst_null' },
    { instruction: 'aconst_null' },
    { instruction: { op: 'bipush', arg: '7' } },
    { instruction: { op: 'sipush', arg: '18580' } },
    {
      labelDef: 'Lcall:',
      instruction: { op: 'invokespecial', arg: ['Method', 'Target', ['d', '(Ljava/lang/String;II)V']] },
    },
    { instruction: 'return' },
  ];
  const ast = { classes: [
    classAst('Target', [callee]),
    classAst('Calls', [method('all', '()V', ['static'], callItems)]),
  ] };
  const facts = [
    {
      signature: 'Target.d(Ljava/lang/String;II)V', owner: 'Target', name: 'd',
      descriptor: '(Ljava/lang/String;II)V', parameterIndex: 1, localIndex: 2,
      parameterDescriptor: 'I', value: 7, callCount: 1, discoveredIteration: 1,
    },
    {
      signature: 'Target.d(Ljava/lang/String;II)V', owner: 'Target', name: 'd',
      descriptor: '(Ljava/lang/String;II)V', parameterIndex: 2, localIndex: 3,
      parameterDescriptor: 'I', value: 18580, callCount: 1, discoveredIteration: 2,
    },
  ];

  const discovery = discoverInterproceduralSignatureCompactions(ast, { facts });
  t.equal(discovery.compactions.length, 1);
  t.equal(discovery.compactions[0].newDescriptor, '(Ljava/lang/String;)V');
  t.deepEqual(discovery.compactions[0].removedParameters.map((item) => item.index), [1, 2]);

  const result = runInterproceduralSignatureCompaction(ast, discovery);
  t.equal(result.methodsChanged, 1);
  t.equal(result.callSitesChanged, 1);
  t.equal(callee.method.descriptor, '(Ljava/lang/String;)V');
  t.deepEqual(callItems.slice(4, 7).map((item) => item.instruction), [
    'pop', 'pop', { op: 'invokespecial', arg: ['Method', 'Target', ['d', '(Ljava/lang/String;)V']] },
  ]);
  t.equal(callItems[4].labelDef, 'Lcall:');
  t.equal(callItems[6].labelDef, undefined);
  t.end();
});

test('signature compaction excludes live, non-trailing, virtual, and colliding parameters', (t) => {
  const live = method('live', '(I)V', ['private'], [
    { instruction: 'iload_1' }, { instruction: 'pop' }, { instruction: 'return' },
  ]);
  const nonTrailing = method('middle', '(ILjava/lang/String;)V', ['private'], [
    { instruction: 'return' },
  ]);
  const virtual = method('virtual', '(I)V', [], [{ instruction: 'return' }]);
  const collision = method('collision', '(I)V', ['static'], [{ instruction: 'return' }]);
  const collisionExisting = method('collision', '()I', ['static'], [{ instruction: 'iconst_0' }, { instruction: 'ireturn' }]);
  const ast = { classes: [classAst('Target', [
    live, nonTrailing, virtual, collision, collisionExisting,
  ])] };
  const facts = [
    { signature: 'Target.live(I)V', parameterIndex: 0, localIndex: 1, value: 1 },
    { signature: 'Target.middle(ILjava/lang/String;)V', parameterIndex: 0, localIndex: 1, value: 1 },
    { signature: 'Target.virtual(I)V', parameterIndex: 0, localIndex: 1, value: 1 },
    { signature: 'Target.collision(I)V', parameterIndex: 0, localIndex: 0, value: 1 },
  ];
  t.deepEqual(discoverInterproceduralSignatureCompactions(ast, { facts }).compactions, []);
  t.end();
});

test('signature compaction rejects source-signature collisions across a hierarchy', (t) => {
  const parent = classAst('Parent', [
    method('a', '()V', ['static'], [{ instruction: 'return' }]),
  ]);
  const child = classAst('Child', [
    method('a', '(I)I', ['private'], [{ instruction: 'iconst_0' }, { instruction: 'ireturn' }]),
  ]);
  child.superClassName = 'Parent';
  const facts = [{
    signature: 'Child.a(I)I', parameterIndex: 0, localIndex: 1, value: 1,
  }];
  t.deepEqual(
    discoverInterproceduralSignatureCompactions({ classes: [parent, child] }, { facts }).compactions,
    [],
  );
  t.end();
});

test('resolves inherited constant calls and rewrites subclass-owned method references', (t) => {
  const parentMethod = method('d', '(I)V', ['static'], [
    { instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' },
  ]);
  const parent = classAst('Parent', [parentMethod]);
  const child = classAst('Child', []);
  child.superClassName = 'Parent';
  const callItems = [
    { instruction: { op: 'bipush', arg: '42' } },
    { instruction: { op: 'invokestatic', arg: ['Method', 'Child', ['d', '(I)V']] } },
    { instruction: 'return' },
  ];
  const calls = classAst('Calls', [method('all', '()V', ['static'], callItems)]);
  const ast = { classes: [parent, child, calls] };

  const constantDiscovery = discoverInterproceduralConstantArguments(ast);
  t.equal(constantDiscovery.facts.length, 1);
  t.equal(constantDiscovery.facts[0].signature, 'Parent.d(I)V');
  t.equal(constantDiscovery.facts[0].callCount, 1);
  runInterproceduralConstantArguments(ast, constantDiscovery);

  const signatureDiscovery = discoverInterproceduralSignatureCompactions(ast, constantDiscovery);
  t.deepEqual(signatureDiscovery.compactions[0].callSiteSignatures, [
    'Child.d(I)V', 'Parent.d(I)V',
  ]);
  runInterproceduralSignatureCompaction({ classes: [calls] }, signatureDiscovery);
  t.equal(callItems[2].instruction.arg[2][1], '()V');
  t.equal(callItems[1].instruction, 'pop');
  t.end();
});

test('supports a constant conversion immediately before the call', (t) => {
  const ast = {
    classes: [
      classAst('Target', [method('d', '(B)V', ['static'], [{ instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' }])]),
      classAst('Calls', [method('all', '()V', ['static'], [
        { instruction: { op: 'sipush', arg: '255' } },
        { instruction: 'i2b' },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Target', ['d', '(B)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };
  const discovery = discoverInterproceduralConstantArguments(ast);
  t.equal(discovery.facts[0].value, -1);
  t.end();
});

test('discovers every constant int-like argument across category-two arguments', (t) => {
  const ast = {
    classes: [
      classAst('Target', [method('d', '(IJI)V', ['static'], [
        { instruction: 'iload_0' },
        { instruction: 'pop' },
        { instruction: 'iload_3' },
        { instruction: 'pop' },
        { instruction: 'return' },
      ])]),
      classAst('Calls', [method('all', '()V', ['static'], [
        { instruction: { op: 'bipush', arg: '7' } },
        { instruction: { op: 'ldc2_w', arg: 123n } },
        { instruction: { op: 'bipush', arg: '9' } },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Target', ['d', '(IJI)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };

  const discovery = discoverInterproceduralConstantArguments(ast);
  t.deepEqual(discovery.facts.map((fact) => [fact.parameterIndex, fact.localIndex, fact.value]), [
    [0, 0, 7],
    [2, 3, 9],
  ]);
  t.end();
});

test('repeats specialization and reachability until a downstream argument becomes constant', (t) => {
  const target = method('d', '(I)V', ['static'], [
    { instruction: 'iload_0' },
    { instruction: { op: 'sipush', arg: '18580' } },
    { instruction: { op: 'if_icmpeq', arg: 'Lreturn' } },
    { instruction: 'aconst_null' },
    { instruction: 'athrow' },
    { labelDef: 'Lreturn:', instruction: 'return' },
  ]);
  const wrapper = method('w', '(B)V', ['static'], [
    { instruction: 'iload_0' },
    { instruction: 'iconst_m1' },
    { instruction: { op: 'if_icmplt', arg: 'Lskip' } },
    { instruction: { op: 'sipush', arg: '109' } },
    { instruction: { op: 'invokestatic', arg: ['Method', 'Target', ['d', '(I)V']] } },
    { labelDef: 'Lskip:', instruction: 'return' },
  ]);
  const ast = {
    classes: [
      classAst('Target', [target]),
      classAst('Wrapper', [wrapper]),
      classAst('Calls', [method('all', '()V', ['static'], [
        { instruction: { op: 'bipush', arg: '-102' } },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Wrapper', ['w', '(B)V']] } },
        { instruction: { op: 'sipush', arg: '18580' } },
        { instruction: { op: 'invokestatic', arg: ['Method', 'Target', ['d', '(I)V']] } },
        { instruction: 'return' },
      ])]),
    ],
  };

  const initial = discoverInterproceduralConstantArguments(ast);
  t.deepEqual(initial.facts.map((fact) => fact.key), ['Wrapper.w(B)V#0'],
    'the reachable 109 call initially prevents specializing Target.d');

  const result = runInterproceduralConstantArgumentFixedPoint(ast);
  t.ok(result.converged, 'the fact set reaches a fixed point');
  t.ok(result.iterations >= 3, 'a later iteration discovers the downstream fact');
  t.deepEqual(result.facts.map((fact) => [fact.key, fact.value]), [
    ['Target.d(I)V#0', 18580],
    ['Wrapper.w(B)V#0', -102],
  ]);
  t.notOk(wrapper.method.attributes[0].code.codeItems.some((item) => {
    const instruction = item && item.instruction;
    return instruction && instruction.op === 'invokestatic'
      && instruction.arg[1] === 'Target';
  }), 'the dead 109 call is removed before rediscovery');
  t.deepEqual(
    target.method.attributes[0].code.codeItems.slice(0, 3).map((item) => item.instruction),
    ['nop', 'nop', { op: 'goto', arg: 'Lreturn' }],
    'the newly constant 18580 comparison is folded');
  t.end();
});

test('keeps public classes and external callback contracts open', (t) => {
  const publicTarget = classAst('PublicTarget', [
    method('d', '(I)V', ['public', 'static'], [{ instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' }]),
  ]);
  publicTarget.flags = ['public'];
  const callbackTarget = classAst('CallbackTarget', [
    method('accept', '(I)V', ['public'], [{ instruction: 'iload_1' }, { instruction: 'pop' }, { instruction: 'return' }]),
  ]);
  callbackTarget.interfaces = ['java/awt/event/ActionListener'];
  const calls = classAst('Calls', [method('all', '()V', ['static'], [
    { instruction: 'iconst_1' },
    { instruction: { op: 'invokestatic', arg: ['Method', 'PublicTarget', ['d', '(I)V']] } },
    { instruction: 'aconst_null' },
    { instruction: 'iconst_1' },
    { instruction: { op: 'invokespecial', arg: ['Method', 'CallbackTarget', ['accept', '(I)V']] } },
    { instruction: 'return' },
  ])]);
  const discovery = discoverInterproceduralConstantArguments({ classes: [publicTarget, callbackTarget, calls] });
  t.deepEqual(discovery.facts, []);
  t.end();
});

test('allows public-looking methods when their class is gamepack-internal', (t) => {
  const target = classAst('InternalTarget', [
    method('d', '(I)V', ['public', 'static'], [{ instruction: 'iload_0' }, { instruction: 'pop' }, { instruction: 'return' }]),
  ]);
  const calls = classAst('Calls', [method('all', '()V', ['static'], [
    { instruction: { op: 'bipush', arg: '42' } },
    { instruction: { op: 'invokestatic', arg: ['Method', 'InternalTarget', ['d', '(I)V']] } },
    { instruction: 'return' },
  ])]);
  const discovery = discoverInterproceduralConstantArguments({ classes: [target, calls] });
  t.equal(discovery.facts.length, 1);
  t.equal(discovery.facts[0].value, 42);
  t.end();
});

test('does not fold a constant branch with an external entry into its producers', (t) => {
  const codeItems = [
    { instruction: 'iconst_1' },
    { labelDef: 'Ljoin:', instruction: 'iconst_1' },
    { instruction: { op: 'if_icmpne', arg: 'Lend' } },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ];
  t.equal(_internals.foldImmediateConstantBranches(codeItems), 0);
  t.equal(codeItems[2].instruction.op, 'if_icmpne');
  t.end();
});

test('folds constant branches on try-range boundaries', (t) => {
  const codeItems = [
    { instruction: 'iconst_0' },
    { labelDef: 'Ltry:', instruction: 'iconst_0' },
    { labelDef: 'Lend:', instruction: { op: 'if_icmpeq', arg: 'Lreturn' } },
    { labelDef: 'Lhandler:', instruction: 'athrow' },
    { labelDef: 'Lreturn:', instruction: 'return' },
  ];
  const ast = {
    classes: [classAst('TryBoundary', [{
      type: 'method',
      method: {
        name: 'f',
        descriptor: '()V',
        flags: ['static'],
        attributes: [{
          type: 'code',
          code: {
            codeItems,
            exceptionTable: [{ startLbl: 'Ltry', endLbl: 'Lend', handlerLbl: 'Lhandler' }],
            attributes: [],
          },
        }],
      },
    }])],
  };
  const result = runImmediateConstantBranchDce(ast);
  t.equal(result.foldedBranches, 1, 'try-range start/end labels are not control-flow entries');
  t.deepEqual(codeItems.slice(0, 3).map((item) => item.instruction), [
    'nop',
    'nop',
    { op: 'goto', arg: 'Lreturn' },
  ]);
  t.end();
});

test('does not fold through an exception handler entry', (t) => {
  const codeItems = [
    { instruction: 'iconst_0' },
    { labelDef: 'Lhandler:', instruction: 'iconst_0' },
    { instruction: { op: 'if_icmpeq', arg: 'Lreturn' } },
    { labelDef: 'Lreturn:', instruction: 'return' },
  ];
  const ast = {
    classes: [classAst('HandlerEntry', [{
      type: 'method',
      method: {
        name: 'f',
        descriptor: '()V',
        flags: ['static'],
        attributes: [{
          type: 'code',
          code: {
            codeItems,
            exceptionTable: [{ startLbl: 'L0', endLbl: 'Lreturn', handlerLbl: 'Lhandler' }],
            attributes: [],
          },
        }],
      },
    }])],
  };
  const result = runImmediateConstantBranchDce(ast);
  t.equal(result.foldedBranches, 0);
  t.equal(codeItems[2].instruction.op, 'if_icmpeq');
  t.end();
});

test('folds nested JVM integer constants and exposes a dead branch', (t) => {
  const codeItems = [
    { instruction: { op: 'bipush', arg: '50' } },
    { instruction: { op: 'bipush', arg: '100' } },
    { instruction: 'imul' },
    { instruction: { op: 'sipush', arg: '150' } },
    { instruction: 'idiv' },
    { instruction: 'istore_0' },
    { instruction: 'iconst_m1' },
    { instruction: 'iconst_m1' },
    { instruction: 'iconst_m1' },
    { instruction: 'ixor' },
    { instruction: { op: 'if_icmple', arg: 'Ltrue' } },
    { instruction: 'return' },
    { labelDef: 'Ltrue:', instruction: 'return' },
  ];
  const ast = { classes: [classAst('Constants', [method('f', '()V', ['static'], codeItems)])] };

  const constants = runConstantExpressionFold(ast);
  t.equal(constants.foldedExpressions, 3, 'folds multiply, divide, and xor');
  t.deepEqual(codeItems[4].instruction, { op: 'bipush', arg: '33' });
  t.equal(codeItems[9].instruction, 'iconst_0');

  const branches = runImmediateConstantBranchDce(ast);
  t.equal(branches.foldedBranches, 1);
  t.deepEqual(codeItems[10].instruction, { op: 'goto', arg: 'Ltrue' });
  t.end();
});

test('normalizes int and long shift distances using JVM masks', (t) => {
  const intItems = [
    { instruction: 'iload_0' },
    { instruction: { op: 'ldc', arg: 211015160 } },
    { instruction: 'iushr' },
    { instruction: 'ireturn' },
  ];
  const longItems = [
    { instruction: 'lload_0' },
    { instruction: 'iconst_m1' },
    { instruction: 'lshl' },
    { instruction: 'lreturn' },
  ];
  const ast = { classes: [classAst('Shifts', [
    method('i', '(I)I', ['static'], intItems),
    method('l', '(J)J', ['static'], longItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.normalizedShiftCounts, 2);
  t.deepEqual(intItems[1].instruction, { op: 'bipush', arg: '24' });
  t.deepEqual(longItems[1].instruction, { op: 'bipush', arg: '63' });
  t.end();
});

test('uses JVM overflow for int and long constant expressions', (t) => {
  const intItems = [
    { instruction: { op: 'ldc', arg: 2147483647 } },
    { instruction: 'iconst_1' },
    { instruction: 'iadd' },
    { instruction: 'ireturn' },
  ];
  const longItems = [
    { instruction: { op: 'ldc2_w', arg: 9223372036854775807n } },
    { instruction: 'lconst_1' },
    { instruction: 'ladd' },
    { instruction: 'lreturn' },
  ];
  const ast = { classes: [classAst('Overflow', [
    method('i', '()I', ['static'], intItems),
    method('l', '()J', ['static'], longItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.foldedExpressions, 2);
  t.deepEqual(intItems[2].instruction, { op: 'ldc', arg: -2147483648 });
  t.deepEqual(longItems[2].instruction, { op: 'ldc2_w', arg: -9223372036854775808n });
  t.end();
});

test('preserves division by zero and expressions with external stack entries', (t) => {
  const divideItems = [
    { instruction: 'iconst_1' },
    { instruction: 'iconst_0' },
    { instruction: 'idiv' },
    { instruction: 'ireturn' },
  ];
  const joinedItems = [
    { instruction: 'iconst_2' },
    { labelDef: 'Ljoin:', instruction: 'iconst_3' },
    { instruction: 'iadd' },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
  ];
  const ast = { classes: [classAst('Safety', [
    method('divide', '()I', ['static'], divideItems),
    method('joined', '()V', ['static'], joinedItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.foldedExpressions, 0);
  t.equal(divideItems[2].instruction, 'idiv', 'keeps observable ArithmeticException');
  t.equal(joinedItems[2].instruction, 'iadd', 'keeps alternate-entry stack expression');
  t.end();
});

test('removes right-hand integer and long identity operations', (t) => {
  const intItems = [
    { instruction: 'iload_0' },
    { instruction: 'iconst_0' },
    { instruction: 'ixor' },
    { instruction: 'iconst_1' },
    { instruction: 'idiv' },
    { instruction: 'ireturn' },
  ];
  const longItems = [
    { instruction: 'lload_0' },
    { instruction: 'lconst_1' },
    { instruction: 'lmul' },
    { instruction: 'iconst_0' },
    { instruction: 'lshr' },
    { instruction: 'lreturn' },
  ];
  const ast = { classes: [classAst('Identities', [
    method('i', '(I)I', ['static'], intItems),
    method('l', '(J)J', ['static'], longItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.simplifiedIdentities, 4);
  t.deepEqual(intItems.slice(1, 5).map((item) => item.instruction),
    ['nop', 'nop', 'nop', 'nop']);
  t.deepEqual(longItems.slice(1, 5).map((item) => item.instruction),
    ['nop', 'nop', 'nop', 'nop']);
  t.end();
});

test('removes unambiguous left-hand identities before local loads', (t) => {
  const intItems = [
    { instruction: 'iconst_1' },
    { instruction: 'iload_0' },
    { instruction: 'imul' },
    { instruction: 'ireturn' },
  ];
  const longItems = [
    { instruction: { op: 'ldc2_w', arg: -1n } },
    { instruction: 'lload_0' },
    { instruction: 'land' },
    { instruction: 'lreturn' },
  ];
  const ast = { classes: [classAst('LeftIdentities', [
    method('i', '(I)I', ['static'], intItems),
    method('l', '(J)J', ['static'], longItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.simplifiedIdentities, 2);
  t.deepEqual(intItems.slice(0, 3).map((item) => item.instruction), ['nop', 'iload_0', 'nop']);
  t.deepEqual(longItems.slice(0, 3).map((item) => item.instruction), ['nop', 'lload_0', 'nop']);
  t.end();
});

test('combines adjacent additive constants with JVM overflow', (t) => {
  const positiveItems = [
    { instruction: 'iload_0' },
    { instruction: 'iconst_5' },
    { instruction: 'iadd' },
    { instruction: { op: 'bipush', arg: '-2' } },
    { instruction: 'isub' },
    { instruction: 'ireturn' },
  ];
  const negativeItems = [
    { instruction: 'iload_0' },
    { instruction: { op: 'bipush', arg: '-36' } },
    { instruction: 'iadd' },
    { instruction: { op: 'bipush', arg: '-3' } },
    { instruction: 'iadd' },
    { instruction: 'ireturn' },
  ];
  const cancelItems = [
    { instruction: 'iload_0' },
    { instruction: 'iconst_5' },
    { instruction: 'iadd' },
    { instruction: 'iconst_5' },
    { instruction: 'isub' },
    { instruction: 'ireturn' },
  ];
  const longOverflowItems = [
    { instruction: 'lload_0' },
    { instruction: { op: 'ldc2_w', arg: 9223372036854775807n } },
    { instruction: 'ladd' },
    { instruction: 'lconst_1' },
    { instruction: 'ladd' },
    { instruction: 'lreturn' },
  ];
  const ast = { classes: [classAst('Chains', [
    method('positive', '(I)I', ['static'], positiveItems),
    method('negative', '(I)I', ['static'], negativeItems),
    method('cancel', '(I)I', ['static'], cancelItems),
    method('overflow', '(J)J', ['static'], longOverflowItems),
  ])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.combinedConstantChains, 4);
  t.deepEqual(positiveItems.slice(1, 5).map((item) => item.instruction), [
    { op: 'bipush', arg: '7' }, 'iadd', 'nop', 'nop',
  ]);
  t.deepEqual(negativeItems.slice(1, 5).map((item) => item.instruction), [
    { op: 'bipush', arg: '39' }, 'isub', 'nop', 'nop',
  ]);
  t.deepEqual(cancelItems.slice(1, 5).map((item) => item.instruction),
    ['nop', 'nop', 'nop', 'nop']);
  t.deepEqual(longOverflowItems.slice(1, 5).map((item) => item.instruction), [
    { op: 'ldc2_w', arg: -9223372036854775808n }, 'ladd', 'nop', 'nop',
  ]);
  t.end();
});

test('does not remove an identity operator with an alternate entry', (t) => {
  const codeItems = [
    { instruction: 'iload_0' },
    { instruction: 'iconst_0' },
    { labelDef: 'Loperator:', instruction: 'iadd' },
    { instruction: { op: 'goto', arg: 'Loperator' } },
  ];
  const ast = { classes: [classAst('IdentityJoin', [method('f', '(I)V', ['static'], codeItems)])] };

  const result = runConstantExpressionFold(ast);
  t.equal(result.simplifiedIdentities, 0);
  t.equal(codeItems[2].instruction, 'iadd');
  t.end();
});
